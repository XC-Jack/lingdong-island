import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { IslandTheme } from '../../../shared/types'
import { ISLAND_THEMES } from '../../../shared/types'

/**
 * 设置窗口「外观」分区（SPEC-settings-theme）。
 *
 * 三套主题的取值、CSS token、岛内 `data-theme` 切换和 `prefs.islandTheme` 读写链路
 * 在 SPEC-island-themes 里已经做完，这里只补一个能点的入口：
 * 点卡片 → 立刻 prefsSet → 主进程落盘并广播 → 岛当场换肤。
 *
 * 为什么不给「保存」按钮：与桌宠/页面管理同一个理由——改完就要立刻看到效果。
 * 为什么图标是 CSS 示意图而不是截图：设置窗口自己看不到岛的背景（岛是透明窗），
 * 抓一张岛的实际样子贴在这里反而会误导；示意图只表达「材质与明暗」。
 */

/** 三套主题的展示文案，顺序即卡片顺序（默认主题在最上面） */
const THEME_META: Record<IslandTheme, { name: string; desc: string }> = {
  'glass-light': {
    name: '亮色玻璃',
    desc: '半透明乳白玻璃，桌面颜色从底下透上来，深色文字。默认。'
  },
  'glass-dark': {
    name: '纯黑玻璃',
    desc: '近黑的玻璃底 + 一道极淡的白边，白色文字，适合深色桌面。'
  },
  mono: {
    name: '纯黑极简',
    desc: '实心纯黑、无描边、无投影，只靠留白和字号分层次。'
  }
}

/** 非法值（手改 prefs.json、旧版本留下的值）一律回到默认主题，与岛内的回落一致 */
function normalizeTheme(v: unknown): IslandTheme {
  return typeof v === 'string' && (ISLAND_THEMES as readonly string[]).includes(v)
    ? (v as IslandTheme)
    : 'glass-light'
}

export default function ThemeSection(): ReactElement {
  const [theme, setTheme] = useState<IslandTheme>('glass-light')
  const [failed, setFailed] = useState(false)
  // 用户点过之后不再接受启动回填（与桌宠分区同一个防覆盖思路）
  const dirty = useRef(false)

  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((p) => {
        if (!alive || dirty.current) return
        setTheme(normalizeTheme(p.islandTheme))
      })
      .catch(() => {
        /* 读不到就用默认 */
      })
    // 岛里或别处改了主题也要跟上（prefs:set 的广播会带回规整后的值）
    const off = window.island.onPrefsChanged((p) => setTheme(normalizeTheme(p.islandTheme)))
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 点卡片：乐观选中 + 写主进程；写失败回滚到原来的主题并提示 */
  const pickTheme = (next: IslandTheme): void => {
    if (next === theme) return
    const prev = theme
    dirty.current = true
    setFailed(false)
    setTheme(next)
    window.island.prefsSet({ islandTheme: next }).catch(() => {
      setTheme(prev)
      setFailed(true)
    })
  }

  return (
    <div className="theme-set">
      <div className="theme-list" role="radiogroup" aria-label="岛的主题">
        {ISLAND_THEMES.map((id) => {
          const meta = THEME_META[id]
          const on = theme === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`theme-card ${on ? 'on' : ''}`}
              data-theme-id={id}
              onClick={() => pickTheme(id)}
            >
              {/* 预览图是纯 CSS 示意图：底色代表桌面，胶囊代表岛。
                  材质取值照抄 styles.css 的三段主题（B 的乳白玻璃 / A 的黑玻璃 / C 的实心黑），
                  改了那边的 token 要同步这里。 */}
              <span className="theme-prev" data-t={id} aria-hidden="true">
                <span className="theme-prev-island">
                  <span className="theme-prev-dot" />
                  <span className="theme-prev-bar" />
                </span>
              </span>
              <span className="theme-card-text">
                <span className="theme-card-name">{meta.name}</span>
                <span className="theme-card-desc">{meta.desc}</span>
              </span>
              <span className="pet-set-radio" aria-hidden="true" />
            </button>
          )
        })}
      </div>
      {failed ? <div className="set-note">保存失败，请重试。</div> : null}
      <div className="pet-set-tip">
        只改桌面上的岛；这个设置窗口始终是深色，方便看清控件。切换立刻生效，不用重启。
        「亮色玻璃」会实时读取岛背后的桌面来调色，另外两套是纯黑，不抓屏。
      </div>
    </div>
  )
}
