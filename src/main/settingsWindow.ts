import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AppInfo, SettingsSection } from '../shared/types'
import { SETTINGS_SECTIONS } from '../shared/types'

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
/* 可缩放后的最小尺寸：再小左侧导航和右侧清单就挤在一起了 */
const SETTINGS_MIN_W = 760
const SETTINGS_MIN_H = 520

let settingsWindow: BrowserWindow | null = null

/** 待送达的分区：窗口还没加载完时先存着，did-finish-load 后再发 */
let pendingSection: SettingsSection | null = null

function isValidSection(v: unknown): v is SettingsSection {
  // 用 shared 里的清单判断，避免每加一个分区就要在两处各补一次
  return typeof v === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(v)
}

/** 「关于」页的仓库地址：固定在主进程，渲染层只能请求打开这一个地址 */
const GITHUB_REPO_URL = 'https://github.com/XC-Jack/lingdong-island'

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
    // 默认 880×580；用户可以拉伸、最大化和最小化（2026-11-20 用户要求）
    resizable: true,
    maximizable: true,
    minWidth: SETTINGS_MIN_W,
    minHeight: SETTINGS_MIN_H,
    fullscreenable: false,
    // 设置窗口要在任务栏有存在感，用户才能切回来（岛是 skipTaskbar 的）
    skipTaskbar: false,
    show: false,
    title: '灵动岛设置',
    // 任务栏图标：设置窗口是唯一 skipTaskbar:false 的窗口，不显式给 icon 时
    // Windows 任务栏显示的是 Electron 默认原子图标。.ico 必须同时打进 build.files。
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  /*
   * 设置页按 880×580 固定排版：锁死页面缩放。
   * 2026-11-19 用户实测遇到整页被横向/纵向带偏（左侧导航与标题栏跑到窗口外），
   * 重新打开设置后恢复；页面缩放后会同时产生溢出和滚动锚点位移，是最可能的入口，
   * 所以直接不允许缩放（Ctrl+滚轮、触控板捏合都走这里）。
   */
  void win.webContents.setVisualZoomLevelLimits(1, 1)
  win.webContents.on('zoom-changed', () => {
    win.webContents.setZoomFactor(1)
  })
  win.webContents.setZoomFactor(1)

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

  // 最大化状态变化时通知标题栏换图标（最大化 / 还原）
  const sendMaximized = (value: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('settings:maximized', value)
  }
  win.on('maximize', () => sendMaximized(true))
  win.on('unmaximize', () => sendMaximized(false))

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

  ipcMain.on('settings:minimize', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.minimize()
  })

  ipcMain.on('settings:toggle-maximize', () => {
    const win = settingsWindow
    if (!win || win.isDestroyed()) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle('settings:is-maximized', () => {
    return Boolean(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isMaximized())
  })

  ipcMain.handle('settings:app-info', (): AppInfo => {
    return { version: app.getVersion(), userData: app.getPath('userData') }
  })

  ipcMain.handle('settings:open-user-data', async (): Promise<boolean> => {
    const err = await shell.openPath(app.getPath('userData'))
    return err === ''
  })

  ipcMain.handle('settings:open-github', async (): Promise<boolean> => {
    await shell.openExternal(GITHUB_REPO_URL)
    return true
  })
}
