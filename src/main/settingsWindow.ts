import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AppInfo, SettingsSection } from '../shared/types'

/**
 * 独立设置窗口（SPEC-settings-shell）。
 *
 * 为什么单独开窗口而不是塞进岛里：岛是贴顶的透明无边框小窗（宽高上限 720×420），
 * 左导航 + 多分区的内容放不下；设置是「偶尔打开、看完就关」的界面，形态本来就该是普通窗口。
 *
 * 生命周期：单例。已存在就 focus 并切分区，不存在才新建；用户点 × 只是销毁这个窗口，
 * 岛和主进程继续跑（与岛的「退出」是两件事）。
 */
const SETTINGS_W = 880
const SETTINGS_H = 580

let settingsWindow: BrowserWindow | null = null

/** 待送达的分区：窗口还没加载完时先存着，did-finish-load 后再发 */
let pendingSection: SettingsSection | null = null

function isValidSection(v: unknown): v is SettingsSection {
  return v === 'general' || v === 'pages' || v === 'focus' || v === 'pet'
}

/** 主进程告诉设置窗口切到哪个分区（导航点击是渲染层自己切的，这里只处理菜单直达） */
function sendSection(win: BrowserWindow, section: SettingsSection): void {
  if (win.isDestroyed()) return
  if (win.webContents.isLoading()) {
    pendingSection = section
    return
  }
  win.webContents.send('settings:section', section)
}

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: SETTINGS_W,
    height: SETTINGS_H,
    // 设置窗口是不透明深色卡片，不需要透明窗口那套 per-pixel 命中测试
    transparent: false,
    backgroundColor: '#131417',
    frame: false,
    // 固定大小：内容按 880×580 排版，可缩放反而会出现难看的留白
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // 设置窗口要在任务栏有存在感，用户才能切回来（岛是 skipTaskbar 的）
    skipTaskbar: false,
    show: false,
    title: '灵动岛设置',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.webContents.on('did-finish-load', () => {
    if (pendingSection !== null) {
      const s = pendingSection
      pendingSection = null
      win.webContents.send('settings:section', s)
    }
  })

  win.on('closed', () => {
    settingsWindow = null
    pendingSection = null
  })

  return win
}

/**
 * 打开设置窗口（菜单「设置…」/「页面管理…」共用）。
 * 已经开着就不再新建：focus 已有窗口并把分区切过去，避免叠出多个设置窗。
 */
export function openSettings(section: SettingsSection): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    sendSection(settingsWindow, section)
    return
  }
  // 先记分区、再建窗口：createSettingsWindow() 里会 loadURL/loadFile，页面可能极快
  // 触发 did-finish-load，反过来写的话那一次补发就丢（靠「加载是异步的」这种时序运气
  // 不算保证，独立验收 B 项点名过）。
  pendingSection = section
  settingsWindow = createSettingsWindow()
}

/** 设置窗口是否开着（e2e 与主进程内部判断用） */
export function isSettingsOpen(): boolean {
  return settingsWindow !== null && !settingsWindow.isDestroyed()
}

/** 关闭设置窗口（渲染层标题栏 × 调这里，而不是 window.close()，保证状态清理一致） */
function closeSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
}

/** 注册设置窗口相关的 IPC，必须在 app.whenReady 后调用 */
export function setupSettingsWindow(): void {
  ipcMain.handle('settings:open', (_e, section: unknown) => {
    openSettings(isValidSection(section) ? section : 'general')
    return true
  })

  ipcMain.on('settings:close', () => {
    closeSettings()
  })

  ipcMain.handle('settings:app-info', (): AppInfo => {
    return { version: app.getVersion(), userData: app.getPath('userData') }
  })

  ipcMain.handle('settings:open-user-data', async (): Promise<boolean> => {
    const err = await shell.openPath(app.getPath('userData'))
    return err === ''
  })
}
