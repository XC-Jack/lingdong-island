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
 * mode=window / free 就开着（free 还会启动自由走动，SPEC-deskpet-walk），其它值就关掉；
 * 用户在设置页改、或点宠物窗口右键「回到岛里」，都通过 `onPrefsWritten`
 * 这条主进程内部通道统一收口，不会出现「窗口开着但偏好是 island」这种对不上的状态。
 */
const PET_WIN_W = 190
/**
 * 窗口高度比宽度高 60px，多出来的这一段专门给底部的旋转把手。
 *
 * 2026-11-12 用户反馈：「我希望在奶娃的下面」——把手要摆在宠物正下方居中。
 * 但 190×190 的窗口里脚底（含投影）已经到 187 附近，下面只剩几像素，
 * 塞不进 22px 的圆（第一版就是硬塞在居中贴底，结果压住脚趾，用户提了「有点遮住脚了」）。
 *
 * 为什么不改小宠物或把宠物往上挤：这个窗口的宠物是「用户给的原图」，
 * 尺寸是他一眼认出来的样子，为了一个图标把它缩小是本末倒置。
 *
 * 为什么不改成窗口内绝对定位、让宠物溢出窗口：透明窗口裁掉溢出部分是默认行为，
 * 宠物会被切掉一块。
 *
 * 加高的副作用要说清楚：SVG 用 `xMidYMid meet`，内容仍是 190×190、在窗口里垂直居中，
 * 所以宠物渲染尺寸**一点没变**，只是上下各留 30px。上面那 30px 是空的（透明），
 * 但也属于 `.petwin`，按住它同样能拖动宠物——相当于把抓取区上下各扩了一截，
 * 对「摸到它」是好事，副作用是宠物头顶上方一小块看不见的地方也能抓。
 *
 * 为什么是 250 而不是正好卡住：投影椭圆底在内容坐标 157.5，换算到窗口是
 * 30 + 157.5×1.1875 ≈ 217；把手顶在 250−6−22 = 222，中间留 5px 空隙。
 * 高度再小就贴上了，再大只是多一块透明空白。
 */
const PET_WIN_H = 250

let petWindow: BrowserWindow | null = null

/** 拖动中的定时器与起始状态（SPEC-deskpet-out 第三节：不用 -webkit-app-region） */
let dragTimer: NodeJS.Timeout | null = null
let dragOrigin: { cursor: PetWindowPos; win: PetWindowPos } | null = null

/** 退出应用的回调：菜单里的「退出灵动岛」要走 index.ts 的 quitApp（要先停各轮询） */
let quitHandler: (() => void) | null = null

// ===== 自由走动（SPEC-deskpet-walk）=====
/** 走动定时器步长：50ms 一帧（约 20 帧/秒），够顺滑又不烧 CPU */
const WALK_TICK_MS = 50
/** 每帧横向位移（DIP）：2px × 20 帧 = 40px/秒，慢慢溜达 */
const WALK_STEP_PX = 2
/** 连续走多少帧后停一会儿（60 帧 ≈ 3 秒） */
const WALK_RUN_TICKS = 60
/** 停下多少帧再走（30 帧 ≈ 1.5 秒），对应「走过的地方会停下」 */
const WALK_REST_TICKS = 30

/** 当前走动方向：1=向右，-1=向左 */
let walkDir: 1 | -1 = -1
let walkTimer: NodeJS.Timeout | null = null
let walkPhase: 'run' | 'rest' = 'run'
let walkTicks = 0
/** 用户正在拖窗口：冻结自动走动，免得 16ms drag 与 50ms walk 同时 setBounds 打架 */
let walkPaused = false
/** 最近一次推给渲染层的方向/状态（渲染层挂载后补发用） */
let walkEmit: 'left' | 'right' | 'idle' = 'idle'

type WalkDir = 'left' | 'right' | 'idle'

/** 把走动方向/状态推给宠物窗口；同时记下来，窗口刚挂载时补发 */
function pushWalk(dir: WalkDir): void {
  walkEmit = dir
  const win = petWindow
  if (win && !win.isDestroyed()) win.webContents.send('pet:walk', dir)
}

/** 停走动：清定时器、复位相位、通知渲染层收起颠动；幂等 */
function stopWalk(): void {
  const wasWalking = walkTimer !== null
  if (walkTimer) {
    clearInterval(walkTimer)
    walkTimer = null
  }
  walkPhase = 'run'
  walkTicks = 0
  walkPaused = false
  walkEmit = 'idle'
  // 只有确实从「走动中」停下才通知渲染层复位朝向、收起颠动。
  // window / island 模式每次偏好写入也会走到这里：没走动时不能推 idle，
  // 否则用户在「独立小窗口」里手动转好的朝向会被一次次强行转回正面。
  if (wasWalking) pushWalk('idle')
}

/**
 * 开走动：只在 free 模式、且窗口已存在时调。
 * 每帧读当前 bounds 往 walkDir 方向挪 WALK_STEP_PX，再用 clampPetPos 钳进工作区；
 * 「想动却没动」就是撞到左右边界，掉头。走满一段停一段，循环往复。
 * 不逐帧写盘：位置只在用户拖动松手时由 savePos 落盘，自动走动是临时的。
 */
function startWalk(): void {
  if (walkTimer) return // 已在走，避免重复起定时器
  const win = petWindow
  if (!win || win.isDestroyed()) return
  // 开局方向：靠右半屏先往左、靠左半屏先往右，避免第一帧就撞边掉头
  try {
    const b = win.getBounds()
    const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
    walkDir = b.x + PET_WIN_W / 2 >= area.x + area.width / 2 ? -1 : 1
  } catch {
    walkDir = -1
  }
  walkPhase = 'run'
  walkTicks = 0
  walkPaused = false
  pushWalk(walkDir === 1 ? 'right' : 'left')
  walkTimer = setInterval(() => {
    const w = petWindow
    if (!w || w.isDestroyed()) {
      stopWalk()
      return
    }
    if (walkPaused) return
    const b = w.getBounds()
    if (walkPhase === 'rest') {
      walkTicks++
      if (walkTicks >= WALK_REST_TICKS) {
        walkPhase = 'run'
        walkTicks = 0
        pushWalk(walkDir === 1 ? 'right' : 'left')
      }
      return
    }
    // run：往当前方向挪一步
    const nx = b.x + walkDir * WALK_STEP_PX
    const clamped = clampPetPos({ x: nx, y: b.y }, PET_WIN_W, PET_WIN_H)
    // 想动却没动 = 撞到工作区左右边界 → 掉头，下一帧再走
    if (clamped.x === b.x && nx !== b.x) {
      walkDir = walkDir === 1 ? -1 : 1
      pushWalk(walkDir === 1 ? 'right' : 'left')
    } else {
      // 仍用 setBounds 显式带尺寸：125% 缩放下 setPosition 会让窗口越走越大（实测过）
      w.setBounds({ x: clamped.x, y: b.y, width: PET_WIN_W, height: PET_WIN_H })
    }
    walkTicks++
    if (walkTicks >= WALK_RUN_TICKS) {
      walkPhase = 'rest'
      walkTicks = 0
      pushWalk('idle')
    }
  }, WALK_TICK_MS)
}

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
    // 关键：movable 保持 true，主进程 setBounds 才生效；
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

  // 页面刚加载好时补发一次当前走动状态：startWalk 可能在渲染层还没挂上监听时就
  // 推过一次，那次会丢；这里补一发，保证 free 模式开窗后桌宠立刻是侧身走动的样子。
  win.webContents.on('did-finish-load', () => {
    if (walkEmit !== 'idle') win.webContents.send('pet:walk', walkEmit)
  })

  win.on('closed', () => {
    stopDrag()
    stopWalk()
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
  stopWalk()
  if (petWindow && !petWindow.isDestroyed()) petWindow.close()
  petWindow = null
}

/** 宠物窗口是否开着（e2e 与主进程内部判断用） */
export function isPetOpen(): boolean {
  return petWindow !== null && !petWindow.isDestroyed()
}

/**
 * 按当前 `petMode` 同步宠物窗口的存在与走动（SPEC-deskpet-out 第三节第 2、3、8 条
 * ＋ SPEC-deskpet-walk）。
 *
 * window / free 都开独立窗口；free 额外起走动定时器，window 则确保走动是停的。
 * 其余值（island，含缺省）关窗。这样手改 prefs.json 成 free 也不会出现
 * 「开着独立窗口但岛里也有桌宠」的怪状态。
 *
 * 每次偏好写入都会走到这里（onPrefsWritten），所以必须是幂等的：
 * openPetWindow 已开就只提一下，startWalk 已在走就直接返回，stopWalk 可重复调。
 */
export function syncPetWindow(): void {
  const mode = getPrefs().petMode ?? 'island'
  if (mode === 'window' || mode === 'free') {
    openPetWindow()
    if (mode === 'free') startWalk()
    else stopWalk()
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
    // 拖动期间冻结自动走动：两个定时器同时 setBounds 会互相抢位置。
    // 同时推 idle 让渲染层收起颠动、转回正面，别一边被拖着走一边还在迈步。
    walkPaused = true
    if (walkTimer) pushWalk('idle')
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
      // 用 setBounds 而不是 setPosition，必须带尺寸——这不是风格选择，是修 bug。
      //
      // 实测（2026-11-12）：本机 125% 缩放，连续调 200 次 setPosition，
      // 窗口从 191×191 一路长到 391×391。原因是 setPosition 只给坐标，
      // Electron 每次都得在 DIP 和物理像素之间换算，换算的余数被并进尺寸里，
      // 于是每动一次长 1px。拖动定时器 16ms 一轮，按住不动都会一直变大；
      // 尺寸涨的时候左上角不动、底边往下走，看起来就是「一直变大还往下跑」。
      // 同一个探针里 setBounds 显式带 width/height，200 次后尺寸纹丝不动。
      w.setBounds({ x: clamped.x, y: clamped.y, width: PET_WIN_W, height: PET_WIN_H })
    }, 16)
  })

  ipcMain.on('pet:drag-end', () => {
    const win = petWindow
    stopDrag()
    walkPaused = false // 松手后恢复自动走动（非 free 模式没有 walkTimer，无副作用）
    // 拖动时推过 idle，松手要按当前相位补回方向/停下状态，否则渲染层一直停在正面
    if (walkTimer) {
      pushWalk(walkPhase === 'rest' ? 'idle' : walkDir === 1 ? 'right' : 'left')
    }
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    savePos({ x: b.x, y: b.y })
  })

  // ---- 右键菜单 ----
  ipcMain.on('pet:show-menu', () => {
    const win = petWindow
    if (!win || win.isDestroyed()) return
    Menu.buildFromTemplate([
      // 动作入口（2026-11-12 追加）：用户点一下会笑，但「打滚」没有自然的
      // 鼠标手势能表达，硬塞成双击/长按会和拖动、转身抢。放菜单里最直观，
      // 以后加动作也只是往这里加一行。
      {
        label: '再来一次大笑',
        click: () => win.webContents.send('pet:action', 'laugh')
      },
      {
        label: '打个滚',
        click: () => win.webContents.send('pet:action', 'roll')
      },
      {
        label: '挥挥手',
        click: () => win.webContents.send('pet:action', 'wave')
      },
      { type: 'separator' },
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
