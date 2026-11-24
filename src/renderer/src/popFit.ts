/**
 * 让岛为「岛内浮层」让出高度（SPEC-island-popover-clip）。
 *
 * ## 为什么需要
 *
 * 岛里的两个弹层——置物架「视图」菜单、待办/日程的「时间选择」面板——都是
 * `position: absolute`（浮层不参与父级内容高度）。而岛自从 2026-11-16 改成
 * 「随内容自适应尺寸」之后：
 *
 *   · `.island` 是 `height: max-content` + **`overflow: hidden`**；
 *   · 主进程的窗口尺寸 = 渲染层量出来的岛尺寸（透明窗口外面什么都没有）。
 *
 * 于是弹层一旦越过岛底，就会被裁掉、而且**落在窗口外面，指针事件根本到不了**。
 * 2026-11-22 用户实测（空置物架页）：
 *   · 视图菜单四项里后两项（小图标 146–168、列表 168–189）在窗口（高 156）之外 → 点不到；
 *   · 时间选择面板共 137 高、底边 242，窗口只有 188 → 24 个小时里只有 3 行可达。
 *
 * ## 怎么做
 *
 * 打开浮层时量出「浮层底边 − 岛底边」的视觉像素差，按实测的缩放比例换算成布局 px，
 * 写进岛根元素的 CSS 变量 `--pop-extra`；CSS 里 `.island.expanded` 的
 * `padding-bottom: calc(20px + var(--pop-extra, 0px))` 把岛撑高。岛一高，
 * 既有的 ResizeObserver（App.tsx 的尺寸上报）会把新尺寸报给主进程，窗口跟着长。
 * 关闭时清掉变量，岛自动缩回。
 *
 * 换算比例用**实测值**（`offsetHeight / getBoundingClientRect().height`），不写死 0.75：
 * `.app` 上的 `zoom` 以后改了也不用同步改这里。
 *
 * 用法：`useEffect(() => { if (!open) return; return fitIslandToPopover(ref.current) }, [open])`
 *
 * 可以一次传多个浮层（日程页：当日安排浮层里还套着时间选择面板），按最靠下的底边补偿；
 * 两个浮层各自写 `--pop-extra` 会互相覆盖，所以必须合并成一次测量。
 *
 * @returns 清理函数（清掉补偿并取消排队的测量）
 */
export function fitIslandToPopover(pop: HTMLElement | null, ...others: (HTMLElement | null)[]): () => void {
  const pops = [pop, ...others].filter((p): p is HTMLElement => p !== null)
  if (pops.length === 0) return () => {}
  const island = (pops[0].closest('.island') ?? document.querySelector('.island')) as HTMLElement | null
  if (!island) return () => {}

  let raf1 = 0
  let raf2 = 0
  let timer = 0

  const apply = (): void => {
    // 先清掉再量：上一轮已经撑高的岛会让「浮层底 − 岛底」变成 0，越量越矮。
    // 清掉与重新设置发生在同一个任务里，布局只会结算一次，ResizeObserver 不会看到中间态。
    island.style.removeProperty('--pop-extra')
    const ir = island.getBoundingClientRect()
    const bottom = Math.max(...pops.map((p) => p.getBoundingClientRect().bottom))
    if (ir.height <= 0) return
    // 视觉 px → 布局 px 的换算：offsetHeight 是布局 px，getBoundingClientRect().height 是视觉 px
    // （`.app` 上 zoom 0.75）。比例用实测值，不写死 0.75。
    const perLayout = island.offsetHeight > 0 ? ir.height / island.offsetHeight : 1
    const extra = bottom - ir.bottom
    if (extra <= 0.5) return // 本来就没超出，不用补偿
    island.style.setProperty('--pop-extra', `${Math.ceil(extra / perLayout)}px`)
  }

  // 浮层开在 .page-fade 的 180ms 淡入动画里，位置还在变：先量一次，再在动画后再量两次兜底
  apply()
  raf1 = requestAnimationFrame(() => {
    apply()
    raf2 = requestAnimationFrame(apply)
  })
  timer = window.setTimeout(apply, 260)

  return () => {
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
    window.clearTimeout(timer)
    island.style.removeProperty('--pop-extra')
  }
}
