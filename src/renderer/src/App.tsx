import { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo, ShelfItem } from '../../shared/types'
/** 收起 700ms 后自动收回，给鼠标留出移入面板的时间 */
const AUTO_COLLAPSE_MS = 700
/** 展开面板的页数（分页圆点数） */
const PAGE_COUNT = 2

function formatClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 岛仔：一只简单的黑胶囊宠物，两个白点眼 + 头顶星星 */
function Pet({ reaction }: { reaction: 'idle' | 'happy' }): React.JSX.Element {
  return (
    <svg className="collapsed-pet" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="4" width="22" height="16" rx="8" fill="#4b2ea8" />
      <circle cx="9" cy="12" r="1.9" fill="#ffffff" />
      <circle cx="15" cy="12" r="1.9" fill="#ffffff" />
      {reaction === 'happy' && (
        <path
          d="M19 2.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"
          fill="#ffd45e"
        />
      )}
    </svg>
  )
}

/** 待办面板：列表 + 勾选 + 增 + 删 + 完成度 n/m */
function TodoPanel({ onDonePulse }: { onDonePulse: () => void }): React.JSX.Element {
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

  const done = todos.filter((t) => t.done).length

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
      <div className="todo-stat">
        <span className="todo-count">
          {done}/{todos.length}
        </span>
        <span className="todo-count-label">已完成</span>
      </div>
      <ul className="todo-list">
        {todos.length === 0 && (
          <li className="todo-empty">还没有待办，加一个吧</li>
        )}
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
        <button type="button" className="todo-add-btn" onClick={() => void add()}>
          + 加一个
        </button>
      </div>
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

/** 通用文件图标：折角纸片 + 扩展名色 */
function FileIcon({ name }: { name: string }): React.JSX.Element {
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

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    // Electron 32+ 没有 File.path，用 preload 里的 webUtils.getPathForFile 拿完整路径
    const paths = Array.from(files)
      .map((f) => window.island.filePath(f))
      .filter((p): p is string => !!p)
    if (paths.length === 0) {
      setError('没拿到文件路径，请直接从资源管理器拖进来')
      return
    }
    setError('')
    setItems(await window.island.shelfAdd(paths))
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
              <li key={it.id} className="shelf-cell" title={it.path}>
                <button
                  type="button"
                  className="shelf-cell-del"
                  title="移除"
                  onClick={() => void remove(it.id)}
                >
                  ×
                </button>
                <button type="button" className="shelf-cell-body" onClick={() => void open(it)}>
                  <FileIcon name={it.name} />
                  <span className="shelf-cell-name">{it.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="shelf-list">
            {items.map((it) => (
              <li key={it.id} className="shelf-item" title={it.path}>
                <FileIcon name={it.name} />
                <button type="button" className="shelf-name" onClick={() => void open(it)}>
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

export default function App(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [battery, setBattery] = useState<number | null>(null)
  const [reaction, setReaction] = useState<'idle' | 'happy'>('idle')
  const [page, setPage] = useState(0)
  const hoverRef = useRef(false)
  const collapseTimer = useRef<number | null>(null)

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
    }, page === 1 ? SHELF_COLLAPSE_MS : AUTO_COLLAPSE_MS)
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

  // 完成待办 → 岛仔开心一下（M2 会扩展成完整情绪系统）
  const onDonePulse = useCallback(() => {
    setReaction('happy')
    window.setTimeout(() => setReaction('idle'), 1200)
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
      }, page === 1 ? SHELF_COLLAPSE_MS : AUTO_COLLAPSE_MS)
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
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onDragEnter={onDragEnter}
        onDragOver={onDragOverRoot}
        onDrop={(e) => {
          onDropRoot(e)
          scheduleCollapse()
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
              <span className="panel-title">{page === 0 ? '待办 清单' : '置物架'}</span>
              <span className="panel-sub">{page === 0 ? 'M1' : 'M4'}</span>
            </div>
            <div className="panel-body">
              {/* 点面板主体不再整体收起：stopPropagation 由内部控件自理 */}
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%' }}>
                {page === 0 ? <TodoPanel onDonePulse={onDonePulse} /> : <ShelfPanel />}
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
            <Pet reaction={reaction} />
            <span className="collapsed-clock">{formatClock(now)}</span>
            {battery !== null && (
              <span className="collapsed-battery" title={`电量 ${battery}%`}>
                {battery}%
              </span>
            )}
            <span className="collapsed-spacer" />
            <span className="collapsed-label">点击展开</span>
          </>
        )}
      </div>
    </div>
  )
}
