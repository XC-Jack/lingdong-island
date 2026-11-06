import { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo, ShelfItem } from '../../shared/types'
/** 收起 700ms 后自动收回，给鼠标留出移入面板的时间 */
const AUTO_COLLAPSE_MS = 700

/** 通知页数据结构（与 preload/notifyStore 保持一致；独立声明避免跨 tsconfig project 引用） */
interface NotifyItem {
  id: number
  order: number
  app: string
  title: string
  body: string
  arrival: number
}

interface NotifyListResult {
  items: NotifyItem[]
  unread: number
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

function formatClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 本地日期键 'YYYY-MM-DD'。不能用 toISOString：那是 UTC，东八区凌晨会差一天 */
function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 置物架视图的四种形态 */
type ShelfView = 'lg' | 'md' | 'sm' | 'list'

/** 视图偏好的存储键（存在渲染层 localStorage，落在 userData 下的 Local Storage 里） */
const SHELF_VIEW_KEY = 'island.shelfView'

/** 收起态可裁剪组件的键（与勾选 UI 一一对应） */
const COLLAPSED_KEYS = ['pet', 'clock', 'battery', 'net', 'todo'] as const
type CollapsedKey = (typeof COLLAPSED_KEYS)[number]

/** 页面裁剪偏好：pages 是显示的页面索引集合，collapsed 是收起态组件开关 */
interface PagesCustom {
  pages: number[]
  collapsed: Record<CollapsedKey, boolean>
}

/** 默认全开（4 页 + 5 个收起态组件） */
function defaultPagesCustom(): PagesCustom {
  return {
    pages: [0, 1, 2, 3],
    collapsed: { pet: true, clock: true, battery: true, net: true, todo: true }
  }
}

/**
 * 校验并规整页面裁剪偏好（US-032）。数据存主进程 userData/prefs.json（经 IPC 读写）。
 * 为什么不用渲染层 localStorage：本机实测 file:// 来源的 localStorage 跨进程重启会丢失
 * （写入后优雅退出再启动读回为 null），裁剪偏好必须跨重启保留。
 * 值不合法（手工改坏/缺字段/全空页面）一律回落默认全开。
 */
function normalizePagesCustom(v: unknown): PagesCustom | null {
  if (!v || typeof v !== 'object') return null
  const raw = v as Partial<PagesCustom>
  // 顺序即用户自定义的页面顺序（US-032 反馈）：只做去重 + 范围校验 + 非空，不排序。
  const pages = Array.isArray(raw.pages)
    ? [...new Set(raw.pages.filter((n) => Number.isInteger(n) && n >= 0 && n <= 3))]
    : []
  if (pages.length === 0) return null
  const collapsed = defaultPagesCustom().collapsed
  if (raw.collapsed && typeof raw.collapsed === 'object') {
    for (const k of COLLAPSED_KEYS) {
      if (typeof raw.collapsed[k] === 'boolean') collapsed[k] = raw.collapsed[k]
    }
  }
  return { pages, collapsed }
}

/**
 * 读上次选的置物架视图（US-034）。
 * 为什么不落成 settings.json：这只是「界面长什么样」的偏好，丢了顶多重置成默认，
 * 不涉及用户数据；localStorage 不用新增 IPC、不用新建文件、也不参与数据迁移。
 * 值不认识或读失败（隐私模式/手工改坏）一律回落到「大图标」，不报错不白屏。
 */
function loadShelfView(): ShelfView {
  try {
    const v = localStorage.getItem(SHELF_VIEW_KEY)
    if (v === 'lg' || v === 'md' || v === 'sm' || v === 'list') return v
  } catch {
    /* localStorage 不可用时用默认值 */
  }
  return 'lg'
}

/** 记住置物架视图；写失败不影响使用（下次还是默认值） */
function saveShelfView(v: ShelfView): void {
  try {
    localStorage.setItem(SHELF_VIEW_KEY, v)
  } catch {
    /* 写不进去就算了，不打扰用户 */
  }
}

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

/** Wi-Fi（收起态 US-005）：三段弧线信号图标 */
const IcoWifi = (): React.JSX.Element => (
  <IconSvg>
    <path d="M2.5 9.5a14 14 0 0 1 19 0" />
    <path d="M5.5 13a9.5 9.5 0 0 1 13 0" />
    <path d="M8.5 16.5a5 5 0 0 1 7 0" />
    <circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none" />
  </IconSvg>
)

/** 网线（收起态 US-005 插网线时）：RJ45 水晶头插口图标，与 Wi-Fi 弧线区分开 */
const IcoEthernet = (): React.JSX.Element => (
  <IconSvg>
    <path d="M7.5 9.5v-3a1.5 1.5 0 0 1 1.5-1.5h6a1.5 1.5 0 0 1 1.5 1.5v3" />
    <path d="M7.5 9.5h-2a1.5 1.5 0 0 0-1.5 1.5v4a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-4a1.5 1.5 0 0 0-1.5-1.5h-2" />
    <path d="M9.5 16.5v2M12 16.5v2M14.5 16.5v2" />
  </IconSvg>
)

/** 日历（日程页） */
const IcoCal = (): React.JSX.Element => (
  <IconSvg>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </IconSvg>
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

/** 岛仔：一只简单的黑胶囊宠物。idle 时呼吸+眨眼，happy 时弯眼+微笑+弹跳+星星 */
function Pet({ mood }: { mood: 'idle' | 'happy' }): React.JSX.Element {
  const happy = mood === 'happy'
  return (
    <svg
      className={`collapsed-pet ${happy ? 'pet-happy' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="1" y="4" width="22" height="16" rx="8" fill="#4b2ea8" />
      {happy ? (
        <>
          {/* 开心：眼睛弯成 ^，嘴角上扬 */}
          <path
            className="pet-eye"
            d="M7 12.6q2-2.6 4 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            className="pet-eye"
            d="M13 12.6q2-2.6 4 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M9.5 15.8q2.5 2.2 5 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M19 2.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"
            fill="#ffd45e"
          />
        </>
      ) : (
        <>
          <circle className="pet-eye" cx="9" cy="12" r="1.9" fill="#ffffff" />
          <circle className="pet-eye" cx="15" cy="12" r="1.9" fill="#ffffff" />
        </>
      )}
    </svg>
  )
}

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
    // Windows 路径转 file:// URL（空格等字符浏览器自动处理）
    const url = `file:///${src.replace(/\\/g, '/')}`
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
  // 初值读上次的选择（US-034）：不记住的话每次重启都回到「大图标」，用户已选过的白选
  const [view, setView] = useState<ShelfView>(loadShelfView)
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

  const scrollBy = (dir: number): void => {
    scrollRef.current?.scrollBy({ left: dir * 220, behavior: 'smooth' })
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
                    setView(v)
                    saveShelfView(v)
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
function NotifyPanel({ onUnread }: { onUnread: (n: number) => void }): React.JSX.Element {
  const [items, setItems] = useState<NotifyItem[]>([])
  const [loaded, setLoaded] = useState(false)
  // 相对时间（"5 分钟前"）每 30s 重算一次，避免开着不动时间变陈旧
  const [, tickNow] = useState(0)

  useEffect(() => {
    void window.island.notifyRefresh().then((r: NotifyListResult) => {
      setItems(r.items)
      onUnread(r.unread)
      setLoaded(true)
    })
  }, [onUnread])

  useEffect(() => {
    const id = window.setInterval(() => tickNow((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const markRead = useCallback(() => {
    void window.island.notifyMarkRead().then((n) => onUnread(n))
  }, [onUnread])

  const clearAll = useCallback(() => {
    void window.island.notifyClearAll().then((r: NotifyListResult) => {
      setItems(r.items)
      onUnread(r.unread)
    })
  }, [onUnread])

  const openOne = useCallback(
    (it: NotifyItem) => {
      void window.island.notifyOpenSource(it.app)
      markRead()
    },
    [markRead]
  )

  return (
    <div className="todo-panel">
      <div className="shelf-toolbar">
        <span className="shelf-count">{items.length > 0 ? `${items.length} 条通知` : ''}</span>
        <span className="shelf-toolbar-spacer" />
        <button
          type="button"
          className="todo-del"
          title="全部标为已读（消除收起态红点）"
          aria-label="全部标为已读"
          onClick={markRead}
          disabled={items.length === 0}
        >
          已读
        </button>
        <button
          type="button"
          className="todo-del"
          title="清空列表（之后旧通知不再显示，新通知照常）"
          aria-label="清空通知列表"
          onClick={clearAll}
          disabled={items.length === 0}
        >
          清空
        </button>
      </div>
      {items.length === 0 ? (
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
          {items.map((it) => (
            <li key={it.id} className="notify-item">
              <button type="button" className="notify-body" title="点击打开来源应用" onClick={() => openOne(it)}>
                <span className="notify-app">{it.app}</span>
                <span className="notify-title">{it.title}</span>
                {it.body && <span className="notify-text">{it.body}</span>}
              </button>
              <span className="notify-time">{fmtRel(it.arrival)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 月历：本月网格（周一为首），今天高亮，有安排的日子带蓝点，可点选日期 */
function MonthCalendar({
  selected,
  onSelect,
  markedDays,
}: {
  selected: string // YYYY-MM-DD
  onSelect: (day: string) => void
  markedDays: Set<string> // 有日程/待办的日子（YYYY-MM-DD）
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

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" title="上个月" aria-label="上个月" onClick={() => shiftMonth(-1)}>
          ‹
        </button>
        <span className="cal-title">
          {viewYear}年{viewMonth + 1}月
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
        {cells.map((day, i) =>
          day === null ? (
            <span key={`e${i}`} />
          ) : (
            <button
              key={day}
              type="button"
              className={`cal-day ${dayKey(day) === todayKey ? 'today' : ''} ${dayKey(day) === selected ? 'selected' : ''}`}
              aria-label={`选择 ${viewMonth + 1} 月 ${day} 日`}
              onClick={() => onSelect(dayKey(day))}
            >
              {day}
              {markedDays.has(dayKey(day)) && <i className="cal-mark" />}
            </button>
          )
        )}
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
  // 有日程的日子标蓝点
  const markedDays = new Set<string>(items.map((it) => it.day))
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
  const dayLabel = `${Number(selDay.slice(5, 7))}月${Number(selDay.slice(8, 10))}日`

  return (
    <div className="sched-split">
      {/* 左栏：月历 */}
      <MonthCalendar selected={selDay} onSelect={setSelDay} markedDays={markedDays} />
      {/* 右栏：当日安排 */}
      <div className="sched-day">
        <div className="sched-day-head">
          <span className="sched-day-title">{dayLabel}</span>
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

/** 页标签：页头图标组件 + 名称（对照视频里每页左上角的彩色小图标 + 页名）；图标用线性 SVG，不用 emoji */
const PAGE_META: { icon: () => React.JSX.Element; label: string; accent: string }[] = [
  { icon: IcoCheck, label: '待办', accent: '#7dd87d' },
  { icon: IcoShelf, label: '置物架', accent: '#ffb74d' },
  { icon: IcoBell, label: '通知', accent: '#9f8bff' },
  { icon: IcoCal, label: '日程', accent: '#64b5f6' },
]

/** 收起态组件在页面管理面板里的显示名（US-032） */
const COLLAPSED_LABELS: Record<CollapsedKey, string> = {
  pet: '岛仔',
  clock: '时钟',
  battery: '电量圈',
  net: '网络图标',
  todo: '待办数字'
}

/**
 * 页面管理面板（US-032）：勾选显示哪些页面、收起态显示哪些组件、拖拽调整页面顺序。
 * 不是轮播页（PAGE_COUNT 只有 4），只能从右键/托盘菜单「页面管理…」进入（page 4）。
 * 改动立即生效并写主进程 prefs.json；至少保留 1 个页面；「完成并收起」收岛退出面板。
 */
function PageManagerPanel({
  pagesCustom,
  onChange,
  onClose
}: {
  pagesCustom: PagesCustom
  onChange: (v: PagesCustom) => void
  onClose: () => void
}): React.JSX.Element {
  const togglePage = (i: number): void => {
    const has = pagesCustom.pages.includes(i)
    // 最后一个页面不允许取消（至少保留 1 页）
    if (has && pagesCustom.pages.length <= 1) return
    // 重新勾上时排到列表末尾（用户当前顺序的自然延伸），不强制按页号排序
    const pages = has ? pagesCustom.pages.filter((n) => n !== i) : [...pagesCustom.pages, i]
    onChange({ ...pagesCustom, pages })
  }
  const toggleCollapsed = (k: CollapsedKey): void => {
    onChange({ ...pagesCustom, collapsed: { ...pagesCustom.collapsed, [k]: !pagesCustom.collapsed[k] } })
  }
  const reset = (): void => onChange(defaultPagesCustom())
  // 拖拽排序（US-032 反馈）：只在「显示的页面」列表里拖换位；HTML5 dataTransfer 必须带数据
  // 才稳定触发 dragover/drop（项目踩坑记录）；语义与置物架一致用「互换」。
  const dragFrom = useRef<number | null>(null)
  const reorderTo = (targetPageId: number): void => {
    const from = dragFrom.current
    dragFrom.current = null
    if (from === null || from === targetPageId) return
    const pages = pagesCustom.pages.includes(from) ? [...pagesCustom.pages] : null
    if (!pages) return
    const fi = pages.indexOf(from)
    const ti = pages.indexOf(targetPageId)
    if (ti === -1) return // 目标未勾选：不参与排序
    pages[fi] = targetPageId
    pages[ti] = from
    onChange({ ...pagesCustom, pages })
  }
  return (
    <div className="pm-panel">
      <div className="pm-section">页面（勾选显示，按住拖动换顺序）</div>
      {(() => {
        // 按用户自定义顺序渲染：已勾选页按 pages 排在前（可拖），未勾选页按固定号排在后
        const shown = pagesCustom.pages.map((p) => ({ m: PAGE_META[p], i: p, on: true }))
        const hidden = PAGE_META.map((m, i) => ({ m, i, on: false })).filter(
          (h) => !pagesCustom.pages.includes(h.i)
        )
        const rows = [...shown, ...hidden]
        return rows.map(({ m, i, on }) => {
          const locked = on && pagesCustom.pages.length <= 1
          return (
            <div
              key={i}
              className={`pm-row ${on ? '' : 'pm-row-off'} ${locked ? 'pm-locked' : ''}`}
              draggable={on}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(i))
                e.dataTransfer.effectAllowed = 'move'
                dragFrom.current = i
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                reorderTo(i)
              }}
              onDragEnd={() => {
                dragFrom.current = null
              }}
            >
              <input type="checkbox" checked={on} onChange={() => togglePage(i)} />
              <span className="pm-name">{m.label}</span>
              {locked ? (
                <span className="pm-lock-hint">至少保留一个</span>
              ) : on ? (
                <span className="pm-grip" title="按住拖到另一行换位置">⋮⋮</span>
              ) : null}
            </div>
          )
        })
      })()}
      <div className="pm-section">收起态组件</div>
      {COLLAPSED_KEYS.map((k) => (
        <label key={k} className="pm-row">
          <input type="checkbox" checked={pagesCustom.collapsed[k]} onChange={() => toggleCollapsed(k)} />
          <span className="pm-name">{COLLAPSED_LABELS[k]}</span>
        </label>
      ))}
      <div className="pm-actions">
        <button type="button" className="pm-reset" onClick={reset}>
          重置为默认
        </button>
        <button type="button" className="pm-close" onClick={onClose}>
          完成并收起
        </button>
      </div>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [battery, setBattery] = useState<number | null>(null)
  // Wi-Fi 快照（收起态 US-005）；null = 读不到，不显示图标
  const [wifi, setWifi] = useState<WifiSnapshot | null>(null)
  const [mood, setMood] = useState<'idle' | 'happy'>('idle')
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
        if (!alive || pagesCustomDirty.current) return
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
  // 开机自启开关状态（null=未取到）
  const [autoStart, setAutoStart] = useState<boolean | null>(null)
  // 通知未读数（收起态红点用；仅在通知页加载/标记时更新）
  const [notifyUnread, setNotifyUnread] = useState(0)
  const hoverRef = useRef(false)
  // US-036 诊断探针：让 blur 回调读到最新 expanded（useEffect 闭包会过期）
  const expandedRef = useRef(false)
  expandedRef.current = expanded
  const collapseTimer = useRef<number | null>(null)
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

  // 电量与 Wi-Fi：首取 + 每 60 秒刷新（主进程另有 30s 缓存）
  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void window.island.statusSnapshot().then((s) => {
        if (alive) {
          setBattery(s.battery)
          setWifi(s.wifi)
        }
      })
    }
    pull()
    const id = window.setInterval(pull, 60_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  // 开机自启：读初始状态
  useEffect(() => {
    let alive = true
    void window.island.autostartGet().then((on) => {
      if (alive) setAutoStart(on)
    })
    return () => {
      alive = false
    }
  }, [])

  const flipAutoStart = useCallback((): void => {
    const next = !(autoStart === true)
    setAutoStart(next) // 乐观更新，主进程会回真实值
    void window.island.autostartSet(next).then((real) => setAutoStart(real))
  }, [autoStart])

  // 状态变化时同步给主进程，由它调整窗口尺寸
  useEffect(() => {
    window.island?.setExpanded(expanded)
  }, [expanded])

  // 点了桌面/其他程序（窗口失焦）→ 立即收回。
  // 坑（历史）：中文输入法的候选窗不会夺走主窗口焦点（微软拼音等 TSF 输入法不触发 window blur，
  // US-036 诊断日志实锤：打字收岛发生时窗口 hasFocus=true、无 blur），所以 blur 路径
  // 不需要为输入法留延迟——当年的延迟确认是误诊产物，只拖慢了点桌面收起（用户反馈「点桌面
  // 要等一会才开始缩」）。输入法的保护由收起定时器路径的 typing 判据负责（US-036 已修）。
  useEffect(() => {
    window.island.onWindowBlur(() => {
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

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer()
    collapseTimer.current = window.setTimeout(() => {
      // 到点后先看「用户是不是正在输入框里」：输入框聚焦（activeElement 是输入控件）时绝不能收。
      // US-036 真凶：展开/切页的窗口尺寸动画会误触发一次 mouseleave，定时器到点时用户
      // 正在添加框打字（手不在鼠标上、没有 mousemove 来重新触发 mouseenter），岛就被收走了。
      // 之前用 document.hasFocus() 判断不行——中文输入法组合瞬间它也会抖成 false。
      // 点桌面/点其他窗口时输入框必然失焦（activeElement 回到 body），收起行为不受影响。
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

  // 翻页（‹ ›）：在被启用的页面里循环（US-032 裁剪后跳过被裁页）；
  // page 4（页面管理面板）不在轮播集合里，从它翻页先回到第一个启用页
  const flipPage = useCallback((dir: 1 | -1) => {
    setPage((p) => {
      const list = enabledPagesRef.current
      if (list.length === 0) return 0
      if (p === 4) return list[0]
      // 当前页可能刚被裁掉：以「列表中的位置」为基准翻
      let idx = list.indexOf(p)
      if (idx === -1) idx = 0
      return list[(idx + dir + list.length) % list.length]
    })
  }, [])

  // enabledPages 的 ref：flipPage 不依赖它重建，避免翻页函数频繁换引用
  const enabledPagesRef = useRef(enabledPages)
  enabledPagesRef.current = enabledPages

  // 当前页被裁掉时自动跳到第一个保留页（US-032）；页面管理面板(page 4)不受影响
  useEffect(() => {
    setPage((p) => {
      if (p >= 4) return p
      return enabledPages.includes(p) ? p : (enabledPages[0] ?? 0)
    })
  }, [enabledPages])

  // 菜单「页面管理…」→ 展开岛并切到页面管理面板（US-032）
  useEffect(() => {
    window.island.onManagePages(() => {
      if (!expandedRef.current) window.island.setExpanded(true)
      expandedRef.current = true
      setExpanded(true)
      setPage(4)
    })
  }, [])

  // 切页淡入：换页时给面板体一个短动画类
  const [pageAnim, setPageAnim] = useState(0)
  const gotoPage = useCallback((i: number) => {
    setPage(i)
    setPageAnim((n) => n + 1)
  }, [])

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

  return (
    <div className="app">
      <div
        className={`island ${expanded ? 'expanded' : 'collapsed'}`}
        ref={islandRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
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
        aria-label={expanded ? `${page === 4 ? '页面管理' : PAGE_META[page]?.label ?? '页面'}面板` : '灵动岛，回车展开'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        {expanded ? (
          <>
            <div className="panel-head">
              <span className={`panel-badge ${page === 4 ? 'accent' : ''}`} style={{ ['--accent' as never]: '#9aa0a6' }}>
                <span className="panel-badge-icon">{page === 4 ? <IcoCheck /> : PAGE_META[page].icon()}</span>
              </span>
              <span className="panel-title">{page === 4 ? '页面管理' : PAGE_META[page].label}</span>
              {/* 顶部常驻信息（对照参考工具：展开后收起态的信息 UI 不消失）——迷你岛仔 + 时钟 + 电量圈，居中 */}
              <span className="head-status">
                <Pet mood={mood} />
                <span className="head-clock">{formatClock(now)}</span>
                {battery !== null && (
                  <span
                    className={`head-battery-ring ${battery <= 20 ? 'low' : ''}`}
                    role="img"
                    aria-label={`电量 ${battery}%`}
                    title={`电量 ${battery}%`}
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
                )}
              </span>
              {/* 状态区已绝对定位不占流：flex:1 spacer 恢复，把完成度+自启开关推到右侧，
                  与中间状态区天然分离（之前 marginLeft:auto 双 auto 均分空间导致完成度卡在中间） */}
              <span className="panel-head-spacer" />
              <button
                type="button"
                className={`autostart-toggle ${autoStart ? 'on' : ''}`}
                title={autoStart ? '开机自启已开启，点击关闭' : '开机自启已关闭，点击开启'}
                onClick={(e) => {
                  e.stopPropagation()
                  flipAutoStart()
                }}
              >
                <span className="autostart-dot" />
                {autoStart === null ? '自启…' : autoStart ? '自启开' : '自启关'}
              </button>
              {/* 完成度缩小为「0/0」纯数字，置于自启开关正下方（用户 m02643） */}
              {page === 0 && (
                <span className="todo-stat">
                  <b className="todo-count">
                    {todoStats.done}/{todoStats.total}
                  </b>
                </span>
              )}
            </div>
            <div className="panel-body">
              {/* 点面板主体不再整体收起：stopPropagation 由内部控件自理 */}
              {/* 置物架/通知页工具条（视图按钮、清空、已读）要贴岛右缘：
                  这两页内容宽度是自适应的，page-fade 不撑满时工具条只到内容右边界、按钮悬在中间。
                  加 wide 让该页整行占满（第 1/4 页内容本身接近满宽，保持原样不动） */}
              <div
                key={pageAnim}
                onClick={(e) => e.stopPropagation()}
                className={`page-fade ${page === 1 || page === 2 || page === 4 ? 'wide' : ''}`}
              >
                {page === 0 ? (
                  <TodoPanel onDonePulse={onDonePulse} onStats={onTodoStats} />
                ) : page === 1 ? (
                  <ShelfPanel />
                ) : page === 2 ? (
                  <NotifyPanel onUnread={onNotifyUnread} />
                ) : page === 4 ? (
                  <PageManagerPanel
                    pagesCustom={pagesCustom}
                    onClose={() => {
                      setPage(enabledPagesRef.current[0] ?? 0)
                      setExpanded(false)
                      expandedRef.current = false
                    }}
                    onChange={(v) => {
                      pagesCustomDirty.current = true
                      setPagesCustom(v)
                      window.island.prefsSet({ pagesCustom: v }).catch(() => {
                        /* 写失败下次还是全开，不打扰用户 */
                      })
                    }}
                  />
                ) : (
                  <SchedulePanel />
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
            {/* 收起态组件按「页面管理」（US-032）的开关显隐；未读红点不参与裁剪 */}
            {pagesCustom.collapsed.pet && <Pet mood={mood} />}
            {pagesCustom.collapsed.clock && <span className="collapsed-clock">{formatClock(now)}</span>}
            {pagesCustom.collapsed.battery && battery !== null && (
              <span
                className={`head-battery-ring ${battery <= 20 ? 'low' : ''}`}
                role="img"
                aria-label={`电量 ${battery}%`}
                title={`电量 ${battery}%`}
              >
                <svg viewBox="0 0 36 36" aria-hidden="true">
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
            )}
            {/* 网络（收起态 US-005）：电量环右侧。Wi-Fi 弧线 / 插网线显示水晶头图标；
                有网白色，连上但没网橙色警示；读不到（没联网 / 命令失败）不渲染，不打扰 */}
            {pagesCustom.collapsed.net && wifi !== null && (
              <span
                className={`collapsed-wifi ${wifi.online ? '' : 'offline'}`}
                title={
                  wifi.kind === 'ethernet'
                    ? `网线：${wifi.name ?? ''}（${wifi.online ? '网络正常' : '连上了但上不了网'}）`
                    : `Wi-Fi：${wifi.name ?? ''}（${wifi.online ? '网络正常' : '连上了但上不了网'}）`
                }
                role="img"
                aria-label={
                  wifi.kind === 'ethernet'
                    ? wifi.online
                      ? '网线已连接，网络正常'
                      : '网线已连接但没有网络'
                    : wifi.online
                      ? 'Wi-Fi 已连接，网络正常'
                      : 'Wi-Fi 已连接但没有网络'
                }
              >
                {wifi.kind === 'ethernet' ? <IcoEthernet /> : <IcoWifi />}
              </span>
            )}
            {/* 待办剩余（收起态）：只在真有未完成的事时出现，全部做完就收起不再催。
                US-033 起统计口径是「待办 + 今天的日程」，所以文案用「件没做完」 */}
            {pagesCustom.collapsed.todo && todoStats.total - todoStats.done > 0 && (
              <span
                className="collapsed-todo"
                title={`今天还有 ${todoStats.total - todoStats.done} 件没做完（共 ${todoStats.total} 件）`}
                role="img"
                aria-label={`今天还有 ${todoStats.total - todoStats.done} 件没做完`}
              >
                <b className="collapsed-todo-num">{todoStats.total - todoStats.done}</b>
              </span>
            )}
            {notifyUnread > 0 && <span className="collapsed-dot" title={`${notifyUnread} 条未读通知`} />}
          </>
        )}
      </div>
    </div>
  )
}
