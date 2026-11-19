import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Todo, ShelfItem, MusicState, MusicCommand, LyricResult, ClockFormat } from '../../shared/types'
import Pet from './pet/Pet'
/** 收起 700ms 后自动收回，给鼠标留出移入面板的时间 */
const AUTO_COLLAPSE_MS = 700

/** 通知页数据结构（与 preload/notifyStore 保持一致；独立声明避免跨 tsconfig project 引用） */
interface NotifyItem {
  id: number
  order: number
  app: string
  /** 应用图标 PNG 绝对路径（file:// 显示）；解析失败为 null（退回应用名文字徽标） */
  icon: string | null
  title: string
  body: string
  arrival: number
  /** toast 的 launch 深链（点击直达来源界面）；无属性为 null */
  launch: string | null
}

interface NotifyListResult {
  items: NotifyItem[]
  unread: number
  /** 已读水位（美化-04）：`item.order > lastOrder` 即未读，用来画蓝点 */
  lastOrder: number
}

/** 日程条目（与 preload/scheduleStore 保持一致） */
interface ScheduleItem {
  id: string
  text: string
  day: string // 'YYYY-MM-DD'
  time: string | null
  done: boolean
  reminded: boolean
  createdAt: number
}

/** 网络快照（收起态 US-005，与主进程 statusStore 保持一致；独立声明避免跨 tsconfig project 引用） */
interface WifiSnapshot {
  connected: boolean
  online: boolean
  name: string | null
  /** 连接方式：'wifi' 无线 / 'ethernet' 网线（插了网线显示网线图标，不显示 Wi-Fi 弧线） */
  kind: 'wifi' | 'ethernet'
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 时钟文本（SPEC-clock-date-format）。顺序固定：日期 → 星期 → 时间
 * （用户 2026-11-18「日期第一位，其次星期，然后时间」）。
 * 日期用「M月D日」不带年份：收起态胶囊只有一行，年份没人看还占宽度；
 * 用户 2026-11-18 明确不要斜杠（「我不要斜杠，给我月日」）。
 * 不带格式参数时保持原来的 `HH:mm`，待办/日程的「已过期」比较继续用它。
 */
function formatClock(d: Date, fmt: ClockFormat = 'time'): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const hm = `${hh}:${mm}`
  if (fmt === 'time') return hm
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return fmt === 'date' ? `${md} ${hm}` : `${md} ${WEEKDAY_NAMES[d.getDay()]} ${hm}`
}

/** 本地日期键 'YYYY-MM-DD'。不能用 toISOString：那是 UTC，东八区凌晨会差一天 */
function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 置物架视图的四种形态 */
type ShelfView = 'lg' | 'md' | 'sm' | 'list'

/** 收起态可裁剪组件的键（与勾选 UI 一一对应） */
const COLLAPSED_KEYS = ['pet', 'clock', 'battery', 'net', 'todo', 'bell'] as const
type CollapsedKey = (typeof COLLAPSED_KEYS)[number]

/** 收起态组件的默认顺序（美化-02）：电量 → 岛仔 → 时钟 → 网络 → 待办 → 铃铛 */
const DEFAULT_COLLAPSED_ORDER: CollapsedKey[] = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

/** 完成度圆环的周长（r=9，2πr≈56.55）：stroke-dasharray 用它，dashoffset 按比例回退（美化-04） */
const RING_CIRC = 2 * Math.PI * 9

/**
 * 页面裁剪偏好：pages 是显示的页面索引集合，collapsed 是收起态组件开关，
 * order 是收起态组件从左到右的顺序（美化-02，用户可拖动调整）。
 */
interface PagesCustom {
  pages: number[]
  collapsed: Record<CollapsedKey, boolean>
  order: CollapsedKey[]
}

/** 默认全开（5 页 + 6 个收起态组件）+ 默认顺序 */
function defaultPagesCustom(): PagesCustom {
  return {
    pages: [0, 1, 2, 3, 4],
    collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
    order: [...DEFAULT_COLLAPSED_ORDER]
  }
}

/**
 * 规整收起态组件顺序（美化-02）：只保留合法键并去重，再把缺失的键按默认顺序补到末尾。
 * 为什么必须补全而不是丢弃：order 是「渲染清单」——少一个键该组件就永远不显示；
 * 旧版 prefs 没有 order、或用户手改坏了，都不该让组件消失，按默认位置补回即可。
 */
function normalizeOrder(v: unknown): CollapsedKey[] {
  const arr = Array.isArray(v) ? v : []
  const seen = new Set<CollapsedKey>()
  const out: CollapsedKey[] = []
  for (const item of arr) {
    if (typeof item === 'string' && (COLLAPSED_KEYS as readonly string[]).includes(item)) {
      const k = item as CollapsedKey
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  for (const k of DEFAULT_COLLAPSED_ORDER) if (!seen.has(k)) out.push(k)
  return out
}

/**
 * 校验并规整页面裁剪偏好（US-032 / 美化-02）。数据存主进程 userData/prefs.json（经 IPC 读写）。
 * 为什么不用渲染层 localStorage：本机实测 file:// 来源的 localStorage 跨进程重启会丢失
 * （写入后优雅退出再启动读回为 null），裁剪偏好必须跨重启保留。
 * 值不合法（手工改坏/缺字段/全空页面）一律回落默认全开。
 */
function normalizePagesCustom(v: unknown): PagesCustom | null {
  if (!v || typeof v !== 'object') return null
  const raw = v as Partial<PagesCustom>
  // 顺序即用户自定义的页面顺序（US-032 反馈）：只做去重 + 范围校验 + 非空，不排序。
  const pages = Array.isArray(raw.pages)
    ? [...new Set(raw.pages.filter((n) => Number.isInteger(n) && n >= 0 && n <= 4))]
    : []
  if (pages.length === 0) return null
  const collapsed = defaultPagesCustom().collapsed
  if (raw.collapsed && typeof raw.collapsed === 'object') {
    for (const k of COLLAPSED_KEYS) {
      if (typeof raw.collapsed[k] === 'boolean') collapsed[k] = raw.collapsed[k]
    }
  }
  return { pages, collapsed, order: normalizeOrder(raw.order) }
}

/**
 * 置物架视图记忆（US-037）：存主进程 prefs.json（经 prefs:get/prefs:set IPC）。
 * 为什么不用渲染层 localStorage：本机实测 file:// 来源的 localStorage 跨进程重启
 * 会丢失（写入后优雅退出再启动读回为 null，本机约束与踩坑.md:52），视图选择必须
 * 跨重启保留——与 US-032 页面裁剪同一存储通道。组件 mount 后异步回填。
 */

/** 线性小图标（stroke 继承 currentColor，替代 emoji：跨平台渲染一致、可随主题着色、任意缩放不糊） */
function IconSvg({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

/** 对勾（待办页） */
const IcoCheck = (): React.JSX.Element => (
  <IconSvg>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </IconSvg>
)

/** 分格收纳（置物架页） */
const IcoShelf = (): React.JSX.Element => (
  <IconSvg>
    <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
    <path d="M3.5 12h17M12 4v8" />
  </IconSvg>
)

/** 铃铛（通知页） */
const IcoBell = (): React.JSX.Element => (
  <IconSvg>
    <path d="M12 4a5.5 5.5 0 0 0-5.5 5.5v3l-1.4 2.4a.8.8 0 0 0 .7 1.2h12.4a.8.8 0 0 0 .7-1.2l-1.4-2.4v-3A5.5 5.5 0 0 0 12 4z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </IconSvg>
)

/** 实心铃铛（收起态美化-01）：白色填充铃铛，贴合用户参考图（黑底白铃铛+红点） */
const IcoBellSolid = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 3a6 6 0 0 0-6 6v2.8l-1.5 2.6a1 1 0 0 0 .87 1.5h13.26a1 1 0 0 0 .87-1.5L18 11.8V9a6 6 0 0 0-6-6z"
    />
    <path fill="currentColor" d="M9.8 17.6a2.3 2.3 0 0 0 4.4 0z" />
  </svg>
)

/** Wi-Fi（收起态 US-005）：三段弧线信号图标 */
const IcoWifi = (): React.JSX.Element => (
  <IconSvg>
    <path d="M2.5 9.5a14 14 0 0 1 19 0" />
    <path d="M5.5 13a9.5 9.5 0 0 1 13 0" />
    <path d="M8.5 16.5a5 5 0 0 1 7 0" />
    <circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none" />
  </IconSvg>
)

/**
 * 无网络（用户 2026-11-19 参考图；同日「图标做的太丑了，你参考一下本机的」「完全对不上」）：
 * 不再手绘——直接用 Windows 自己画任务栏图标用的那个字形 U+F384
 * （Segoe Fluent Icons「地球 + 禁止符」，本机字体里按像素比对确认，相似度 0.78，远超其它候选）。
 * 与网线 U+E839 同一做法：字形由系统字体提供，观感与任务栏完全一致。
 * 字形本身铺满 em 框，所以字号单独收到 15px，视觉尺寸与旁边 18px 视框的 Wi-Fi 弧线相当。
 */
const IcoNoNet = (): React.JSX.Element => (
  <span className="fluent-ico nonet-glyph" aria-hidden="true">&#xF384;</span>
)

/**
 * 网线（收起态 US-005 插网线时）：直接用 Windows 系统图标字体里的以太网字形（U+E839）。
 *
 * 2026-11-18 用户「原图标太丑了，换成系统自带的」：原来手绘的 RJ45 插口在 18px 下
 * 糊成一团，看不出是网线。系统字形本身就是「显示器 + 网线插头」，与 Windows 设置页的
 * 以太网图标一致；Win10 的 Segoe MDL2 Assets 也带同一码位，字体链里做了回落。
 */
const IcoEthernet = (): React.JSX.Element => (
  <span className="fluent-ico" aria-hidden="true">&#xE839;</span>
)

/** 日历（日程页） */
const IcoCal = (): React.JSX.Element => (
  <IconSvg>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </IconSvg>
)

/** 音符（音乐页）：实心音符更适合做控制条前缀 */
const IcoMusic = (): React.JSX.Element => (
  <IconSvg>
    <path d="M9 18V6.5l9-2v11" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="15.5" cy="15.5" r="2.5" />
  </IconSvg>
)

/** 上一首 / 下一首 / 播放 / 暂停（音乐页控制按钮） */
const IcoPrev = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
    <rect x="5" y="6" width="2.2" height="12" rx="1" />
    <path d="M19 6.6v10.8a.8.8 0 0 1-1.24.67l-8.1-5.4a.8.8 0 0 1 0-1.34l8.1-5.4A.8.8 0 0 1 19 6.6z" />
  </svg>
)

const IcoNext = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
    <rect x="16.8" y="6" width="2.2" height="12" rx="1" />
    <path d="M5 6.6v10.8a.8.8 0 0 0 1.24.67l8.1-5.4a.8.8 0 0 0 0-1.34l-8.1-5.4A.8.8 0 0 0 5 6.6z" />
  </svg>
)

const IcoPlay = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
    <path d="M8 5.6v12.8a.9.9 0 0 0 1.38.76l9.6-6.4a.9.9 0 0 0 0-1.52l-9.6-6.4A.9.9 0 0 0 8 5.6z" />
  </svg>
)

const IcoPause = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
    <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
  </svg>
)

/** 小喇叭（音量行图标） */
const IcoVolume = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 6a8.5 8.5 0 0 1 0 12" />
  </svg>
)

/** 文件夹（在文件夹中显示） */
const IcoFolder = (): React.JSX.Element => (
  <IconSvg>
    <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </IconSvg>
)

/** 列表视图（三行点线） */
const IcoList = (): React.JSX.Element => (
  <IconSvg>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.8" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.8" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.8" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
  </IconSvg>
)

/** 大图标视图（四宫格） */
const IcoGrid = (): React.JSX.Element => (
  <IconSvg>
    <rect x="4" y="4" width="7" height="7" rx="1.6" />
    <rect x="13" y="4" width="7" height="7" rx="1.6" />
    <rect x="4" y="13" width="7" height="7" rx="1.6" />
    <rect x="13" y="13" width="7" height="7" rx="1.6" />
  </IconSvg>
)

/** 中图标视图（九宫格缺角，与大图标区分） */
const IcoGridMd = (): React.JSX.Element => (
  <IconSvg>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
    <rect x="8.75" y="8.75" width="6.5" height="6.5" rx="1.4" />
  </IconSvg>
)

/** 小图标视图（密集点阵，与小图标区分） */
const IcoGridSm = (): React.JSX.Element => (
  <IconSvg>
    <rect x="4" y="4" width="4.5" height="4.5" rx="1" />
    <rect x="9.75" y="4" width="4.5" height="4.5" rx="1" />
    <rect x="15.5" y="4" width="4.5" height="4.5" rx="1" />
    <rect x="4" y="9.75" width="4.5" height="4.5" rx="1" />
    <rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1" />
    <rect x="15.5" y="9.75" width="4.5" height="4.5" rx="1" />
    <rect x="4" y="15.5" width="4.5" height="4.5" rx="1" />
    <rect x="9.75" y="15.5" width="4.5" height="4.5" rx="1" />
    <rect x="15.5" y="15.5" width="4.5" height="4.5" rx="1" />
  </IconSvg>
)

/** 时钟（日程时间选择按钮，点它弹原生时间选择器） */
const IcoClock = (): React.JSX.Element => (
  <IconSvg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </IconSvg>
)

/**
 * 岛仔（桌宠）已搬到 `./pet/`（SPEC-deskpet-skin）：
 * 形象画法按「皮肤」拆分，`App.tsx` 只负责决定尺寸、情绪和用哪套皮肤。
 * 原来这里的内联 `<Pet>` 原样搬进了 `pet/skinCapsule.tsx`，岛上长相不变。
 */


/** 待办面板：今天要做什么（今天的日程 + 待办混排） + 勾选 + 增 + 删 + 改（双击编辑） + 完成度 n/m
 *  US-033：待办页与「今天」同步——只列今天的日程，明天/昨天不出现，新增的内容存为今天的日程 */
function TodoPanel({
  onDonePulse,
  onStats,
}: {
  onDonePulse: () => void
  onStats: (done: number, total: number) => void
}): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([])
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [draft, setDraft] = useState('')
  // 双击编辑：正在改名的条目 id + 草稿
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const draftInputRef = useRef<HTMLInputElement | null>(null)
  // 列表超长时岛内滚动，新加的条目在可视区外 → 加完滚到底让用户看见（US-037）
  const todoListRef = useRef<HTMLUListElement | null>(null)
  // 新增时可选的时间（HH:mm 或空），复用日程页那套自绘深色时间面板
  const [time, setTime] = useState('')
  const [timePop, setTimePop] = useState(false)
  const timePopRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.island.todosList().then((list) => {
      if (alive) setTodos(list)
    })
    void window.island.scheduleList().then((list) => {
      if (alive) setItems(list)
    })
    return () => {
      alive = false
    }
  }, [])

  // 时间面板开着时，点面板外自动收起
  useEffect(() => {
    if (!timePop) return
    const onDown = (e: MouseEvent): void => {
      if (!timePopRef.current?.contains(e.target as Node)) setTimePop(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [timePop])

  // 只取今天（本地日期）的日程：明天的、昨天的一律不进来
  const today = localDayKey()
  const todayItems = items.filter((it) => it.day === today)
  const schedSorted = [...todayItems].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.time && b.time) return a.time.localeCompare(b.time)
    if (a.time) return -1
    if (b.time) return 1
    return a.createdAt - b.createdAt
  })
  const todoSorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done))

  // 完成度统计上抛给面板头（右上角「n/m 已完成」）：待办 + 今天的日程一起算
  const done = todos.filter((t) => t.done).length + todayItems.filter((it) => it.done).length
  const total = todos.length + todayItems.length
  useEffect(() => {
    onStats(done, total)
  }, [done, total, onStats])

  const hm = formatClock(new Date())

  const add = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const t = time
    setTime('')
    setTimePop(false)
    // 存为「今天的日程」：今天在待办页与日程页都能看到，明天从待办页消失
    setItems(await window.island.scheduleAdd(text, t || null, today))
    // 加完保持输入框焦点，方便连着录几条
    draftInputRef.current?.focus()
    // 新条目在列表尾部，列表超长时会滚出可视区——滚到底让用户看见它加上了（US-037）
    requestAnimationFrame(() => todoListRef.current?.scrollTo({ top: todoListRef.current.scrollHeight }))
  }, [draft, time, today])

  const toggle = useCallback(
    async (t: Todo) => {
      setTodos(await window.island.todosToggle(t.id))
      // 从未完成勾成已完成 → 通知岛仔开心
      if (!t.done) onDonePulse()
    },
    [onDonePulse]
  )

  const toggleSched = useCallback(
    async (it: ScheduleItem) => {
      setItems(await window.island.scheduleToggle(it.id))
      if (!it.done) onDonePulse()
    },
    [onDonePulse]
  )

  const remove = useCallback(async (id: string) => {
    setTodos(await window.island.todosRemove(id))
  }, [])

  const removeSched = useCallback(async (id: string) => {
    setItems(await window.island.scheduleRemove(id))
  }, [])

  // 日程条目双击改名（与日程页同款交互，复用 schedule:edit）
  const [editingSchedId, setEditingSchedId] = useState<string | null>(null)
  const [schedEditDraft, setSchedEditDraft] = useState('')
  const startSchedEdit = useCallback((it: ScheduleItem) => {
    setEditingSchedId(it.id)
    setSchedEditDraft(it.text)
  }, [])
  const commitSchedEdit = useCallback(async () => {
    const id = editingSchedId
    const t = schedEditDraft.trim()
    setEditingSchedId(null)
    if (!id || !t) return // 空文本视为取消，不误清内容
    setItems(await window.island.scheduleEdit(id, { text: t }))
  }, [editingSchedId, schedEditDraft])

  // 双击进入编辑：草稿先填当前文本，下次渲染时选中全部
  const startEdit = useCallback((t: Todo) => {
    setEditingId(t.id)
    setEditDraft(t.text)
  }, [])

  const commitEdit = useCallback(async () => {
    const id = editingId
    const text = editDraft.trim()
    setEditingId(null)
    if (!id) return
    if (!text) return // 空文本视为取消，不误删内容
    setTodos(await window.island.todosRename(id, text))
  }, [editingId, editDraft])

  return (
    <div className="todo-panel">
      <div className="todo-add">
        <input
          ref={draftInputRef}
          className="todo-input"
          value={draft}
          placeholder="加一条今天要做的事，回车连记…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 拦住冒泡：岛根 onKeyDown 见到 Enter/空格会 toggle() 收起岛（US-036 踩坑）。
            // 拼音输入用空格选字、回车上屏都会冒泡到这里，把正在输入的岛收走。
            e.stopPropagation()
            if (e.key === 'Enter') void add()
          }}
        />
        {/* 时钟按钮：可选时间，选过之后高亮显示，再点可收起 */}
        <button
          type="button"
          className={`sched-time-btn ${time ? 'picked' : ''} ${timePop ? 'open' : ''}`}
          title={time ? `已选 ${time}，点击重选` : '可选：加个时间'}
          aria-label={time ? `已选时间 ${time}，点击重选` : '选择时间'}
          aria-expanded={timePop}
          onClick={() => setTimePop((v) => !v)}
        >
          <IcoClock />
        </button>
        <button
          type="button"
          className="todo-add-btn"
          title="添加"
          aria-label="添加"
          onClick={() => void add()}
        >
          +
        </button>
        {timePop && (
          <div className="sched-time-pop" ref={timePopRef}>
            <div className="time-pop-head">
              <span>{time ? `已选 ${time}` : '选择时间'}</span>
              {time && (
                <button
                  type="button"
                  className="time-pop-clear"
                  onClick={() => {
                    setTime('')
                  }}
                >
                  清除
                </button>
              )}
            </div>
            <div className="time-pop-cols">
              <div className="time-pop-col">
                {Array.from({ length: 24 }, (_, h) => (
                  <button
                    key={h}
                    type="button"
                    className={`time-pop-cell ${time.slice(0, 2) === String(h).padStart(2, '0') ? 'picked' : ''}`}
                    onClick={() => setTime((prev) => `${String(h).padStart(2, '0')}${prev.slice(2) || ':00'}`)}
                  >
                    {String(h).padStart(2, '0')}
                  </button>
                ))}
              </div>
              <div className="time-pop-col">
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`time-pop-cell ${time.slice(3) === String(m).padStart(2, '0') ? 'picked' : ''}`}
                    onClick={() => setTime((prev) => `${prev.slice(0, 2) || '08'}:${String(m).padStart(2, '0')}`)}
                  >
                    {String(m).padStart(2, '0')}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <ul className="todo-list" ref={todoListRef}>
        {schedSorted.length === 0 && todoSorted.length === 0 && (
          <li className="todo-empty">今天还没有安排，加一条吧</li>
        )}
        {/* 今天的日程：只显示时间（不显示日期），过点未完成的徽标变橙 */}
        {schedSorted.map((it) => (
          <li key={`s${it.id}`} className={`todo-item todo-sched ${it.done ? 'done' : ''}`}>
            <button
              type="button"
              className={`todo-check ${it.done ? 'checked' : ''}`}
              title={it.done ? '标记为未完成' : '标记为已完成'}
              aria-label={it.done ? `标记日程 ${it.text} 为未完成` : `标记日程 ${it.text} 为已完成`}
              onClick={() => void toggleSched(it)}
            >
              {it.done ? <IcoCheck /> : ''}
            </button>
            {it.time && (
              <span className={`sched-badge ${!it.done && it.time <= hm ? 'sched-past' : ''}`}>{it.time}</span>
            )}
            {editingSchedId === it.id ? (
              <input
                className="todo-edit"
                autoFocus
                value={schedEditDraft}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setSchedEditDraft(e.target.value)}
                onBlur={() => void commitSchedEdit()}
                onKeyDown={(e) => {
                  // 拦住冒泡：岛根 onKeyDown 见到 Enter/空格会 toggle() 收起岛（US-036 踩坑）
                  e.stopPropagation()
                  if (e.key === 'Enter') void commitSchedEdit()
                  if (e.key === 'Escape') {
                    e.stopPropagation() // Esc 另有「收起岛」的全局监听，编辑框内 Esc 只取消编辑
                    setEditingSchedId(null)
                  }
                }}
              />
            ) : (
              <span
                className="todo-text"
                title="双击编辑"
                onDoubleClick={() => startSchedEdit(it)}
              >
                {it.text}
              </span>
            )}
            <button
              type="button"
              className="todo-del"
              title="删除"
              aria-label={`删除日程 ${it.text}`}
              onClick={() => void removeSched(it.id)}
            >
              ×
            </button>
          </li>
        ))}
        {todoSorted.map((t) => (
          <li key={t.id} className={`todo-item ${t.done ? 'done' : ''}`}>
            <button
              type="button"
              className={`todo-check ${t.done ? 'checked' : ''}`}
              title={t.done ? '标记为未完成' : '标记为已完成'}
              aria-label={t.done ? `标记 ${t.text} 为未完成` : `标记 ${t.text} 为已完成`}
              onClick={() => void toggle(t)}
            >
              {t.done ? <IcoCheck /> : ''}
            </button>
            {editingId === t.id ? (
              <input
                className="todo-edit"
                autoFocus
                value={editDraft}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={() => void commitEdit()}
                onKeyDown={(e) => {
                  // 拦住冒泡：岛根 onKeyDown 见到 Enter/空格会 toggle() 收起岛，
                  // 编辑框里回车提交会把整座岛收走（US-036 实测踩坑，待办编辑框同修）
                  e.stopPropagation()
                  if (e.key === 'Enter') void commitEdit()
                  if (e.key === 'Escape') {
                    e.stopPropagation() // Esc 另有「收起岛」的全局监听，编辑框内 Esc 只取消编辑
                    setEditingId(null)
                  }
                }}
              />
            ) : (
              <span
                className="todo-text"
                title="双击编辑"
                onDoubleClick={() => startEdit(t)}
              >
                {t.text}
              </span>
            )}
            <button
              type="button"
              className="todo-del"
              title="删除"
              aria-label={`删除待办 ${t.text}`}
              onClick={() => void remove(t.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {/* 美化-04：完成度进度条（细轨 + 圆头填充 + 百分比）。
          放在列表下方而不是头部——头部已经有圆环在显示同一个数，列表下方这一条
          是"扫一眼就知道还剩多少"的横向读数，和头部圆环互为补充。 */}
      {total > 0 && (
        <div className="todo-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <div className="todo-progress-bar">
            <div
              className={`todo-progress-fill ${done >= total ? 'full' : ''}`}
              style={{ transform: `scaleX(${total > 0 ? done / total : 0})` }}
            />
          </div>
          <span className="todo-progress-text">
            {done >= total ? '今天全部做完' : `还差 ${total - done} 件`}
            <b>{Math.round((done / total) * 100)}%</b>
          </span>
        </div>
      )}
    </div>
  )
}

/** 置物架页收起前的宽限：比待办页长一点，方便去拿文件 */
const SHELF_COLLAPSE_MS = 4000

/** 按扩展名给文件图标配色 */
function extColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return '#4fc3f7'
  if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return '#ff8a65'
  if (['mp3', 'wav', 'flac', 'm4a'].includes(ext)) return '#ba68c8'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '#ffb74d'
  if (['doc', 'docx', 'pdf', 'txt', 'md'].includes(ext)) return '#81c784'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '#aed581'
  if (['exe', 'msi', 'lnk'].includes(ext)) return '#90a4ae'
  return '#b0bec5'
}

/** 通用文件图标：优先用系统真实图标（文件夹/文件用真实路径取，其余按扩展名缓存），拿不到退回折角纸片 */
function FileIcon({ name, path }: { name: string; path: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.island.shelfIcon(name, path).then((p) => {
      if (alive) setSrc(p)
    })
    return () => {
      alive = false
    }
  }, [name, path])
  if (src) {
    // 走 ldapp:// 自定义协议，理由见 iconUrl() 的注释（开发版 http 源引用 file:// 会被拦）
    const url = `ldapp://local/${encodeURIComponent(src)}`
    return <img className="shelf-icon" src={url} alt="" draggable={false} />
  }
  const color = extColor(name)
  return (
    <svg className="shelf-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill={color}
        opacity="0.9"
      />
      <path d="M15 2l5 5h-5z" fill="#ffffff" opacity="0.45" />
    </svg>
  )
}

/** 置物架面板：拖文件进来暂存，点击打开，可删除/清空 */
function ShelfPanel(): React.JSX.Element {
  const [items, setItems] = useState<ShelfItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  /**
   * 底部提示条。kind=missing 时说明文件已不在，并带「从架子上移除」按钮；
   * kind=failed 是系统打开失败（极少见），只显示中文说明 + 原始报错。
   */
  const [notice, setNotice] = useState<{ kind: 'missing' | 'failed'; text: string; removeId?: string } | null>(
    null
  )
  // 视图：大/中/小图标（横向一排滚动，两侧箭头）或列表（纵向滚动）
  // 初值默认「大图标」，mount 后从 prefs.json 异步回填（US-037）——与页面裁剪同为
  // 「先默认后异步回填」的既有模式；localStorage 版跨重启会丢已废弃。
  const [view, setView] = useState<ShelfView>('lg')
  // 视图记忆回填：只在挂载时读一次 prefs.json，合法值才应用（用户已点的操作不覆盖——
  // 回填窗口极短（几十毫秒），实际冲突概率可忽略）
  const viewDirty = useRef(false)
  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((prefs) => {
        if (!alive || viewDirty.current) return
        const v = prefs.shelfView
        if (v === 'lg' || v === 'md' || v === 'sm' || v === 'list') setView(v)
      })
      .catch(() => {
        /* 读不到就用默认 */
      })
    return () => {
      alive = false
    }
  }, [])
  // 清空按钮二次确认态：第一次点变「确认清空？」，再点才真正清
  const [confirmClear, setConfirmClear] = useState(false)
  // 视图选择菜单展开态：点视图按钮弹出四项菜单（大/中/小/列表）
  const [viewPop, setViewPop] = useState(false)
  // 图标视图横向滚动：是否还有更多内容（决定两侧箭头显隐）
  const [canScroll, setCanScroll] = useState(false)
  /** 正在拖动换位的条目 id（网格内排序用） */
  const reorderFrom = useRef<string | null>(null)
  const reorderSeq = useRef(0)
  /** 图标视图滚动容器 */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 视图选择菜单容器：开着时点外面自动收起 */
  const viewPopRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!viewPop) return
    const onDown = (e: MouseEvent): void => {
      if (!viewPopRef.current?.contains(e.target as Node)) setViewPop(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [viewPop])

  const updateCanScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      setCanScroll(false)
      return
    }
    setCanScroll(el.scrollWidth > el.clientWidth + 4)
  }, [])

  // 内容/视图变化后量一次能否滚动；rAF 等布局落定（首次挂载时 strip 可能还没排好版）
  useEffect(() => {
    const id = window.requestAnimationFrame(updateCanScroll)
    return () => window.cancelAnimationFrame(id)
  }, [items, view, updateCanScroll])

  // 容器尺寸变化（窗口展开/收起、换页动画）也要重量
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateCanScroll)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view, updateCanScroll])

  // 滚轮滚动：竖向滚轮转成横向滚（用户 m01366「支持滚轮滚动」）。
  // 必须用原生 addEventListener + passive:false，React 的 onWheel 是 passive 的，preventDefault 会被忽略。
  // 依赖里必须带 items.length：首帧 items 还是空数组时 .shelf-strip 根本没渲染，ref 是 null，
  // 只依赖 [view] 会让这个 effect 永远拿不到节点、滚轮监听压根没挂上（2026-11-16 实测踩到）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const max = el.scrollWidth - el.clientWidth
      if (max <= 1) return
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (delta === 0) return
      e.preventDefault()
      // 到两端继续滚就绕回另一头（用户 m01366「左右两边的滚动循环」）
      let next = el.scrollLeft + delta
      if (next > max) next = 0
      else if (next < 0) next = max
      el.scrollLeft = next
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view, items.length])

  /** 两侧箭头：到头再点一次就绕到另一头（循环，用户 m01366 要求） */
  const scrollBy = (dir: number): void => {
    const el = scrollRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    if (max <= 1) return
    if (dir > 0 && el.scrollLeft >= max - 1) {
      el.scrollTo({ left: 0, behavior: 'smooth' })
      return
    }
    if (dir < 0 && el.scrollLeft <= 1) {
      el.scrollTo({ left: max, behavior: 'smooth' })
      return
    }
    el.scrollBy({ left: dir * 220, behavior: 'smooth' })
  }

  useEffect(() => {
    let alive = true
    void window.island.shelfList().then((l) => {
      if (alive) setItems(l)
    })
    return () => {
      alive = false
    }
  }, [])

  // 拖放落点在整岛根上，本面板不直接收 drop；这里只订阅广播的落盘通知
  useEffect(() => {
    window.island.onShelfAdded((list) => {
      setItems(list)
      setDragOver(false)
      setNotice(null)
    })
  }, [])

  const remove = useCallback(async (id: string) => {
    setItems(await window.island.shelfRemove(id))
    setNotice(null)
  }, [])

  const clear = useCallback(async () => {
    setItems(await window.island.shelfClear())
    setNotice(null)
  }, [])

  /**
   * 打开条目。文件已不在时不再显示英文系统报错，而是给一句中文说明 + 一键移除；
   * 真的打开失败（权限、关联程序缺失等）也翻成人话，英文原文放在括号里兜底。
   */
  const open = useCallback(async (it: ShelfItem) => {
    const r = await window.island.shelfOpen(it.path)
    if (r.ok) {
      setNotice(null)
      return
    }
    if (r.reason === 'missing') {
      setNotice({ kind: 'missing', text: `「${it.name}」已经不在了，可能被移走或删除。`, removeId: it.id })
      return
    }
    if (r.reason === 'empty') {
      setNotice({ kind: 'failed', text: '这个条目没有记录文件路径，无法打开。' })
      return
    }
    setNotice({
      kind: 'failed',
      text: `「${it.name}」打不开：系统没能用默认程序打开它。${r.detail ? `（${r.detail}）` : ''}`
    })
  }, [])

  /** 「在文件夹中显示」：失效条目直接说明原因，不再静默失败 */
  const reveal = useCallback(async (it: ShelfItem) => {
    const r = await window.island.shelfShowInFolder(it.path)
    if (r.ok) {
      setNotice(null)
      return
    }
    if (r.reason === 'missing') {
      setNotice({ kind: 'missing', text: `「${it.name}」已经不在了，找不到它的文件夹。`, removeId: it.id })
      return
    }
    setNotice({ kind: 'failed', text: `「${it.name}」没有可定位的路径。` })
  }, [])

  // 网格内拖动换位：拖起记 id，落到另一个格子上与目标**互换位置**（最直觉的桌面语义）。
  // 用函数式更新拿最新列表；主进程返回的排序列表是唯一真相，inFlight 序号防旧响应覆盖新顺序
  const reorderTo = useCallback(async (target: ShelfItem) => {
    const from = reorderFrom.current
    reorderFrom.current = null
    if (!from || from === target.id) return
    setItems((prev) => {
      const ids = prev.map((x) => x.id)
      const fi = ids.indexOf(from)
      const ti = ids.indexOf(target.id)
      if (fi === -1 || ti === -1) return prev
      // 互换：A 拖到 B 上，A 占 B 的位置，B 退到 A 原来的位置
      ;[ids[fi], ids[ti]] = [ids[ti], ids[fi]]
      // 换位序号：只有最新一次 reorder 的响应才允许覆盖 items，避免 IPC 慢响应乱序回写
      const seq = ++reorderSeq.current
      void window.island.shelfReorder(ids).then((sorted) => {
        if (seq === reorderSeq.current) setItems(sorted)
      })
      return prev.map((x) => (x.id === from ? { ...x } : x))
    })
  }, [])

  const fmtSize = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  return (
    <div className="todo-panel">
      <div className="shelf-toolbar">
        <span className="shelf-count">{items.length} 个文件</span>
        <span className="shelf-toolbar-spacer" />
        {/* 视图切换：点开弹四项选择菜单（大/中/小/列表），不是循环切换（用户 m02221 要求可选择） */}
        <span className="shelf-view-wrap" ref={viewPopRef}>
          <button
            type="button"
            className={`shelf-view-btn ${viewPop ? 'open' : ''}`}
            title="选择视图"
            aria-label="选择视图"
            aria-expanded={viewPop}
            onClick={() => setViewPop((v) => !v)}
          >
            {view === 'lg' ? <IcoGrid /> : view === 'md' ? <IcoGridMd /> : view === 'sm' ? <IcoGridSm /> : <IcoList />}
          </button>
          {viewPop && (
            <span className="shelf-view-pop" role="menu" aria-label="选择视图">
              {([
                ['lg', '大图标', <IcoGrid />],
                ['md', '中图标', <IcoGridMd />],
                ['sm', '小图标', <IcoGridSm />],
                ['list', '列表', <IcoList />],
              ] as const).map(([v, label, icon]) => (
                <button
                  key={v}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === v}
                  className={`shelf-view-item ${view === v ? 'picked' : ''}`}
                  onClick={() => {
                    viewDirty.current = true
                    setView(v)
                    window.island.prefsSet({ shelfView: v }).catch(() => {
                      /* 写不进去就算了，不打扰用户 */
                    })
                    setViewPop(false)
                  }}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </span>
          )}
        </span>
        <button
          type="button"
          className={`todo-del ${confirmClear ? 'confirm-clear' : ''}`}
          title="清空置物架"
          aria-label="清空置物架"
          // 破坏性操作二次确认（baseline-ui: MUST confirm destructive actions）：第一次点进入确认态，失焦取消
          aria-expanded={confirmClear}
          onClick={() => {
            if (confirmClear) {
              void clear()
              setConfirmClear(false)
            } else {
              setConfirmClear(true)
            }
          }}
          onBlur={() => setConfirmClear(false)}
          disabled={items.length === 0}
        >
          {confirmClear ? '确认清空？' : '清空'}
        </button>
      </div>
      <div className={`shelf-drop ${view} ${dragOver ? 'over' : ''}`}>
        {items.length === 0 ? (
          <span className="shelf-drop-hint">把文件拖进来暂存（落在岛内任意位置）</span>
        ) : view === 'list' ? (
          <ul className="shelf-list">
            {items.map((it) => (
              <li
                key={it.id}
                className={`shelf-item ${it.missing ? 'missing' : ''}`}
                title={it.missing ? `文件已不在：${it.path}` : it.path}
              >
                <FileIcon name={it.name} path={it.path} />
                <button
                  type="button"
                  className="shelf-name"
                  title={it.missing ? '文件已不在（点击查看）' : '双击打开'}
                  onClick={() => {
                    if (it.missing) void open(it)
                  }}
                  onDoubleClick={() => void open(it)}
                >
                  {it.name}
                </button>
                {it.missing && (
                  <span className="shelf-badge-missing" aria-label="文件已不在">
                    失效
                  </span>
                )}
                <span className="shelf-size">{fmtSize(it.size)}</span>
                <button
                  type="button"
                  className="todo-del shelf-row-folder"
                  title={it.missing ? '文件已不在，无法定位' : '在文件夹中显示'}
                  aria-label={it.missing ? `${it.name} 文件已不在，无法定位` : `在文件夹中显示 ${it.name}`}
                  disabled={it.missing}
                  onClick={() => void reveal(it)}
                >
                  <IcoFolder />
                </button>
                <button
                  type="button"
                  className="todo-del"
                  title="从置物架移除"
                  aria-label={`从置物架移除 ${it.name}`}
                  onClick={() => void remove(it.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          /* 图标视图：横向一排滚动，两侧箭头（对照截图） */
          <div className="shelf-hscroll">
            {canScroll && (
              <button type="button" className="shelf-scroll-arrow left" title="向左滚" aria-label="向左滚动" onClick={() => scrollBy(-1)}>
                ‹
              </button>
            )}
            <div className="shelf-strip" ref={scrollRef} onScroll={updateCanScroll}>
              <ul className="shelf-grid">
                {items.map((it) => (
                  <li
                    key={it.id}
                    className={`shelf-cell ${it.missing ? 'missing' : ''}`}
                    title={it.missing ? `文件已不在：${it.path}` : it.path}
                    draggable
                    onDragStart={(e) => {
                      reorderFrom.current = it.id
                      // Electron 的拖动需要 dataTransfer 里有数据，dragover/drop 才会稳定触发
                      e.dataTransfer.setData('text/plain', it.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      // 网格内换位：只拦截「架内图标拖动」；外部文件拖入必须放行冒泡，
                      // 否则事件在这里被吞、光标变禁止、drop 也被吞掉（架上有东西就放不进来的根因）
                      if (reorderFrom.current === null) return
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onDrop={(e) => {
                      // 同上：外部文件拖入时放行，冒泡到岛根 onDropRoot 加入置物架
                      if (reorderFrom.current === null) return
                      e.preventDefault()
                      e.stopPropagation()
                      void reorderTo(it)
                    }}
                    onDragEnd={() => {
                      reorderFrom.current = null
                    }}
                  >
                    <button
                      type="button"
                      className="shelf-cell-del"
                      title="移除"
                      aria-label={`移除 ${it.name}`}
                      onClick={() => void remove(it.id)}
                    >
                      ×
                    </button>
                    <button
                      type="button"
                      className="shelf-cell-body"
                      title={it.missing ? '文件已不在（点击查看）' : '双击打开'}
                      onClick={() => {
                        if (it.missing) void open(it)
                      }}
                      onDoubleClick={() => void open(it)}
                    >
                      <FileIcon name={it.name} path={it.path} />
                      <span className="shelf-cell-name">{it.name}</span>
                      {it.missing && (
                        <span className="shelf-badge-missing" aria-label="文件已不在">
                          失效
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="shelf-cell-folder"
                      title={it.missing ? '文件已不在，无法定位' : '在文件夹中显示'}
                      aria-label={it.missing ? `${it.name} 文件已不在，无法定位` : `在文件夹中显示 ${it.name}`}
                      disabled={it.missing}
                      onClick={() => void reveal(it)}
                    >
                      <IcoFolder />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {canScroll && (
              <button type="button" className="shelf-scroll-arrow right" title="向右滚" aria-label="向右滚动" onClick={() => scrollBy(1)}>
                ›
              </button>
            )}
          </div>
        )}
      </div>
      {notice && (
        <div className={`shelf-notice ${notice.kind}`} role="status">
          <span className="shelf-notice-text">{notice.text}</span>
          {notice.removeId && (
            <button
              type="button"
              className="shelf-notice-btn"
              onClick={() => void remove(notice.removeId as string)}
            >
              从架子上移除
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Windows 绝对路径 → 可加载的图片 URL。
 *
 * 为什么不用 file://（2026-11-12 用户反馈「这个图标怎么显示不出来」）：
 * 打包版页面源是 file://，引用 file:// 同源、能加载；但开发预览版页面源是
 * http://localhost:5173，从 http 源引用 file:// 会被 Chromium 底层拦掉，
 * <img> 静默失败、连 CSP 违规都不报，横幅图标就剩一块空灰底。
 * 改用主进程注册的 ldapp:// 自定义协议，两种源下都能加载。
 * 拼接规则必须与 src/main/localFileProtocol.ts 的 localFileUrl() 一致。
 */
function iconUrl(p: string): string {
  return `ldapp://local/${encodeURIComponent(p)}`
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / 具体日期 */
function fmtRel(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const mmdd = `${d.getMonth() + 1}/${d.getDate()}`
  return sameYear ? mmdd : `${d.getFullYear()}/${mmdd}`
}

/** 通知面板：读取 Windows 通知中心历史（toast），点条目尝试打开来源应用 */
function NotifyPanel({
  onUnread,
  refreshTick,
}: {
  onUnread: (n: number) => void
  refreshTick: number
}): React.JSX.Element {
  const [items, setItems] = useState<NotifyItem[]>([])
  const [loaded, setLoaded] = useState(false)
  // 已读水位（美化-04）：order > lastOrder 的条目算未读，画蓝点
  const [lastOrder, setLastOrder] = useState(0)
  // 相对时间（"5 分钟前"）每 30s 重算一次，避免开着不动时间变陈旧
  const [, tickNow] = useState(0)

  useEffect(() => {
    void window.island.notifyRefresh().then((r: NotifyListResult) => {
      setItems(r.items)
      setLastOrder(r.lastOrder ?? 0)
      onUnread(r.unread)
      setLoaded(true)
    })
  }, [onUnread, refreshTick]) // refreshTick 变化（展开期间有新消息）→ 重拉列表

  useEffect(() => {
    const id = window.setInterval(() => tickNow((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // 标记已读后要拿到新的已读水位才能把蓝点消掉：notify:mark-read 只回未读数，
  // 这里再拉一次 notify:list（读的是内存缓存，很轻）把 items/lastOrder/unread 一起刷新。
  const markRead = useCallback(() => {
    void window.island.notifyMarkRead().then(() => {
      void window.island.notifyList().then((r: NotifyListResult) => {
        setItems(r.items)
        setLastOrder(r.lastOrder ?? 0)
        onUnread(r.unread)
      })
    })
  }, [onUnread])

  const clearAll = useCallback(() => {
    void window.island.notifyClearAll().then((r: NotifyListResult) => {
      setItems(r.items)
      setLastOrder(r.lastOrder ?? 0)
      onUnread(r.unread)
    })
  }, [onUnread])

  const openOne = useCallback(
    (it: NotifyItem) => {
      void window.island.notifyOpenSource(it.app, it.launch)
      markRead()
    },
    [markRead]
  )

  // ===== 单级堆叠（SPEC-notify-icon-and-single-group）=====
  // 只按 app 分组一层；点开应用直接平铺该应用的全部具体通知，不再按 title 细分会话。
  // 纯渲染层变换——items 顺序即到达序（新→旧），分组保留该序取每组最新。
  // （旧版 US-040 是两级堆叠：组内再按标题分「会话」，用户 2026-11-14 要求只分一次。）
  const visibleItems = useMemo(() => items.filter((it) => it.title || it.body), [items])
  const groups = useMemo(() => {
    const byApp = new Map<string, NotifyItem[]>()
    for (const it of visibleItems) {
      const arr = byApp.get(it.app)
      if (arr) arr.push(it)
      else byApp.set(it.app, [it])
    }
    // 组内保持新→旧；组间按最新通知时间倒序（插入序即最新序，Map 保序）
    return [...byApp.values()].map((list) => ({ app: list[0].app, icon: list[0].icon, list }))
  }, [visibleItems])

  // 展开状态：只保留一级 key=app（删掉旧版 US-040 的二级会话展开态）
  const [openApps, setOpenApps] = useState<Set<string>>(new Set())

  const toggleApp = useCallback((app: string) => {
    setOpenApps((prev) => {
      const next = new Set(prev)
      if (next.has(app)) next.delete(app)
      else next.add(app)
      return next
    })
  }, [])

  /**
   * 条目右侧那一列（美化-04）：相对时间 + 未读蓝点（蓝点固定在最右端）。
   * 2026-11-11 用户实机反馈后调整：①去掉原来的「打开」按钮（点了没效果，正文点击已经能打开，
   * 组条目的正文点击被「展开/收起」占用，要打开就展开到具体条目再点）；②蓝点从时间左边
   * 挪到时间右边，成为整行的最右端标记，扫一眼就能看出哪几条没读。
   * 2026-11-16 用户 m03042「可以把主干下面的这个时间给去掉」：组条目（主干）不再显示时间，
   * 只留未读蓝点——组内每条自己带时间，展开就能看到，主干那条反而和图标/标题挤在一起。
   */
  const renderSide = (arrival: number, unread: boolean, showTime = true): React.JSX.Element => (
    <span className="notify-side">
      {showTime && <span className="notify-time">{fmtRel(arrival)}</span>}
      {unread && <i className="notify-unread" title="未读" />}
    </span>
  )

  /**
   * 图标区（SPEC-notify-icon-and-single-group）：每条通知左侧固定一个方块。
   * 有真图标 → img.notify-icon；解析不到图标 → 应用名首字的中性占位方块（title 显示完整应用名）。
   * count>1 时图标右上角浮计数徽标（该应用堆叠了几条）。
   * 占位方块特意用独立类名 .notify-icon-fallback，不复用 .notify-icon，
   * 这样「图标真的解码出来了」这类只针对真 <img> 的断言不会把它算进去。
   */
  const renderIcon = (icon: string | null, app: string, count: number): React.JSX.Element => (
    <span className="notify-icon-wrap">
      {icon ? (
        <img className="notify-icon" src={iconUrl(icon)} alt="" aria-hidden="true" />
      ) : (
        <span className="notify-icon-fallback" title={app} aria-label={app}>{app.slice(0, 1)}</span>
      )}
      {count > 1 && <span className="notify-badge">{count}</span>}
    </span>
  )

  return (
    <div className="todo-panel">
      <div className="shelf-toolbar">
        <span className="shelf-count">{visibleItems.length > 0 ? `${visibleItems.length} 条通知` : ''}</span>
        <span className="shelf-toolbar-spacer" />
        <button
          type="button"
          className="todo-del"
          title="全部标为已读（消除收起态红点）"
          aria-label="全部标为已读"
          onClick={markRead}
          disabled={visibleItems.length === 0}
        >
          已读
        </button>
        <button
          type="button"
          className="todo-del"
          title="清空列表（之后旧通知不再显示，新通知照常）"
          aria-label="清空通知列表"
          onClick={clearAll}
          disabled={visibleItems.length === 0}
        >
          清空
        </button>
      </div>
      {visibleItems.length === 0 ? (
        <div className="notify-empty">
          <div className="notify-empty-inner">
            {loaded ? (
              <>
                <svg viewBox="0 0 24 24" className="notify-empty-icon" aria-hidden="true">
                  <path
                    d="M12 3a6 6 0 0 0-6 6v3.2l-1.6 2.7a.9.9 0 0 0 .77 1.35h13.66a.9.9 0 0 0 .77-1.35L18 12.2V9a6 6 0 0 0-6-6z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path d="M10 19.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span className="shelf-drop-hint">暂无通知</span>
                <span className="notify-empty-sub">应用弹过通知后会出现在这里</span>
              </>
            ) : (
              /* 加载骨架条（baseline-ui：结构化骨架优于纯文案） */
              <div className="notify-skeleton" aria-busy="true" aria-label="通知加载中">
                <div className="notify-skel-row" />
                <div className="notify-skel-row" />
                <div className="notify-skel-row" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <ul className="notify-list">
          {/* 单级堆叠（SPEC-notify-icon-and-single-group）：只按应用分一层；点开直接平铺该应用的全部通知，不再按标题细分会话 */}
          {groups.map((g) => {
            const latest = g.list[0]
            const isOpen = openApps.has(g.app)
            return (
              <li key={g.app} className="notify-item notify-group">
                <button
                  type="button"
                  className="notify-body has-icon"
                  title={isOpen ? '点击收起该应用的通知' : '点击展开该应用的通知'}
                  aria-expanded={isOpen}
                  onClick={() => toggleApp(g.app)}
                >
                  {renderIcon(g.icon, g.app, g.list.length)}
                  <span className="notify-main">
                    {/* 应用名与标题同排（2026-11-16 用户 m00795「只显示 3 条」）：
                        原来应用名单独占一行，导致没图标的条目 3 行、有图标的 2 行，
                        行高不一致时按固定高度裁切会切掉第 3 条。同排后行高统一。 */}
                    <span className="notify-line">
                      {!g.icon && <span className="notify-app">{g.app}</span>}
                      <span className="notify-title">
                        <span className="notify-title-text">{latest.title}</span>
                        {g.list.length > 1 && <span className="notify-more-hint">（等 {g.list.length} 条）</span>}
                      </span>
                    </span>
                    {latest.body && <span className="notify-text">{latest.body}</span>}
                  </span>
                </button>
                {renderSide(latest.arrival, latest.order > lastOrder, false)}
                {isOpen && (
                  <ul className="notify-sublist">
                    {g.list.map((it) => (
                      <li key={it.id} className="notify-item notify-leaf">
                        <button
                          type="button"
                          className="notify-body has-icon"
                          title="点击打开来源应用"
                          onClick={() => openOne(it)}
                        >
                          {renderIcon(it.icon, it.app, 1)}
                          <span className="notify-main">
                            <span className="notify-line">
                              {!it.icon && <span className="notify-app">{it.app}</span>}
                              <span className="notify-title"><span className="notify-title-text">{it.title}</span></span>
                            </span>
                            {it.body && <span className="notify-text">{it.body}</span>}
                          </span>
                        </button>
                        {renderSide(it.arrival, it.order > lastOrder)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 月历：本月网格（周一为首），今天实心高亮，有安排的日子底部一个小蓝点，可点选日期 */
function MonthCalendar({
  selected,
  onSelect,
  markedDays,
}: {
  selected: string // YYYY-MM-DD
  onSelect: (day: string) => void
  markedDays: Set<string> // 有安排的日子
}): React.JSX.Element {
  const [viewYear, setViewYear] = useState(() => Number(selected.slice(0, 4)))
  const [viewMonth, setViewMonth] = useState(() => Number(selected.slice(5, 7)) - 1) // 0-based

  const todayKey = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  // 本月网格：补齐周一为首列的前导空位
  const cells: (number | null)[] = (() => {
    const first = new Date(viewYear, viewMonth, 1)
    const lead = (first.getDay() + 6) % 7 // 周一=0
    const days = new Date(viewYear, viewMonth + 1, 0).getDate()
    return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  })()

  const dayKey = (day: number): string =>
    `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const shiftMonth = (dir: number): void => {
    const m = viewMonth + dir
    setViewYear((y) => y + Math.floor(m / 12))
    setViewMonth(((m % 12) + 12) % 12)
  }

  // 选中日的「日」并进月历标题（SPEC-calendar-date-in-title，用户 2026-11-18 指出右栏
  // 「11月18日」与标题「2026年11月」月份重复）。翻到别的月份时不显示不属于该月的日号，
  // 否则会出现「2026年12月 18日」这种误导。
  const selectedInView = selected.startsWith(`${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`)

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" title="上个月" aria-label="上个月" onClick={() => shiftMonth(-1)}>
          ‹
        </button>
        <span className="cal-title">
          {viewYear}年{viewMonth + 1}月
          {selectedInView ? ` ${Number(selected.slice(8, 10))}日` : ''}
        </span>
        <button type="button" className="cal-nav" title="下个月" aria-label="下个月" onClick={() => shiftMonth(1)}>
          ›
        </button>
      </div>
      <div className="cal-grid cal-week">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <span key={w} className="cal-weekday">
            {w}
          </span>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((day, i) => {
          if (day === null) return <span key={`e${i}`} />
          const key = dayKey(day)
          const has = markedDays.has(key)
          return (
            <button
              key={day}
              type="button"
              className={`cal-day ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''}`}
              aria-label={`选择 ${viewMonth + 1} 月 ${day} 日`}
              onClick={() => onSelect(key)}
            >
              {day}
              {has && <i className="cal-mark" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 日程面板：左月历 + 右当日安排（日程+待办混排），可带时间（到点弹系统提醒） */
function SchedulePanel(): React.JSX.Element {
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [text, setText] = useState('')
  // 可选时间（HH:mm 或空）：时钟图标按钮展开自绘深色时间选择面板（原生选择器白底割裂，不用）
  const [time, setTime] = useState('')
  // 时间选择面板开关
  const [timePop, setTimePop] = useState(false)
  const timePopRef = useRef<HTMLDivElement>(null)
  // 选中的日期（YYYY-MM-DD，默认今天）
  const [selDay, setSelDay] = useState<string>(() => localDayKey())
  // 行内编辑（与待办页双击编辑同款交互）：editingSchedId 是正在编辑的日程 id
  const [editingSchedId, setEditingSchedId] = useState<string | null>(null)
  const [schedEditDraft, setSchedEditDraft] = useState('')
  // 当日列表超长时岛内滚动，新加的条目可能在可视区外 → 加完滚到底（US-037）
  const schedListRef = useRef<HTMLUListElement | null>(null)

  const startSchedEdit = useCallback((it: ScheduleItem) => {
    setEditingSchedId(it.id)
    setSchedEditDraft(it.text)
  }, [])

  const commitSchedEdit = useCallback(async () => {
    const id = editingSchedId
    const t = schedEditDraft.trim()
    setEditingSchedId(null)
    if (!id || !t) return // 空文本视为取消，不误清内容
    setItems(await window.island.scheduleEdit(id, { text: t }))
  }, [editingSchedId, schedEditDraft])

  useEffect(() => {
    void window.island.scheduleList().then(setItems)
    void window.island.todosList().then(setTodos)
  }, [])

  // 时间面板开着时，点面板外自动收起
  useEffect(() => {
    if (!timePop) return
    const onDown = (e: MouseEvent): void => {
      if (!timePopRef.current?.contains(e.target as Node)) setTimePop(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [timePop])

  const add = useCallback(() => {
    const t = text.trim()
    if (!t) return
    void window.island.scheduleAdd(t, time || null, selDay).then((list) => {
      setItems(list)
      setText('')
      setTime('')
      setTimePop(false)
      // 列表超长时新条目会滚出可视区——滚到底让用户看见它加上了（US-037；
      // 新条目带时间时排在时间组里，滚到底不一定精确盖住它，但多数场景（无时间）在尾部）
      requestAnimationFrame(() => schedListRef.current?.scrollTo({ top: schedListRef.current.scrollHeight }))
    })
  }, [text, time, selDay])

  const toggle = useCallback((id: string) => {
    void window.island.scheduleToggle(id).then(setItems)
  }, [])

  const toggleTodo = useCallback((id: string) => {
    void window.island.todosToggle(id).then(setTodos)
  }, [])

  const remove = useCallback((id: string) => {
    void window.island.scheduleRemove(id).then(setItems)
  }, [])

  // 今天（本地时区），用于「待办只在今天混排」与过期判定
  const todayKey = localDayKey()
  // 日历上「有安排」的日子：只用来画底部小蓝点，格子里不放文字。
  // 2026-11-11 用户实机反馈：格内小标签会把那一行撑高、破坏对齐，改回只标一个点。
  const markedDays = useMemo(() => new Set<string>(items.map((it) => it.day)), [items])
  // 选中日当天的日程（按 done / 时间排序）
  const dayItems = items.filter((it) => it.day === selDay)
  const schedSorted = [...dayItems].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.time && b.time) return a.time.localeCompare(b.time)
    if (a.time) return -1
    if (b.time) return 1
    return a.createdAt - b.createdAt
  })
  // 待办不分日期，只在看「今天」时与日程混排，避免被误当成那一天的待办
  const showTodos = selDay === todayKey
  const todoSorted = showTodos ? [...todos].sort((a, b) => Number(a.done) - Number(b.done)) : []
  const hm = formatClock(new Date())

  return (
    <div className="sched-split">
      {/* 左栏：月历 */}
      <MonthCalendar selected={selDay} onSelect={setSelDay} markedDays={markedDays} />
      {/* 右栏：当日安排 */}
      <div className="sched-day">
        <div className="sched-day-head">
          <span className="sched-day-sub">
            {dayItems.length} 条日程 · {showTodos ? `${todos.length} 条待办` : '待办只在今天'}
          </span>
        </div>
        <div className="sched-add">
          <input
            className="sched-input"
            placeholder="加个安排…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 拦住冒泡：岛根 onKeyDown 见到 Enter/空格会 toggle() 收起岛（US-036 踩坑，
              // 日程页输入框与待办页同修：空格选字/回车提交都会冒泡）
              e.stopPropagation()
              if (e.key === 'Enter') add()
            }}
          />
          {/* 时钟按钮：展开自绘深色时间选择面板，选过时间后高亮显示，再点可收起 */}
          <button
            type="button"
            className={`sched-time-btn ${time ? 'picked' : ''} ${timePop ? 'open' : ''}`}
            title={time ? `已选 ${time}，点击重选` : '可选：到点前提醒'}
            aria-label={time ? `已选时间 ${time}，点击重选` : '选择提醒时间'}
            aria-expanded={timePop}
            onClick={() => setTimePop((v) => !v)}
          >
            <IcoClock />
          </button>
          <button type="button" className="todo-add-btn" title="添加日程" aria-label="添加日程" onClick={add}>
            +
          </button>
          {/* 自绘时间选择面板：小时/分钟两列，深色风格与岛一致 */}
          {timePop && (
            <div className="sched-time-pop" ref={timePopRef}>
              <div className="time-pop-head">
                <span>{time ? `已选 ${time}` : '选择提醒时间'}</span>
                {time && (
                  <button type="button" className="time-pop-clear" onClick={() => { setTime(''); }}>
                    清除
                  </button>
                )}
              </div>
              <div className="time-pop-cols">
                <div className="time-pop-col">
                  {Array.from({ length: 24 }, (_, h) => (
                    <button
                      key={h}
                      type="button"
                      className={`time-pop-cell ${time.slice(0, 2) === String(h).padStart(2, '0') ? 'picked' : ''}`}
                      onClick={() => setTime((prev) => `${String(h).padStart(2, '0')}${prev.slice(2) || ':00'}`)}
                    >
                      {String(h).padStart(2, '0')}
                    </button>
                  ))}
                </div>
                <div className="time-pop-col">
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`time-pop-cell ${time.slice(3) === String(m).padStart(2, '0') ? 'picked' : ''}`}
                      onClick={() => setTime((prev) => `${prev.slice(0, 2) || '08'}:${String(m).padStart(2, '0')}`)}
                    >
                      {String(m).padStart(2, '0')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        {schedSorted.length === 0 && todoSorted.length === 0 ? (
          <div className="notify-empty">
            <div className="notify-empty-inner">
              <svg viewBox="0 0 24 24" className="notify-empty-icon" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="shelf-drop-hint">这一天还没有安排</span>
              <span className="notify-empty-sub">加一条试试，可带时间到点提醒</span>
            </div>
          </div>
        ) : (
          <ul className="todo-list sched-list" ref={schedListRef}>
            {schedSorted.map((it) => (
              <li key={`s${it.id}`} className={`todo-item ${it.done ? 'done' : ''}`}>
                <button
                  type="button"
                  className={`todo-check ${it.done ? 'checked' : ''}`}
                  title={it.done ? '标记为未完成' : '标记为已完成'}
                  aria-label={it.done ? `标记日程 ${it.text} 为未完成` : `标记日程 ${it.text} 为已完成`}
                  onClick={() => void toggle(it.id)}
                >
                  {it.done ? <IcoCheck /> : ''}
                </button>
                {it.time && (
                  <span
                    className={`sched-badge ${
                      !it.done && (it.day < todayKey || (it.day === todayKey && it.time <= hm)) ? 'sched-past' : ''
                    }`}
                  >
                    {it.time}
                  </span>
                )}
                {!it.time && !it.done && it.day < todayKey && <span className="sched-badge sched-past">逾期</span>}
                {editingSchedId === it.id ? (
                  <input
                    className="todo-edit"
                    autoFocus
                    value={schedEditDraft}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setSchedEditDraft(e.target.value)}
                    onBlur={() => void commitSchedEdit()}
                    onKeyDown={(e) => {
                      // 拦住冒泡：岛根 onKeyDown 见到 Enter/空格会 toggle() 收起岛，
                      // 编辑框里回车提交会把整座岛收走（US-036 实测踩坑）
                      e.stopPropagation()
                      if (e.key === 'Enter') void commitSchedEdit()
                      if (e.key === 'Escape') {
                        e.stopPropagation() // Esc 另有「收起岛」的全局监听，编辑框内 Esc 只取消编辑
                        setEditingSchedId(null)
                      }
                    }}
                  />
                ) : (
                  <span
                    className="todo-text"
                    title="双击编辑"
                    onDoubleClick={() => startSchedEdit(it)}
                  >
                    {it.text}
                  </span>
                )}
                <button
                  type="button"
                  className="todo-del"
                  title="删除"
                  aria-label={`删除日程 ${it.text}`}
                  onClick={() => remove(it.id)}
                >
                  ×
                </button>
              </li>
            ))}
            {todoSorted.map((t) => (
              <li key={`t${t.id}`} className={`todo-item ${t.done ? 'done' : ''}`}>
                <button
                  type="button"
                  className={`todo-check ${t.done ? 'checked' : ''}`}
                  title={t.done ? '标记为未完成' : '标记为已完成'}
                  aria-label={t.done ? `标记待办 ${t.text} 为未完成` : `标记待办 ${t.text} 为已完成`}
                  onClick={() => void toggleTodo(t.id)}
                >
                  {t.done ? <IcoCheck /> : ''}
                </button>
                <span className="sched-badge sched-badge-todo">待办</span>
                <span className="todo-text">{t.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * 音乐页（SPEC-music-page / US-031）：显示系统正在播放什么 + 播放/上一首/下一首控制。
 *
 * 数据来源是 Windows SMTC（系统媒体传输控制），不是任何一家播放器的私有接口，
 * 所以 PotPlayer、网易云、浏览器里的视频都能用同一套。
 *
 * 两个刻意的设计：
 * 1. 进度条**不**每秒重挂：主进程按整秒比较后才广播，界面收到 position 直接改
 *    transform: scaleX，靠 CSS transition 补成连续前进，避免一跳一跳。
 * 2. 播放中才本地插值：主进程每秒给一个采样点，两次采样之间界面自己的
 *    setInterval 把进度往前推，暂停时立刻停——这样即使主进程慢一拍，进度条也是顺的。
 */
function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const mmss = `${m}:${String(s).padStart(2, '0')}`
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : mmss
}

/**
 * 播放进度钟（放在模块级，不在组件里）。
 *
 * 用户 m06607「音乐已经播了一半了，然后我每次点到歌曲页面，进度条都会重新开始，字幕也是」：
 * 进度原来存在 MusicPanel 的 state 里，而切走页面时 MusicPanel 会被整块卸载
 * （App 里是 `page === 4 ? <MusicPanel /> : <别的页>`），state 跟着没了，
 * 再切回来就从 0 重新数——进度条归零、歌词也跟着回到第一句。
 *
 * 现在把「这首歌从哪一刻、从第几秒开始算」放在模块级：页面切来切去都不丢，
 * 用墙钟（Date.now）算当前位置，离开音乐页那段时间的流逝也照样算进去。
 * 订阅也常驻在这里，所以人不在音乐页时暂停/继续也能记准。
 */
interface ProgressClock {
  /** 这首歌的身份（歌名|歌手），变了就是要重新从头算 */
  key: string
  /** 这一段「开始算」的墙钟时刻 */
  startAt: number
  /** 这一段开始时的位置（秒） */
  startPos: number
  /** 当前是不是在放 */
  playing: boolean
}
const progressClock: ProgressClock = { key: '', startAt: 0, startPos: 0, playing: false }
let clockWatcherInstalled = false

/**
 * 「点进度条」期间抑制 blur 收起的时间戳（用户 m02806「我一点进度条，岛就会缩起来」）。
 *
 * 为什么会有 blur：播放器不报进度时，跳转靠点它自己窗口里的进度条，而真实鼠标事件
 * 只对前台窗口有效，所以桥接必须先把它顶到前台（`BringKeyless`）。前台一换，岛就
 * 失焦 → 主进程发 `island:window-blur` → 渲染层立刻 `setExpanded(false)`。
 * 用户看到的就是「点一下进度条，岛自己缩起来」——他根本没想收起岛。
 *
 * 放模块级而不是 `useRef`：点进度条的 `MusicPanel` 和收岛逻辑的 `App` 是两个组件，
 * 各自 `useRef` 互不可见；这不是渲染状态，放进 state 还会白刷一帧。
 * 只在这段时间内忽略 blur，不做全局豁免：超时后点桌面照样正常收起。
 */
let blurSuppressUntil = 0

function clockKeyOf(m: MusicState): string {
  return `${m.title}|${m.artist}`
}

/** 此刻这首歌放到第几秒（暂停就停在冻结值） */
function clockNow(): number {
  if (!progressClock.playing) return progressClock.startPos
  return progressClock.startPos + (Date.now() - progressClock.startAt) / 1000
}

/**
 * 把进度钟强行拨到某一秒（用户 m07228）。
 *
 * 什么时候用：播放器不报时长、但我们能从它自己窗口的进度条里读到「已播比例」时。
 * 那个比例乘上总时长就是它的**真实位置**，比墙钟自己数准得多（用户手动在播放器里
 * 拖一下进度条，墙钟就会一直偏着）。读到就掰回来，之后继续按墙钟平滑往前走，
 * 不至于让进度条每 2 秒一格一格地跳。
 *
 * 以前这里被用来「假装 seek 成功了」（点岛上进度条 → 界面跳、音乐不动），那是错的，
 * 用户 m06991 抓到过；现在只在**真的读到播放器位置**时掰，点完也真的会去点它的进度条。
 */
function clockAnchor(pos: number, playing: boolean): void {
  progressClock.startPos = Math.max(0, pos)
  progressClock.startAt = Date.now()
  progressClock.playing = playing
}

/**
 * 用一份播放器快照校准/推进进度钟。
 *
 * 两种播放器分开对待：
 * - 会报时间轴的（汽水音乐等 duration>0）：直接拿它给的 position 当基准，最可信；
 * - 不报时间轴的（网易云 duration=0）：只能按墙钟自己数，歌变了归零，
 *   暂停时把当前值冻结（stopPos），继续播放时从冻结值往后数。
 */
function clockSync(m: MusicState): void {
  if (!m.active) {
    progressClock.key = ''
    progressClock.startAt = Date.now()
    progressClock.startPos = 0
    progressClock.playing = false
    return
  }
  const key = clockKeyOf(m)
  if (m.duration > 0) {
    // 播放器自己报位置：以它为准，顺手让钟跟着对齐（切页回来能立刻接上）
    progressClock.key = key
    progressClock.startAt = Date.now()
    progressClock.startPos = Math.max(0, m.position)
    progressClock.playing = m.playing
    return
  }
  if (progressClock.key !== key) {
    // 换歌（或第一次见到这首）：从头开始
    progressClock.key = key
    progressClock.startAt = Date.now()
    progressClock.startPos = 0
    progressClock.playing = m.playing
    return
  }
  if (progressClock.playing === m.playing) return
  // 播放状态变了：先把「此刻到第几秒」固化下来，再从这一秒继续/停住
  const frozen = clockNow()
  progressClock.startAt = Date.now()
  progressClock.startPos = frozen
  progressClock.playing = m.playing
}

/** 常驻订阅：不管当前在哪一页，进度钟都跟着播放器走 */
function ensureClockWatcher(): void {
  if (clockWatcherInstalled) return
  clockWatcherInstalled = true
  const api = window.island
  if (!api) return
  const apply = (m: MusicState): void => {
    clockSync(m)
  }
  void api.musicGet().then(apply)
  api.onMusicState(apply)
}

/** 音源显示名：桥接回来的名字优先；锁定目标没在列表里时用它兜底 */
const MUSIC_SOURCE_NAMES: Record<string, string> = {
  cloudmusic: '网易云音乐',
  qqmusic: 'QQ 音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  spotify: 'Spotify',
  potplayermini64: 'PotPlayer',
  potplayermini: 'PotPlayer'
}

function musicSourceLabel(exe: string): string {
  const n = exe.replace(/\.exe$/i, '').toLowerCase()
  return MUSIC_SOURCE_NAMES[n] ?? (n || '未知应用')
}

/** 进程名归一（与主进程/桥接同规则），只用于比较 */
function musicExeKey(exe: string): string {
  return exe.replace(/\.exe$/i, '').toLowerCase()
}

/**
 * 音乐页「音源」胶囊 + 选择器（SPEC-music-source-picker，方案 A）。
 *
 * 为什么放在头部第一行右侧：音乐页该位置原本是空的，不挤占播放控件；点开浮层右对齐，
 * 盖住面板内容而不是把页面撑开。组件只在音乐页渲染（切页/收起即卸载，浮层跟着关闭），
 * 自己订阅 music 状态，避免把 App 全局换成「任何页面都跟着音乐秒级重渲染」。
 */
function MusicSourceChip(): React.JSX.Element {
  const [music, setMusic] = useState<MusicState | null>(null)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let alive = true
    void window.island.musicGet().then((s) => {
      if (alive) setMusic(s)
    })
    const off = window.island.onMusicState((s) => setMusic(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 关闭时机：点击浮层外 / Esc。切页与收起由卸载天然覆盖。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pin = music?.pinnedExe ?? ''
  const missing = music?.pinnedMissing === true
  const sources = useMemo(() => music?.sources ?? [], [music?.sources])

  const nameOf = (exe: string): string =>
    sources.find((s) => musicExeKey(s.exe) === musicExeKey(exe))?.name ?? musicSourceLabel(exe)

  const currentName =
    pin !== ''
      ? nameOf(pin)
      : music?.app
        ? nameOf(music.app)
        : '自动'

  // 列表：锁定的排最前，其余在播的排暂停前面（同等条件保持桥接给的顺序）
  const rows = useMemo(() => {
    const list = [...sources]
    list.sort((a, b) => {
      const aPin = pin !== '' && musicExeKey(a.exe) === pin
      const bPin = pin !== '' && musicExeKey(b.exe) === pin
      if (aPin !== bPin) return aPin ? -1 : 1
      if (a.playing !== b.playing) return a.playing ? -1 : 1
      return 0
    })
    return list
  }, [sources, pin])
  const pinInList = pin !== '' && rows.some((s) => musicExeKey(s.exe) === pin)

  const pick = (exe: string | null): void => {
    setOpen(false)
    void window.island.musicSetSource(exe)
  }

  return (
    // stopPropagation：面板里点一下会触发岛「点击收起/展开」的手势，这里必须拦住
    <span
      className={`music-src ${open ? 'open' : ''}`}
      ref={boxRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="music-src-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="音乐页跟着哪个播放器显示；可锁定，也可恢复自动"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="music-src-text">
          音源 · {currentName}
          {pin !== '' && missing ? '（未运行）' : ''}
        </span>
        {pin !== '' && (
          <span className="fluent-ico music-src-lock" aria-hidden="true">
            &#xE72E;
          </span>
        )}
        <span className="music-src-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="music-src-pop" role="listbox" aria-label="音源">
          <button
            type="button"
            role="option"
            aria-selected={pin === ''}
            className={`music-src-item ${pin === '' ? 'current' : ''}`}
            onClick={() => pick(null)}
          >
            <span className="music-src-name">自动（跟随播放）</span>
            <span className="music-src-tag">{pin === '' ? '✓' : '推荐'}</span>
          </button>
          {rows.map((s) => {
            const isCurrent = pin !== '' && musicExeKey(s.exe) === pin
            return (
              <button
                key={s.exe}
                type="button"
                role="option"
                aria-selected={isCurrent}
                className={`music-src-item ${isCurrent ? 'current' : ''} ${s.playing ? '' : 'idle'}`}
                onClick={() => pick(s.exe)}
              >
                <span className="music-src-name">{s.name}</span>
                <span className="music-src-tag">
                  {s.playing ? '● 在播' : '暂停'}
                  {isCurrent ? ' ✓' : ''}
                </span>
              </button>
            )
          })}
          {pin !== '' && !pinInList && (
            <div className="music-src-item current idle" role="option" aria-selected>
              <span className="music-src-name">{musicSourceLabel(pin)}</span>
              <span className="music-src-tag">未运行 ✓</span>
            </div>
          )}
          {rows.length === 0 && pin === '' && (
            <div className="music-src-empty">没有检测到其它播放器</div>
          )}
          <div className="music-src-hint">选中后固定显示，选「自动」恢复跟随</div>
        </div>
      )}
    </span>
  )
}

function MusicPanel({
  onLyricOpenChange,
  desktopLyricEnabled = true
}: {
  /** 歌词面板开合上报（SPEC-music-lyric-pin）：开着时岛不按下鼠标离开定时收起 */
  onLyricOpenChange?: (open: boolean) => void
  /** 「词」第二下是否召唤桌面歌词（SPEC-desktop-lyric-setting），设置页可关 */
  desktopLyricEnabled?: boolean
}): React.JSX.Element {
  const [music, setMusic] = useState<MusicState | null>(null)
  // 本地插值出来的播放位置（秒）：两次主进程采样之间自己往前走，暂停时冻结
  const [live, setLive] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  // 拖进度条 / 拖音量时，本地值先跟上，等下一次 poll 回来再对齐真实值
  // seeking 用于挂 .dragging 类（关掉位移动画）与停掉本地每秒插值；
  // effect 里要立刻读到最新拖动状态，故另用同步的 seekingRef
  const [seeking, setSeeking] = useState(false)
  const [volLocal, setVolLocal] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const seekingRef = useRef(false)
  // 松手后的「防回缩」保护：记下拖动目标、时间与当时的歌名，在播放器把 Position
  // 跳到目标前忽略 seek 生效前的旧快照（否则条子先缩回拖动前的位置、再滑到目标）
  const seekGuardRef = useRef<{ target: number; at: number; title: string } | null>(null)
  // 音量滑块拖动时会连发 onChange，用 120ms 防抖只把最后一个值发去主进程；
  // 不走 ctl 的 busy 锁（那是给「点一下按钮」防连点用的，会把拖动中的事件全吃掉）
  const volTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volPending = useRef<number | null>(null)
  // 封面 data URL 万一解码失败，记下「哪一个封面坏了」，只回落到音符占位；
  // 换歌拿到新 data URL 时这个旧值不相等，会自然再试一次图片。
  const [coverFailedFor, setCoverFailedFor] = useState<string | null>(null)
  // 音量竖直滑块是否弹出：平时只留喇叭按钮，点一下展开、再点收起（用户 m02462 定义「点声标才显现」；
  // m02917 纠正回竖直，保留「平时隐形、点喇叭显现」这条交互）
  const [volOpen, setVolOpen] = useState(false)
  // 用户 m04356「就是喇叭这个拉条，我想我点别的地方它也可以隐藏，而不是每次都要去点那个喇叭」：
  // 音量条的容器，用来判断一次点击是不是落在条内。点条内不算「别的地方」，
  // 否则拖滑块的第一下就会把条收掉
  const volBoxRef = useRef<HTMLDivElement>(null)
  // 歌词页是否展开（用户 m03579「当我点击歌词这个ui的时候，就会跳出右边的歌词页，不然则消失，不显示」）。
  // 点「词」开、再点一次关；面板右上角 × 也能关。默认关＝「不然则消失，不显示」。
  const [lyricOpen, setLyricOpen] = useState(false)
  // 桌面歌词切换中（第二次点「词」要走一趟 CDP，防连点）
  const [desktopBusy, setDesktopBusy] = useState(false)
  // 桌面歌词状态以网易云页面为准（music.desktopLyric，每秒轮询带回）。
  // 没有后台控制（CDP）时这项恒为 null，按钮降级成纯面板开合。
  // 设置里关掉第二态后，按钮回到「纯面板开合」：既不发请求，也不因网易云那边开着而高亮
  // （SPEC-desktop-lyric-setting：岛不擅自关用户已经开着的桌面歌词）。
  const desktopLyricOn = desktopLyricEnabled && music?.desktopLyric === true
  const canDesktopLyric = desktopLyricEnabled && music?.neteaseCdp === true
  /**
   * 「词」按钮三态循环（SPEC-music-desktop-lyric，用户 2026-11-18）：
   * 关 → 岛内歌词面板 → 关面板 + 开网易云桌面歌词 → 关桌面歌词。
   * 没有 CDP 时第三态不存在，退回原来的「开/关面板」。
   */
  const onWordClick = (): void => {
    if (desktopBusy) return
    if (lyricOpen) {
      setLyricOpen(false)
      if (canDesktopLyric) {
        setDesktopBusy(true)
        void window.island
          .musicDesktopLyric(true)
          .catch(() => null)
          .finally(() => setDesktopBusy(false))
      }
      return
    }
    if (desktopLyricOn) {
      setDesktopBusy(true)
      void window.island
        .musicDesktopLyric(false)
        .catch(() => null)
        .finally(() => setDesktopBusy(false))
      return
    }
    setLyricOpen(true)
  }
  // 把开合状态（含 × 关闭、切页卸载）同步给 App：面板开着时岛不自动收起
  // （SPEC-music-lyric-pin，用户 2026-11-18「不动他过一会就自己缩回去」）。
  useEffect(() => {
    onLyricOpenChange?.(lyricOpen)
    return () => onLyricOpenChange?.(false)
  }, [lyricOpen, onLyricOpenChange])
  // 歌词（SPEC-music-lyric，用户 m04986「我们现在来开发歌词吧」+ m05013「可以按你的来」）：
  // null＝还没问；{ok:false,reason}＝问了但没拿到（照实显示原因，绝不编造）；{ok:true,lines}＝拿到带时间轴的行
  const [lyric, setLyric] = useState<LyricResult | null>(null)
  const [lyricLoading, setLyricLoading] = useState(false)
  // 记下这份歌词是给哪首歌的，避免换歌间隙把上一首的歌词闪到新歌上
  const lyricForRef = useRef('')
  const lyricScrollRef = useRef<HTMLDivElement | null>(null)
  const lyricActiveRef = useRef<HTMLDivElement | null>(null)
  /**
   * 播放位置的插值基准：这次快照给的 position + 收到它的高精度时刻。
   *
   * 用户 m05562「喝唱的对不齐」的根因就在这里：原来靠 `setInterval(1000)` 每秒给 live 加 1，
   * 可主进程 poll 回来的 position 并不是每秒准时更新（实测假会话 6.6 秒才跳一次），
   * 按整秒累加会让歌词相对人声越走越偏。改成「基准位置 + 真实流逝时间」外推，
   * 每次收到新快照就把基准重设一次，误差不会累积。
   */
  const liveBaseRef = useRef<{ pos: number; at: number } | null>(null)

  const sendVolume = useCallback((v: number) => {
    volPending.current = v
    if (volTimer.current !== null) clearTimeout(volTimer.current)
    volTimer.current = setTimeout(() => {
      volTimer.current = null
      if (volPending.current !== null) void window.island.musicControl({ cmd: 'volume', value: volPending.current }).catch(() => false)
      volPending.current = null
    }, 120)
  }, [])

  useEffect(() => () => {
    if (volTimer.current !== null) clearTimeout(volTimer.current)
  }, [])

  // 用户 m04356「我想我点别的地方它也可以隐藏，而不是每次都要去点那个喇叭」：
  // 音量条展开时，在 document 上挂一次捕获阶段的 pointerdown —— 落点不在喇叭/滑条那块就收起。
  // 用 pointerdown 而不是 click：点空白处、点其它按钮都能立刻收起，不必等一次完整点击；
  // 用捕获阶段：即使目标元素自己 stopPropagation 也照收。点条内不收起，否则拖滑块第一下就没了。
  useEffect(() => {
    if (!volOpen) return
    const onDown = (e: PointerEvent) => {
      const box = volBoxRef.current
      if (box && e.target instanceof Node && box.contains(e.target)) return
      setVolOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [volOpen])

  // 音量条拖不动（用户 m04432「现在直接拖动不了」）：
  // 根因是原生 input[type=range] 竖直方向只有 3px 可见轨道、命中宽度约 21px，
  // 往旁边偏 8px 就落到浮层背景上，而背景不接拖动 —— 手感就是「拖不动」。
  // 这里在滑块那一段盖一层透明热区接管拖动：按在任意位置都按 Y 位置换算音量并跟随移动，
  // 不再要求精确压在那 3px 轨道上（热区只盖滑块高度，不盖下方百分比数字，否则一碰就静音）。
  const volDragId = useRef<number | null>(null)
  const volInputRef = useRef<HTMLInputElement>(null)
  const volFromY = useCallback((clientY: number) => {
    const input = volInputRef.current
    if (!input) return
    const r = input.getBoundingClientRect()
    if (r.height <= 0) return
    // 竖直滑条用 writing-mode: vertical-lr + direction: rtl 渲染 ⇒ 顶部＝1、底部＝0
    const ratio = (r.bottom - clientY) / r.height
    const v = Math.min(1, Math.max(0, Math.round(ratio * 100) / 100))
    setVolLocal(v)
    sendVolume(v)
  }, [sendVolume])
  // 拖动一律由这层透明热区接管，不再依赖原生 input[type=range] 的竖直拖动：
  // 原生竖直滑条只有 3px 轨道可瞄，本机实测同一落点有时生效有时不生效；
  // 接管后「按在哪儿就从哪儿开始算」，整块区域都是有效热区（用户 m04432「现在直接拖动不了」）。
  const volDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    volDragId.current = e.pointerId
    // 先取值再捕获：setPointerCapture 极端情况下可能抛，抛了也不该影响这一次取值
    volFromY(e.clientY)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 指针已失效，忽略 */ }
  }, [volFromY])
  const volDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (volDragId.current !== e.pointerId) return
    volFromY(e.clientY)
  }, [volFromY])
  const volDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (volDragId.current !== e.pointerId) return
    volDragId.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 指针已释放 */ }
  }, [])

  // 首帧先取一次快照（同时让主进程懒启动桥接），之后靠推送
  useEffect(() => {
    let alive = true
    void window.island.musicGet().then((s) => {
      if (alive) setMusic(s)
    })
    const off = window.island.onMusicState((s) => setMusic(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 每次收到新快照就把插值重置到采样点。两点防「回缩」：
  // ①拖动中（seekingRef）完全不打断本地值；②松手后 seek 生效前，播放器还会连续回传
  //   拖动前的旧 position，若照单全收，条子会先缩回去、等 seek 生效再滑到目标。
  //   这段保护窗口内忽略旧快照，直到 position 跳到目标附近（=seek 生效）才恢复跟随。
  useEffect(() => {
    if (!music || seekingRef.current) return
    const guard = seekGuardRef.current
    if (guard) {
      if (music.title !== guard.title || Date.now() - guard.at > 2500) {
        // 换歌 / 超时（比如播放器拒绝 seek）→ 放弃保护，诚实跟随真实位置，不永久卡住
        seekGuardRef.current = null
      } else if (Math.abs(music.position - guard.target) > 2) {
        // 还没跳到目标：这条是 seek 生效前的旧快照，忽略，保持拖动目标值
        return
      } else {
        // 位置已到目标附近 = seek 生效，结束保护
        seekGuardRef.current = null
      }
    }
    setLive(music.position)
    // 记下「这个位置是什么时候知道的」，供下面的平滑外推用（用户 m05562）
    liveBaseRef.current = { pos: music.position, at: performance.now() }
  }, [music?.position, music?.title, music?.playing])

  // 主进程采样回来后清掉音量本地值，让滑块对齐当前应用音频会话的真实音量
  useEffect(() => {
    if (music) setVolLocal(null)
  }, [music?.volume])

  /**
   * 换歌就要换歌词（SPEC-music-lyric）。
   *
   * 用户 m06116「你用这个我怎么看播放时间」之后改成**一直查**，不再等歌词栏打开：
   * 网易云不报总时长，进度条要靠歌词库里那条记录的时长来算；只有歌词栏打开才查的话，
   * 关着歌词栏就永远是 `--:--`。每首歌只查一次（主进程有本地缓存，第二次直接命中文件），
   * 并把结果顺手用在歌词栏上，一举两得。
   * 查询键用「歌名+歌手+专辑+时长取整」，同一首歌反复开关歌词栏不会重复请求。
   */
  const lyricKey =
    music?.active && music.title
      ? `${music.title}|${music.artist}|${music.album}|${Math.round(music.duration)}`
      : ''
  useEffect(() => {
    if (!lyricKey) return
    if (lyricForRef.current === lyricKey && lyric) return
    lyricForRef.current = lyricKey
    let alive = true
    setLyricLoading(true)
    void window.island
      .lyricGet({
        title: music?.title ?? '',
        artist: music?.artist ?? '',
        album: music?.album ?? '',
        duration: music?.duration ?? 0
      })
      .then((r) => {
        if (!alive) return
        setLyric(r)
      })
      .catch(() => {
        if (!alive) return
        setLyric({
          ok: false,
          title: music?.title ?? '',
          artist: music?.artist ?? '',
          source: 'none',
          lines: [],
          reason: '查歌词时出错了，稍后再试'
        })
      })
      .finally(() => {
        if (alive) setLyricLoading(false)
      })
    return () => {
      alive = false
    }
  }, [lyricKey, lyric, music?.title, music?.artist, music?.album, music?.duration])

  /**
   * 播放器报的进度可不可信。
   *
   * 用户 m05794「我换了一个软件网易云，歌词进度条封面都直接卡住了」：
   * 实测网易云（cloudmusic.exe）只往系统媒体接口写 歌名/歌手/封面，时间轴永远是
   * `pos=0 / end=0 / lastUpd=1601-01-01 / canSeek=false`（连采 30 次不变）。
   *
   * 用户 m06116「--:-- 你用这个我怎么看播放时间」：上一版在这里直接显示两个横杠，
   * 那是逃避。改成自己算：歌词库那条记录带着这首歌的准确总时长（`lyric.duration`），
   * 拿它当分母，位置从「开始播放那一刻」起按真实时间累加，暂停就不动、换歌就归零。
   * 算不出来（连总时长都没有）才退回横杠。
   */
  const playerNoTimeline = music?.active === true && music.duration <= 0
  /** 歌词库给的总时长，用来补播放器不报的那一份 */
  const lyricDuration = lyric?.duration && lyric.duration > 0 ? lyric.duration : 0
  /**
   * 实际用来算进度的总时长：优先用播放器自己报的（最可信），
   * 播放器不报就用歌词库那条的时长（网易云场景）。
   */
  const totalDur = music && music.duration > 0 ? music.duration : lyricDuration
  /**
   * 播放位置的心跳。
   *
   * 用户 m06607「我每次点到歌曲页面，进度条都会重新开始，字幕也是」：
   * 走的是模块级的 progressClock（见文件上部），本组件只负责每 250ms 读一次、触发重渲染。
   * 组件卸载不丢时钟，切走再切回来能接上原来那一秒，歌词也停在同一句。
   */
  const [, setClockTick] = useState(0)
  useEffect(() => {
    ensureClockWatcher()
    const id = window.setInterval(() => setClockTick((n) => (n + 1) % 1000000), 250)
    return () => window.clearInterval(id)
  }, [])
  /** 真正显示在进度条/时间上的位置：播放器报就用它的（live），不报就用墙上时钟自己数 */
  const shownPos = playerNoTimeline ? clockNow() : live
  /** 连总时长都算不出来时，才诚实显示横杠（此时确实无法给出任何时间） */
  const noTimeline = playerNoTimeline && totalDur <= 0
  /**
   * 播放器压根不报进度、但我们能从它自己窗口的进度条里读到已播比例（`barOk`）。
   *
   * 用户 m07228「做不到也要做」：网易云实现了 SMTC 的歌名/歌手/封面，却把进度藏起来
   * （`IsPlaybackPositionEnabled=False`、`Position/EndTime` 恒 0），SMTC 的 seek 也只会
   * 返回 true 而什么都不做。但它自己的窗口底部有一条进度条，已播段有颜色、未播段是灰的，
   * 用 `PrintWindow` 离屏读像素就能算出真实比例，**点它也真的会让网易云跳**
   * （实测目标 0.70→0.694、0.20→0.194、0.45→0.444，误差 <0.01）。
   * 所以这类播放器照样允许拖进度条，只是走 `barseek`（点它窗口里的条）而不是 SMTC seek。
   */
  const barClickable = playerNoTimeline && music?.barOk === true && totalDur > 0

  /**
   * 用播放器窗口进度条读回的真实位置校准自算的墙钟。
   *
   * 为什么需要：墙钟从「开始播放那一刻」自己数，用户要是在网易云里手动拖一下进度条，
   * 墙钟就会一直偏着（差的秒数不会自己回来）。桥接每 2 秒读一次真实比例，
   * 乘上总时长就是真实位置；**只在偏差超过 1.5 秒时才掰**，否则每 2 秒硬掰一次会让
   * 进度条一格格地跳，反而难看（桥接那边有 2 秒缓存，读到的值本来就滞后）。
   */
  useEffect(() => {
    if (!playerNoTimeline || !music?.barOk) return
    if (totalDur <= 0) return
    const b = Number(music.barPct)
    if (!Number.isFinite(b) || b < 0) return
    const target = Math.min(totalDur, Math.max(0, b * totalDur))
    if (Math.abs(clockNow() - target) > 1.5) clockAnchor(target, music.playing === true)
  }, [playerNoTimeline, music?.barOk, music?.barPct, music?.playing, totalDur])

  // 当前该高亮第几句：取「开始时间 ≤ 当前播放位置」的最后一行。没拿到歌词就是 -1
  const lyricLines = lyric?.ok && lyric.lines.length > 0 ? lyric.lines : []
  /**
   * 用户 m06418「歌词依旧没反应」：实测《戒烟》第一句在 20.97 秒，前 21 秒全是前奏——
   * 本来就一句都不该亮。但「一片灰、没一个亮」在用户眼里就是坏了。
   * 所以前奏期给两个明确信号：①第一句单独提亮一档（.music-lyric-row.next）；
   * ②歌词栏底部一行「前奏中 · 还有 N 秒开唱」。
   * preludeLeft 只在「有歌词、还没到第一句」时有值，其余为 0。
   */
  const lyricActive = useMemo(() => {
    if (lyricLines.length === 0) return -1
    let idx = -1
    for (let i = 0; i < lyricLines.length; i += 1) {
      if (lyricLines[i].time <= shownPos + 0.15) idx = i
      else break
    }
    return idx
  }, [lyricLines, shownPos])
  const preludeLeft =
    lyricLines.length > 0 && lyricActive === -1 ? Math.max(0, lyricLines[0].time - shownPos) : 0

  /**
   * 让当前那句始终停在歌词栏正中：每句平均约 20~30 布局 px 高，
   * 用 scrollTop = 行顶 − 容器一半 + 行高一半 让它居中，行为 smooth。
   * 不用 scrollIntoView —— 那会把外层岛一起滚。
   *
   * 用户 m05419「一条一条出来，不是 txt 这样揉成一团」之后歌词区变高了，
   * 靠 scrollTop 计算在容器尺寸刚变（开合歌词栏 / 岛展开收起）时用的是旧 clientHeight，
   * 结果当前行跑到框外。改成「先量容器和行的实际矩形，按差值补一次」，
   * 并且首帧/尺寸变化时用 auto（立即到位），之后切句仍走 smooth。
   */
  useEffect(() => {
    const box = lyricScrollRef.current
    const row = lyricActiveRef.current
    if (!box) return
    /**
     * 用户 m05562「歌词播放没有中心感，在上面播放，完全看不到」：
     * 歌开头的几句没有足够的上方内容可滚，scrollTop 顶到 0 就停住，当前行只能贴框顶
     * （实测 offset 只有 −34.3，还被上方 14px 渐隐吃掉）。给滚动区上下各垫「半框高 − 半行高」，
     * 第一句和最后一句也能滚到正中。行高用 ×1.35 兜住当前行放大到 15px 后的占位。
     */
    const shortH = box.clientHeight
    const rowH = (row ?? box.querySelector('.music-lyric-row'))?.getBoundingClientRect().height ?? 0
    if (shortH > 0 && rowH > 0) {
      const pad = Math.max(0, Math.round((shortH - rowH) / 2))
      box.style.setProperty('--lyric-pad', `${pad}px`)
    }
    if (!row) return
    /**
     * 按实际矩形把当前行推到正中。做两遍：第一遍滚过去之后，
     * 当前行字号变化（12→15）会让各行高度重新排布，位置会偏半行，
     * 第二遍按实测差值补正。差值 <2px 就不动了，避免抖动。
     */
    const align = (smooth: boolean): void => {
      for (let pass = 0; pass < 2; pass += 1) {
        const boxRect = box.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        if (boxRect.height <= 0 || rowRect.height <= 0) return
        const delta = rowRect.top + rowRect.height / 2 - (boxRect.top + boxRect.height / 2)
        if (Math.abs(delta) < 2) return
        box.scrollTo({ top: Math.max(0, box.scrollTop + delta), behavior: smooth ? 'smooth' : 'auto' })
        smooth = false
      }
    }
    align(false)
    const raf = requestAnimationFrame(() => align(false))
    return () => cancelAnimationFrame(raf)
  }, [lyricActive, lyricLines.length])

  // 歌词栏开合 / 尺寸变化时重新把当前句摆到中间（此时刚 display:flex，高度是新的）
  useEffect(() => {
    if (!lyricOpen) return
    const box = lyricScrollRef.current
    if (!box) return
    const align = (): void => {
      const row = lyricActiveRef.current
      if (!row) return
      const boxRect = box.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      if (boxRect.height <= 0 || rowRect.height <= 0) return
      const delta = rowRect.top + rowRect.height / 2 - (boxRect.top + boxRect.height / 2)
      if (Math.abs(delta) < 2) return
      box.scrollTo({ top: Math.max(0, box.scrollTop + delta), behavior: 'auto' })
    }
    const pad = (): void => {
      const row = lyricActiveRef.current
      const h = box.clientHeight
      const rowH = (row ?? box.querySelector('.music-lyric-row'))?.getBoundingClientRect().height ?? 0
      if (h > 0 && rowH > 0) box.style.setProperty('--lyric-pad', `${Math.max(0, Math.round((h - rowH) / 2))}px`)
    }
    pad()
    const raf = requestAnimationFrame(() => {
      pad()
      align()
    })
    const timer = setTimeout(() => {
      pad()
      align()
    }, 260)
    const timer2 = setTimeout(() => {
      pad()
      align()
    }, 700)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      clearTimeout(timer2)
    }
  }, [lyricOpen])

  // 播放中把本地位置平滑往前推。到总时长就停在末尾（不越界），暂停/空态不动。
  // seek 生效前的保护窗口内不推进，避免本地值在「拖动目标」和「旧位置」之间来回漂。
  //
  // 用户 m05562「唱的对不齐」：原来按整秒 +1 累加，可主进程快照并不准时（实测假会话 6.6 秒
  // 才跳一次），按整秒推就会与真实播放越走越远。改成「基准位置 + 真实流逝时间」外推，
  // 每次新快照都会重设基准，所以误差不累积；250ms 一帧让高亮切行更准。
  useEffect(() => {
    if (!music || !music.active || !music.playing || seeking) return
    // 用户 m05794：网易云（cloudmusic.exe）通过系统媒体接口根本不报时间轴
    // （实测连采 30 次 pos=0 / end=0 / lastUpd=1601-01-01 / canSeek=false）。
    // 总时长 0 时没有可信基准，硬外推只会让数字自己往上跑，干脆不推。
    if (music.duration <= 0) return
    const id = setInterval(() => {
      if (seekGuardRef.current) return
      const base = liveBaseRef.current
      // 外推最多超前最近一次快照 0.9 秒：主进程已经从桥接层按 LastUpdatedTime 补过位置，
      // 这里再夹一层是为了两次快照之间平滑，不是用来追延迟的（用户要的是对齐，不是抢跑）
      const next = base ? base.pos + Math.min((performance.now() - base.at) / 1000, 0.9) : null
      if (next === null) return
      setLive((v) => {
        // 外推值比本地值落后超过 1.5 秒就当基准过期，保住本地值往前（防倒退跳帧）
        const target = next > v - 1.5 ? next : v
        return music.duration > 0 ? Math.min(target, music.duration) : target
      })
    }, 250)
    return () => clearInterval(id)
  }, [music?.active, music?.playing, music?.duration, music, seeking])

  const ctl = useCallback(
    (cmd: MusicCommand) => {
      if (busy) return
      const key = typeof cmd === 'string' ? cmd : cmd.cmd
      // 拖/点进度条不锁整页控件。busy 的用途是「防连点把播放器按懵」，
      // 而 seek 本身幂等（后一次覆盖前一次）；以前这里一并 setBusy，导致每次点进度条
      // 三个按钮都会 disabled 300ms、透明度掉到 0.45，看起来像「闪一下消失」。
      if (key === 'seek' || key === 'barseek') {
        void window.island.musicControl(cmd).catch(() => false)
        return
      }
      setBusy(key)
      void window.island
        .musicControl(cmd)
        .catch(() => false)
        .finally(() => {
          // 给播放器 300ms 反应时间再解锁，防连点把播放器按懵
          setTimeout(() => setBusy(null), 300)
        })
    },
    [busy]
  )

  const active = music?.active === true
  const pct =
    totalDur > 0 ? Math.min(1, Math.max(0, (noTimeline ? 0 : shownPos) / totalDur)) : 0
  // 参考图（用户 m02652）进度行右端是「负数剩余时间」，如 -04:03
  const remain = Math.max(0, totalDur - (noTimeline ? 0 : shownPos))

  /** 把鼠标横坐标换算成秒数（点在进度条热区任意位置都成立） */
  const secAt = (clientX: number): number => {
    const el = barRef.current
    if (!el || totalDur <= 0) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return ratio * totalDur
  }

  /** 同一个横坐标的「比例」形式：窗口点击通道要的是比例不是秒（见 barseek 的注释） */
  const ratioAt = (clientX: number): number => {
    const el = barRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  /**
   * 能不能点进度条。
   *
   * 用户 m06607「进度条我也点不了」时的第一版修法是「只要算得出总时长就允许点，
   * 点完先把我们自己的钟挪过去，界面立刻有反应」——这是错的，用户 m06991
   * 「我点击音乐条音乐不会跟着音乐条同步，现在只是字幕同步了而已」抓到要害：
   * 网易云根本不接受跳转（实测见下），把钟挪过去只会让界面和音乐彻底脱节。
   *
   * 网易云为什么不能跳（2026-11-16 实测，`.tmp/word/ne-seek-proof.ps1`）：
   *   - 它的 SMTC 会话 `IsPlaybackPositionEnabled = False`，`Position/EndTime` 恒为 0，
   *     `LastUpdatedTime` 是 1601-01-01（DateTimeOffset 默认值）；
   *   - `TryChangePlaybackPositionAsync` 返回 True（谎报成功），但位置一点不动；
   *     用 9999 秒（远超曲末）试探，若真被接受必然夹到结尾并播完，实测连播放状态都不变。
   *   对照组汽水音乐：`IsPlaybackPositionEnabled = True`，seek 到 102.5 秒后位置真的变成 102.5。
   *
   * 所以门槛回到「播放器自己报时间轴才允许跳」：能跳就跳真的，不能跳就不给点，
   * 并且用 title 说清原因，而不是演一个假的跳转。
   *
   * 用户 m07228「从第一性原理出发，做不到也要做」之后补上的例外：
   * 播放器不报时间轴、但**能从它窗口里读到并在它的进度条上点**的（`barClickable`），
   * 照样允许拖——点击会真的发到它自己的进度条上，网易云会真的跳。这不是变通，
   * 这是另一条真实的通道（Now Playing 等同类工具也是这么处理这类播放器的）。
   */
  const canSeekNow = ((!playerNoTimeline && totalDur > 0) || barClickable) && !busy

  /**
   * 跳到某一秒。拖进度条松手与「点歌词行」共用这一条通道。
   *
   * ratio 可选：拖进度条时用鼠标落点算出的比例（比秒更贴近播放器的真实长度），
   * 点歌词行时只有时间戳，就按 totalDur 换算。
   */
  const jumpToSec = (sec: number, ratio?: number): void => {
    if (!canSeekNow || totalDur <= 0) return
    const target = Math.min(totalDur, Math.max(0, sec))
    const r = ratio ?? Math.min(1, Math.max(0, target / totalDur))
    // 松手后先进入保护窗口：期间忽略播放器回传的旧 position，条子不回缩；
    // 收到跳到目标附近的快照（或换歌 / 2.5s 超时）再恢复跟随真实位置
    seekGuardRef.current = { target, at: Date.now(), title: music?.title ?? '' }
    if (barClickable) {
      // 播放器不报进度：把钟先拨到目标秒，让进度条/歌词立刻跟手；
      // 紧接着真的去点它窗口里的进度条（点完它是真的会跳的，`music:state` 回来还会再校准）
      clockAnchor(target, music?.playing === true)
      // 这一下会让桥接把播放器顶到前台，岛紧接着就会失焦。先挂个抑制窗口，
      // 否则用户「点一下进度条」的观感就是「岛自己缩起来了」（用户 m02806）。
      blurSuppressUntil = Date.now() + 2500
      ctl({ cmd: 'barseek', value: Math.round(r * 1000) / 1000 })
    } else {
      ctl({ cmd: 'seek', value: Math.round(target * 10) / 10 })
    }
  }

  const onSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!canSeekNow) return
    e.currentTarget.setPointerCapture(e.pointerId)
    seekingRef.current = true
    seekGuardRef.current = null
    setSeeking(true)
    setLive(secAt(e.clientX))
  }
  const onSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!seekingRef.current) return
    setLive(secAt(e.clientX))
  }
  const onSeekPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!seekingRef.current) return
    const sec = secAt(e.clientX)
    const ratio = ratioAt(e.clientX)
    seekingRef.current = false
    setSeeking(false)
    setLive(sec)
    jumpToSec(sec, ratio)
  }

  const volume = volLocal ?? music?.volume ?? 0

  if (!active) {
    return (
      <div className="todo-panel">
        <div className="notify-empty">
          <div className="notify-empty-inner">
            <svg viewBox="0 0 24 24" className="notify-empty-icon" aria-hidden="true">
              <path
                d="M9 18V6.5l9-2v11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="15.5" cy="15.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span className="shelf-drop-hint">现在没有在放歌</span>
            <span className="notify-empty-sub">用任意播放器开始播放，这里就会显示</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`todo-panel music-panel ${lyricOpen ? 'lyric-open' : ''}`}>
      {/* 网易云后台精确控制（用户 m0xxxx「必须把网易云显示出来才能控进度，那还不如不要」）：
          调试端口只能在网易云启动时打开，所以这里给一键重启入口。开启后进度/seek 直接
          操作它的页面，窗口最小化也有效，不再依赖抓像素和把窗口顶到前台。 */}
      {/* 档位为「关闭」时连这个入口都不给（SPEC-netease-cdp-mode）：用户明确不想让岛碰网易云 */}
      {music?.neteaseRunning === true && !music.neteaseCdp && music.neteaseCdpMode !== 'off' && (
        <button
          type="button"
          className={`music-cdp-tip ${music.neteaseCdpBusy ? 'busy' : ''}`}
          disabled={music.neteaseCdpBusy || busy === 'netease-enable'}
          onClick={() => ctl({ cmd: 'netease-enable' })}
          title="网易云的调试端口只能在启动时开启；会重启网易云一次，之后最小化、被遮挡都能拖动进度"
        >
          {music.neteaseCdpBusy
            ? '正在重启网易云开启后台控制…几秒后自动恢复播放'
            : '网易云：点此开启后台精确控制（重启一次，之后最小化也能拖进度）'}
        </button>
      )}
      {/* 参考图（用户 m03174「根据截图，把音乐页面的布局先做，宽幅不过可以拉长」，
          2026-11-16 用户 m03368 指出进度条不该横穿整页）：
          上下两块并排 —— 左栏＝封面+曲名/歌手 + 进度条 + 左右时间，整栏宽度即进度条宽度；
          中间一条竖分隔线；右栏＝歌词位，独占右侧、上下居中。
          歌词文本来自 SPEC-music-lyric（2026-11-16 用户 m04986 重新授权；11-15 否决的是
          `a474ed5` 那版 LRCLIB 双源实现），查不到时只放诚实占位「暂无歌词」+ 原因，绝不编造 */}
      <div className="music-main">
        <div className="music-side">
          <div className="music-id">
            {/* 真实封面：主进程从 SMTC Thumbnail 读出的 data URL；取不到或解码失败时回落音符占位 */}
            <div className={`music-cover ${music?.playing ? 'playing' : ''}`} aria-hidden="true">
              {music?.cover && coverFailedFor !== music.cover ? (
                <img
                  className="music-cover-img"
                  src={music.cover}
                  alt=""
                  onError={() => setCoverFailedFor(music.cover)}
                />
              ) : (
                <IcoMusic />
              )}
            </div>
            <div className="music-meta">
              <div className="music-title" title={music?.title || '未知曲目'}>
                {music?.title || '未知曲目'}
              </div>
              <div className="music-artist" title={music?.artist || music?.album || ''}>
                {music?.artist || music?.album || (music?.app ? music.app.replace(/\.exe$/i, '') : '—')}
              </div>
            </div>
          </div>

          {/* 进度条只占左栏宽度，不横穿整页（用户 m03368） */}
          <div className="music-progress" role="progressbar" aria-valuemin={0} aria-valuemax={Math.round(totalDur)} aria-valuenow={Math.round(shownPos)}>
            {/* 热区比 3px 的条子高，手指/鼠标才点得到。
                只有播放器真的报了时间轴（能跳）才给 seekable，否则点不动、悬停也不变手型，
                并用 title 说明是哪一种情况（用户 m06991：不许演假的跳转） */}
            <div
              className={`music-seek ${canSeekNow ? 'seekable' : ''} ${seeking ? 'dragging' : ''}`}
              ref={barRef}
              title={
                canSeekNow
                  ? barClickable
                    ? '点任意位置跳到那里（点它自己的进度条）'
                    : '点任意位置跳到那里'
                  : playerNoTimeline
                    ? '这个播放器不接受系统的跳转指令，也没法从它的窗口里读到进度条'
                    : '总时长未知，暂时不能跳'
              }
              onPointerDown={onSeekPointerDown}
              onPointerMove={onSeekPointerMove}
              onPointerUp={onSeekPointerUp}
            >
              <div className="music-bar">
                <div className="music-bar-fill" style={{ transform: `scaleX(${pct})` }} />
              </div>
            </div>
            <div className="music-times">
              {/* 只有在「播放器不报时长 + 歌词库也没给出时长」时才显示 --:--（此时确实算不出来）。
                  网易云那种情况用歌词库的总时长 + 自己累加位置，能正常显示时间（用户 m06116）。
                  e2e 的 U5 断言「右端是 -mm:ss」，正常播放器与补齐后的网易云都走下面那支，不受影响 */}
              {noTimeline ? (
                <>
                  <span className="music-time" title="这个播放器没向系统报告播放进度">
                    --:--
                  </span>
                  <span className="music-time" title="这个播放器没向系统报告播放进度">
                    --:--
                  </span>
                </>
              ) : (
                <>
                  <span className="music-time">{fmtDuration(shownPos)}</span>
                  <span className="music-time">-{fmtDuration(remain)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <span className="music-divider" aria-hidden="true" />
        {/* 右栏歌词位（SPEC-music-lyric）：主进程去 lrclib 查带时间轴的歌词，本地有缓存就秒出。
            三种状态都能照实说明：加载中 / 拿到歌词（跟着播放位置滚动高亮）/ 没拿到（显示具体原因）。
            **没有歌词就显示「暂无歌词」+ 原因，绝不编造文本**——这是 SPEC 里写死的红线。 */}
        <div
          className="music-lyric-slot"
          title={
            lyricLoading
              ? '正在查歌词…'
              : lyric?.ok
                ? lyric.source === 'cache'
                  ? '歌词（来自本地缓存）'
                  : lyric.source === 'netease'
                    ? '歌词（来自网易云）'
                    : '歌词（来自 lrclib.net）'
                : (lyric?.reason ?? '暂无歌词')
          }
        >
          {lyricLoading ? (
            <span className="music-lyric-tip">正在查歌词…</span>
          ) : lyricLines.length > 0 ? (
            <>
              <div className="music-lyric-scroll" ref={lyricScrollRef}>
                {lyricLines.map((ln, i) => (
                  <div
                    key={`${ln.time}-${i}`}
                    ref={i === lyricActive ? lyricActiveRef : null}
                    className={`music-lyric-row ${canSeekNow ? 'seekable' : ''} ${
                      i === lyricActive ? 'active' : ''
                    }${preludeLeft > 0 && i === 0 ? ' next' : ''}`}
                    data-time={ln.time}
                    // 点某句直接跳到那句（用户反馈「鼠标放在歌词上样式没变」）：
                    // 只有真能跳（canSeekNow）才给手型和点击，跳不动的播放器不装样子。
                    title={canSeekNow ? `点这句跳到 ${fmtDuration(ln.time)}` : undefined}
                    onClick={canSeekNow ? () => jumpToSec(ln.time) : undefined}
                  >
                    {ln.text}
                  </div>
                ))}
              </div>
              {/* 前奏期（还没到第一句）给一行明确倒计时，免得一片灰看着像坏了——用户 m06418 */}
              {preludeLeft > 0 ? (
                <span className="music-lyric-tip music-lyric-prelude">
                  前奏中 · 还有 {Math.ceil(preludeLeft)} 秒开唱
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="music-lyric-tip">暂无歌词</span>
              {lyric && !lyric.ok && lyric.reason ? (
                <span className="music-lyric-why">{lyric.reason}</span>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* 参考图（用户 m02652）：控制行＝播放按钮一排。
          用户 m03435「喇叭移到下一首的右边，所以播放和切换要位于歌名的正下方中心位置」：
          .music-control-row 与上面 .music-main 同分栏（左栏 212 / 分隔线 / 右栏 212），
          三个按钮在左栏内居中 ⇒ 正好落在「封面＋歌名」那块的正下方；
          喇叭（.music-extra）绝对定位贴在「下一首」右外侧，既不挤压按钮、也不再吊在整岛最右端。
          容器仍是 .music-ctl、三个按钮仍是 .music-btn、音量仍包在 .music-volume 里，保住 e2e 断言口径 */}
      <div className="music-control-row">
        <div className="music-ctl">
          <div className="music-ctl-buttons">
            {/* 用户 m04117「可以把封面等ui分开一点布局，这样子可以填满这个界面，这样两边的黑边就不会很多余，
                还有就是歌词ui放切上一首的旁边」：
                整行两段 —— .music-ctl-mid（「词」+ 三按钮，居中）/ .music-extra（喇叭，贴最右）。
                中间那组 flex:1 吃掉剩余宽度，「词」贴着「上一首」左边，两端不再留黑边。
                歌词后来由用户 m04986（2026-11-16）重新授权并实现（SPEC-music-lyric），
                这枚按钮开合右侧真实歌词栏；类名沿用 `.music-word` 是历史命名，不为改名动 e2e。 */}
            <div className="music-ctl-mid">
              <button
                type="button"
                className={`music-word ${lyricOpen || desktopLyricOn ? 'on' : ''}`}
                title={
                  lyricOpen
                    ? canDesktopLyric
                      ? '关闭岛内歌词，打开网易云桌面歌词'
                      : '收起歌词栏（需开启后台控制才能用桌面歌词）'
                    : desktopLyricOn
                      ? '关闭网易云桌面歌词'
                      : '展开歌词栏；再点一次换成桌面歌词'
                }
                aria-label="歌词"
                aria-expanded={lyricOpen}
                aria-pressed={lyricOpen || desktopLyricOn}
                onClick={onWordClick}
              >
                词
              </button>
              <button
                type="button"
                className="music-btn"
                title="上一首"
                aria-label="上一首"
                disabled={busy !== null}
                onClick={() => ctl('prev')}
              >
                <IcoPrev />
              </button>
            <button
              type="button"
              className={`music-btn music-btn-main ${music?.playing ? 'on' : ''}`}
              title={music?.playing ? '暂停' : '播放'}
              aria-label={music?.playing ? '暂停' : '播放'}
              aria-pressed={music?.playing === true}
              disabled={busy !== null}
              onClick={() => ctl('toggle')}
            >
              {music?.playing ? <IcoPause /> : <IcoPlay />}
            </button>
            <button
              type="button"
              className="music-btn"
              title="下一首"
              aria-label="下一首"
              disabled={busy !== null}
              onClick={() => ctl('next')}
            >
              <IcoNext />
            </button>
            </div>

            <div className="music-extra">
              <div
                ref={volBoxRef}
                className={`music-volume ${music?.canVolume !== true ? 'off' : ''}`}
                title={music?.canVolume === true ? '当前播放应用的音量（只影响这个应用）' : '没找到这个播放应用的音量，无法单独调'}
              >
                {/* 平时只留喇叭按钮；点一下展开竖直音量条，再点收起（用户 m02462 / m02917） */}
                <button
                  type="button"
                  className={`music-vol-toggle ${volOpen ? 'open' : ''}`}
                  aria-label="音量"
                  aria-expanded={volOpen}
                  title="点击展开/收起音量"
                  onClick={() => setVolOpen((v) => !v)}
                >
                  <IcoVolume />
                </button>
                {/* 竖直弹出层：input 常驻 DOM（不条件渲染），保住既有 e2e 对 .music-volume input[type=range] 的断言 */}
                <div className={`music-vol-pop ${volOpen ? 'open' : ''}`}>
                  <input
                    ref={volInputRef}
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    disabled={music?.canVolume !== true}
                    aria-label="当前播放应用的音量"
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setVolLocal(v)
                      sendVolume(v)
                    }}
                  />
                  {/* 透明拖动热区：盖住整条滑块，按在任意位置都能拖。
                      复用 m03141「加宽热区」的思路，但不再受原生滑条命中死角限制（用户 m04432） */}
                  <div
                    className="music-vol-drag"
                    onPointerDown={volDragStart}
                    onPointerMove={volDragMove}
                    onPointerUp={volDragEnd}
                    onPointerCancel={volDragEnd}
                  />
                  <span className="music-volume-num">{music?.canVolume === true ? `${Math.round(volume * 100)}%` : '--'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 页标签：页头图标组件 + 名称（对照视频里每页左上角的彩色小图标 + 页名）；图标用线性 SVG，不用 emoji */
const PAGE_META: { icon: () => React.JSX.Element; label: string; accent: string }[] = [
  { icon: IcoCheck, label: '待办', accent: '#7dd87d' },
  { icon: IcoShelf, label: '置物架', accent: '#ffb74d' },
  { icon: IcoBell, label: '通知', accent: '#9f8bff' },
  { icon: IcoCal, label: '日程', accent: '#64b5f6' },
  { icon: IcoMusic, label: '音乐', accent: '#ff8fa3' },
]

export default function App(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [battery, setBattery] = useState<number | null>(null)
  // 充电中（status:snapshot 一直带着 charging，UI 从未用过——电量态轮次开始消费）
  const [charging, setCharging] = useState<boolean>(false)
  // Wi-Fi 快照（收起态 US-005）；null = 读不到，不显示图标
  const [wifi, setWifi] = useState<WifiSnapshot | null>(null)
  const [mood, setMood] = useState<'idle' | 'happy'>('idle')
  // 桌宠皮肤（SPEC-deskpet-skin）：默认胶囊（升级前的老形象），mount 后从 prefs 回填。
  // 为什么不和 pagesCustom 合成一个 state：皮肤改动是「设置页单选」，频率与页面裁剪不同，
  // 且它只影响一处渲染，单独一份更好读。
  const [petSkin, setPetSkin] = useState<string>('capsule')
  // 桌宠出现模式（SPEC-deskpet-out）：'window' 时岛里不画桌宠——它出门了。
  // 与 petSkin 同一份 prefs，同样「先默认后异步回填」，同样不吃 dirty。
  const [petMode, setPetMode] = useState<string>('island')
  // 时钟显示档位（SPEC-clock-date-format）：默认仅时间，mount 后从 prefs 回填
  const [clockFormat, setClockFormat] = useState<ClockFormat>('time')
  // 「词」第二下是否召唤桌面歌词（SPEC-desktop-lyric-setting）：默认开，与主进程缺失值一致
  const [desktopLyricEnabled, setDesktopLyricEnabled] = useState(true)
  const [page, setPage] = useState(0)
  // 页面裁剪（US-032）：显示哪些页面 + 收起态组件开关；page 4 是「页面管理」面板本身。
  // 偏好走主进程 prefs.json（IPC），localStorage 跨重启会丢（本机实测），所以初始先默认全开，
  // mount 后异步取回真实偏好再应用——与电量/网络快照同为「先默认后异步回填」的既有模式。
  const [pagesCustom, setPagesCustom] = useState<PagesCustom>(defaultPagesCustom)
  const enabledPages = pagesCustom.pages
  // 用户一旦在面板里改过（dirty）就不再接受启动回填，避免覆盖用户操作
  const pagesCustomDirty = useRef(false)
  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((prefs) => {
        if (!alive) return
        // 皮肤不受 pagesCustomDirty 影响（是另一份偏好），先无条件应用
        if (typeof prefs.petSkin === 'string') setPetSkin(prefs.petSkin)
        if (typeof prefs.petMode === 'string') setPetMode(prefs.petMode)
        if (prefs.clockFormat) setClockFormat(prefs.clockFormat)
        if (typeof prefs.desktopLyricEnabled === 'boolean') setDesktopLyricEnabled(prefs.desktopLyricEnabled)
        if (pagesCustomDirty.current) return
        const v = normalizePagesCustom(prefs.pagesCustom)
        if (v) setPagesCustom(v)
      })
      .catch(() => {
        /* 读不到就用默认全开 */
      })
    return () => {
      alive = false
    }
  }, [])
  // 通知未读数（收起态红点用；仅在通知页加载/标记时更新）
  const [notifyUnread, setNotifyUnread] = useState(0)
  // 新消息到岛横幅（参考苹果灵动岛）：收起态弹「图标+应用名+标题」，5 秒后收回；
  // 展开态忽略（用户正在看通知页）。后到覆盖先到（多条并发只显示最新一条）。
  const [banner, setBanner] = useState<{ item: NotifyItem; count: number } | null>(null)
  const bannerTimer = useRef<number | null>(null)
  const bannerCountRef = useRef<number>(0)
  const hoverRef = useRef(false)
  // 歌词面板开着（SPEC-music-lyric-pin）：定时收起到点时读它，开着就放弃这次收起。
  // 用 ref 而不是 state 是刻意的——收起定时器回调不该因为面板开合而重建。
  const lyricOpenRef = useRef(false)
  const onLyricOpenChange = useCallback((open: boolean) => {
    lyricOpenRef.current = open
  }, [])
  // US-036 诊断探针：让 blur 回调读到最新 expanded（useEffect 闭包会过期）
  const expandedRef = useRef(false)
  expandedRef.current = expanded
  const collapseTimer = useRef<number | null>(null)
  /** US-041：避让回调要调 clearCollapseTimer，但那函数声明在后——用 ref 桥接 */
  const clearCollapseTimerRef = useRef<(() => void) | null>(null)
  const islandRef = useRef<HTMLDivElement | null>(null)
  // 一次拖动只处理一次 dragEnter 的去重标记（dragleave/drop 时复位）
  const dragActive = useRef(false)

  // 尺寸自适应上报：岛元素按内容自然撑开（CSS max-content），这里量出实际尺寸报给主进程定窗口。
  // 去抖 80ms：避开 width/height 过渡动画的中间值，只在尺寸稳定后上报。
  useEffect(() => {
    const el = islandRef.current
    if (!el) return
    let timer: number | null = null
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        const r = el.getBoundingClientRect()
        const w = Math.ceil(r.width)
        const h = Math.ceil(r.height)
        if (w <= 0 || h <= 0) return
        if (el.classList.contains('expanded')) {
          window.island.setExpandedSize(w, h)
        } else {
          window.island.setCollapsedWidth(w)
        }
      }, 80)
    })
    ro.observe(el)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      ro.disconnect()
    }
  }, [])

  // 时钟走字
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // 新消息横幅：主进程轮询发现新通知时推送。
  // 展开态不立即弹（用户正看着通知页），暂存 pendingBanner，收起瞬间补弹——
  // 否则展开期间错过的消息会被主进程记入 bannerSent，收起后永远看不到横幅。
  // 展开期间同时自增 notifyRefreshTick，让挂载中的 NotifyPanel 重拉列表（否则停在通知页时
  // 新消息要退出重进才出现——2026-11-07 用户实测反馈的 bug）。
  const pendingBanner = useRef<{ item: NotifyItem; count: number } | null>(null)
  const [notifyRefreshTick, setNotifyRefreshTick] = useState(0)
  useEffect(() => {
    window.island.onNotifyArrived((item: NotifyItem) => {
      // 未读数只能从这里来：NotifyPanel 只在展开态且停在通知页时挂载，
      // 它卸载后没人更新 notifyUnread，铃铛数字会一直停在旧值
      // （2026-11-11 用户实测「来通知了岛没反应」就是这条）。所以每条到达都主动重拉一次。
      void window.island
        .notifyList()
        .then((r: NotifyListResult) => setNotifyUnread(r.unread))
        .catch(() => {})
      if (expandedRef.current) {
        // 展开期间累计条数：补弹时一次性显示总数
        if (pendingBanner.current === null) pendingBanner.current = { item, count: 1 }
        else pendingBanner.current = { item, count: pendingBanner.current.count + 1 }
        setNotifyRefreshTick((t) => t + 1)
        return
      }
      showBanner(item)
    })
  }, [])

  const showBanner = (item: NotifyItem): void => {
    if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current)
    bannerCountRef.current += 1 // 横幅期内每条 +1；收回时清零
    setBanner({ item, count: bannerCountRef.current })
    window.island.setBannerVisible(true) // 收起窗口只有胶囊高，横幅期主进程加高窗口（否则渲染在窗口外看不见）
    announceBannerHold(true) // US-041 横幅优先：正在全屏避让时临时现身
    bannerTimer.current = window.setTimeout(() => {
      setBanner(null)
      bannerCountRef.current = 0
      bannerTimer.current = null
      window.island.setBannerVisible(false)
      announceBannerHold(false)
    }, 5000)
  }

  /** 点击横幅：打开来源应用并立即收回横幅（不收起/展开岛，不动已读水位） */
  const openFromBanner = (): void => {
    if (banner === null) return
    void window.island.notifyOpenSource(banner.item.app, banner.item.launch)
    if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current)
    setBanner(null)
    bannerCountRef.current = 0
    bannerTimer.current = null
    window.island.setBannerVisible(false)
    announceBannerHold(false)
  }

  // 展开态切回收起态：若有展开期间错过的消息，补弹横幅（带累计条数）
  useEffect(() => {
    if (!expanded && pendingBanner.current !== null) {
      const { item, count } = pendingBanner.current
      pendingBanner.current = null
      bannerCountRef.current = count - 1 // showBanner 内部会 +1，这里预扣使最终显示恰好为 count
      showBanner(item)
    }
  }, [expanded])

  // US-039 验证码横幅：主进程剪贴板轮询识别到验证码时推送。
  // 与通知横幅共用横幅位（后到覆盖先到）；8s 自动消失（验证码时效短）；
  // 展开态忽略、不补弹（SPEC 明确：展开时用户正在操作，补弹无意义）。
  const [codeBanner, setCodeBanner] = useState<string | null>(null)
  const [codeCopied, setCodeCopied] = useState(false)
  const codeBannerTimer = useRef<number | null>(null)
  useEffect(() => {
    window.island.onCodeArrived((code: string) => {
      if (expandedRef.current) return // 展开态不弹不补弹
      showCode(code)
    })
  }, [])
  const showCode = (code: string): void => {
    if (codeBannerTimer.current !== null) window.clearTimeout(codeBannerTimer.current)
    setCodeBanner(code)
    setCodeCopied(false)
    window.island.setBannerVisible(true)
    announceBannerHold(true) // US-041 横幅优先
    codeBannerTimer.current = window.setTimeout(() => {
      setCodeBanner(null)
      setCodeCopied(false)
      codeBannerTimer.current = null
      window.island.setBannerVisible(false)
      announceBannerHold(false)
    }, 8000)
  }
  /** 点击验证码横幅 → 复制验证码到剪贴板，横幅提示「已复制」并照常 8s 计时收回 */
  const copyCodeBanner = (): void => {
    if (codeBanner === null) return
    void window.island.clipboardWriteText(codeBanner).then((okFlag) => {
      if (okFlag) setCodeCopied(true)
    })
  }
  const closeCodeBanner = (): void => {
    if (codeBannerTimer.current !== null) window.clearTimeout(codeBannerTimer.current)
    setCodeBanner(null)
    setCodeCopied(false)
    codeBannerTimer.current = null
    window.island.setBannerVisible(false)
    announceBannerHold(false)
  }

  // 电量与 Wi-Fi：首取 + 主进程推送（插拔电源即时刷新）+ 每 15 秒兜底刷新
  // （2026-11-19：原来 60 秒一次，用户断网后最多要等一分半才看到图标）
  useEffect(() => {
    let alive = true
    const apply = (s: { battery: number | null; charging: boolean; wifi: WifiSnapshot | null }): void => {
      setBattery(s.battery)
      setCharging(s.charging)
      setWifi(s.wifi)
    }
    const pull = (): void => {
      void window.island.statusSnapshot().then((s) => {
        if (alive) apply(s)
      })
    }
    // 主进程在插拔电源 / 休眠恢复时主动推一份（判定口径与 statusSnapshot 完全一致）
    // onStatusChanged 返回取消订阅函数，cleanup 里必须调，否则重复挂载会叠加监听
    const offStatus = window.island.onStatusChanged((s) => {
      if (alive) apply(s)
    })
    // 系统网络切换（Chromium online/offline、NetworkInformation change）时立刻强制重读，
    // 不等 15 秒轮询；主进程另有 TCP 探针兜住「连着网但上不了网」这种不发 online 事件的情况。
    const refresh = (): void => {
      void window.island.statusRefresh().then((s) => {
        if (alive) apply(s)
      })
    }
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection
    conn?.addEventListener?.('change', refresh)
    // 点岛/展开时顺手拉一次：用户刚断网、马上点开看状态时不必等下一个轮询周期
    // （capture 阶段监听，不干扰各页面自己的点击处理）
    window.addEventListener('pointerdown', pull, true)
    pull()
    const id = window.setInterval(pull, 15_000)
    return () => {
      alive = false
      window.clearInterval(id)
      window.removeEventListener('pointerdown', pull, true)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
      conn?.removeEventListener?.('change', refresh)
      offStatus()
    }
  }, [])

  // 开机自启：岛头部那枚胶囊 2026-11-16 按用户 m01514「岛上的这个自启开关去掉吧，
  // 在设置页里即可」删除，岛内不再渲染、也不再订阅 autostart 状态。
  // 唯一的开关在设置窗口「常规」分区（src/renderer/src/settings/SettingsApp.tsx），
  // 主进程 IPC `autostart:get`/`autostart:set`/`autostart:changed` 全部保留不动。

  // 状态变化时同步给主进程，由它调整窗口尺寸
  useEffect(() => {
    window.island?.setExpanded(expanded)
  }, [expanded])

  // US-041 全屏避让：主进程隐藏/恢复岛时，渲染层同步收起面板（恢复后回收起态，
  // 不做展开记忆——SPEC 明确）并保证横幅计时器不悬挂（隐藏中横幅 DOM 不可见但 timer 还在跑）。
  const [avoidHidden, setAvoidHidden] = useState(false)
  useEffect(() => {
    window.island.onAvoidChanged((hidden: boolean) => {
      setAvoidHidden(hidden)
      if (hidden) {
        if (expandedRef.current) {
          setExpanded(false)
          expandedRef.current = false
        }
        // 清掉展开态自动收起计时器（隐藏期间没有意义）
        clearCollapseTimerRef.current?.()
      }
    })
  }, [])

  // US-041 横幅优先：通知/验证码横幅弹出时让主进程临时现身（即使正在避让）；
  // 横幅结束后回传 false，主进程按当前全屏状态决定回隐或常驻。
  const announceBannerHold = (on: boolean): void => {
    window.island.requestTempShow(on)
  }

  // 点了桌面/其他程序（窗口失焦）→ 立即收回。
  // 坑（历史）：中文输入法的候选窗不会夺走主窗口焦点（微软拼音等 TSF 输入法不触发 window blur，
  // US-036 诊断日志实锤：打字收岛发生时窗口 hasFocus=true、无 blur），所以 blur 路径
  // 不需要为输入法留延迟——当年的延迟确认是误诊产物，只拖慢了点桌面收起（用户反馈「点桌面
  // 要等一会才开始缩」）。输入法的保护由收起定时器路径的 typing 判据负责（US-036 已修）。
  useEffect(() => {
    window.island.onWindowBlur(() => {
      // 「点进度条」这一下不算「用户想收起」：桥接为了点击把播放器顶到前台，岛必然失焦。
      // 窗口给到 2.5 秒（点击动作本身含 120ms 置前台 + 160ms + 100ms + 480ms 收尾，
      // 再加 IPC 往返余量），只在按下过进度条时生效，过完这段时间点桌面仍然正常收起。
      if (Date.now() < blurSuppressUntil) {
        window.island.logDiag('render blur ignored; bar seek in flight')
        return
      }
      hoverRef.current = false
      window.island.logDiag('render blur -> collapse now')
      setExpanded(false)
    })
  }, [])

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = null
    }
  }, [])
  clearCollapseTimerRef.current = clearCollapseTimer

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer()
    collapseTimer.current = window.setTimeout(() => {
      // 到点后先看「用户是不是正在输入框里」：输入框聚焦（activeElement 是输入控件）时绝不能收。
      // US-036 真凶：展开/切页的窗口尺寸动画会误触发一次 mouseleave，定时器到点时用户
      // 正在添加框打字（手不在鼠标上、没有 mousemove 来重新触发 mouseenter），岛就被收走了。
      // 之前用 document.hasFocus() 判断不行——中文输入法组合瞬间它也会抖成 false。
      // 点桌面/点其他窗口时输入框必然失焦（activeElement 回到 body），收起行为不受影响。
      // 歌词面板开着就别按「鼠标离开」收：用户要求「除非点桌面或再点歌词 ui，否则一直展开」
      // （SPEC-music-lyric-pin）。点桌面走的是失焦路径，不经过这里。
      if (lyricOpenRef.current) return
      const el = document.activeElement
      if (hoverRef.current || (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))) return
      setExpanded(false)
      window.island.logDiag('collapse by schedule timer; no active input')
    }, page === 0 ? AUTO_COLLAPSE_MS : SHELF_COLLAPSE_MS)
  }, [clearCollapseTimer, page])

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      if (next) {
        clearCollapseTimer()
      } else {
        scheduleCollapse()
      }
      return next
    })
  }, [clearCollapseTimer, scheduleCollapse])

  // 开心事件：勾掉待办、拖文件进岛 → 岛仔开心 1.8s
  const pulseHappy = useCallback(() => {
    setMood('happy')
    window.setTimeout(() => setMood('idle'), 1800)
  }, [])

  // 拖文件落进岛也表扬一下
  const onDonePulse = pulseHappy

  // 待办完成度（展开态右上角 n/m 已完成 + 收起态「还剩 N」共用一份）
  const [todoStats, setTodoStats] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const onTodoStats = useCallback((done: number, total: number) => {
    setTodoStats({ done, total })
  }, [])

  // 收起态不渲染 TodoPanel，拿不到它上抛的统计，这里直接问一次主进程现算。
  // 只在「首次挂载」和「每次收回」时算（expanded 初值就是 false，挂载即覆盖），
  // 不挂轮询：收起态没有待办编辑入口，唯一的变动来源是展开态里的操作。
  // 口径必须与 TodoPanel 的 onStats 一致：待办 + 今天的日程（US-033）。
  const refreshTodoStats = useCallback(() => {
    const today = localDayKey()
    void Promise.all([window.island.todosList(), window.island.scheduleList()]).then(([list, sched]) => {
      const day = sched.filter((it) => it.day === today)
      setTodoStats({
        done: list.filter((t) => t.done).length + day.filter((it) => it.done).length,
        total: list.length + day.length
      })
    })
  }, [])

  useEffect(() => {
    if (!expanded) refreshTodoStats()
  }, [expanded, refreshTodoStats])

  // 通知未读回调（NotifyPanel 上抛）
  const onNotifyUnread = useCallback((n: number) => setNotifyUnread(n), [])

  // 启动时拉一次未读数（美化-01）：收起态铃铛/红点依赖 notifyUnread，但 NotifyPanel 只在
  // 展开态挂载——重启后不拉一次，收起态永远不知道有未读（既有缺口，铃铛改造时补齐）
  useEffect(() => {
    void window.island.notifyList().then((r: NotifyListResult) => setNotifyUnread(r.unread)).catch(() => {})
  }, [])

  useEffect(() => clearCollapseTimer, [clearCollapseTimer])

  const onEnter = (): void => {
    hoverRef.current = true
    clearCollapseTimer()
  }

  const onLeave = (): void => {
    hoverRef.current = false
    if (expanded) scheduleCollapse()
  }

  // 拖文件悬停在岛上（含收起态）：通知主进程放大窗口，切到置物架页，暂停收回。
  // dragEnter 会在光标每划过一个子元素时冒泡重复触发——必须去重，
  // 否则反复 gotoPage(1) 重挂页面重放淡入动画 = 用户看到的频闪抖动（m02309）
  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.stopPropagation()
    if (dragActive.current) return
    dragActive.current = true
    window.island.dragHover()
    clearCollapseTimer()
    hoverRef.current = true
    if (!expanded) {
      window.island.setExpanded(true)
      setExpanded(true)
    }
    setPage((p) => (p === 1 ? p : 1))
    setPageAnim((n) => (page === 1 ? n : n + 1))
  }

  // 拖动结束（drop 或拖离窗口）复位去重标记，下一次拖入重新生效
  const onDragLeaveRoot = (): void => {
    dragActive.current = false
  }

  // Esc 键收起（展开时），免得非得点空白或移开鼠标
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setExpanded(false)
        scheduleCollapse()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, scheduleCollapse])

  // 翻页（‹ ›）：在被启用的页面里逐页走，**到头循环**（第一页按左回到最后一页、
  // 最后一页按右回到第一页，2026-11-11 用户确认要这样）。
  // 用户当时报的「一直点左边的切换界面的按键会一直重复」不是循环语义的问题，
  // 而是下面那条残留守卫 `if (p === 4) return list[0]` 造成的（翻到音乐页弹回第一页）。
  // 注意：这里原来还有一条 `if (p === 4) return list[0]`——那是「page 4 = 页面管理面板」时代的守卫，
  // 页面管理搬进设置窗口后 4 变成了音乐页，这条残留导致翻到音乐页就被弹回第一页。
  const flipPage = useCallback((dir: 1 | -1) => {
    setPage((p) => {
      const list = enabledPagesRef.current
      if (list.length === 0) return 0
      // 当前页可能刚被裁掉：以「列表中的位置」为基准翻
      let idx = list.indexOf(p)
      if (idx === -1) idx = 0
      // 取模循环：第一页按左回到最后一页、最后一页按右回到第一页。
      return list[(idx + dir + list.length) % list.length]
    })
  }, [])

  // enabledPages 的 ref：flipPage 不依赖它重建，避免翻页函数频繁换引用
  const enabledPagesRef = useRef(enabledPages)
  enabledPagesRef.current = enabledPages

  // 当前页被裁掉时自动跳到第一个保留页（US-032）
  // 2026-11-11 修：原来写 `if (p >= 4) return p`，那是「page 4 = 页面管理面板」时代的豁免——
  // 页面管理搬走后 4 是音乐页，这行会让「用户裁掉音乐页」时仍然停在音乐页。现在音乐页也照常裁。
  useEffect(() => {
    setPage((p) => (enabledPages.includes(p) ? p : (enabledPages[0] ?? 0)))
  }, [enabledPages])

  // 设置窗口改了偏好（SPEC-settings-shell）→ 岛上立刻跟上。
  // 原来这里是「菜单点页面管理… → 展开岛切到第 5 页」，该页已搬进独立设置窗口；
  // 现在岛只负责接收偏好广播，把勾选/顺序的变化同步过来（不用重启，也不用重新打开面板）。
  useEffect(() => {
    const off = window.island.onPrefsChanged((prefs) => {
      // 皮肤：设置页改完立刻换脸，不走 dirty 判断（它是独立的偏好项）
      if (typeof prefs.petSkin === 'string') setPetSkin(prefs.petSkin)
      // 出现模式：切到独立小窗口后岛里那只立刻消失（宠物窗口由主进程开）
      if (typeof prefs.petMode === 'string') setPetMode(prefs.petMode)
      if (prefs.clockFormat) setClockFormat(prefs.clockFormat)
      if (typeof prefs.desktopLyricEnabled === 'boolean') setDesktopLyricEnabled(prefs.desktopLyricEnabled)
      const v = normalizePagesCustom(prefs.pagesCustom)
      if (!v) return
      // 广播来自「已落盘的真实状态」，比本地乐观更新的值更权威，直接覆盖
      pagesCustomDirty.current = true
      setPagesCustom(v)
    })
    return off
  }, [])

  // 切页淡入：换页时给面板体一个短动画类
  const [pageAnim, setPageAnim] = useState(0)
  const gotoPage = useCallback((i: number) => {
    setPage(i)
    setPageAnim((n) => n + 1)
  }, [])

  // 通知铃铛被点击 → 展开岛并直接落在通知页（page 2）。
  // 用户 2026-11-10 要求：点铃铛不必先展开到第一页再自己翻两下。
  // 与菜单「页面管理…」（见上方 useEffect）同一套路：先同步主进程窗口尺寸，再切页；
  // 已经在通知页时不再重放淡入动画（重放 = 页面重挂 = 用户看到的频闪）。
  const openNotifyPage = useCallback(() => {
    clearCollapseTimer()
    if (!expandedRef.current) {
      window.island.setExpanded(true)
      expandedRef.current = true
      setExpanded(true)
    }
    if (page !== 2) {
      setPage(2)
      setPageAnim((n) => n + 1)
    }
  }, [clearCollapseTimer, page])

  const onDragOverRoot = (e: React.DragEvent): void => {
    e.preventDefault()
    // 悬停期间不断续命，防止拖着拖着岛收走
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      window.island.logDiag('collapse suppressed by drag-over')
      collapseTimer.current = null
    }
  }

  // 整个岛都是投放区：文件可以落在面板任意位置
  const onDropRoot = (e: React.DragEvent): void => {
    e.preventDefault()
    if (!e.dataTransfer.files.length) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.island.filePath(f))
      .filter((p): p is string => !!p)
    if (paths.length === 0) return
    // 落在哪个页都算加进置物架（岛只有一个存放区），主进程回传后广播刷新
    void window.island.shelfAdd(paths).then((list) => {
      window.island.emitShelfAdded(list)
    })
  }

  /**
   * 单个状态组件（美化-03）：收起态胶囊与展开态头部共用这一份实现，避免两处 JSX 漂移。
   * 返回 null = 现在不该显示：未勾选（pagesCustom.collapsed[k] === false）或没有数据
   * （读不到电量 / 没有网络 / 今天没有未完成 / 没有未读通知），沿用收起态既有语义。
   * 只有 'pet' 会返回岛仔本体，且由调用方决定放在哪一层——展开态必须放在信息行外层，不能进 .head-info。
   */
  const renderStatusItem = (k: CollapsedKey): React.JSX.Element | null => {
    if (!pagesCustom.collapsed[k]) return null
    // 桌宠出门了（SPEC-deskpet-out / SPEC-deskpet-walk）：window 与 free 模式下
    // 岛里都不画它，否则会同时出现两只。只影响渲染，不动 pagesCustom.collapsed.pet
    // 的开关状态——切回 island 后用户原来「岛仔显不显示」的选择原样生效。
    if (k === 'pet' && (petMode === 'window' || petMode === 'free')) return null
    switch (k) {
      case 'battery': {
        // 电量环（美化-01 起在默认顺序第一位）；读不到电量不渲染。
        // 电量态轮次（2026-11-09）：充电态优先——charging 时弧变绿，
        // 低电量红（含数字）只在「没充电且 ≤20%」出现，两者占时以充电为准。
        // 小闪电按用户 2026-11-09 要求移除，充电只靠绿色弧表达。
        const low = battery !== null && !charging && battery <= 20
        return battery !== null ? (
          <span
            key="battery"
            className={`head-battery-ring ${low ? 'low' : ''} ${charging ? 'charging' : ''}`}
            role="img"
            aria-label={charging ? `充电中 · 电量 ${battery}%` : low ? `电量偏低 · ${battery}%` : `电量 ${battery}%`}
            title={charging ? `充电中 · 电量 ${battery}%` : low ? `电量偏低 · ${battery}%` : `电量 ${battery}%`}
          >
            <svg viewBox="0 0 36 36" aria-hidden="true">
              {/* 底环 + 进度环：stroke-dasharray 按 battery% 画弧（r=15.5 周长≈97.4） */}
              <circle className="ring-bg" cx="18" cy="18" r="15.5" />
              <circle
                className="ring-fg"
                cx="18"
                cy="18"
                r="15.5"
                strokeDasharray={`${(battery / 100) * 97.4} 97.4`}
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span className="ring-num">{battery}</span>
          </span>
        ) : null
      }
      case 'pet':
        return <Pet key="pet" skin={petSkin} mood={mood} size="tiny" />
      case 'clock':
        return (
          <span key="clock" className="collapsed-clock">
            {formatClock(now, clockFormat)}
          </span>
        )
      case 'net': {
        // 网络（US-005 / 2026-11-19 用户参考图）：有网显示 Wi-Fi 弧线 / 网线；
        // 没网（Wi-Fi 断开，或连上但上不了网）显示系统风格的「地球 + 斜杠」。
        // wifi=null 只代表状态读取失败，保持不渲染，避免把读失败误报成断网。
        if (wifi === null) return null
        const netOk = wifi.connected && wifi.online
        const kindName = wifi.kind === 'ethernet' ? '网线' : 'Wi-Fi'
        const title = netOk
          ? `${kindName}：${wifi.name ?? ''}（网络正常）`
          : wifi.connected
            ? `${kindName}：${wifi.name ?? ''}（连上了但上不了网）`
            : '网络未连接（没有可用的 Wi-Fi 或网线）'
        const aria = netOk
          ? `${kindName}已连接，网络正常`
          : wifi.connected
            ? `${kindName}已连接但没有网络`
            : '网络未连接'
        return (
          <span
            key="net"
            className={`collapsed-wifi ${netOk ? '' : 'offline'}`}
            title={title}
            role="img"
            aria-label={aria}
          >
            {netOk ? wifi.kind === 'ethernet' ? <IcoEthernet /> : <IcoWifi /> : <IcoNoNet />}
          </span>
        )
      }
      case 'todo':
        // 待办剩余：只在真有未完成的事时出现，全部做完就收起不再催。
        // US-033 起统计口径是「待办 + 今天的日程」，所以文案用「件没做完」
        return todoStats.total - todoStats.done > 0 ? (
          <span
            key="todo"
            className="collapsed-todo"
            title={`今天还有 ${todoStats.total - todoStats.done} 件没做完（共 ${todoStats.total} 件）`}
            role="img"
            aria-label={`今天还有 ${todoStats.total - todoStats.done} 件没做完`}
          >
            <b className="collapsed-todo-num">{todoStats.total - todoStats.done}</b>
          </span>
        ) : null
      case 'bell':
        // 通知铃铛（美化-01）：有未读时白铃铛 + 右上红点；无未读不渲染。
        // 2026-11-10 起可点：点它 = 展开岛并直接跳到通知页（用户要求，不必再自己翻页）。
        // 必须 stopPropagation——岛根节点 onClick 在收起态是 toggle()，冒泡上去会刚展开又被收起。
        return notifyUnread > 0 ? (
          <span
            key="bell"
            className="collapsed-bell"
            title={`${notifyUnread} 条未读通知，点击查看`}
            role="button"
            tabIndex={0}
            aria-label={`${notifyUnread} 条未读通知，点击查看`}
            onClick={(e) => {
              e.stopPropagation()
              openNotifyPage()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                openNotifyPage()
              }
            }}
          >
            <IcoBellSolid />
            <i className="bell-badge" aria-hidden="true" />
          </span>
        ) : null
      default:
        return null
    }
  }

  return (
    <div className="app">
      <div
        className={`island ${expanded ? 'expanded' : 'collapsed'}`}
        ref={islandRef}
        onMouseEnter={onEnter}
        // US-041 摸边唤回后的「移开回隐」：避让临时现身期间鼠标离开岛窗口 → 上报主进程。
        // React DOM 事件没有原生 mouseleave 的 relatedTarget 语义（crossing 出窗口时
        // relatedTarget=null），这里合并原 onLeave 与 edgeLeave 上报。
        onMouseLeave={(e) => {
          onLeave()
          if (e.nativeEvent.relatedTarget === null && !expandedRef.current) {
            window.island.edgeLeave()
          }
        }}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeaveRoot}
        onDragOver={onDragOverRoot}
        onDrop={(e) => {
          onDropRoot(e)
          onDragLeaveRoot()
          scheduleCollapse()
          if (e.dataTransfer.files.length) pulseHappy()
        }}
        onClick={() => {
          // 展开态点面板空白处（非控件）回到第一页而非直接收起？——收起语义保留：点空白收起
          if (!expanded) toggle()
        }}
        // 岛内右键 → 弹应用菜单（US-034）。窗口无边框、任务栏无图标，
        // 右键是用户最容易想到的「怎么关掉这个东西」，菜单里给一条真正的退出。
        // 这里必须拦住浏览器默认右键菜单，否则弹的是 Chromium 的「后退/刷新」那种。
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          window.island.showAppMenu()
        }}
        role="button"
        tabIndex={0}
        aria-label={expanded ? `${PAGE_META[page]?.label ?? '页面'}面板` : '灵动岛，回车展开'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        {avoidHidden && !expanded && (
          /* US-041 避让临时现身时的视觉提示条：告诉用户「摸到边了，岛回来了」，鼠标移开即回隐 */
          <div className="avoid-tip" role="status">已让路 · 移开鼠标自动隐藏</div>
        )}        {expanded ? (
          <>
            <div className="panel-head">
              {/* 第一行：页面身份（徽章 + 标题）+ 岛仔 + 右侧完成度。
                  2026-11-18（SPEC-expanded-head-two-rows）：状态区原来和标题挤在同一行，
                  dateWeek 档时钟被 50% 宽的绝对居中盒压成三行并压住标题；改成上下两行后
                  状态行独占整宽居中，标题再长也不会和它抢横向空间。 */}
              <div className="head-top">
                <span className="panel-badge" style={{ ['--accent' as never]: '#9aa0a6' }}>
                  <span className="panel-badge-icon">{PAGE_META[page].icon()}</span>
                </span>
                <span className="panel-title">{PAGE_META[page].label}</span>
                {pagesCustom.collapsed.pet && <span className="head-pet">{renderStatusItem('pet')}</span>}
                <span className="panel-head-spacer" />
                {/* 音源胶囊只在音乐页出现（SPEC-music-source-picker A 方案） */}
                {page === 4 && <MusicSourceChip />}
                {/* 完成度：美化-04 起左边加一个小圆环（Apple Watch 同心环的单环版），
                    右边仍是纯数字「n/m」。数字节点的类名与文本格式保持原样不动——
                    e2e-todo-today / e2e-collapsed-todo 都对 `.todo-stat .todo-count` 的文本做精确比对。 */}
                {page === 0 && (
                  <span className="todo-stat">
                    <svg className="todo-ring" viewBox="0 0 24 24" aria-hidden="true">
                      <circle className="todo-ring-bg" cx="12" cy="12" r="9" />
                      <circle
                        className={`todo-ring-fg ${todoStats.total > 0 && todoStats.done >= todoStats.total ? 'full' : ''}`}
                        cx="12"
                        cy="12"
                        r="9"
                        strokeDasharray={RING_CIRC}
                        strokeDashoffset={RING_CIRC * (1 - (todoStats.total > 0 ? todoStats.done / todoStats.total : 0))}
                      />
                    </svg>
                    <b className="todo-count">
                      {todoStats.done}/{todoStats.total}
                    </b>
                  </span>
                )}
              </div>
              {/* 第二行：顶部常驻信息（对照参考工具：展开后收起态的信息 UI 不消失）。
                  美化-03：与收起态共用同一套 pagesCustom（显隐 + 顺序）——
                  岛仔不参与排序，放在第一行；其余组件按 order 在这一行居中。 */}
              <span className="head-status">
                <span className="head-info">
                  {pagesCustom.order.filter((k) => k !== 'pet').map((k) => renderStatusItem(k))}
                </span>
              </span>
            </div>
            <div className="panel-body">
              {/* 点面板主体不再整体收起：stopPropagation 由内部控件自理 */}
              {/* 置物架/通知页工具条（视图按钮、清空、已读）要贴岛右缘：
                  这两页内容宽度是自适应的，page-fade 不撑满时工具条只到内容右边界、按钮悬在中间。
                  加 wide 让该页整行占满（第 1/4 页内容本身接近满宽，保持原样不动） */}
              <div
                key={pageAnim}
                onClick={(e) => e.stopPropagation()}
                className={`page-fade ${page === 1 || page === 2 ? 'wide' : ''}`}
              >
                {page === 0 ? (
                  <TodoPanel onDonePulse={onDonePulse} onStats={onTodoStats} />
                ) : page === 1 ? (
                  <ShelfPanel />
                ) : page === 2 ? (
                  <NotifyPanel onUnread={onNotifyUnread} refreshTick={notifyRefreshTick} />
                ) : page === 3 ? (
                  <SchedulePanel />
                ) : (
                  <MusicPanel
                    onLyricOpenChange={onLyricOpenChange}
                    desktopLyricEnabled={desktopLyricEnabled}
                  />
                )}
              </div>
            </div>
            <div className="pager">
              <button
                type="button"
                className="pager-arrow"
                title="上一页"
                aria-label="上一页"
                onClick={(e) => {
                  e.stopPropagation()
                  flipPage(-1)
                }}
              >
                ‹
              </button>
              <div className="dots">
                {enabledPages.map((i) => (
                  <button
                    key={i}
                    type="button"
                    className={`dot ${i === page ? 'active' : ''}`}
                    aria-label={`跳到第 ${i + 1} 页：${PAGE_META[i].label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      gotoPage(i)
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                className="pager-arrow"
                title="下一页"
                aria-label="下一页"
                onClick={(e) => {
                  e.stopPropagation()
                  flipPage(1)
                }}
              >
                ›
              </button>
            </div>
          </>
        ) : (
          <>
            {/* 收起态组件按「页面管理」（US-032 / 美化-02）的开关显隐、按 order 排列。
                order 恒含全部 6 项（normalizeOrder 会补齐），关掉的只是不渲染，位置信息保留。
                渲染实现抽到 renderStatusItem（美化-03），与展开态头部共用同一份。 */}
            {pagesCustom.order.map((k) => renderStatusItem(k))}
          </>
        )}
      </div>
      {/* 新消息到岛横幅（US 通知图标故事）：显示在胶囊正下方，5 秒后收回。
          必须挂在 .app 层（island 的兄弟节点）而不是 island 内——island 有 overflow:hidden
          （圆角裁内容），横幅 top 超出胶囊下边界会被整个裁掉，屏幕上一个像素都不画
          （六轮排障最终根因：CDP 查得到 DOM 和 rect，但渲染被裁）。 */}
      {banner !== null && !expanded && (
        <div
          className={`collapsed-banner${banner.count > 1 ? ' banner-shake' : ''}`}
          key={banner.count} // 条数变化时重挂节点：重播入场动画+抖动
          role="button"
          tabIndex={0}
          title="点击打开来源应用"
          aria-label={`新消息：${banner.item.app} ${banner.item.title}，共 ${banner.count} 条，点击打开`}
          onClick={openFromBanner}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openFromBanner()
          }}
        >
          <span className="banner-count" aria-hidden="true">
            {banner.count > 99 ? '99+' : banner.count}
          </span>
          {banner.item.icon ? (
            <img className="banner-icon" src={iconUrl(banner.item.icon)} alt="" aria-hidden="true" />
          ) : (
            <span className="banner-icon banner-icon-fallback" aria-hidden="true">
              {banner.item.app.slice(0, 1)}
            </span>
          )}
          <span className="banner-text">
            <span className="banner-app">{banner.item.app}</span>
            <span className="banner-title">{banner.item.title}</span>
          </span>
        </div>
      )}
      {/* US-039 验证码横幅：与通知横幅共用横幅位（互斥渲染，通知优先级高——通知横幅在显示时本组件不渲染）。点击 = 复制验证码；Esc = 关闭 */}
      {codeBanner !== null && !expanded && banner === null && (
        <div
          className="collapsed-banner code-banner"
          key={codeBanner} // 码变化时重挂重播动画
          role="button"
          tabIndex={0}
          title={codeCopied ? '已复制到剪贴板' : '点击复制验证码'}
          aria-label={`验证码 ${codeBanner}，点击复制`}
          onClick={copyCodeBanner}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') copyCodeBanner()
            if (e.key === 'Escape') closeCodeBanner()
          }}
        >
          <span className="banner-code-badge" aria-hidden="true">验证码</span>
          <span className="banner-code-text">{codeBanner}</span>
          {codeCopied && <span className="banner-code-copied" aria-hidden="true">已复制</span>}
        </div>
      )}
    </div>
  )
}


