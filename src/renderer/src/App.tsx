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

/** 待办面板：列表 + 勾选 + 增 + 删 + 改（双击编辑） + 完成度 n/m */
function TodoPanel({
  onDonePulse,
  onStats,
}: {
  onDonePulse: () => void
  onStats: (done: number, total: number) => void
}): React.JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([])
  const [draft, setDraft] = useState('')
  // 双击编辑：正在改名的条目 id + 草稿
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const draftInputRef = useRef<HTMLInputElement | null>(null)

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
    // 加完保持输入框焦点，方便连着录几条
    draftInputRef.current?.focus()
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
          placeholder="加一个待办，回车连记…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <button
          type="button"
          className="todo-add-btn"
          title="添加"
          aria-label="添加待办"
          onClick={() => void add()}
        >
          +
        </button>
      </div>
      <ul className="todo-list">
        {todos.length === 0 && <li className="todo-empty">还没有待办，加一个吧</li>}
        {todos.map((t) => (
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
                  if (e.key === 'Enter') void commitEdit()
                  if (e.key === 'Escape') setEditingId(null)
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
  const [error, setError] = useState('')
  // 视图：大/中/小图标（横向一排滚动，两侧箭头）或列表（纵向滚动）
  const [view, setView] = useState<'lg' | 'md' | 'sm' | 'list'>('lg')
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
                  className="todo-del shelf-row-folder"
                  title="在文件夹中显示"
                  aria-label={`在文件夹中显示 ${it.name}`}
                  onClick={() => window.island.shelfShowInFolder(it.path)}
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
                      title="双击打开"
                      onDoubleClick={() => void open(it)}
                    >
                      <FileIcon name={it.name} path={it.path} />
                      <span className="shelf-cell-name">{it.name}</span>
                    </button>
                    <button
                      type="button"
                      className="shelf-cell-folder"
                      title="在文件夹中显示"
                      aria-label={`在文件夹中显示 ${it.name}`}
                      onClick={() => window.island.shelfShowInFolder(it.path)}
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
  const [selDay, setSelDay] = useState<string>(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })

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
    void window.island.scheduleAdd(t, time || null).then((list) => {
      setItems(list)
      setText('')
      setTime('')
      setTimePop(false)
    })
  }, [text, time])

  const toggle = useCallback((id: string) => {
    void window.island.scheduleToggle(id).then(setItems)
  }, [])

  const toggleTodo = useCallback((id: string) => {
    void window.island.todosToggle(id).then(setTodos)
  }, [])

  const remove = useCallback((id: string) => {
    void window.island.scheduleRemove(id).then(setItems)
  }, [])

  // 日程全部按「今天」处理（数据模型暂无日期字段）；有日程的日子标蓝点
  const todayKey = selDay
  const markedDays = new Set<string>([todayKey, ...items.map(() => todayKey)])
  // 选中日的混排列表：日程（带时间在前）+ 待办
  const schedSorted = [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.time && b.time) return a.time.localeCompare(b.time)
    if (a.time) return -1
    if (b.time) return 1
    return a.createdAt - b.createdAt
  })
  const todoSorted = [...todos].sort((a, b) => Number(a.done) - Number(b.done))
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
          <span className="sched-day-sub">{items.length} 条日程 · {todos.length} 条待办</span>
        </div>
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
          <ul className="todo-list sched-list">
            {schedSorted.map((it) => (
              <li key={`s${it.id}`} className={`todo-item ${it.done ? 'done' : ''}`}>
                <input
                  type="checkbox"
                  className="todo-check"
                  checked={it.done}
                  aria-label={it.done ? `标记日程 ${it.text} 为未完成` : `标记日程 ${it.text} 为已完成`}
                  onChange={() => toggle(it.id)}
                />
                {it.time && (
                  <span className={`sched-badge ${!it.done && it.time <= hm ? 'sched-past' : ''}`}>
                    {it.time}
                  </span>
                )}
                <span className="todo-text">{it.text}</span>
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
                <input
                  type="checkbox"
                  className="todo-check"
                  checked={t.done}
                  aria-label={t.done ? `标记待办 ${t.text} 为未完成` : `标记待办 ${t.text} 为已完成`}
                  onChange={() => toggleTodo(t.id)}
                />
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

  // 翻页（‹ ›）：循环，不越界
  const flipPage = useCallback((dir: 1 | -1) => {
    setPage((p) => (p + dir + PAGE_COUNT) % PAGE_COUNT)
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
        role="button"
        tabIndex={0}
        aria-label={expanded ? `${PAGE_META[page].label}面板` : '灵动岛，回车展开'}
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
              <span className={`panel-badge ${PAGE_META[page].accent ? 'accent' : ''}`} style={{ ['--accent' as never]: PAGE_META[page].accent }}>
                <span className="panel-badge-icon">{PAGE_META[page].icon()}</span>
              </span>
              <span className="panel-title">{PAGE_META[page].label}</span>
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
              <div key={pageAnim} onClick={(e) => e.stopPropagation()} className="page-fade">
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
                {Array.from({ length: PAGE_COUNT }, (_, i) => (
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
            <Pet mood={mood} />
            <span className="collapsed-clock">{formatClock(now)}</span>
            {battery !== null && (
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
            {notifyUnread > 0 && <span className="collapsed-dot" title={`${notifyUnread} 条未读通知`} />}
          </>
        )}
      </div>
    </div>
  )
}
