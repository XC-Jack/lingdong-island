import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import Pet from '../pet/Pet'

/**
 * 桌宠独立小窗口的界面（SPEC-deskpet-out）。
 *
 * 这一屏只干三件事：画一只大尺寸的桌宠、按住能拖、右键弹菜单。
 * 情绪固定 `idle`——它出门了自己一只，没有「勾完待办」这种事件可开心，
 * 硬接岛上的 mood 反而会让它莫名其妙弹一下（SPEC 第六节第 4 条）。
 *
 * 为什么拖动自己算而不给 CSS `-webkit-app-region: drag`：
 * 那个属性会让整块区域被系统当成标题栏吞掉，右键菜单收不到事件，
 * 也没法区分「按住拖动」和「点一下」——将来要做「点它一下有反应」就死路一条。
 * 这里改成 pointerdown 通知主进程开始跟光标，pointerup 通知停并落盘位置。
 */

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

  return (
    <div
      className={`petwin ${pressed ? 'dragging' : ''}`}
      data-pet-skin={skin}
      onPointerDown={onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        window.island.petShowMenu()
      }}
      role="button"
      tabIndex={0}
      aria-label="桌宠，按住可拖动，右键打开菜单"
    >
      <Pet skin={skin} mood="idle" size="full" />
    </div>
  )
}
