import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { openSettings } from './settingsWindow'
import { startupLog } from './startupLog'

/**
 * 应用内自动更新（SPEC-auto-update，用户 2026-11-18 选「先问再下」）。
 *
 * 为什么用 electron-updater：项目是 electron-builder 打的标准 NSIS + 公开 GitHub Release，
 * 更新器需要的 latest.yml / blockmap 打包时已经生成，自写一套下载与安装只会多一份要维护的代码。
 *
 * 关键取舍：
 * - `autoDownload = false`：发现新版本只提示，120 MB 流量要用户点了才下载。
 * - `autoInstallOnAppQuit = false`：没点「重启并安装」就绝不偷偷装，避免正在写日程时被重启。
 * - 开发版（`app.isPackaged === false`）完全不碰 autoUpdater：它没有 app-update.yml，
 *   调了只会抛英文错误，界面统一显示「开发版不检查更新」。
 * - 失败不弹窗、不打断：只在设置页状态里写明原因，并留「打开发布页」的降级出口。
 */

/** 启动后多久做第一次静默检查（避开启动时的窗口/托盘初始化） */
const FIRST_CHECK_DELAY_MS = 60_000
/** 自动检查间隔 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** 降级出口：打不开更新器时让用户自己下 */
const RELEASE_PAGE = 'https://github.com/XC-Jack/lingdong-island/releases/latest'

let state: UpdateState = { stage: 'idle', current: '0.0.0' }
let checking = false
let firstCheckTimer: NodeJS.Timeout | null = null
let intervalTimer: NodeJS.Timeout | null = null
/** 系统通知必须留引用，否则会被 GC 提前回收导致 click 收不到 */
let updateNotification: Notification | null = null

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', state)
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, current: app.getVersion() }
  broadcast()
}

/** 把 electron-updater 的英文错误归成一句能看懂的话，原文留在 detail 里排查用 */
function describeError(raw: string): string {
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|timed? ?out/i.test(raw)) {
    return '连不上 GitHub，检查网络后重试'
  }
  if (/404|Cannot find latest\.yml|latest\.yml not found/i.test(raw)) {
    return '发布页缺少更新信息（latest.yml），需要重新发版'
  }
  if (/sha512|checksum/i.test(raw)) {
    return '下载校验失败，请重试'
  }
  return '检查更新失败'
}

function fail(e: unknown): void {
  const raw = e instanceof Error ? e.message : String(e)
  startupLog(`update: error ${raw}`)
  setState({ stage: 'error', message: describeError(raw), detail: raw })
}

/** 发现新版本时发一条系统通知；点了直接落到设置页「常规」 */
function notifyAvailable(version: string): void {
  if (!Notification.isSupported()) return
  updateNotification = new Notification({
    title: `灵动岛 ${version} 可以更新`,
    body: '点这里打开设置，确认后下载',
    silent: true
  })
  updateNotification.on('click', () => openSettings('general'))
  updateNotification.show()
}

async function check(): Promise<void> {
  if (!app.isPackaged) {
    setState({ stage: 'unsupported', message: '开发版不检查更新，安装版才会自动检查' })
    return
  }
  if (checking || state.stage === 'downloading') return
  checking = true
  setState({ stage: 'checking', message: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    fail(e)
  } finally {
    checking = false
  }
}

async function download(): Promise<void> {
  if (state.stage !== 'available' && state.stage !== 'error') return
  if (!state.version) return
  setState({ stage: 'downloading', percent: 0, message: undefined })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    fail(e)
  }
}

function install(): void {
  if (state.stage !== 'ready') return
  startupLog(`update: quitAndInstall ${state.version ?? ''}`)
  // 第一个 true = 静默安装（NSIS 带 /S），第二个 true = 装完自动拉起。
  // 数据在 %APPDATA%\lingdong-island，覆盖安装不动它。
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}

function attachEvents(): void {
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    startupLog(`update: available ${info.version}`)
    setState({
      stage: 'available',
      version: info.version,
      percent: undefined,
      checkedAt: Date.now(),
      message: undefined
    })
    notifyAvailable(info.version)
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    startupLog(`update: none (latest ${info.version})`)
    setState({
      stage: 'none',
      version: undefined,
      percent: undefined,
      checkedAt: Date.now(),
      message: undefined
    })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
    // 每 1% 才广播一次，避免高频 IPC 让设置页掉帧
    if (state.stage === 'downloading' && state.percent === percent) return
    setState({ stage: 'downloading', percent })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    startupLog(`update: downloaded ${info.version}`)
    setState({ stage: 'ready', version: info.version, percent: 100, message: undefined })
  })

  autoUpdater.on('error', (e: Error) => {
    fail(e)
  })
}

/** 注册 IPC 与定时检查，必须在 app.whenReady 后调用 */
export function setupUpdater(): void {
  state = { stage: 'idle', current: app.getVersion() }

  ipcMain.handle('update:get-state', (): UpdateState => state)
  ipcMain.handle('update:check', async (): Promise<UpdateState> => {
    await check()
    return state
  })
  ipcMain.handle('update:download', async (): Promise<UpdateState> => {
    await download()
    return state
  })
  ipcMain.handle('update:install', (): boolean => {
    install()
    return true
  })
  ipcMain.handle('update:open-page', async (): Promise<boolean> => {
    try {
      await shell.openExternal(RELEASE_PAGE)
      return true
    } catch (e) {
      fail(e)
      return false
    }
  })

  if (!app.isPackaged) {
    startupLog('update: dev mode, checks disabled')
    setState({ stage: 'unsupported', message: '开发版不检查更新，安装版才会自动检查' })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = {
    info: (...args: unknown[]) => startupLog(`[updater] ${args.join(' ')}`),
    warn: (...args: unknown[]) => startupLog(`[updater] warn ${args.join(' ')}`),
    error: (...args: unknown[]) => startupLog(`[updater] error ${args.join(' ')}`),
    debug: (...args: unknown[]) => startupLog(`[updater] debug ${args.join(' ')}`)
  }

  attachEvents()
  startupLog(`update: armed, version ${app.getVersion()}`)
  firstCheckTimer = setTimeout(() => {
    void check()
  }, FIRST_CHECK_DELAY_MS)
  intervalTimer = setInterval(() => {
    void check()
  }, CHECK_INTERVAL_MS)

  app.on('before-quit', () => {
    if (firstCheckTimer) clearTimeout(firstCheckTimer)
    if (intervalTimer) clearInterval(intervalTimer)
    firstCheckTimer = null
    intervalTimer = null
  })
}
