import { BrowserWindow, Menu, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import {
  clampPetPos,
  defaultPetPos,
  getPrefs,
  onPrefsWritten,
  patchPrefs,
  PET_IMG_PAD_X,
  PET_IMG_PAD_Y
} from './prefsStore'
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

// ===== 自由走动（SPEC-deskpet-walk / SPEC-deskpet-walk-polish / SPEC-deskpet-walk-roam）=====
/** 走动定时器步长：50ms 一帧（约 20 帧/秒），够顺滑又不烧 CPU */
const WALK_TICK_MS = 50
/** 默认每帧位移（DIP）：2px × 20 帧 = 40px/秒；随机漫步每段会在 1~3px 间重新抽 */
const WALK_STEP_PX = 2
/** 默认停下时长（帧）：30 帧 ≈ 1.5 秒；随机漫步每段会在 10~60 帧（0.5~3 秒）间重新抽 */
const WALK_REST_TICKS = 30

/**
 * 首段「贴边」用的 4 个纯方向：右 / 下 / 左 / 上（下标也就是目标边）。
 *
 * 2026-11-14 m02126 反馈「贴边不行」后定为巡边：开局朝最近的一条边直走、
 * 真的贴住才停，让用户几秒内看到桌宠贴到屏幕边。m02689 又反馈「一直绕屏幕
 * 走没有什么不同」，本轮（SPEC-deskpet-walk-roam）把「停完以后」改成随机漫步：
 * 只保留首段这一次贴边，之后换成随机目标，不再四边固定循环。
 */
const WALK_DIRS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 }
]

type WalkDir = 'left' | 'right' | 'up' | 'down' | 'idle'

/** 当前实际移动方向的符号（供 currentWalkDir() 与拖动松手后补发用） */
let walkVec: { dx: number; dy: number } = { dx: -1, dy: 0 }
/** 首段贴边的目标边编号（0 右 / 1 下 / 2 左 / 3 上） */
let walkSeq = 0
/** 'edge' = 首段朝最近边直走贴住；'roam' = 之后朝随机目标漫步 */
let walkMode: 'edge' | 'roam' = 'edge'
/** 当前随机目标点（窗口左上角坐标）；edge 段为 null */
let walkTarget: PetWindowPos | null = null
/** 本段停下多少帧 / 每帧走多少 px，每段随机抽，节奏不再固定 */
let walkRestTicks = WALK_REST_TICKS
let walkStep = WALK_STEP_PX
let walkTimer: NodeJS.Timeout | null = null
let walkPhase: 'run' | 'rest' = 'run'
let walkTicks = 0
/** 用户正在拖窗口：冻结自动走动，免得 16ms drag 与 50ms walk 同时 setBounds 打架 */
let walkPaused = false
/** 最近一次推给渲染层的方向/状态（渲染层挂载后补发用） */
let walkEmit: WalkDir = 'idle'

/** 方向分量 → 方向名。斜向时横向优先（侧视更自然，也避开 dx/dy 相等时分不出主导） */
function dirOf(dx: number, dy: number): WalkDir {
  if (dx > 0) return 'right'
  if (dx < 0) return 'left'
  if (dy > 0) return 'down'
  if (dy < 0) return 'up'
  return 'idle'
}
function currentWalkDir(): WalkDir {
  return dirOf(walkVec.dx, walkVec.dy)
}

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
 * 走动的边界（SPEC-deskpet-walk-polish）：按「桌宠图片」算，不按整窗。
 *
 * 留白常量在 prefsStore.ts 的 PET_IMG_PAD_X / PET_IMG_PAD_Y，与拖动、重启用的
 * clampPetPos() 共用一份——用户 2026-11-14 反馈「独立小窗口也碰不到边」后统一，
 * 三个入口（拖动 / 重启 / 自动走动）不会再出现两套边界。
 *
 * 换算依据见 prefsStore.ts 的常量注释：窗口 190×250 里图片约左 45、右 145、
 * 顶 42、底 208；让这段透明留白越出工作区，图片边缘正好贴住屏幕边。
 */
interface WalkLimits {
  minX: number
  maxX: number
  minY: number
  maxY: number
}
interface WalkArea {
  x: number
  y: number
  width: number
  height: number
}
function walkLimits(): WalkLimits {
  const win = petWindow
  let area: WalkArea
  try {
    const b = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0 }
    area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  } catch {
    area = screen.getPrimaryDisplay().workArea
  }
  return {
    // 窗口左边可越出工作区 PET_IMG_PAD_X，图片左边缘正好贴 area.x
    minX: area.x - PET_IMG_PAD_X,
    // 窗口右边可越出工作区 PET_IMG_PAD_X，图片右边缘正好贴 area.x+area.width
    maxX: area.x + area.width - (PET_WIN_W - PET_IMG_PAD_X),
    minY: area.y - PET_IMG_PAD_Y,
    maxY: area.y + area.height - (PET_WIN_H - PET_IMG_PAD_Y)
  }
}

/**
 * 随机挑下一个目标点（SPEC-deskpet-walk-roam，用户 m02689「一直绕屏幕走没什么不同」）：
 * 约三成概率把某一轴钉在边极限上（保留「偶尔也能贴边」），另一轴随机；
 * 其余落在屏幕内部随机点。目标始终在 walkLimits() 的允许范围内。
 * 每次停下后重新抽，路线不再固定循环。
 */
function pickRoamTarget(lim: WalkLimits): PetWindowPos {
  const rx = (): number => lim.minX + Math.random() * (lim.maxX - lim.minX)
  const ry = (): number => lim.minY + Math.random() * (lim.maxY - lim.minY)
  if (Math.random() < 0.3) {
    const side = Math.floor(Math.random() * 4)
    if (side === 0) return { x: lim.maxX, y: ry() }
    if (side === 1) return { x: lim.minX, y: ry() }
    if (side === 2) return { x: rx(), y: lim.maxY }
    return { x: rx(), y: lim.minY }
  }
  return { x: rx(), y: ry() }
}

/** 抽本段的随机节奏：停下 0.5~3 秒、每帧走 1~3px，不再固定 1.5 秒 + 40px/秒 */
function randomizeWalkPace(): void {
  walkRestTicks = 10 + Math.floor(Math.random() * 51)
  walkStep = 1 + Math.floor(Math.random() * 3)
}

/**
 * 开走动：只在 free 模式、且窗口已存在时调。
 *
 * 2026-11-14 m02689「一直绕屏幕走没有什么不同」后改成随机漫步：
 * 首段仍朝离当前位置最近的一条边直走、真的贴住才停（保住「两个统一，都可以碰边」
 * 的验收语义，也让 e2e P13g 四条边运行时贴边断言成立）；贴边停下后切到 roam：
 * 每段用 pickRoamTarget() 随机挑一个目标点（约三成贴边、其余在屏幕内部），
 * 以随机步速朝它直走（可斜走），到了随机停一会儿再换目标，路线不再固定循环。
 *
 * 位置始终在 walkLimits() 的「桌宠图片」边界内：图片上下各留 42px、左右各留 45px
 * 透明区，允许越出工作区，贴边时窗口 y 可到 area.y-42，桌宠头顶正好贴屏幕上边。
 * 不逐帧写盘：位置只在用户拖动松手时落盘。
 */
function startWalk(): void {
  if (walkTimer) return // 已在走，避免重复起定时器
  const win = petWindow
  if (!win || win.isDestroyed()) return
  // 首段：选「离当前位置最近、且还没贴住」的那条边当目标，几秒内就能看到贴边
  try {
    const b = win.getBounds()
    const lim = walkLimits()
    const dist = [
      lim.maxX - b.x, // 右
      lim.maxY - b.y, // 下
      b.x - lim.minX, // 左
      b.y - lim.minY // 上
    ]
    let best = -1
    for (let i = 0; i < 4; i++) {
      if (dist[i] <= 0) continue // 已经贴住的边跳过
      if (best < 0 || dist[i] < dist[best]) best = i
    }
    walkSeq = best < 0 ? 0 : best
  } catch {
    walkSeq = 0
  }
  walkVec = { ...WALK_DIRS[walkSeq] }
  walkMode = 'edge'
  walkTarget = null
  randomizeWalkPace()
  walkPhase = 'run'
  walkTicks = 0
  walkPaused = false
  pushWalk(currentWalkDir())
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
      if (walkTicks >= walkRestTicks) {
        walkPhase = 'run'
        walkTicks = 0
        randomizeWalkPace()
        // 首段贴边完成后切到 roam，之后每段都重新随机挑目标
        walkMode = 'roam'
        const tgt = pickRoamTarget(walkLimits())
        walkTarget = tgt
        walkVec = {
          dx: Math.sign(tgt.x - b.x),
          dy: Math.sign(tgt.y - b.y)
        }
        pushWalk(currentWalkDir())
      }
      return
    }
    // run：朝当前目标（首段是边、之后是随机点）走，到了就停
    const lim = walkLimits()
    let nx: number
    let ny: number
    let reached: boolean
    if (walkMode === 'edge' && walkTarget === null) {
      // 首段贴边：沿纯方向一直走，撞到那条边才算到达
      nx = b.x + walkVec.dx * walkStep
      ny = b.y + walkVec.dy * walkStep
      switch (walkSeq) {
        case 0:
          reached = nx >= lim.maxX
          if (reached) nx = lim.maxX
          break
        case 1:
          reached = ny >= lim.maxY
          if (reached) ny = lim.maxY
          break
        case 2:
          reached = nx <= lim.minX
          if (reached) nx = lim.minX
          break
        default:
          reached = ny <= lim.minY
          if (reached) ny = lim.minY
          break
      }
    } else {
      // 随机漫步：朝目标点直走（可斜走），两轴距离进一帧步长内算到达
      const tgt = walkTarget as PetWindowPos
      const dx = tgt.x - b.x
      const dy = tgt.y - b.y
      const dist = Math.hypot(dx, dy)
      reached = dist <= walkStep
      if (reached) {
        nx = tgt.x
        ny = tgt.y
      } else {
        nx = b.x + (dx / dist) * walkStep
        ny = b.y + (dy / dist) * walkStep
      }
    }
    nx = Math.min(lim.maxX, Math.max(lim.minX, nx))
    ny = Math.min(lim.maxY, Math.max(lim.minY, ny))
    // 仍用 setBounds 显式带尺寸：125% 缩放下 setPosition 会让窗口越走越大（实测过）
    w.setBounds({
      x: Math.round(nx),
      y: Math.round(ny),
      width: PET_WIN_W,
      height: PET_WIN_H
    })
    if (reached) {
      walkPhase = 'rest'
      walkTicks = 0
      pushWalk('idle') // 停下转正面，让用户看清它到地方了
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
      pushWalk(walkPhase === 'rest' ? 'idle' : currentWalkDir())
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
