import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { initFullscreenWatch, stopFullscreenWatch } from './fullscreenWatch'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { setupTodoStore } from './todoStore'
import { setupStatus, stopStatus } from './statusStore'
import { setupShelfStore } from './shelfStore'
import { setupNotifyStore, stopNotifyStore } from './notifyStore'
import { setupScheduleStore, stopScheduleStore } from './scheduleStore'
import { setupExportStore } from './exportStore'
import { setupPrefsStore, getPrefs, patchPrefs } from './prefsStore'
import { setupMusicStore, stopMusicStore } from './musicStore'
import { openSettings, setupSettingsWindow } from './settingsWindow'
import { closePetWindow, setupPetWindow, syncPetWindow } from './petWindow'
import { initClipboardWatch } from './clipboardStore'
import { setIslandWindow } from './islandWindowRef'
import { setupLocalFileProtocol } from './localFileProtocol'
import type { ShelfOpenResult, ShelfRevealResult } from '../shared/types'

/**
 * 收起态窗口总高：胶囊 52（渲染层 .island.collapsed 的固定高）+ 下方横幅预留区 24。
 * 2026-11-16 用户 m01634 两轮要求胶囊「大一点」「还可以再大一点」，渲染层从 42 改到 52，
 * 这里同步 66→76（预留区仍够放横幅：.collapsed-banner 的 top:56px 布局 px）。
 *
 * 横幅（新消息到岛提示）显示在胶囊正下方的预留区，平时空置为透明。
 * 为什么常驻而不是横幅期临时加高：动态 setBounds 加高后，透明窗口新区域在 Windows 上
 * 可能不被合成器画出（实机截屏五轮验证：横幅 DOM/窗口尺寸全对但屏幕无像素）。
 * 常驻透明区靠 Windows 透明窗口 per-pixel 命中测试：透明像素点击自动穿透到下层窗口。
 */
const COLLAPSED_WIN_HEIGHT = 76
/** 收起态宽度上下限（防过窄/过宽）。2026-11-16 用户 m01634 胶囊放大后同步放宽 113~240 → 134~290 */
const COLLAPSED_MIN_W = 134
const COLLAPSED_MAX_W = 290
/** 收起态当前宽度（渲染层量出来的，默认值给个合理初始） */
let collapsedWidth = 168
/** 展开态尺寸（CSS 逻辑像素）：由渲染层按当前页内容量量出后经 IPC 下发，这里只存 */
// 展开态尺寸（2026-11-16 起改为「随内容自适应 + 有上限」，用户 m00791/m00795）：
// 1) SPEC-island-compact 把整岛按 zoom 0.75 缩小，所以上限从 {720,420} 收到 {540,315}；
// 2) 2026-11-11 曾按用户当次要求把各页改成固定尺寸（styles.css 写死 470×320 布局 px，
//    0.75 缩放后 ≈ 353×240 视觉 px）。2026-11-16 用户看到「下面的空间就是一块黑布」，
//    明确要求改成随内容伸缩、有最大范围、到上限后靠滚轮查看，遂推翻固定尺寸：
//    styles.css 的 .island.expanded 改成 width/height:max-content + min/max 上下限。
//    布局 340~720 × 150~420 与这里 0.75 缩放后的 {255,113}~{540,315} 一一对应，
//    改一边必须同步改另一边。（宽度下限 2026-11-16 晚由 300 抬到 340：头部状态区放大后
//    居中会压到左侧标题，e2e-head-order 的 H5a 报 overlapTitle=true。）
const EXPANDED_MIN = { width: 255, height: 113 }
const EXPANDED_MAX = { width: 540, height: 315 }
/** 展开态当前尺寸（渲染层量出来的；初始值只用于首帧开窗，随后被 ResizeObserver 纠正） */
let expandedSize = { width: 353, height: 240 }
/** 距屏幕顶部的缝隙 */
const TOP_GAP = 6
/** 过渡动画时长（毫秒）。用户实测 220ms 太急，调到 500ms（US-038 验收反馈，用户嫌 320 仍快） */
const TWEEN_MS = 500

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = false
let tweenTimer: NodeJS.Timeout | null = null
/** US-041 手动隐藏标志（菜单文案切换用；真实状态机在 fullscreenWatch.ts） */
let manualHide = false

/**
 * 真正退出应用（US-034）。
 * 顺序很重要：先停各轮询（通知 30s、日程提醒 60s、音乐 1s）与常驻子进程，再 app.quit()。
 * 不先停的话，退出瞬间可能正好轮询到一条到点提醒，弹出一个「点不回去」的通知；
 * 音乐那条常驻 PowerShell 也会变成孤儿进程留在后台。
 */
function quitApp(): void {
  stopStatus()
  stopNotifyStore()
  stopScheduleStore()
  stopMusicStore()
  stopFullscreenWatch()
  // 宠物窗口是独立窗口（SPEC-deskpet-out）：不主动关它的话，它会拖住
  // window-all-closed 的判定，退出会卡在半路。先关掉再 quit。
  closePetWindow()
  app.quit()
}

/**
 * 岛内右键 / 托盘右键共用的菜单。设置（SPEC-settings-shell）+ 手动隐藏（US-041）+ 退出。
 * 导出数据（US-029）2026-11-11 起搬到设置窗口「常规 → 导出数据」，这里不再提供入口。
 *
 * 2026-11-12 加「桌宠出岛 / 收回岛里」（SPEC-deskpet-out）：
 * 用户原话「给右键添加一个出岛，不然每次都要点设置」。
 * 按当前 `petMode` 显示两项之一——已经出去了就显示「收回」，
 * 一个开关比一次点击更省事，也不用去菜单里找哪个是当前状态。
 * 2026-11-14（SPEC-deskpet-walk）：free 也是「出去了」，一样显示收回。
 */
function buildAppMenu(): Menu {
  // US-041：手动隐藏后岛不可见，菜单只在托盘右键可达——此时显示「显示灵动岛」
  const hiddenByUser = manualHide
  // 只有 window / free 才算「出去了」。不能写成 !== 'island'：
  // 老用户 prefs 里没有 petMode（undefined）时那会误判成已出岛，显示「收回」。
  const pm = getPrefs().petMode
  const petOut = pm === 'window' || pm === 'free'
  return Menu.buildFromTemplate([
    { label: '设置…', click: () => openSettings('general') },
    { label: '页面管理…', click: () => openSettings('pages') },
    { type: 'separator' },
    // 切 petMode 就够：petWindow.ts 里的 onPrefsWritten 会去开/关窗口，
    // 岛里的岛仔由 App.tsx 跟随 petMode 自行隐藏。这里不直接调 openPetWindow，
    // 是因为「偏好」才是唯一事实来源，绕过它会出现「窗口开了但偏好还是 island」。
    petOut
      ? {
          label: '让桌宠回到岛里',
          click: () => {
            patchPrefs({ petMode: 'island' })
          }
        }
      : {
          label: '让桌宠出岛…',
          click: () => {
            patchPrefs({ petMode: 'window' })
          }
        },
    { type: 'separator' },
    hiddenByUser
      ? { label: '显示灵动岛', click: () => mainWindow?.webContents.send('noop') /* 占位 */ }
      : { label: '暂时隐藏灵动岛', click: () => mainWindow?.webContents.send('island:avoid-do-hide') },
    { type: 'separator' },
    { label: '退出灵动岛', click: () => quitApp() }
  ])
}

/**
 * 托盘图标（US-034）。窗口是 skipTaskbar: true，任务栏看不到它，
 * 托盘是用户找回岛和退出应用的入口。
 * 图标按 32×32 缩放到通知区域合适大小；拿不到图片时不建托盘（不阻塞启动）。
 */
function createTray(): void {
  if (tray) return
  // 开发版 __dirname = out/main → 上两级是项目根；打包版在 app.asar 内，
  // 所以 package.json 的 build.files 必须带上 build/icon.png（否则这里取不到）。
  const iconPath = join(__dirname, '..', '..', 'build', 'icon.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    console.warn('[tray] 托盘图标读取失败，跳过托盘：', iconPath)
    return
  }
  image = image.resize({ width: 32, height: 32 })
  tray = new Tray(image)
  tray.setToolTip('灵动岛')
  tray.setContextMenu(buildAppMenu())
  // 左键单击：把岛显示出来（切屏/被别的窗口挡住时的找回路径；
  // US-041 手动隐藏时也是找回入口，清手动标志）
  tray.on('click', () => {
    if (manualHide) {
      manualHide = false
      mainWindow?.webContents.send('island:manual-restore')
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    mainWindow.showInactive()
  })
}

/** 按主显示器工作区算出窗口矩形，水平居中、贴顶 */
function computeBounds(isExpanded: boolean): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const size = isExpanded
    ? expandedSize
    : { width: collapsedWidth, height: COLLAPSED_WIN_HEIGHT }
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
    // 任务栏/Alt+Tab 里显示的应用图标（开发版用源文件；打包版由 exe 图标接管）
    icon: join(__dirname, '../../build/icon.ico'),
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
    // US-036 诊断探针：记录 blur 时刻，配合渲染层日志区分「真点桌面」与「IME 瞬时失焦」
    appendDiagLog(`main window blur; focused-after=${mainWindow?.isFocused() ?? 'no-win'}`)
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
    // 登记处也要清：关掉的窗口引用留着，sendToIsland 会一直往死窗口发
    setIslandWindow(null)
  })

  // 登记给 notifyStore / clipboardStore 用（它们以前用 getAllWindows()[0]，
  // 桌宠出岛后 [0] 变成宠物窗口，横幅全发给了一个不监听该事件的窗口）。
  setIslandWindow(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 通知归属（US-029 反馈修复）：Windows 上不设 AppUserModelId，系统通知可能
  // 归不到本应用而不弹出。id 必须与打包配置的 appId 一致才能对上快捷方式。
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.xcjack.lingdong-island')
  }
  // 本地图片自定义协议（2026-11-12）：开发预览版的页面源是 http://localhost:5173，
  // 从 http 源引用 file:// 本地图片会被 Chromium 拦掉，通知横幅/置物架图标全变空白。
  // 注册成 ldapp:// 就能跨源加载（协议特权已在模块顶层登记）。
  setupLocalFileProtocol()
  setupTodoStore()
  setupStatus()
  setupShelfStore()
  setupNotifyStore()
  setupScheduleStore()
  setupExportStore()
  setupPrefsStore()
  setupMusicStore()
  setupSettingsWindow()
  // 桌宠独立小窗口（SPEC-deskpet-out）：注册 IPC + 订阅偏好变化。
  // 必须在 createWindow 之前——偏好里可能已经是 window 模式，启动时就该把它开出来。
  setupPetWindow({ onQuit: () => quitApp() })
  initClipboardWatch()
  createWindow()
  // 按当前 petMode 决定要不要把桌宠放出去（偏好缺失时是 island，这里什么都不做）
  syncPetWindow()
  createTray()
  // US-041 全屏自动避让：检测子进程 + 状态机 + 感应窗
  initFullscreenWatch(
    () => mainWindow,
    (hidden) => {
      // 状态落地时同步菜单用的标志（自动避让不改 manualHide；仅渲染层菜单发起的手动隐藏改）
      if (!hidden) manualHide = false
      mainWindow?.webContents.send('island:avoid-changed', hidden)
    }
  )
  // 渲染层菜单发起的手动隐藏：置标志再走状态机（真正 hide 在 fullscreenWatch）
  ipcMain.on('island:manual-hide', () => {
    manualHide = true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 设置窗口是独立窗口（SPEC-settings-shell）：关掉它不能等于退出应用。
  // 岛上窗口（mainWindow）还在时不算「全部窗口关闭」；这里额外兜一层，
  // 用户手动关掉设置窗后岛仍然活着的正常路径不会走到这。
  stopStatus()
  stopNotifyStore()
  stopScheduleStore()
  stopMusicStore()
  app.quit()
})

// 渲染进程请求改变展开状态
ipcMain.on('island:set-expanded', (_event, value: boolean) => {
  if (value === expanded) return
  // US-036 诊断探针：收起发生时记录一行，便于定位「打字时岛自己收起」的真实路径。
  // 诊断稳定后可整体移除（连同 logDiag 通道）。
  if (!value) appendDiagLog(`render set-expanded=false; hasFocus(主进程视角)=${mainWindow?.isFocused() ?? 'no-win'}`)
  animateTo(value)
})

// 诊断日志：追加写 userData/collapse-log.txt（探针，US-036 定位用）
function appendDiagLog(line: string): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(app.getPath('userData'), 'collapse-log.txt')
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 探针日志失败不影响功能 */
  }
}

// 渲染层诊断上报（探针）：blur 去抖判定结果、键盘事件等
ipcMain.on('island:log-diag', (_event, line: unknown) => {
  appendDiagLog(String(line ?? ''))
})

// 渲染层量出收起态内容宽度后下发（随信息数量自适应：有电量时宽、无电量时窄）
ipcMain.on('island:set-collapsed-width', (_event, value: unknown) => {
  const w = Number(value)
  if (!Number.isFinite(w)) return
  const next = Math.round(Math.min(COLLAPSED_MAX_W, Math.max(COLLAPSED_MIN_W, w)))
  if (next === collapsedWidth) return
  collapsedWidth = next
  // 只在收起态时立即应用（展开态下次收起时自然生效）
  if (!expanded && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(computeBounds(false))
  }
})

// 收起态窗口高 42px 只装得下胶囊；横幅需要 46px 额外空间。
// **关键约束（第五轮截图实锤）**：岛贴屏幕顶（TOP_GAP=6），胶囊上方屏幕只剩 ~12px——
// （历史）横幅期动态加高方案已废弃：实机截屏五轮验证，动态 setBounds 后透明窗口新增区域
// 在 Windows 上不被合成器画出——横幅 DOM/尺寸/可见性全对但屏幕无像素。
// 现方案：收起窗口常驻 COLLAPSED_WIN_HEIGHT（胶囊+横幅预留区），横幅显示不需要主进程配合，
// set-banner-visible IPC 保留为空操作（渲染层调用点不删，避免改三处）。
ipcMain.on('island:set-banner-visible', () => {})

// 渲染层量出展开态内容尺寸后下发（随各页内容量自适应，clamp 防过小/过大）
ipcMain.on('island:set-expanded-size', (_event, w: unknown, h: unknown) => {
  const nw = Number(w)
  const nh = Number(h)
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return
  const next = {
    width: Math.round(Math.min(EXPANDED_MAX.width, Math.max(EXPANDED_MIN.width, nw))),
    height: Math.round(Math.min(EXPANDED_MAX.height, Math.max(EXPANDED_MIN.height, nh)))
  }
  if (next.width === expandedSize.width && next.height === expandedSize.height) return
  expandedSize = next
  // 只在展开态时立即应用（收起态下次展开时自然生效）
  if (expanded && mainWindow && !mainWindow.isDestroyed()) {
    animateTo(true)
  }
})

// 打开置物架里的文件（用系统默认程序）
// 返结构化的结果而不是原始字符串：文件已不在时直接回 missing，
// 不让 shell.openPath 的英文系统报错（如 "Failed to open path"）透到界面上。
ipcMain.handle('shelf:open', async (_e, path: unknown): Promise<ShelfOpenResult> => {
  const p = String(path ?? '')
  if (!p) return { ok: false, reason: 'empty' }
  if (!existsSync(p)) return { ok: false, reason: 'missing' }
  const err = await shell.openPath(p)
  // 成功时 openPath 返回空字符串
  if (!err) return { ok: true, reason: 'ok' }
  return { ok: false, reason: 'failed', detail: err }
})

// 在资源管理器里显示文件；文件已不在时同样如实回报，让界面能说明原因
ipcMain.handle('shelf:show-in-folder', (_e, path: unknown): ShelfRevealResult => {
  const p = String(path ?? '')
  if (!p) return { ok: false, reason: 'empty' }
  if (!existsSync(p)) return { ok: false, reason: 'missing' }
  shell.showItemInFolder(p)
  return { ok: true, reason: 'ok' }
})

// ---------- 退出入口（US-034） ----------
// 窗口是 skipTaskbar: true 且 frame: false，没有标题栏关闭按钮，任务栏也没有图标，
// 加上没有托盘的话，用户想关掉它只能去任务管理器结束进程。这里补两条路：
//   1）岛内右键 → 渲染层发 app:show-menu → 主进程在光标处弹原生菜单
//   2）通知区域托盘图标右键 → 同一个菜单
// 两者最终都调 quitApp()，是真正的进程退出，不是隐藏窗口。

// 岛内右键：在光标处弹出菜单（菜单是系统原生的，不受岛的半透明样式影响）
ipcMain.on('app:show-menu', () => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  buildAppMenu().popup({ window: win })
})

// US-041 手动隐藏的第二段：菜单点击 → 渲染层转发 → 主进程状态机真正 hide。
// 拆两段是因为 buildAppMenu 在渲染层右键时也要弹（岛可见，走 island:manual-hide→fullscreenWatch），
// 托盘右键时岛可能已隐藏（走 island:avoid-do-hide → 同一状态机）。
ipcMain.on('island:avoid-do-hide', () => {
  manualHide = true
})

// 渲染层直接请求退出（目前菜单点击走主进程自己的 quitApp，这里留给以后做「确认后退出」）
ipcMain.on('app:quit', () => {
  quitApp()
})

// ---------- 开机自启 ----------

// 查询当前开机自启状态
// 注意 1：get/set 必须传同样的 args——Electron 在 Windows 上按「exe 路径+启动参数」
// 匹配 HKCU\...\Run 里的值，参数不一致时 openAtLogin 永远读回 false（实测踩坑）。
// 注意 2：args 必须含 **绝对** app 路径。开机启动时工作目录是 C:\WINDOWS\system32，
// 相对路径 '.' 会解析到 system32 → 「Unable to find Electron app at
// C:\WINDOWS\system32」（用户重启实测弹错）。
// 注意 3：打包版 electron.exe 自带 app（asar），args 只需 --hidden；开发版裸引擎
// 必须带项目根路径。__dirname 反推（out/main → 上两级）只对开发版成立，asar 里
// 会指到 resources\app.asar 而不是安装根，所以用 app.isPackaged 分支。
const AUTOSTART_ARGS: string[] = app.isPackaged
  ? ['--hidden']
  : [join(__dirname, '..', '..'), '--hidden']

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
  const real = app.getLoginItemSettings({ args: AUTOSTART_ARGS }).openAtLogin === true
  // 广播真实状态（SPEC-settings-shell 阻断项 B2）：岛头部胶囊与设置窗口的开关是两处
  // 独立渲染进程，不广播的话改完只有当前窗口变，另一处要等到重启才同步。
  // 用真实值而非入参——系统拒绝写入时两边都得看到实际结果。
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('autostart:changed', real)
  }
  return real
})
