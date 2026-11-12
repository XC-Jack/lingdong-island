import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import Pet from '../pet/Pet'

/**
 * 桌宠独立小窗口的界面（SPEC-deskpet-out）。
 *
 * 这一屏只干四件事：画一只大尺寸的桌宠、按住能拖、拖动时跟着转身、右键弹菜单。
 * 情绪固定 `idle`——它出门了自己一只，没有「勾完待办」这种事件可开心，
 * 硬接岛上的 mood 反而会让它莫名其妙弹一下（SPEC 第六节第 4 条）。
 *
 * 为什么拖动自己算而不给 CSS `-webkit-app-region: drag`：
 * 那个属性会让整块区域被系统当成标题栏吞掉，右键菜单收不到事件，
 * 也没法区分「按住拖动」和「点一下」——将来要做「点它一下有反应」就死路一条。
 * 这里改成 pointerdown 通知主进程开始跟光标，pointerup 通知停并落盘位置。
 *
 * ===== 拖动转身（2026-11-12 追加，见 SPEC-deskpet-turn）=====
 * 用户原话：「我希望我可以用鼠标来让它转身，22 秒转一次感觉很怪」。
 *
 * 所以自动转身删了，改成**横向拖动驱动**：按住往右拖，它顺时针转（露出右脸）；
 * 往左拖，逆时针转。每 110px 转四分之一圈，转过的角度一直累加，松手停在当前那面。
 * 转过一整圈回到正面，所以拖多远都不会转飞。
 *
 * 为什么用 `screenX` 而不是 `clientX`：窗口是**跟着光标走**的（主进程每 16ms
 * 把窗口挪到光标位置），所以光标在窗口内的相对位置几乎不变，`clientX` 全程是常数，
 * 拿它算位移永远是 0。`screenX` 是屏幕坐标，只有它在动。
 *
 * 为什么转角累加、松手保留：用户要的是「我让它转」，不是「我拖一下它自己转回来」。
 * 站哪儿、朝哪儿都由用户决定，这才是它像一只宠物的地方。
 * 想让它重新面对你：双击它。
 */

/** 横向拖多少像素转四分之一圈。110 是试出来的——再小一点挪个位置就转到背面了 */
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
  return (((-q % VIEW_COUNT) + VIEW_COUNT) % VIEW_COUNT) as number
}

export default function PetWindowApp(): JSX.Element {
  const [skin, setSkin] = useState<string>('capsule')
  /** 仅用于视觉反馈（拖动中换光标）；判断「在不在拖」看下面的 ref */
  const [pressed, setPressed] = useState(false)
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

  /** 已经转过的四分之一圈数（正值 = 顺时针），松手后保留 */
  const quarters = useRef(0)
  /** 本次按下时的起点，用来算位移与累加基准 */
  const dragStartX = useRef(0)
  const dragStartQ = useRef(0)

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

  const onPointerDown = (e: React.PointerEvent): void => {
    // 只接左键：右键留给菜单，中键不做事
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    setPressed(true)
    dragStartX.current = e.screenX
    dragStartQ.current = quarters.current
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

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    const dx = e.screenX - dragStartX.current
    if (!Number.isFinite(dx)) return
    // 四舍五入而不是取整：往左拖时 floor 会让第一格要多拖一点才触发，手感不匀
    const q = dragStartQ.current + Math.round(dx / TURN_PX)
    if (q !== quarters.current) applyFacing(q)
  }

  const endDrag = (): void => {
    if (!dragging.current) return
    dragging.current = false
    setPressed(false)
    window.island.petDragEnd()
  }

  return (
    <div
      className={`petwin ${pressed ? 'dragging' : ''}`}
      data-pet-skin={skin}
      data-pet-facing={facing}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 双击转回正面：拖歪了想让它重新面对你，不用去设置里折腾
      onDoubleClick={() => applyFacing(0)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        window.island.petShowMenu()
      }}
      role="button"
      tabIndex={0}
      aria-label="桌宠，按住可拖动，左右拖动会让它转身，双击转回正面，右键打开菜单"
    >
      <Pet skin={skin} mood="idle" size="full" />
    </div>
  )
}
