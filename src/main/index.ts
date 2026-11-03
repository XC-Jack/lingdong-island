import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import { setupTodoStore } from './todoStore'
import { setupStatus } from './statusStore'
import { setupShelfStore } from './shelfStore'

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

  // 拖文件进来时 Chromium 默认会导航到该文件——拦掉，交给渲染层 onDrop 处理
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  // 文件拖到收起态胶囊上：先放大成展开面板，让用户有地方松手
  ipcMain.on('island:drag-hover', () => {
    if (!expanded) animateTo(true)
  })

  // 点桌面/其他窗口（岛失焦）→ 自动收回。展开时点空白处同理
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('island:window-blur')
  })
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
  setupStatus()
  setupShelfStore()
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

// 打开置物架里的文件（用系统默认程序）
ipcMain.handle('shelf:open', async (_e, path: unknown) => {
  const p = String(path ?? '')
  if (!p) return 'empty path'
  const err = await shell.openPath(p)
  // 成功时 openPath 返回空字符串
  return err || 'ok'
})

// 在资源管理器里显示文件
ipcMain.handle('shelf:show-in-folder', (_e, path: unknown) => {
  const p = String(path ?? '')
  if (p) shell.showItemInFolder(p)
})

// ---------- 开机自启 ----------

// 查询当前开机自启状态
// 注意 1：get/set 必须传同样的 args——Electron 在 Windows 上按「exe 路径+启动参数」
// 匹配 HKCU\...\Run 里的值，参数不一致时 openAtLogin 永远读回 false（实测踩坑）。
// 注意 2：args 里必须带 app 路径 '.'。开发模式下 electron.exe 不带路径参数启动会弹
// Electron 默认欢迎页（用户开机时看到的蓝色 Atom 页面就是这个），灵动岛本体根本没起。
const AUTOSTART_ARGS = ['.', '--hidden']

ipcMain.handle('autostart:get', () => {
  return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin === true
})

// 设置/取消开机自启
ipcMain.handle('autostart:set', (_e, on: unknown) => {
  app.setLoginItemSettings({
    openAtLogin: on === true,
    // 自启时以隐藏方式拉起（窗口逻辑自己 ready-to-show showInactive）
    args: AUTOSTART_ARGS
  })
  return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin === true
})
