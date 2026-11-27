import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import {
  hideIslandManually,
  initFullscreenWatch,
  isIslandManuallyHidden,
  restoreIslandFromManual,
  stopFullscreenWatch
} from './fullscreenWatch'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { setupTodoStore } from './todoStore'
import { setupStatus, stopStatus } from './statusStore'
import { setupShelfStore } from './shelfStore'
import { setupNotifyStore, stopNotifyStore } from './notifyStore'
import { setupScheduleStore, stopScheduleStore } from './scheduleStore'
import { setupExportStore } from './exportStore'
import { setupImportStore } from './importStore'
import { setupPrefsStore, getPrefs, patchPrefs } from './prefsStore'
import { setupMusicStore, stopMusicStore } from './musicStore'
import { setupLyricStore } from './lyricStore'
import { openSettings, setupSettingsWindow } from './settingsWindow'
import { setupCleanupStore } from './cleanupStore'
import { setupResidueStore } from './residueStore'
import { setupAdminCleanupStore } from './adminCleanupStore'
import { setupSoftwareResidueStore } from './softwareResidueStore'
import { closePetWindow, setupPetWindow, syncPetWindow } from './petWindow'
import { initClipboardWatch } from './clipboardStore'
import { setIslandWindow } from './islandWindowRef'
import { setupLocalFileProtocol } from './localFileProtocol'
import { startupLog, startupLogSync } from './startupLog'
import { setupUpdater } from './updater'
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
/**
 * 歌词条模式的上限（SPEC-collapsed-lyric-bar）。
 * 歌词条按参考视频做成一条宽胶囊：渲染层固定 400 视觉 px，这里留 420 的余量；
 * 普通收起态仍按 290 夹，不因为这项功能把日常胶囊放开。
 */
const COLLAPSED_LYRIC_MAX_W = 420
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
//    居中会压到左侧标题，e2e-head-order 的 H5a 报 overlapTitle=true。随后用户 m02546
//    要求统一各页左上角，徽章 26→30、标题 14→16/800，三字标题页仍差 9 布局 px，再抬到 380。）
// 3) 2026-11-16 晚用户 m03988「两边有点多余，去除掉」：布局最小宽 380→340、左右内边距 24→16，
//    视觉下限 285→255（每侧少约 11 视觉 px），置物架页标题与状态区仍有 8.5 布局 px 余量。
const EXPANDED_MIN = { width: 255, height: 113 }
const EXPANDED_MAX = { width: 540, height: 315 }
/** 展开态当前尺寸（渲染层量出来的）。初始值取组件网格的固定尺寸（340×362 布局 px ×0.75），
 *  2026-11-25 起展开前渲染层会先报一次真实尺寸，这里只是兜底，避免退回固定尺寸时代的 353×240。
 *  2026-11-27（SPEC-widget-drag 五卡等大后网格 330→362）同步初值：高度 248→272。 */
let expandedSize = { width: 255, height: 272 }
/** 距屏幕顶部的缝隙 */
const TOP_GAP = 6
/** 开合补间时长（毫秒）。原 500 ms，2026-11-25 用户嫌开合动画卡，收到 220 ms */
const TWEEN_MS = 220
/**
 * 尺寸上报的死区（视觉 px）。渲染层量出来的宽高会因缩放取整来回抖 ±1px，
 * 抖动一次就让窗口跟着改一次，肉眼就是「窗口边缘一直微微跳动」。
 * 1 视觉 px 在 0.75 缩放下 ≈ 1.33 布局 px，肉眼不可辨，直接忽略。
 */
const SIZE_DEADZONE_PX = 1

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let expanded = false
let tweenTimer: NodeJS.Timeout | null = null
/** 补间起点矩形与起始时刻 */
let tweenFrom: Electron.Rectangle | null = null
let tweenStart = 0
// US-041 手动隐藏的唯一真源在 fullscreenWatch 的状态机（state === 'manual'）。
// 这里不再另存布尔值：2026-11-25 实测两份标志会分叉——横幅把岛叫亮时把主进程那份清成
// false，状态机却还停在 manual，托盘恢复因此漏发 island:manual-restore，岛卡在最上层、
// 最大化/真全屏都不再躲。

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
  const hiddenByUser = isIslandManuallyHidden()
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
    // 2026-11-25 修（用户实测「暂时隐藏没有任何反应」）：旧实现是主进程给渲染层发
    // `island:avoid-do-hide` 让渲染层再转发回来，但渲染层从来没有监听这个频道，
    // 主进程收到同一个频道也只置标志不隐藏 —— 点了等于什么都没做，菜单还会变成占位的
    // 「显示灵动岛」。现在两个方向都直接落地：隐藏调状态机的 hideIslandManually()，
    // 显示复用托盘左键同一条恢复路径。
    hiddenByUser
      ? { label: '显示灵动岛', click: () => restoreIsland() }
      : {
          label: '暂时隐藏灵动岛',
          click: () => {
            hideIslandManually()
            refreshTrayMenu()
          }
        },
    { type: 'separator' },
    { label: '退出灵动岛', click: () => quitApp() }
  ])
}

/**
 * 托盘菜单是一份构建时的快照：状态机是不是「手动隐藏」决定那一项是「暂时隐藏」还是「显示」，
 * 状态变了不重建，托盘里就一直是旧文案。
 * 2026-11-25 实测踩到：隐藏后托盘右键仍是「暂时隐藏灵动岛」，点下去又隐藏一次，岛回不来。
 */
function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(buildAppMenu())
}

/** 找回岛（托盘左键 / 菜单「显示灵动岛」共用）。
 * 无条件通知状态机（它自己判断在不在 manual，不在就直接忽略），再 showInactive 顶回最上层。
 * 两条纪律：① 不能先看主进程自己的标志——那个标志会被横幅叫亮时的 show 清掉，漏发通知后
 * 状态机永远卡在 manual；② 不能用 `webContents.send`——那个频道没有渲染层监听者，等于没发
 * （2026-11-25 探针复现：窗口亮着、判定却停摆）。直接调状态机导出的函数。 */
function restoreIsland(): void {
  restoreIslandFromManual()
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    refreshTrayMenu()
    return
  }
  mainWindow.showInactive()
  refreshTrayMenu()
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
  tray.on('click', () => restoreIsland())
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

/**
 * 展开/收起补间。2026-11-25 从 500 ms 收到 220 ms，并且改成单调（渲染层会在 set-expanded
 * 之前先上报目标尺寸），把用户说的「震动」——窗口宽度先冲过头再缩回来——去掉。
 *
 * 为什么还保留逐帧补间、不改成一次 setBounds：实机逐帧截图实测，透明置顶窗口在「一次
 * 跳变尺寸 + 内容变换」后，合成器有几百毫秒不呈现新画面（屏幕上是空的/旧的）；连续
 * 小幅 setBounds 会强制它持续出帧。220 ms × 16 ms ≈ 14 帧，比原来的 500 ms（≈30 帧）
 * 少一半，配合渲染层的淡入缩放已经把卡顿感压下去。
 *
 * 2026-11-27 修「有应用盖在岛下面时展开卡顿、显示不完整」：
 * 旧实现只要补间在跑，任何一次 `animateTo` 都会把 `tweenStart` 重置成 now——而渲染层在
 * 入场期间会反复上报尺寸（ResizeObserver 去抖 + 结束补报 + 切页路径），用户机器上量到的
 * 尺寸有 ±1px 抖动，于是每 40ms 就把 220ms 的补间从头再来一次，窗口永远到不了终点。
 * 用户视频逐帧实测：岛高每帧 +1px、爬了约 1.7 秒（本机探针同条件复现：终值时刻
 * 244ms → 448ms，之后还在 274/275 之间来回跳）。
 * 现在：**方向不变就不重置计时**——补间每帧本来就用 `computeBounds(expanded)` 现算终点，
 * 中途换目标会自动收敛，不需要重来。只有方向翻转（展开↔收起）才起一段新补间。
 */
function animateTo(isExpanded: boolean): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return

  const sameDirection = isExpanded === expanded
  expanded = isExpanded
  // 已在补间且方向没变：让现有补间继续走，终点下一帧自然按新目标算
  if (tweenTimer && sameDirection) return
  tweenFrom = win.getBounds()
  tweenStart = Date.now()
  if (tweenTimer) return // 方向翻转：沿用同一个定时器，但从当前位置重新计时
  tweenTimer = setInterval(tweenTick, 16)
  tweenTick()
}

/** 补间的一帧：从 tweenFrom 到当前目标矩形，easeOutCubic */
function tweenTick(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    if (tweenTimer) clearInterval(tweenTimer)
    tweenTimer = null
    return
  }
  const from = tweenFrom ?? win.getBounds()
  const to = computeBounds(expanded)
  const t = Math.min(1, (Date.now() - tweenStart) / TWEEN_MS)
  const e = 1 - Math.pow(1 - t, 3)
  win.setBounds({
    x: Math.round(from.x + (to.x - from.x) * e),
    y: Math.round(from.y + (to.y - from.y) * e),
    width: Math.round(from.width + (to.width - from.width) * e),
    height: Math.round(from.height + (to.height - from.height) * e)
  })
  if (t >= 1) {
    if (tweenTimer) clearInterval(tweenTimer)
    tweenTimer = null
    tweenFrom = null
    win.setBounds(computeBounds(expanded))
  }
}

/**
 * 直接把窗口放到目标矩形，不做补间。用于切页（内容尺寸变化，不需要窗口动画）。
 * 若正好有开合补间在跑，先停掉它，避免两套尺寸互相覆盖。
 */
function applyBoundsNow(isExpanded: boolean): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (tweenTimer) {
    clearInterval(tweenTimer)
    tweenTimer = null
  }
  tweenFrom = null
  expanded = isExpanded
  win.setBounds(computeBounds(isExpanded))
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

/**
 * 启动诊断日志（2026-11-18 加，起因见 docs/Spec/SPEC-startup-diagnostics.md）。
 *
 * 用户反馈「同学的机器上双击打不开，界面上什么都没有」。打包版默认不写任何日志，
 * 双击失败时用户/我们两边都只能猜（杀软拦截？系统太旧？初始化抛异常？）。
 * 这里做两件事：
 *  1. 每次启动往 `userData/startup.log` 追一行（版本、Electron 版本、系统版本、可疑环境变量）；
 *  2. 捕获未处理异常/未处理 Promise 拒绝，既写日志，也用原生对话框把「为什么打不开」显示出来
 *     —— 安装包未签名、缺运行环境、磁盘只读之类的问题都能第一时间看到原因，
 *     而不是双击后一片安静。
 *
 * 注意：日志写入失败绝不能影响启动（整段 try/catch）。日志文件放在数据目录里，
 * 设置窗口的「打开数据文件夹」就能直达。
 */
function describeEnv(): string {
  const parts = [
    'version=' + app.getVersion(),
    'electron=' + process.versions.electron,
    'chrome=' + process.versions.chrome,
    'packaged=' + app.isPackaged,
    'argv=' + JSON.stringify(process.argv.slice(1)),
    'exe=' + process.execPath,
    'cwd=' + process.cwd()
  ]
  // 已知会让打包版「双击没反应」的环境变量：设了它 Electron 会以纯 Node 方式跑，
  // 主进程逻辑根本不执行（[实测] 见 docs/facts/本机约束与踩坑.md）
  if (process.env['ELECTRON_RUN_AS_NODE']) parts.push('WARN:ELECTRON_RUN_AS_NODE=' + process.env['ELECTRON_RUN_AS_NODE'])
  if (process.env['ELECTRON_NO_ATTACH_CONSOLE']) parts.push('WARN:ELECTRON_NO_ATTACH_CONSOLE=1')
  return parts.join(' ')
}

process.on('uncaughtException', (err) => {
  const detail = err && err.stack ? err.stack : String(err)
  // 同步写：这行之后要弹框并 app.exit(1)，异步写会随进程一起消失
  startupLogSync('FATAL uncaughtException: ' + detail)
  try {
    dialog.showErrorBox(
      '灵动岛启动失败',
      '程序遇到错误，没能正常启动。\n\n' +
        String((err && err.message) || err) +
        '\n\n日志：' +
        join(app.getPath('userData'), 'startup.log')
    )
  } catch {
    /* 连对话框都弹不出来（极端情况）就只剩日志 */
  }
  app.exit(1)
})

process.on('unhandledRejection', (reason: unknown) => {
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  startupLog('WARN unhandledRejection: ' + detail)
})

startupLog('=== 启动 ' + describeEnv())

/**
 * 单实例锁（2026-11-17 加）。
 *
 * 为什么需要：用户机器重启后同时出现了**两个岛**。原因是注册表 HKCU\...\Run 里有两条自启：
 * 早期版本写的 `electron.app.灵动岛`（Electron 默认名）和现在的 `com.xcjack.lingdong-island`
 * （改用自定义 appId 后写的），两条都指向同一个 exe —— 于是开机起两个实例，各自一个岛窗口、
 * 各自一个常驻判定进程抢同一个心跳文件。过时那条已手工删掉，这里加锁兜底：
 * 任何方式重复启动（自启、双击、开发预览版与装机版同时开）第二个实例都直接退出，
 * 并尽量把已有的岛叫到前面。
 *
 * 注意：E2E 都用 `--user-data-dir` 隔离数据目录，Electron 的单实例锁按 userData 划分，
 * 所以互不干扰。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.showInactive()
      win.moveTop()
    }
  })
}

app.whenReady().then(() => {
  // 拿不到锁的实例已经 quit 了，别再往下初始化（否则会建第二个岛、起第二个辅助进程）
  if (!hasSingleInstanceLock) return
  startupLog('whenReady ok, creating window')
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
  setupImportStore()
  setupPrefsStore()
  setupMusicStore()
  // 歌词（SPEC-music-lyric）：只注册 IPC，真正联网只在渲染层来问时才发生
  setupLyricStore()
  setupSettingsWindow()
  // 空间清理（SPEC-space-cleanup）：只注册扫描/清理 IPC，真正的文件操作要用户点才做
  setupCleanupStore()
  setupResidueStore()
  setupAdminCleanupStore()
  setupSoftwareResidueStore()
  // 自动更新（SPEC-auto-update）：注册 IPC 与定时检查；开发版只登记「不支持」状态
  setupUpdater()
  // 桌宠独立小窗口（SPEC-deskpet-out）：注册 IPC + 订阅偏好变化。
  // 必须在 createWindow 之前——偏好里可能已经是 window 模式，启动时就该把它开出来。
  setupPetWindow({ onQuit: () => quitApp() })
  initClipboardWatch()
  createWindow()
  // 按当前 petMode 决定要不要把桌宠放出去（偏好缺失时是 island，这里什么都不做）
  syncPetWindow()
  createTray()
  // US-041 全屏自动避让：判定辅助进程 + 状态机 + 感应窗
  // 策略（三档，SPEC-avoid-mode-and-latency）每次评估现读一份，改设置后 150ms 内生效
  initFullscreenWatch(
    () => mainWindow,
    (hidden) => {
      // 状态落地后重建托盘菜单：手动隐藏 / 恢复 / 横幅叫亮都会改「暂时隐藏 ↔ 显示」文案
      refreshTrayMenu()
      mainWindow?.webContents.send('island:avoid-changed', hidden)
    },
    () => getPrefs().avoidMode ?? 'maximized'
  )
  // 渲染层菜单发起的手动隐藏由 fullscreenWatch 自己接（island:manual-hide 同一个频道）；
  // 这里只跟着刷托盘文案，避免「状态已变、菜单还写暂时隐藏」。
  ipcMain.on('island:manual-hide', () => {
    refreshTrayMenu()
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
  // 2026-11-25 用户「打开和关闭时的震动动画容易卡」：补间从 500ms 收到 220ms，
  // 且渲染层会先上报目标尺寸再触发，窗口单调展开、不再先冲过头再缩回来。
  // （不能改成一次 setBounds：实测透明窗跳变后合成器几百毫秒不呈现新画面。）
  animateTo(value)
})

// 诊断日志：追加写 userData/collapse-log.txt（探针，US-036 定位用）
// 2026-11-22 改异步（SPEC-perf-no-sync-ps）：旧版用 appendFileSync，每次窗口失焦/收起
// 都在主线程上等一次磁盘 I/O。探针本身要留，但不应该参与「点一下就卡」的体感。
function appendDiagLog(line: string): void {
  // 生产版不写（SPEC-idle-cost-reclaim）：这是 US-036「打字时岛自己收起」的排障探针，
  // 2026-11-19 已定位收口。它挂在每次窗口失焦/收起上，留着只会让用户数据目录常年增长。
  if (app.isPackaged) return
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(app.getPath('userData'), 'collapse-log.txt')
    fs.appendFile(file, `${new Date().toISOString()} ${line}\n`, () => {
      /* 写失败不影响功能 */
    })
  } catch {
    /* 探针日志失败不影响功能 */
  }
}

// 渲染层诊断上报（探针）：blur 去抖判定结果、键盘事件等
ipcMain.on('island:log-diag', (_event, line: unknown) => {
  appendDiagLog(String(line ?? ''))
})

// 渲染层量出收起态内容宽度后下发（随信息数量自适应：有电量时宽、无电量时窄）
ipcMain.on('island:set-collapsed-width', (_event, value: unknown, lyric: unknown) => {
  const w = Number(value)
  if (!Number.isFinite(w)) return
  const maxW = lyric === true ? COLLAPSED_LYRIC_MAX_W : COLLAPSED_MAX_W
  const next = Math.round(Math.min(maxW, Math.max(COLLAPSED_MIN_W, w)))
  // 1px 死区，理由同 SIZE_DEADZONE_PX（收起态同样会被取整抖动带着来回改窗口宽度）
  if (Math.abs(next - collapsedWidth) <= SIZE_DEADZONE_PX) return
  collapsedWidth = next
  // 只在收起态时立即应用（展开态下次收起时自然生效）
  if (!expanded && mainWindow && !mainWindow.isDestroyed()) {
    // 收起补间途中：从当前位置重起补间，别抢一次 setBounds 造成闪一下
    if (tweenTimer) {
      animateTo(false)
      return
    }
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

// 渲染层量出展开态内容尺寸后下发（随各页内容量自适应，clamp 防过小/过大）。
// 用 handle 而不是 on：渲染层切页时要等「窗口已改好」再显示新页（SPEC-switch-size-sync），
// 返回值就是这个回执。ipcRenderer.invoke 在 handler 返回后才 resolve。
ipcMain.handle('island:set-expanded-size', (_event, w: unknown, h: unknown) => {
  const nw = Number(w)
  const nh = Number(h)
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return { ...expandedSize }
  const next = {
    width: Math.round(Math.min(EXPANDED_MAX.width, Math.max(EXPANDED_MIN.width, nw))),
    height: Math.round(Math.min(EXPANDED_MAX.height, Math.max(EXPANDED_MIN.height, nh)))
  }
  // 1px 死区（2026-11-27）：渲染层量出来的尺寸会因缩放取整来回抖 ±1px，
  // 每次抖动都会走到下面的 applyBoundsNow / animateTo，窗口跟着来回跳 1px。
  // 用户视频逐帧实测：展开结束后窗口还在 274/275 之间反复跳（探针同条件复现 6 帧回退）。
  // 1 视觉 px 在 0.75 缩放下不到 1.4 布局 px，肉眼不可辨，直接忽略。
  if (
    Math.abs(next.width - expandedSize.width) <= SIZE_DEADZONE_PX &&
    Math.abs(next.height - expandedSize.height) <= SIZE_DEADZONE_PX
  ) {
    return { ...expandedSize }
  }
  expandedSize = next
  // 只在展开态时立即应用（收起态下次展开时自然生效）
  if (expanded && mainWindow && !mainWindow.isDestroyed()) {
    // 展开补间途中收到新尺寸：从当前位置重起补间（单调收敛，不来回跳）
    if (tweenTimer) {
      animateTo(true)
      return { ...expandedSize }
    }
    applyBoundsNow(true)
  }
  return { ...expandedSize }
})

// ---------- 岛背后的「真透视」底色（SPEC-island-themes 第二轮） ----------
// 目标：B 主题（亮色乳白玻璃）要像效果图那样，能隐约看见桌面颜色在岛底下晕开。
//
// 为什么非得抓屏（两条都是实测结论，见 docs/facts/本机约束与踩坑.md）：
//   1) 透明 Electron 窗口上 backdrop-filter 采不到窗口背后的桌面像素，只会采样到窗口自己的透明底；
//   2) Windows 的 backgroundMaterial('acrylic'/'mica') 加在透明窗上会把窗口变成不透明灰板，反而丢掉透明。
// 所以只剩「自己抓一块桌面 → 交给渲染层当背景 → CSS 模糊」这一条路。
//
// 三条硬约束：
//   1) **不能靠开关 setContentProtection 来躲开岛自己**（第一版这么干，被用户抓包「老是闪」）：
//      Windows 在切换 WDA_EXCLUDEFROMCAPTURE 的那一瞬间会把窗口换成一张旧的缓存画面 ——
//      录屏逐帧实测，每 1.5s 有 4~5 帧显示的是「启动时的收起态小胶囊」，肉眼就是突然缩一下再弹回来。
//      现在改成：照常抓（岛会在图里），再把岛占的那块矩形**用左右两侧的真实桌面像素横向插值填掉**。
//      反正最后要 blur(22px)，插值出来的低频色块和真桌面看不出区别。
//   2) 图只回给渲染层当 CSS 背景，不落盘、不进日志；渲染层也只在内存里持有。
//   3) 由渲染层按需拉取（收起 5s / 展开 1.5s 一次），主进程不自己起定时器 —— 岛隐藏时没人拉就没有开销。
let backdropBusy = false

ipcMain.handle('island:backdrop', async (): Promise<string | null> => {
  const win = mainWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return null
  if (backdropBusy) return null // 上一次还没抓完（低端机/4K 屏可能超 200ms），直接跳过这一拍
  // 开合补间进行中不抓屏（2026-11-26，SPEC-expand-clip）：desktopCapturer.getSources 实测
  // 阻塞主进程 135~192ms，会把 16ms 的补间定时器卡出一个 100ms 级空档 —— 窗口停在原地、
  // 岛已经展开，屏幕上就是「只剩页头一条」的裁切态。补间只有 220ms，跳过这一拍几乎无感
  // （渲染层展开态每 1.5s 拉一次，下一次就补上了）。
  if (tweenTimer) return null
  backdropBusy = true
  try {
    const bounds = win.getBounds() // DIP
    const display = screen.getDisplayMatching(bounds)
    const sf = display.scaleFactor || 1
    // 缩略图只取全屏物理像素的 35%：模糊之后根本看不出画质差别，耗时却从 ~150ms 降到 ~60ms
    const thumbW = Math.max(64, Math.round(display.size.width * sf * 0.35))
    const thumbH = Math.max(64, Math.round(display.size.height * sf * 0.35))

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH }
    })
    if (!sources.length) return null
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    const img = src.thumbnail
    const size = img.getSize()
    if (size.width < 8 || size.height < 8) return null
    // 缩略图 px / 屏幕物理 px；显示器可能被系统缩放，用实际尺寸反推最稳
    const ratio = size.width / (display.size.width * sf)
    const toPx = (dip: number): number => Math.round(dip * sf * ratio)
    // 岛自己的矩形（缩略图坐标）
    const ix = Math.max(0, Math.min(toPx(bounds.x - display.bounds.x), size.width - 8))
    const iy = Math.max(0, Math.min(toPx(bounds.y - display.bounds.y), size.height - 8))
    const iw = Math.max(8, Math.min(toPx(bounds.width), size.width - ix))
    const ih = Math.max(8, Math.min(toPx(bounds.height), size.height - iy))

    // 往外多抓一圈真实桌面：既给模糊留上下文，也给插图提供干净的左右采样列。
    // 必须四边同宽（取能放下的最大值）：岛贴着屏幕顶，若只按"能扩多少扩多少"，
    // 上下不对称会让 crop 中心偏离岛中心，cover 之后底图整体错位。
    const pad = Math.max(
      0,
      Math.min(Math.round(36 * ratio), ix, iy, size.width - (ix + iw), size.height - (iy + ih))
    )
    const cx = ix - pad
    const cy = iy - pad
    const cw = iw + pad * 2
    const ch = ih + pad * 2
    const crop = img.crop({ x: cx, y: cy, width: cw, height: ch })

    // 把岛那块矩形填掉：每一行取左右紧贴的桌面列，按 smoothstep 横向插值。
    // 岛的圆角外本来就是透明窗（能拍到底下的真桌面），这几列也一起被覆盖，不影响。
    const hx = ix - cx
    const hy = iy - cy
    const hw = Math.min(iw, cw - hx)
    const hh = Math.min(ih, ch - hy)
    if (hw > 0 && hh > 0 && cw > 2) {
      const bmp = crop.toBitmap() // BGRA，行优先
      const lx = Math.max(0, hx - 1)
      const rx = Math.min(cw - 1, hx + hw)
      const hasL = lx < hx
      const hasR = rx >= hx + hw
      if (hasL || hasR) {
        for (let y = hy; y < hy + hh; y++) {
          const row = y * cw * 4
          const l = row + lx * 4
          const r = row + rx * 4
          const l0 = bmp[l]
          const l1 = bmp[l + 1]
          const l2 = bmp[l + 2]
          const r0 = bmp[r]
          const r1 = bmp[r + 1]
          const r2 = bmp[r + 2]
          // 两侧取不到的极端情况（岛贴屏边）就用另一侧整行铺满
          const a0 = hasL ? l0 : r0
          const a1 = hasL ? l1 : r1
          const a2 = hasL ? l2 : r2
          const b0 = hasR ? r0 : l0
          const b1 = hasR ? r1 : l1
          const b2 = hasR ? r2 : l2
          for (let x = hx; x < hx + hw; x++) {
            const t0 = (x - hx + 1) / (hw + 1)
            const t = t0 * t0 * (3 - 2 * t0) // smoothstep：与两侧桌面接缝处导数为 0
            const o = row + x * 4
            bmp[o] = Math.round(a0 + (b0 - a0) * t)
            bmp[o + 1] = Math.round(a1 + (b1 - a1) * t)
            bmp[o + 2] = Math.round(a2 + (b2 - a2) * t)
            bmp[o + 3] = 255
          }
        }
      }
      return nativeImage.createFromBitmap(bmp, { width: cw, height: ch }).toDataURL()
    }
    // 连一行干净的桌面像素都取不到（岛把整屏占满这种理论上不可能的情况）：
    // 宁可不给底图，也不能把岛自己当底图回灌，否则会一层层糊上去
    return null
  } catch {
    // 抓屏失败（远程桌面、显卡驱动异常等）不能影响界面：渲染层拿不到就退回静态乳白玻璃
    return null
  } finally {
    backdropBusy = false
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

// 岛内右键：在光标处弹出菜单（菜单是系统原生的，不受岛的半透明样式影响）。
// 菜单打开期间窗口会失焦、光标也会离开岛，渲染层若照旧收起，用户还没把鼠标移到
// 「暂时隐藏灵动岛」，岛就缩回去了（2026-11-25 用户报障，SPEC-app-menu-collapse）。
// 所以菜单关闭时给渲染层发一条结束通知，渲染层再决定要不要收起。
ipcMain.on('app:show-menu', () => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const notifyClosed = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('island:app-menu-closed')
    }
  }
  try {
    buildAppMenu().popup({ window: win, callback: notifyClosed })
  } catch (err) {
    // 弹不出来时也要把「菜单结束」告诉渲染层，否则它一直以为菜单开着、永远不自动收起
    notifyClosed()
    startupLog('WARN app menu popup failed: ' + String(err))
  }
})

// （2026-11-25 删除）旧的 `island:avoid-do-hide` 频道：菜单只给渲染层发消息、渲染层没有
// 监听，主进程也只置标志不隐藏，是彻底的死链路；现在菜单直接调 hideIslandManually()。

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
