import { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo, ShelfItem } from '../../shared/types'
/** 收起 700ms 后自动收回，给鼠标留出移入面板的时间 */
const AUTO_COLLAPSE_MS = 700
/** 展开面板的页数（分页圆点数） */
const PAGE_COUNT = 4

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
  time: string | null
  done: boolean
  reminded: boolean
  createdAt: number
}

function formatClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

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

/** 待办面板：列表 + 勾选 + 增 + 删 + 完成度 n/m */
function TodoPanel({
  onDonePulse,
  onStats,
}: {
  onDonePulse: () => void
  onStats: (done: number, total: number) => void
}): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([])
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let alive = true
    void window.island.todosList().then((list) => {
      if (alive) setTodos(list)
    })
    return () => {
      alive = false
    }
  }, [])

  // 完成度统计上抛给面板头（右上角「n/m 已完成」）
  const done = todos.filter((t) => t.done).length
  useEffect(() => {
    onStats(done, todos.length)
  }, [done, todos.length, onStats])

  const add = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setTodos(await window.island.todosAdd(text))
  }, [draft])

  const toggle = useCallback(
    async (t: Todo) => {
      setTodos(await window.island.todosToggle(t.id))
      // 从未完成勾成已完成 → 通知岛仔开心
      if (!t.done) onDonePulse()
    },
    [onDonePulse]
  )

  const remove = useCallback(async (id: string) => {
    setTodos(await window.island.todosRemove(id))
  }, [])

  return (
    <div className="todo-panel">
      <div className="todo-add">
        <input
          className="todo-input"
          value={draft}
          placeholder="加一个待办…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <button type="button" className="todo-add-btn" title="添加" onClick={() => void add()}>
          +
        </button>
      </div>
      <ul className="todo-list">
        {todos.length === 0 && <li className="todo-empty">还没有待办，加一个吧</li>}
        {todos.map((t) => (
          <li key={t.id} className={`todo-item ${t.done ? 'done' : ''}`}>
            <button
              type="button"
              className="todo-check"
              title={t.done ? '标记为未完成' : '标记为已完成'}
              onClick={() => void toggle(t)}
            >
              {t.done ? '✓' : ''}
            </button>
            <span className="todo-text" title={t.text}>
              {t.text}
            </span>
            <button
              type="button"
              className="todo-del"
              title="删除"
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
  const [error, setError] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  /** 正在拖动换位的条目 id（网格内排序用） */
  const reorderFrom = useRef<string | null>(null)
  const reorderSeq = useRef(0)

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
      setError('')
    })
  }, [])

  const remove = useCallback(async (id: string) => {
    setItems(await window.island.shelfRemove(id))
  }, [])

  const clear = useCallback(async () => {
    setItems(await window.island.shelfClear())
  }, [])

  const open = useCallback(async (item: ShelfItem) => {
    const r = await window.island.shelfOpen(item.path)
    if (r !== 'ok') setError(`打不开：${r}`)
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
        <button
          type="button"
          className="shelf-view-btn"
          title={view === 'grid' ? '切换为列表' : '切换为大图标'}
          onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
        >
          {view === 'grid' ? '☰' : '⊞'}
        </button>
        <button
          type="button"
          className="todo-del"
          title="清空置物架"
          onClick={() => void clear()}
          disabled={items.length === 0}
        >
          清空
        </button>
      </div>
      <div className={`shelf-drop ${view} ${dragOver ? 'over' : ''}`}>
        {items.length === 0 ? (
          <span className="shelf-drop-hint">把文件拖进来暂存（落在岛内任意位置）</span>
        ) : view === 'grid' ? (
          <ul className="shelf-grid">
            {items.map((it) => (
              <li
                key={it.id}
                className="shelf-cell"
                title={it.path}
                draggable
                onDragStart={(e) => {
                  reorderFrom.current = it.id
                  // Electron 的拖动需要 dataTransfer 里有数据，dragover/drop 才会稳定触发
                  e.dataTransfer.setData('text/plain', it.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  // 网格内换位：阻止默认，避免和外层文件投放逻辑混淆
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDrop={(e) => {
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
                  onClick={() => void remove(it.id)}
                >
                  ×
                </button>
                <button
                  type="button"
                  className="shelf-cell-body"
                  title="双击打开"
                  onDoubleClick={() => void open(it)}
                >
                  <FileIcon name={it.name} path={it.path} />
                  <span className="shelf-cell-name">{it.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="shelf-list">
            {items.map((it) => (
              <li key={it.id} className="shelf-item" title={it.path}>
                <FileIcon name={it.name} path={it.path} />
                <button
                  type="button"
                  className="shelf-name"
                  title="双击打开"
                  onDoubleClick={() => void open(it)}
                >
                  {it.name}
                </button>
                <span className="shelf-size">{fmtSize(it.size)}</span>
                <button
                  type="button"
                  className="todo-del"
                  title="从置物架移除"
                  onClick={() => void remove(it.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <div className="shelf-error">{error}</div>}
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

  useEffect(() => {
    void window.island.notifyRefresh().then((r: NotifyListResult) => {
      setItems(r.items)
      onUnread(r.unread)
      setLoaded(true)
    })
  }, [onUnread])

  const markRead = useCallback(() => {
    void window.island.notifyMarkRead().then((n) => onUnread(n))
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
        <button type="button" className="todo-del" title="全部标为已读（消除收起态红点）" onClick={markRead} disabled={items.length === 0}>
          已读
        </button>
      </div>
      {items.length === 0 ? (
        <div className="notify-empty">
          <span className="shelf-drop-hint">{loaded ? '暂无通知（电脑上应用弹过通知后会出现在这里）' : '读取中…'}</span>
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

/** 日程面板：今天的安排，可带时间（到点弹系统提醒） */
function SchedulePanel(): React.JSX.Element {
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [text, setText] = useState('')
  const [time, setTime] = useState('')

  useEffect(() => {
    void window.island.scheduleList().then(setItems)
  }, [])

  const add = useCallback(() => {
    const t = text.trim()
    if (!t) return
    void window.island.scheduleAdd(t, time.trim() || null).then((list) => {
      setItems(list)
      setText('')
      setTime('')
    })
  }, [text, time])

  const toggle = useCallback((id: string) => {
    void window.island.scheduleToggle(id).then(setItems)
  }, [])

  const remove = useCallback((id: string) => {
    void window.island.scheduleRemove(id).then(setItems)
  }, [])

  const sorted = [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.time && b.time) return a.time.localeCompare(b.time)
    if (a.time) return -1
    if (b.time) return 1
    return a.createdAt - b.createdAt
  })
  const hm = formatClock(new Date())

  return (
    <div className="todo-panel">
      {/* 输入区放顶部（与待办页一致）：文本 + 可选时间 */}
      <div className="sched-add">
        <input
          className="sched-input"
          placeholder="加个安排…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <input
          className="sched-time"
          type="time"
          title="可选：到点前提醒"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <button type="button" className="todo-add-btn" title="添加日程" onClick={add}>
          +
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="notify-empty">
          <span className="shelf-drop-hint">今天还没有安排</span>
        </div>
      ) : (
        <ul className="todo-list sched-list">
          {sorted.map((it) => (
            <li key={it.id} className={`todo-item ${it.done ? 'done' : ''}`}>
              <input
                type="checkbox"
                className="todo-check"
                checked={it.done}
                onChange={() => toggle(it.id)}
              />
              {it.time && (
                <span className={`sched-badge ${!it.done && it.time <= hm ? 'sched-past' : ''}`}>
                  {it.time}
                </span>
              )}
              <span className="todo-text">{it.text}</span>
              <button type="button" className="todo-del" title="删除" onClick={() => remove(it.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [battery, setBattery] = useState<number | null>(null)
  const [mood, setMood] = useState<'idle' | 'happy'>('idle')
  const [page, setPage] = useState(0)
  // 开机自启开关状态（null=未取到）
  const [autoStart, setAutoStart] = useState<boolean | null>(null)
  // 通知未读数（收起态红点用；仅在通知页加载/标记时更新）
  const [notifyUnread, setNotifyUnread] = useState(0)
  const hoverRef = useRef(false)
  const collapseTimer = useRef<number | null>(null)
  const islandRef = useRef<HTMLDivElement | null>(null)

  // 收起态宽度自适应：内容变化（电量出现/消失等）后量实际宽度报给主进程
  useEffect(() => {
    if (expanded) return
    const el = islandRef.current
    if (!el) return
    // 等一帧让 DOM 先按新内容排好版
    const id = window.requestAnimationFrame(() => {
      const w = Math.ceil(el.getBoundingClientRect().width)
      if (w > 0) window.island.setCollapsedWidth(w)
    })
    return () => window.cancelAnimationFrame(id)
  }, [expanded, battery])

  // 时钟走字
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // 电量：首取 + 每 60 秒刷新（主进程另有 30s 缓存）
  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void window.island.statusSnapshot().then((s) => {
        if (alive) setBattery(s.battery)
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

  // 点了桌面/其他程序（窗口失焦）→ 自动收回
  useEffect(() => {
    window.island.onWindowBlur(() => {
      hoverRef.current = false
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
      if (!hoverRef.current) setExpanded(false)
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

  // 待办完成度（右上角 n/m 已完成）
  const [todoStats, setTodoStats] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const onTodoStats = useCallback((done: number, total: number) => {
    setTodoStats({ done, total })
  }, [])

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

  // 拖文件悬停在岛上（含收起态）：通知主进程放大窗口，切到置物架页，暂停收回
  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    window.island.dragHover()
    clearCollapseTimer()
    hoverRef.current = true
    setPage(1)
    setExpanded(true)
  }

  const onDragOverRoot = (e: React.DragEvent): void => {
    e.preventDefault()
    // 悬停期间不断续命，防止拖着拖着岛收走
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = window.setTimeout(() => {
        if (!hoverRef.current) setExpanded(false)
      }, page === 0 ? AUTO_COLLAPSE_MS : SHELF_COLLAPSE_MS)
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
        onDragOver={onDragOverRoot}
        onDrop={(e) => {
          onDropRoot(e)
          scheduleCollapse()
          if (e.dataTransfer.files.length) pulseHappy()
        }}
        onClick={() => {
          // 展开态点面板空白处（非控件）回到第一页而非直接收起？——收起语义保留：点空白收起
          if (!expanded) toggle()
        }}
        role="button"
        tabIndex={0}
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
              <span className="panel-title">
                {page === 0 ? '待办' : page === 1 ? '置物架' : page === 2 ? '通知' : '日程'}
              </span>
              <span className="panel-head-spacer" />
              {page === 0 && (
                <span className="todo-stat">
                  <b className="todo-count">
                    {todoStats.done}/{todoStats.total}
                  </b>
                  <span className="todo-count-label">已完成</span>
                </span>
              )}
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
            </div>
            <div className="panel-body">
              {/* 点面板主体不再整体收起：stopPropagation 由内部控件自理 */}
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%' }}>
                {page === 0 ? (
                  <TodoPanel onDonePulse={onDonePulse} onStats={onTodoStats} />
                ) : page === 1 ? (
                  <ShelfPanel />
                ) : page === 2 ? (
                  <NotifyPanel onUnread={onNotifyUnread} />
                ) : (
                  <SchedulePanel />
                )}
              </div>
            </div>
            <div className="dots">
              {Array.from({ length: PAGE_COUNT }, (_, i) => (
                <span
                  key={i}
                  className={`dot ${i === page ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPage(i)
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <Pet mood={mood} />
            <span className="collapsed-clock">{formatClock(now)}</span>
            {battery !== null && (
              <span className="collapsed-battery" title={`电量 ${battery}%`}>
                {battery}%
              </span>
            )}
            {notifyUnread > 0 && <span className="collapsed-dot" title={`${notifyUnread} 条未读通知`} />}
          </>
        )}
      </div>
    </div>
  )
}
