import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import Pet from '../pet/Pet'

/**
 * 桌宠独立小窗口的界面（SPEC-deskpet-out）。
 *
 * 这一屏只干四件事：画一只大尺寸的桌宠、按住身体能拖走、按住底部的旋转把手能转身、
 * 右键弹菜单。情绪固定 `idle`——它出门了自己一只，没有「勾完待办」这种事件可开心，
 * 硬接岛上的 mood 反而会让它莫名其妙弹一下（SPEC 第六节第 4 条）。
 *
 * 为什么拖动自己算而不给 CSS `-webkit-app-region: drag`：
 * 那个属性会让整块区域被系统当成标题栏吞掉，右键菜单收不到事件，
 * 也没法区分「按住拖动」和「点一下」——将来要做「点它一下有反应」就死路一条。
 * 这里改成 pointerdown 通知主进程开始跟光标，pointerup 通知停并落盘位置。
 *
 * ===== 两个把手，各管一件事（2026-11-12 第三轮，用户要求）=====
 * 用户原话：「我希望桌宠的下面有一个旋转的图标，按住它拖动鼠标可以旋转，
 * 平时碰到桌宠时图标才显现」。
 *
 * 所以把「移动」和「转身」彻底分开了：
 * - 按住**身体** = 把宠物挪到别处（窗口跟着光标走，它本人不转身）
 * - 按住**底部旋转图标** = 原地转身（窗口纹丝不动）
 *
 * 为什么必须分开：合成一个手势时，把宠物从屏幕这头拖到那头，路上它会转好几圈，
 * 摆到目标位置时朝向是随机的——这不是用户想要的。给个专门的把手，
 * 两个意图各归各位。
 *
 * 图标平时藏在 hover 之后（`opacity: 0`），鼠标碰到宠物才淡入，不打扰观感。
 */

/** 横向拖多少像素转四分之一圈。110 是试出来的——再小一点挪一下就转到背面了 */
const TURN_PX = 110
/** 视角总数（正面 / 侧左 / 背面 / 侧右） */
const VIEW_COUNT = 4

/**
 * 把「转过的四分之一圈数」换算成 `skinPhoto` 里的视图下标。
 *
 * 转数为正 = 顺时针（往右拖）= 露出右脸。
 * 下标顺序是 `front(0) / side-l(1) / back(2) / side-r(3)`，
 * 所以顺时针一格是 3 而不是 1——左右是反的，这里最容易搞混。
 */
function viewIndexFromQuarters(q: number): number {
  return ((-q % VIEW_COUNT) + VIEW_COUNT) % VIEW_COUNT
}

export default function PetWindowApp(): JSX.Element {
  const [skin, setSkin] = useState<string>('capsule')
  /** 仅用于视觉反馈（拖动中换光标）；判断「在不在拖」看下面的 ref */
  const [pressed, setPressed] = useState(false)
  /** 是否正在用底部把手转身（只影响把手自己的高亮） */
  const [rotating, setRotating] = useState(false)
  /**
   * 拖动状态用 ref 而不是 state。
   *
   * 为什么：`setPressed(true)` 是异步的（React 18 自动批处理），
   * pointerdown 和 pointerup 落在同一个事件循环里时（快速点一下、或者自动化点），
   * pointerup 的处理函数读到的 `pressed` 还是 false，松手事件就被吞了——
   * 主进程收不到 drag-end，窗口会一直粘在鼠标上（实测就是这么发现的）。
   * ref 是同步的，不受批处理影响。
   */
  const dragging = useRef(false)
  /** 把手转身的状态，同理用 ref */
  const turning = useRef(false)

  /** 已经转过的四分之一圈数（正值 = 顺时针），松手后保留 */
  const quarters = useRef(0)
  /** 本次按下时的起点，用来算位移与累加基准 */
  const turnStartX = useRef(0)
  const turnStartQ = useRef(0)

  /** 当前该显示哪一面（给 e2e 和 aria 看的可读值） */
  const [facing, setFacing] = useState(0)

  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((p) => {
        if (alive && typeof p.petSkin === 'string') setSkin(p.petSkin)
      })
      .catch(() => {
        /* 读不到就用默认皮肤，不阻塞显示 */
      })
    // 设置页换皮肤后这个窗口要跟着换（宠物已经出门了，不能让它在外面还是旧形象）
    const off = window.island.onPrefsChanged((p) => {
      if (typeof p.petSkin === 'string') setSkin(p.petSkin)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 把累加的转角推给皮肤层（皮肤自己管淡入淡出，这里只负责说「看哪面」） */
  const applyFacing = (q: number): void => {
    quarters.current = q
    const i = viewIndexFromQuarters(q)
    setFacing(i)
    window.dispatchEvent(new CustomEvent('pet:turn-abs', { detail: i }))
  }

  // ---------- 身体：拖动 = 移动窗口 ----------
  const onPointerDown = (e: React.PointerEvent): void => {
    // 只接左键：右键留给菜单，中键不做事
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    setPressed(true)
    window.island.petDragStart()
    // 指针捕获：鼠标甩得快、移出窗口时仍能收到 pointerup，
    // 否则松手事件丢了会一直处于「拖动中」，窗口粘在鼠标上。
    // 用 try/catch：某些合成事件里 pointerId 没有对应的活动指针，会抛 NotFoundError。
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* 捕获失败不影响拖动本身，主进程照样跟光标 */
    }
  }

  const endDrag = (): void => {
    if (!dragging.current) return
    dragging.current = false
    setPressed(false)
    window.island.petDragEnd()
  }

  // ---------- 底部把手：拖动 = 转身 ----------
  const onRotorDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    // 拦住冒泡，否则会同时触发身体的 window 拖动——转个身把宠物拖着跑，很怪
    e.preventDefault()
    e.stopPropagation()
    turning.current = true
    setRotating(true)
    turnStartX.current = e.screenX
    turnStartQ.current = quarters.current
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* 同上：合成事件里指针可能不存在 */
    }
  }

  const onRotorMove = (e: React.PointerEvent): void => {
    if (!turning.current) return
    // 必须用 screenX：窗口会跟着光标走（移动时），光标在窗口内的相对位置几乎不变，
    // clientX 全程是同一个数，拿它算位移永远是 0。这个坑踩过一次。
    const dx = e.screenX - turnStartX.current
    if (!Number.isFinite(dx)) return
    // 四舍五入而不是取整：往左拖时 floor 会让第一格要多拖一点才触发，手感不匀
    const q = turnStartQ.current + Math.round(dx / TURN_PX)
    if (q !== quarters.current) applyFacing(q)
  }

  const endRotor = (): void => {
    if (!turning.current) return
    turning.current = false
    setRotating(false)
  }

  return (
    <div
      className={`petwin ${pressed ? 'dragging' : ''}`}
      data-pet-skin={skin}
      data-pet-facing={facing}
      onPointerDown={onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 双击转回正面：转歪了想让它重新面对你，不用去设置里折腾
      onDoubleClick={() => applyFacing(0)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        window.island.petShowMenu()
      }}
      role="button"
      tabIndex={0}
      aria-label="桌宠，按住身体可拖动，按住底部图标左右拖动会让它转身，双击转回正面，右键打开菜单"
    >
      <Pet skin={skin} mood="idle" size="full" />

      {/* 底部旋转把手。平时 opacity:0，鼠标碰到宠物才出现（见 petwin.css）。
          单独做一个元素而不是复用手势：移动和转身是两个意图，混在一起会互相干扰。 */}
      <div
        className={`pet-rotor ${rotating ? 'rotating' : ''}`}
        data-rotor="rotate"
        onPointerDown={onRotorDown}
        onPointerMove={onRotorMove}
        onPointerUp={endRotor}
        onPointerCancel={endRotor}
        // 右键落在把手上：交给窗口的菜单，不要弹系统菜单
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          window.island.petShowMenu()
        }}
        role="button"
        tabIndex={-1}
        aria-label="旋转桌宠，按住左右拖动"
        title="按住左右拖动，可以让它转身"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          {/* 圆弧 + 箭头：通用的「旋转」符号，不用写字就能看懂 */}
          <path
            d="M20 12a8 8 0 1 1-2.34-5.66"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path
            d="M20 4.2v5.2h-5.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}
