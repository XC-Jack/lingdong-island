import { app, BrowserWindow, ipcMain, net, Notification, powerMonitor, shell } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
/**
 * 周期检查（2026-11-19 用户定 4 小时）。
 * 岛通常长期挂在托盘里、用睡眠代替关机，只在启动时查一次会让更新永远查不到
 * （0.1.13 → 0.1.14 用户反馈「基本没有弹过更新」）。
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** 系统从睡眠唤醒后多久补查（合盖睡眠不会触发进程重启，只能靠事件补） */
const RESUME_CHECK_DELAY_MS = 30_000
/** 单次检查失败后的重试间隔；两次都不行就等下一个 4 小时周期 */
const RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000]
/** 降级出口：打不开更新器时让用户自己下 */
const RELEASE_PAGE = 'https://github.com/XC-Jack/lingdong-island/releases/latest'
/** 指定版本安装包的 GitHub 直链（文件名规则由 build.artifactName 固定） */
const ASSET_URL = (version: string): string =>
  `https://github.com/XC-Jack/lingdong-island/releases/download/v${version}/Lingdong-Island-Setup-${version}.exe`
/**
 * 已提示过的版本与日期（2026-11-19 起按天去重）。
 * 原来只记版本、一个版本永远只提示一次：toast 被专注助手拦掉或人不在电脑前，
 * 这个版本就再也不会提示。现在同一版本每天最多一次，跨天仍未更新会再提示。
 */
const NOTIFY_STATE_FILE = 'update-notified.json'

let state: UpdateState = { stage: 'idle', current: '0.0.0' }
let checking = false
let firstCheckTimer: NodeJS.Timeout | null = null
let intervalTimer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
let resumeTimer: NodeJS.Timeout | null = null
/** 已排过的重试次数（对应 RETRY_DELAYS_MS 下标） */
let retryIndex = 0
/** 系统通知必须留引用，否则会被 GC 提前回收导致 click 收不到 */
let updateNotification: Notification | null = null
/** 当前下载的取消令牌；暂停/取消都靠它打断 electron-updater */
let activeToken: CancellationToken | null = null
/** 用户主动打断下载时记录意图，区分「暂停」和「取消」的收尾状态 */
let cancelMode: 'pause' | 'cancel' | null = null

/**
 * electron-updater 的下载临时目录。
 * 路径规则见其 AppAdapter.getAppCacheDir：Windows 是 %LOCALAPPDATA%\<app.name>-updater，
 * 半截文件在 pending\temp-*.exe；取消时 electron-updater 只清理最终文件、不清临时文件，
 * 所以这里自己删，保证用户说的「取消之后没有残留」。
 */
function updateCacheDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, `${app.name}-updater`)
}

function pendingDownloadDir(): string {
  return join(updateCacheDir(), 'pending')
}

function clearPendingDownload(): void {
  try {
    rmSync(pendingDownloadDir(), { recursive: true, force: true })
    startupLog('update: pending download cleared')
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    startupLog(`update: clear pending failed ${raw}`)
  }
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readNotifyMark(): { version: string; date: string } {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), NOTIFY_STATE_FILE), 'utf8'))
    return {
      version: typeof raw?.version === 'string' ? raw.version : '',
      date: typeof raw?.date === 'string' ? raw.date : ''
    }
  } catch {
    return { version: '', date: '' }
  }
}

/** 今天是否已经为这个版本提示过 */
function notifiedToday(version: string): boolean {
  const mark = readNotifyMark()
  return mark.version === version && mark.date === todayKey()
}

function markNotified(version: string): void {
  try {
    writeFileSync(
      join(app.getPath('userData'), NOTIFY_STATE_FILE),
      JSON.stringify({ version, date: todayKey() }),
      'utf8'
    )
  } catch {
    /* 写不了就下次再提示，不影响更新本身 */
  }
}

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
/**
 * checkForUpdates 自身没有超时：没开加速器时 GitHub 的 TCP 连接会被黑洞吞掉，
 * 状态会永远停在「检查中…」（2026-11-19 用户实测截图）。25 秒没结果就按失败处理。
 */
const CHECK_TIMEOUT_MS = 25_000

function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

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
  setState({ stage: 'error', message: describeError(raw), detail: raw, checkedAt: Date.now() })
}

function clearRetryTimer(): void {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
}

/** 检查成功后清零，重新开始记失败次数 */
function resetRetry(): void {
  clearRetryTimer()
  retryIndex = 0
}

/** 失败后按 10 分钟 → 30 分钟重试；两次用完就交给 4 小时周期 */
function scheduleRetry(): void {
  if (retryTimer !== null || retryIndex >= RETRY_DELAYS_MS.length) return
  const delay = RETRY_DELAYS_MS[retryIndex]
  retryIndex += 1
  startupLog(`update: retry in ${Math.round(delay / 60000)} min`)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void check()
  }, delay)
}

/** 通知渲染层弹岛内横幅（收起态）；设置窗口也收得到，但它没有对应处理，忽略即可 */
function announceAvailable(version: string): void {
  const wins = BrowserWindow.getAllWindows()
  startupLog(`update: announce ${version} to ${wins.length} window(s)`)
  for (const win of wins) {
    if (!win.isDestroyed()) win.webContents.send('update:announce', version)
  }
}

/**
 * 发现新版本时提示：岛内横幅 + 系统通知。
 * 同一版本每天最多提示一次（记在 userData\update-notified.json 的 version + date），
 * 跨天仍未更新会再提示；系统通知不支持时横幅仍然弹。
 */
function notifyAvailable(version: string): void {
  if (notifiedToday(version)) {
    startupLog(`update: already notified ${version} today, skip`)
    return
  }
  markNotified(version)
  announceAvailable(version)
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
  if (
    checking ||
    state.stage === 'downloading' ||
    state.stage === 'paused' ||
    state.stage === 'ready'
  ) {
    return
  }
  // 没网就直接跳过，不写「检查失败」——用户 2026-11-18 要求连不上时安静；
  // 也不排重试，等下一个 4 小时周期或唤醒补查。
  if (!net.isOnline()) {
    startupLog('update: offline, skip check')
    if (state.stage !== 'none') setState({ stage: 'error', message: '当前没有网络，未检查更新' })
    return
  }
  checking = true
  setState({ stage: 'checking', message: undefined })
  try {
    // 消息里带 ETIMEDOUT，走 describeError 的「连不上 GitHub」文案
    await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS, 'ETIMEDOUT: 检查更新超过 25 秒无响应')
    resetRetry()
  } catch (e) {
    fail(e)
    scheduleRetry()
  } finally {
    checking = false
  }
}

async function download(): Promise<void> {
  if (state.stage !== 'available' && state.stage !== 'error' && state.stage !== 'paused') return
  // 上一笔下载还在收尾（刚点过取消/暂停）：electron-updater 的 downloadPromise 未清空前
  // 再调 downloadUpdate 会复用旧 Promise，直接忽略这次点击
  if (activeToken !== null) {
    startupLog('update: previous download still stopping, ignore')
    return
  }
  if (!state.version) return
  const version = state.version
  const token = new CancellationToken()
  activeToken = token
  cancelMode = null
  /*
   * 差分下载需要缓存里的上一版 installer.exe 才能拼出新安装包。
   * 没有它时 electron-updater 仍会先拉两份 .blockmap（国内网络经常卡几十秒到几分钟），
   * 再以 ENOENT 失败回退全量——纯浪费。手动安装/首次使用的机器都没有这个文件，
   * 所以先判断，缺了就直接全量。
   */
  const canDifferential = existsSync(join(updateCacheDir(), 'installer.exe'))
  autoUpdater.disableDifferentialDownload = !canDifferential
  startupLog(`update: download ${version} (${canDifferential ? 'differential' : 'full, no cached installer'})`)
  setState({ stage: 'downloading', percent: 0, message: undefined })
  try {
    await autoUpdater.downloadUpdate(token)
  } catch (e) {
    // 取消不会派发 error 事件，只在 downloadUpdate 的 Promise 上以 CancellationError 结束
    if (token.cancelled) {
      if (cancelMode === 'pause') {
        startupLog(`update: download paused at ${state.percent ?? 0}%`)
        clearPendingDownload()
        setState({ stage: 'paused', version, message: '已暂停，继续会从头下载' })
      } else if (cancelMode === 'cancel') {
        startupLog('update: download cancelled by user')
        clearPendingDownload()
        setState({ stage: 'available', version, percent: undefined, message: undefined })
      } else {
        // 非用户操作（如退出前清理）打断：回到可下载状态
        setState({ stage: 'available', version, percent: undefined, message: undefined })
      }
      return
    }
    fail(e)
    clearPendingDownload()
  } finally {
    if (activeToken === token) activeToken = null
    cancelMode = null
  }
}

/** 暂停下载：取消当前传输并清掉临时文件，状态停在 paused，之后可重新下载 */
function pauseDownload(): void {
  if (state.stage !== 'downloading' || activeToken === null || cancelMode !== null) return
  cancelMode = 'pause'
  activeToken.cancel()
}

/**
 * 取消下载：回到「发现新版本、可下载」状态，不留半截文件。
 * 下载中只发取消信号，状态等 download() 的 catch 收尾后统一落回 available——
 * 提前放回 available 会让用户能立刻再点下载，撞上尚未结束的旧任务。
 */
function cancelDownload(): void {
  if (state.stage !== 'downloading' && state.stage !== 'paused') return
  if (cancelMode === 'cancel') return
  const version = state.version
  if (state.stage === 'paused' || activeToken === null) {
    clearPendingDownload()
    setState({ stage: 'available', version, percent: undefined, message: undefined })
    startupLog('update: download cancelled from paused')
    return
  }
  cancelMode = 'cancel'
  startupLog('update: cancelling download')
  activeToken.cancel()
}

/** 直接下载：用系统浏览器打开发布资产，绕开应用内下载慢的问题 */
async function openDownload(): Promise<boolean> {
  const version = state.version
  try {
    await shell.openExternal(version ? ASSET_URL(version) : RELEASE_PAGE)
    startupLog(`update: open download ${version || 'release page'}`)
    return true
  } catch (e) {
    fail(e)
    return false
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
    resetRetry()
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
    resetRetry()
    setState({
      stage: 'none',
      version: undefined,
      percent: undefined,
      checkedAt: Date.now(),
      message: undefined
    })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    // 用户已点暂停/取消、收尾还没完成时，迟到的进度包不能把状态翻回 downloading
    if (cancelMode !== null) return
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
  ipcMain.handle('update:pause', (): UpdateState => {
    pauseDownload()
    return state
  })
  ipcMain.handle('update:cancel', (): UpdateState => {
    cancelDownload()
    return state
  })
  ipcMain.handle('update:open-download', async (): Promise<boolean> => await openDownload())
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
  // 启动查一次 + 每 4 小时一次（2026-11-19 用户定）。
  // 岛通常长期不重启，只在启动查一次会让新版本永远发现不了。
  firstCheckTimer = setTimeout(() => {
    void check()
  }, FIRST_CHECK_DELAY_MS)
  intervalTimer = setInterval(() => {
    void check()
  }, CHECK_INTERVAL_MS)
  startupLog(`update: periodic check every ${CHECK_INTERVAL_MS / 3600000} h`)
  // 笔记本合盖睡眠不会重启进程，唤醒后补查一次，避免「睡了一周回来还是旧版本」。
  powerMonitor.on('resume', () => {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      startupLog('update: check after resume')
      void check()
    }, RESUME_CHECK_DELAY_MS)
  })

  app.on('before-quit', () => {
    if (firstCheckTimer) clearTimeout(firstCheckTimer)
    if (intervalTimer) clearInterval(intervalTimer)
    if (resumeTimer) clearTimeout(resumeTimer)
    clearRetryTimer()
    firstCheckTimer = null
    intervalTimer = null
    resumeTimer = null
  })
}
