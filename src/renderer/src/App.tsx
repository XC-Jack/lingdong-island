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

/** 置物架面板：拖文件进来暂存，点击打开，可删除/清空 */
function ShelfPanel(): React.JSX.Element {
  const [items, setItems] = useState<ShelfItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void window.island.shelfList().then((l) => {
      if (alive) setItems(l)
    })
    return () => {
      alive = false
    }
  }, [])

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    // Electron 里 File 对象带 .path（完整路径）
    const paths = Array.from(files)
      .map((f) => (f as File & { path?: string }).path)
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
      <div
        className={`shelf-drop ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.stopPropagation()
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
          void addFiles(e.dataTransfer.files)
        }}
      >
        {items.length === 0 ? (
          <span className="shelf-drop-hint">把文件拖进来暂存</span>
        ) : (
          <ul className="shelf-list">
            {items.map((it) => (
              <li key={it.id} className="shelf-item" title={it.path}>
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
      <div className="shelf-actions">
        <button
          type="button"
          className="todo-add-btn"
          onClick={() => void clear()}
          disabled={items.length === 0}
        >
          清空
        </button>
        <span className="shelf-count">{items.length} 个文件</span>
      </div>
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

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = null
    }
  }, [])

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer()
    collapseTimer.current = window.setTimeout(() => {
      // 置物架页不自动收回：拖文件必须先离开岛去资源管理器拿文件，
      // 700ms 自动收回会让人拖到一半岛就没了
      if (!hoverRef.current && page !== 1) setExpanded(false)
    }, AUTO_COLLAPSE_MS)
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

  return (
    <div className="app">
      <div
        className={`island ${expanded ? 'expanded' : 'collapsed'}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={() => {
          // 展开态点面板空白处（非控件）回到第一页而非直接收起？——收起语义保留：点空白收起
          if (!expanded) toggle()
        }}
        onDragOver={(e) => {
          // 全窗口允许 drop：不写 preventDefault 光标会显示"禁止"，
          // 且松手会触发系统导航（主进程另有 will-navigate 兜底）
          e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
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
