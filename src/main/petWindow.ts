import { BrowserWindow, Menu, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { clampPetPos, defaultPetPos, getPrefs, onPrefsWritten, patchPrefs } from './prefsStore'
import type { PetWindowPos } from '../shared/types'

/**
 * 桌宠独立小窗口（SPEC-deskpet-out）。
 *
 * 为什么单独开窗口而不是在岛里放大：岛是贴顶的透明条，展开上限 720×420，
 * 而且它永远贴在屏幕顶部中间——「把桌宠摆到桌面右下角」这件事它做不到。
 * 独立窗口才能自由摆放、记住位置、被用户拖来拖去。
 *
 * 生命周期：单例，跟着 `prefs.petMode` 走。
 * mode=window 就开着，其它值就关掉；用户在设置页改、或点宠物窗口右键「回到岛里」，
 * 都通过 `onPrefsWritten` 这条主进程内部通道统一收口，不会出现「窗口开着但偏好是 island」
 * 这种对不上的状态。
 */
const PET_WIN_W = 190
const PET_WIN_H = 190

let petWindow: BrowserWindow | null = null

/** 拖动中的定时器与起始状态（SPEC-deskpet-out 第三节：不用 -webkit-app-region） */
let dragTimer: NodeJS.Timeout | null = null
let dragOrigin: { cursor: PetWindowPos; win: PetWindowPos } | null = null

/** 退出应用的回调：菜单里的「退出灵动岛」要走 index.ts 的 quitApp（要先停各轮询） */
let quitHandler: (() => void) | null = null

function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  dragOrigin = null
}

/**
 * 松手后落盘位置（SPEC-deskpet-out 第五节第 7 条）。
 *
 * 为什么落盘在 `petDragEnd` 而不是拖动过程中：拖动每 16ms 动一次，
 * 每次写盘就是每 16ms 一次磁盘写 + 一次跨窗口广播，纯属浪费。
 * 松手那一下才是用户认可的最终位置。
 */
function savePos(pos: PetWindowPos): void {
  patchPrefs({ petWindowPos: pos })
}

function createPetWindow(): BrowserWindow {
  const prefs = getPrefs()
  const pos: PetWindowPos = prefs.petWindowPos
    ? clampPetPos(prefs.petWindowPos, PET_WIN_W, PET_WIN_H)
    : defaultPetPos(PET_WIN_W, PET_WIN_H)

  const win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: PET_WIN_W,
    height: PET_WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    // 关键：movable 保持 true，主进程 setPosition 才生效；
    // 但用户拖不动它——因为系统标题栏不存在，拖动全靠我们自己算（见 petDragStart）。
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 和岛一样不在任务栏占位：它是一只宠物，不是一个「应用窗口」
    skipTaskbar: true,
    // 不抢焦点：出现时不该把用户正在打字的窗口切走
    focusable: true,
    show: false,
    title: '灵动岛桌宠',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 与岛同级别：浮在普通窗口之上（'screen-saver' 是 Electron 里最高的常规层级）
  win.setAlwaysOnTop(true, 'screen-saver')

  // 拖文件进来时 Chromium 默认会导航走——拦掉（宠物窗口不接文件，但别让页面被替换）
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.once('ready-to-show', () => {
    // showInactive：出现但不抢焦点（SPEC 第三节第 9 条）
    win.showInactive()
  })

  win.on('closed', () => {
    stopDrag()
    petWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/pet.html'))
  }

  return win
}

/** 打开宠物窗口（已开着就只把它提到前面，不重复建） */
export function openPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.showInactive()
    return
  }
  petWindow = createPetWindow()
}

/** 关闭宠物窗口（切回「只在岛里」或退出应用时调） */
export function closePetWindow(): void {
  stopDrag()
  if (petWindow && !petWindow.isDestroyed()) petWindow.close()
  petWindow = null
}

/** 宠物窗口是否开着（e2e 与主进程内部判断用） */
export function isPetOpen(): boolean {
  return petWindow !== null && !petWindow.isDestroyed()
}

/**
 * 按当前 `petMode` 同步宠物窗口的存在（SPEC-deskpet-out 第三节第 2、3、8 条）。
 *
 * 只认 `window`：`free`（自由走动）还没做，落盘了也不该开窗——
 * 否则用户手改 prefs.json 成 free，会得到一个「开着的独立窗口但岛里也有桌宠」的怪状态。
 */
export function syncPetWindow(): void {
  const mode = getPrefs().petMode ?? 'island'
  if (mode === 'window') {
    openPetWindow()
  } else {
    closePetWindow()
  }
}

/** 注册宠物窗口相关的 IPC 与偏好订阅，必须在 app.whenReady 后调用 */
export function setupPetWindow(opts: { onQuit: () => void }): void {
  quitHandler = opts.onQuit

  // ---- 拖动（SPEC 第四节：渲染层 pointerdown → 主进程跟光标 → pointerup 停）----
  ipcMain.on('pet:drag-start', () => {
    const win = petWindow
    if (!win || win.isDestroyed()) return
    stopDrag()
    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()
    dragOrigin = { cursor, win: { x: b.x, y: b.y } }
    dragTimer = setInterval(() => {
      const w = petWindow
      if (!w || w.isDestroyed() || !dragOrigin) {
        stopDrag()
        return
      }
      const now = screen.getCursorScreenPoint()
      const nx = dragOrigin.win.x + (now.x - dragOrigin.cursor.x)
      const ny = dragOrigin.win.y + (now.y - dragOrigin.cursor.y)
      const clamped = clampPetPos({ x: nx, y: ny }, PET_WIN_W, PET_WIN_H)
      w.setPosition(clamped.x, clamped.y)
    }, 16)
  })

  ipcMain.on('pet:drag-end', () => {
    const win = petWindow
    stopDrag()
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    savePos({ x: b.x, y: b.y })
  })

  // ---- 右键菜单 ----
  ipcMain.on('pet:show-menu', () => {
    const win = petWindow
    if (!win || win.isDestroyed()) return
    Menu.buildFromTemplate([
      { label: '回到岛里', click: () => patchPrefs({ petMode: 'island' }) },
      { type: 'separator' },
      { label: '退出灵动岛', click: () => quitHandler?.() }
    ]).popup({ window: win })
  })

  // 偏好变化 → 窗口开关跟着走。
  // 用主进程内部的 onPrefsWritten 而不是 IPC：设置窗口改完 petMode 后，
  // prefs:set 那条路只广播给渲染层，主进程这边听不到，窗口就不会跟着开/关。
  onPrefsWritten(() => {
    syncPetWindow()
  })
}
