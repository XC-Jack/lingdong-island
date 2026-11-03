import { useCallback, useEffect, useRef, useState } from 'react'

/** 收起 700ms 后自动收回，给鼠标留出移入面板的时间 */
const AUTO_COLLAPSE_MS = 700

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

export default function App(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [reaction, setReaction] = useState<'idle' | 'happy'>('idle')
  const hoverRef = useRef(false)
  const collapseTimer = useRef<number | null>(null)

  // 时钟走字
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
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
      if (!hoverRef.current) setExpanded(false)
    }, AUTO_COLLAPSE_MS)
  }, [clearCollapseTimer])

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
    setReaction('happy')
    window.setTimeout(() => setReaction('idle'), 900)
  }, [clearCollapseTimer, scheduleCollapse])

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
        onClick={toggle}
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
              <span className="panel-title">灵动岛</span>
              <span className="panel-sub">M0 · 岛壳</span>
            </div>
            <div className="panel-body">面板内容接下来一步步填进来</div>
            <div className="dots">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className={`dot ${i === 0 ? 'active' : ''}`} />
              ))}
            </div>
          </>
        ) : (
          <>
            <Pet reaction={reaction} />
            <span className="collapsed-clock">{formatClock(now)}</span>
            <span className="collapsed-spacer" />
            <span className="collapsed-label">点击展开</span>
          </>
        )}
      </div>
    </div>
  )
}
