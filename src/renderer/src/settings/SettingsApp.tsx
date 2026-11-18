import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AvoidMode, NeteaseCdpMode, SettingsSection } from '../../../shared/types'
import { AVOID_MODES } from '../../../shared/types'
import PageManagerSection, {
  defaultPagesCustom,
  normalizePagesCustom,
  type PagesCustom
} from './PageManagerSection'
import DeskPetSection from './DeskPetSection'

/**
 * 设置窗口的根组件（SPEC-settings-shell）。
 *
 * 为什么是独立窗口里的独立入口：岛的窗口是贴顶的透明无边框小窗（高上限 420），
 * 放不下左导航 + 多分区；设置是「偶尔打开、看完就关」的界面，形态本来就该是普通
 * 880×580 窗口。整窗是不透明深色卡片，标题栏自绘（主进程 settingsWindow.ts 里
 * 用的是 frame:false），所以关闭按钮必须自己实现并调 window.island.closeSettings()。
 *
 * 状态同步：mount 时 prefsGet() 回填；onPrefsChanged 订阅岛里改动的推送（反过来
 * 这里改的也会经主进程广播给岛）；onSettingsSection 让菜单「设置…/页面管理…」直达分区。
 */

/** 左导航分区定义：键、显示名、图标（线性 SVG，stroke 继承 currentColor） */
const NAV: { key: SettingsSection; label: string; icon: () => ReactElement }[] = [
  {
    key: 'general',
    label: '常规',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M2 5h7M11.5 5H14M2 11h2.5M7 11h7" strokeLinecap="round" />
        <circle cx="10" cy="5" r="1.8" />
        <circle cx="5.5" cy="11" r="1.8" />
      </svg>
    )
  },
  {
    key: 'pages',
    label: '页面管理',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="2" y="3" width="12" height="10" rx="1.6" />
        <path d="M6 3v10" strokeLinecap="round" />
      </svg>
    )
  },
  {
    key: 'pet',
    label: '桌宠',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path
          d="M8 3.4c2.6 0 4.2 1.9 4.2 4.4 0 .5.1.9.2 1.4.4 1.7-.6 3.1-1.8 3.4-1.4.4-3.8.4-5.2 0-1.2-.3-2.2-1.7-1.8-3.4.1-.5.2-.9.2-1.4 0-2.5 1.6-4.4 4.2-4.4Z"
          strokeLinejoin="round"
        />
        <circle cx="6.5" cy="7.6" r="1.05" fill="currentColor" stroke="none" />
        <circle cx="9.5" cy="7.6" r="1.05" fill="currentColor" stroke="none" />
      </svg>
    )
  },
  {
    key: 'focus',
    label: '专注·喝水',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path
          d="M8 2.2c2 2.3 3.4 4 3.4 5.9A3.4 3.4 0 0 1 8 11.5a3.4 3.4 0 0 1-3.4-3.4c0-1.9 1.4-3.6 3.4-5.9Z"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
]

/**
 * 尽早订阅「切分区」指令。
 *
 * 主进程 settingsWindow.ts 在 did-finish-load 时 send('settings:section')，而
 * createRoot().render() 是并发调度、不保证在 load 事件前提交首帧；如果等到
 * useEffect 里才注册 ipcRenderer 监听，这条指令就会丢掉——菜单点「页面管理…」打开
 * 窗口却停在「常规」，e2e 也就查不到 .pm-row。所以在模块求值阶段（preload 已就绪）
 * 就挂上监听，还没有订阅者时先缓存最新一条，由组件挂载后取走。
 */
let pendingSection: SettingsSection | null = null
let sectionSink: ((s: SettingsSection) => void) | null = null
void window.island.onSettingsSection((s) => {
  if (sectionSink) sectionSink(s)
  else pendingSection = s
})

/** 一行设置项：左侧标签、右侧值/控件 */
function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }): ReactElement {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-label">{label}</div>
        {hint ? <div className="set-hint">{hint}</div> : null}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  )
}

/**
 * 全屏避让三档（SPEC-avoid-mode-and-latency，用户 2026-11-17 要求）：
 * 三个选项互斥，点一下立刻写 prefs.json 并广播（岛主进程 150ms 内跟上）。
 * 文案刻意写明「最大化算不算」，因为这两档的差别只有这一点。
 */
const AVOID_META: Record<AvoidMode, { label: string; desc: string }> = {
  fullscreen: {
    label: '只在真全屏时隐藏',
    desc: 'F11、全屏视频、全屏游戏这类才把岛收起来；平时把窗口最大化，岛照常待着。'
  },
  maximized: {
    label: '窗口最大化时也隐藏',
    desc: '只要前台窗口铺满屏幕（含最大化）就把岛收起来，默认。鼠标移到屏幕最顶边 4px 可以临时叫出来。'
  },
  off: {
    label: '不隐藏',
    desc: '任何时候都留着岛。看视频/玩游戏时它会挡在画面上，需要自己点「暂时隐藏」。'
  }
}

/**
 * 网易云后台控制三档（SPEC-netease-cdp-mode，用户 2026-11-18 要求「再加一个自动和半自动的」）。
 * 自动＝现状（发现端口缺失就重启）；半自动＝只保留音乐页的「点此开启」入口；关闭＝连入口也不显示。
 */
const CDP_MODES: NeteaseCdpMode[] = ['auto', 'manual', 'off']
const CDP_MODE_META: Record<NeteaseCdpMode, { label: string; desc: string }> = {
  auto: {
    label: '自动',
    desc: '发现网易云没开后台控制端口时，自动重启它一次（约 4 秒），之后最小化也能拖进度。'
  },
  manual: {
    label: '半自动',
    desc: '不自动重启，只在音乐页显示「点此开启后台精确控制」入口，你点了才重启。'
  },
  off: {
    label: '关闭',
    desc: '不自动重启，也不显示入口；灵动岛不会碰网易云。'
  }
}

export default function SettingsApp(): ReactElement {
  // 首帧就落在菜单要求的分区（模块级订阅可能在 render 之前已经收到一条）
  const [section, setSection] = useState<SettingsSection>(pendingSection ?? 'general')
  // 偏好先落默认全开，mount 后异步回填真实值——与岛内「先默认后异步回填」同一模式
  const [pagesCustom, setPagesCustom] = useState<PagesCustom>(defaultPagesCustom)
  // 用户一旦在这里改过（dirty）就不再接受启动回填，避免覆盖用户刚点的操作
  const pagesCustomDirty = useRef(false)
  // 开机自启（null = 还没取到，开关先不显示假状态）
  const [autoStart, setAutoStart] = useState<boolean | null>(null)
  // 全屏避让策略（SPEC-avoid-mode-and-latency）：默认与主进程一致 = maximized
  const [avoidMode, setAvoidMode] = useState<AvoidMode>('maximized')
  // 用户点过就不再接受启动回填（与桌宠分区同一个防覆盖思路）
  const avoidDirty = useRef(false)
  // 网易云后台控制档位（SPEC-netease-cdp-mode）：默认与主进程一致 = auto
  const [cdpMode, setCdpMode] = useState<NeteaseCdpMode>('auto')
  const cdpModeDirty = useRef(false)
  // 版本号与数据目录（appInfo 异步取，取不到就显示占位）
  const [info, setInfo] = useState<{ version: string; userData: string } | null>(null)
  // 导出进行中（防连点叠两个另存为对话框）；导出结果提示（成功给路径、失败给原因）
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState('')

  // 启动回填偏好 + 订阅后续变更
  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((prefs) => {
        if (!alive) return
        if (!avoidDirty.current && prefs.avoidMode) setAvoidMode(prefs.avoidMode)
        if (!cdpModeDirty.current) setCdpMode(prefs.neteaseCdpMode ?? 'auto')
        if (pagesCustomDirty.current) return
        const v = normalizePagesCustom(prefs.pagesCustom)
        if (v) setPagesCustom(v)
      })
      .catch(() => {
        /* 读不到就用默认全开 */
      })
    // 岛里改了页面裁剪，设置窗口要当场跟上。这里不加 dirty 判断：
    // prefs:set 的广播带回来的是主进程规整后的同一份数据（等价于本地状态），
    // 若因 dirty 跳过，用户第一次点击之后就再也收不到岛侧的改动。
    const offPrefs = window.island.onPrefsChanged((prefs) => {
      const v = normalizePagesCustom(prefs.pagesCustom)
      if (v) setPagesCustom(v)
      if (!avoidDirty.current && prefs.avoidMode) setAvoidMode(prefs.avoidMode)
      if (!cdpModeDirty.current) setCdpMode(prefs.neteaseCdpMode ?? 'auto')
    })
    return () => {
      alive = false
      offPrefs()
    }
  }, [])

  // 菜单「设置…」/「页面管理…」直达分区：接上模块级订阅，并把挂载前收到的那条补上
  useEffect(() => {
    sectionSink = setSection
    if (pendingSection !== null) {
      const s = pendingSection
      pendingSection = null
      setSection(s)
    }
    return () => {
      sectionSink = null
    }
  }, [])

  // 常规页的本机信息
  useEffect(() => {
    let alive = true
    void window.island
      .appInfo()
      .then((i) => {
        if (alive) setInfo(i)
      })
      .catch(() => {
        /* 取不到就显示占位，不弹错 */
      })
    void window.island
      .autostartGet()
      .then((on) => {
        if (alive) setAutoStart(on)
      })
      .catch(() => {
        /* 读不到就保持未知 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 自启状态被另一处改了（岛头部那枚胶囊）也要跟上（SPEC-settings-shell 阻断项 B2）
  useEffect(() => window.island.onAutostartChanged((on) => setAutoStart(on)), [])

  /** 避让策略：立即生效 + 写主进程，不等「保存」（与桌宠/页面管理同一套模式） */
  const pickAvoidMode = (m: AvoidMode): void => {
    avoidDirty.current = true
    setAvoidMode(m)
    window.island.prefsSet({ avoidMode: m }).catch(() => {
      /* 写失败下次还是旧值，不打扰用户 */
    })
  }

  /** 网易云后台控制档位：立即生效 + 写主进程（主进程经 onPrefsWritten 热更新） */
  const pickCdpMode = (m: NeteaseCdpMode): void => {
    cdpModeDirty.current = true
    setCdpMode(m)
    window.island.prefsSet({ neteaseCdpMode: m }).catch(() => {
      /* 写失败下次还是旧值，不打扰用户 */
    })
  }

  /** 页面管理改动：立即生效 + 写主进程，不等「保存」 */
  const changePages = (v: PagesCustom): void => {
    pagesCustomDirty.current = true
    setPagesCustom(v)
    window.island.prefsSet({ pagesCustom: v }).catch(() => {
      /* 写失败下次还是旧值，不打扰用户 */
    })
  }

  /**
   * 导出数据（US-029；2026-11-11 从右键/托盘菜单搬到这里）。
   * 真正的文件读写与另存为对话框都在主进程，这里只触发并把结果显示在行内；
   * 主进程同时会发系统通知，岛收起时也看得到。
   */
  const runExport = (): void => {
    if (exporting) return
    setExporting(true)
    setExportNote('')
    window.island
      .exportData()
      .then((r) => {
        if (r.ok) setExportNote(`已导出到 ${r.path}`)
        else if (r.canceled) setExportNote('')
        else setExportNote(`导出失败：${r.detail ?? r.reason ?? '未知原因'}`)
      })
      .catch((err: unknown) => {
        setExportNote(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setExporting(false))
  }

  /** 开机自启：先乐观翻转，再以主进程实际状态校准 */
  const toggleAutoStart = (): void => {
    const next = !(autoStart ?? false)
    setAutoStart(next)
    window.island
      .autostartSet(next)
      .then((real) => setAutoStart(real))
      .catch(() => {
        /* 系统调用失败：保持乐观值，下次打开窗口会读到真实状态 */
      })
  }

  return (
    <div className="set-root">
      <header className="set-titlebar">
        <span className="set-title">设置</span>
        <button
          type="button"
          className="set-close"
          title="关闭"
          aria-label="关闭设置"
          onClick={() => window.island.closeSettings()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="set-body">
        <nav className="set-nav">
          {NAV.map(({ key, label, icon }) => (
            <button
              key={key}
              type="button"
              className={`set-nav-item ${section === key ? 'on' : ''}`}
              onClick={() => setSection(key)}
            >
              <span className="set-nav-icon">{icon()}</span>
              <span className="set-nav-label">{label}</span>
            </button>
          ))}
        </nav>
        <main className="set-content">
          {section === 'general' ? (
            <section className="set-page">
              <h2 className="set-page-title">常规</h2>
              <div className="set-card">
                <Row label="开机自启" hint="开机后自动运行灵动岛">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoStart === true}
                    aria-label="开机自启"
                    className={`set-switch ${autoStart === true ? 'on' : ''}`}
                    disabled={autoStart === null}
                    onClick={toggleAutoStart}
                  >
                    <span className="set-knob" />
                  </button>
                </Row>
                <Row label="版本">{info ? info.version : '—'}</Row>
                <Row label="数据文件夹" hint={info ? info.userData : undefined}>
                  <button
                    type="button"
                    className="set-btn"
                    onClick={() => {
                      void window.island.openUserData()
                    }}
                  >
                    打开文件夹
                  </button>
                </Row>
                <Row label="导出数据" hint="把待办和日程保存成一个 JSON 文件">
                  <button
                    type="button"
                    className="set-btn"
                    disabled={exporting}
                    onClick={runExport}
                  >
                    {exporting ? '导出中…' : '导出…'}
                  </button>
                </Row>
              </div>
              <div className="set-card">
                <div className="pet-set-head">全屏时怎么办</div>
                {AVOID_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`pet-set-mode ${avoidMode === m ? 'on' : ''}`}
                    data-avoid-mode={m}
                    aria-pressed={avoidMode === m}
                    onClick={() => pickAvoidMode(m)}
                  >
                    <span className="pet-set-mode-text">
                      <span className="pet-set-mode-name">{AVOID_META[m].label}</span>
                      <span className="pet-set-mode-desc">{AVOID_META[m].desc}</span>
                    </span>
                    <span className="pet-set-radio" aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="set-card">
                <div className="pet-set-head">网易云后台控制</div>
                {CDP_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`pet-set-mode ${cdpMode === m ? 'on' : ''}`}
                    data-cdp-mode={m}
                    aria-pressed={cdpMode === m}
                    onClick={() => pickCdpMode(m)}
                  >
                    <span className="pet-set-mode-text">
                      <span className="pet-set-mode-name">{CDP_MODE_META[m].label}</span>
                      <span className="pet-set-mode-desc">{CDP_MODE_META[m].desc}</span>
                    </span>
                    <span className="pet-set-radio" aria-hidden="true" />
                  </button>
                ))}
              </div>
              {exportNote ? <div className="set-note">{exportNote}</div> : null}
            </section>
          ) : section === 'pages' ? (
            <section className="set-page">
              <h2 className="set-page-title">页面管理</h2>
              <div className="set-card set-card-plain">
                <PageManagerSection pagesCustom={pagesCustom} onChange={changePages} />
              </div>
            </section>
          ) : section === 'pet' ? (
            <section className="set-page">
              <h2 className="set-page-title">桌宠</h2>
              <DeskPetSection />
            </section>
          ) : (
            <section className="set-page">
              <h2 className="set-page-title">专注·喝水</h2>
              <div className="set-card">
                <div className="set-placeholder">这一项还没开始做，以后放专注计时和喝水提醒。</div>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
