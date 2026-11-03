import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { setupTodoStore } from './todoStore'

/** 收起态尺寸（CSS 逻辑像素） */
const COLLAPSED = { width: 240, height: 42 }
/** 展开态尺寸（CSS 逻辑像素） */
const EXPANDED = { width: 720, height: 300 }
/** 距屏幕顶部的缝隙 */
const TOP_GAP = 6
/** 过渡动画时长（毫秒） */
const TWEEN_MS = 220

let mainWindow: BrowserWindow | null = null
let expanded = false
let tweenTimer: NodeJS.Timeout | null = null

/** 按主显示器工作区算出窗口矩形，水平居中、贴顶 */
function computeBounds(isExpanded: boolean): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const size = isExpanded ? EXPANDED : COLLAPSED
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: workArea.y + TOP_GAP,
    width: size.width,
    height: size.height
  }
}

/** 缓动到目标矩形。Windows 不支持原生窗口动画，这里手动补间 */
function animateTo(isExpanded: boolean): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return

  if (tweenTimer) {
    clearInterval(tweenTimer)
    tweenTimer = null
  }

  expanded = isExpanded
  const from = win.getBounds()
  const to = computeBounds(isExpanded)
  const start = Date.now()

  tweenTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (tweenTimer) clearInterval(tweenTimer)
      tweenTimer = null
      return
    }

    const t = Math.min(1, (Date.now() - start) / TWEEN_MS)
    // easeOutCubic
    const e = 1 - Math.pow(1 - t, 3)

    mainWindow.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.round(from.width + (to.width - from.width) * e),
      height: Math.round(from.height + (to.height - from.height) * e)
    })

    if (t >= 1) {
      if (tweenTimer) clearInterval(tweenTimer)
      tweenTimer = null
      mainWindow?.setBounds(to)
    }
  }, 8)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...computeBounds(false),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 浮在所有普通窗口之上，但仍可被用户切走
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  // 注意：不开整窗穿透。收起态窗口仅 240×42，几乎全是胶囊本体；
  // Electron 的 setIgnoreMouseEvents(forward:true) 会让整个窗口（含胶囊）收不到点击，
  // 实测导致收起态点不开。若以后要精修四角，用原生 WS_EX_TRANSPARENT 分区域方案。

  mainWindow.on('ready-to-show', () => {
    mainWindow?.showInactive()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  setupTodoStore()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// 渲染进程请求改变展开状态
ipcMain.on('island:set-expanded', (_event, value: boolean) => {
  if (value === expanded) return
  animateTo(value)
})
