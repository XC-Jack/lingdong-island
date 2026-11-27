import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AvoidMode, ClockFormat, NeteaseCdpMode, SettingsSection, UpdateState } from '../../../shared/types'
import { AVOID_MODES, CLOCK_FORMATS } from '../../../shared/types'
import PageManagerSection, {
  defaultPagesCustom,
  normalizePagesCustom,
  type PagesCustom
} from './PageManagerSection'
import DeskPetSection from './DeskPetSection'
import SpaceSection from './SpaceSection'
import ThemeSection from './ThemeSection'

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
    key: 'appearance',
    // 2026-11-24：换肤入口（SPEC-settings-theme）。图标用「半明半暗」的圆，表示材质/明暗
    label: '外观',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 1.8a6.2 6.2 0 0 0 0 12.4Z" fill="currentColor" stroke="none" />
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
    key: 'space',
    label: '空间',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="2" y="3.6" width="12" height="8.8" rx="1.8" />
        <path d="M2 9.2h12" strokeLinecap="round" />
        <circle cx="5" cy="11" r="0.8" fill="currentColor" stroke="none" />
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
  },
  {
    key: 'about',
    label: '关于',
    icon: () => (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 7.3v4" strokeLinecap="round" />
        <circle cx="8" cy="4.9" r="0.8" fill="currentColor" stroke="none" />
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
    desc: '只在「不显示任务栏」的全屏场景收岛：F11、全屏视频、全屏游戏；收起后摸顶边不唤回。窗口最大化（底部还有任务栏）时岛照常待着。'
  },
  maximized: {
    label: '窗口最大化时也隐藏',
    desc: '只要前台窗口铺满屏幕（含最大化）就把岛收起来，默认。窗口最大化时（底部还有任务栏），鼠标移到屏幕最顶边 4px 可以临时叫出来；真全屏（F11、全屏视频/游戏，没有任务栏）不唤回，只能点托盘图标。'
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

/**
 * 时钟显示三档（SPEC-clock-date-format，用户 2026-11-18「时间显示里面可以显示日期月份，
 * 可以在设置里面选择挡位」）。顺序按用户要求：日期 → 星期 → 时间。
 */
const CLOCK_META: Record<ClockFormat, { label: string; desc: string }> = {
  time: {
    label: '仅时间',
    desc: '收起态只显示 17:54，和现在一样。'
  },
  date: {
    label: '日期 + 时间',
    desc: '显示 11月18日 17:54，月份日期在前、时间在后。'
  },
  dateWeek: {
    label: '日期 + 星期 + 时间',
    desc: '显示 11月18日 周二 17:54，最完整的一档。'
  }
}

export default function SettingsApp(): ReactElement {
  // 首帧就落在菜单要求的分区（模块级订阅可能在 render 之前已经收到一条）
  const [section, setSection] = useState<SettingsSection>(pendingSection ?? 'general')
  // 窗口是否最大化：标题栏第二个按钮据此在「最大化 / 还原」之间切换
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void window.island
      .settingsMaximized()
      .then(setMaximized)
      .catch(() => {})
    return window.island.onSettingsMaximized(setMaximized)
  }, [])
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
  // 时钟显示档位（SPEC-clock-date-format）：默认与主进程一致 = time
  const [clockFormat, setClockFormat] = useState<ClockFormat>('time')
  const clockFormatDirty = useRef(false)
  // 「词」第二下召唤桌面歌词（SPEC-desktop-lyric-setting）：默认开
  const [desktopLyric, setDesktopLyric] = useState(true)
  const desktopLyricDirty = useRef(false)
  // 版本号与数据目录（appInfo 异步取，取不到就显示占位）
  const [info, setInfo] = useState<{ version: string; userData: string } | null>(null)
  // 自动更新状态（SPEC-auto-update）：null = 还没取到，按钮先不显示假状态
  const [update, setUpdate] = useState<UpdateState | null>(null)
  // 导出进行中（防连点叠两个另存为对话框）；导出结果提示（成功给路径、失败给原因）
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState('')
  // 导入进行中（防连点叠两个「打开」对话框）；导入结果提示
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState('')

  // 启动回填偏好 + 订阅后续变更
  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((prefs) => {
        if (!alive) return
        if (!avoidDirty.current && prefs.avoidMode) setAvoidMode(prefs.avoidMode)
        if (!cdpModeDirty.current) setCdpMode(prefs.neteaseCdpMode ?? 'auto')
        if (!clockFormatDirty.current) setClockFormat(prefs.clockFormat ?? 'time')
        if (!desktopLyricDirty.current) setDesktopLyric(prefs.desktopLyricEnabled ?? true)
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
      if (!clockFormatDirty.current) setClockFormat(prefs.clockFormat ?? 'time')
      if (!desktopLyricDirty.current) setDesktopLyric(prefs.desktopLyricEnabled ?? true)
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

  // 自动更新：先取一次快照，再订阅主进程广播（检查/下载进度/下载完成都走这一条）
  useEffect(() => {
    let alive = true
    void window.island
      .updateGetState()
      .then((s) => {
        if (alive) setUpdate(s)
      })
      .catch(() => {
        /* 取不到就不显示更新行，不影响其它设置 */
      })
    const off = window.island.onUpdateState((s) => setUpdate(s))
    return () => {
      alive = false
      off()
    }
  }, [])

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

  /** 时钟显示档位：立即生效 + 写主进程（岛经 prefs:changed 广播当场换格式） */
  const pickClockFormat = (f: ClockFormat): void => {
    clockFormatDirty.current = true
    setClockFormat(f)
    window.island.prefsSet({ clockFormat: f }).catch(() => {
      /* 写失败下次还是旧值，不打扰用户 */
    })
  }

  /** 「词」第二下召唤桌面歌词：乐观切换 + 写主进程（岛经 prefs:changed 当场生效） */
  const toggleDesktopLyric = (): void => {
    const next = !desktopLyric
    desktopLyricDirty.current = true
    setDesktopLyric(next)
    window.island.prefsSet({ desktopLyricEnabled: next }).catch(() => {
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

  /**
   * 导入数据（SPEC-data-import）：与导出一对。
   * 主进程做校验、规范化与合并；这里只触发并把结果显示在行内。
   * 只合并不覆盖，所以不需要二次确认——最坏情况是多出几条数据，不会删掉现有的。
   */
  const runImport = (): void => {
    if (importing) return
    setImporting(true)
    setImportNote('')
    window.island
      .importData()
      .then((r) => {
        if (r.ok) {
          const added = r.added ?? { todos: 0, schedule: 0 }
          const skipped = r.skipped ?? { todos: 0, schedule: 0 }
          const skipSum = skipped.todos + skipped.schedule
          setImportNote(
            `已导入待办 ${added.todos} 条、日程 ${added.schedule} 条` +
              (skipSum > 0 ? `（跳过重复 ${skipSum} 条）` : '')
          )
        } else if (r.canceled) {
          setImportNote('')
        } else {
          setImportNote(`导入失败：${r.detail ?? r.reason ?? '未知原因'}`)
        }
      })
      .catch((err: unknown) => {
        setImportNote(`导入失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setImporting(false))
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

  /** 更新按钮文案：同一个按钮按状态换动作（检查 → 下载 → 重启安装） */
  const updateLabel = ((): string => {
    if (!update) return '检查更新'
    switch (update.stage) {
      case 'checking':
        return '检查中…'
      case 'downloading':
        return '暂停'
      case 'paused':
        return '继续下载'
      case 'available':
        return update.version ? `下载 ${update.version}` : '下载'
      case 'ready':
        return '重启并安装'
      case 'error':
        return '重试'
      default:
        return '检查更新'
    }
  })()

  /** 更新时间文案：最近一次检查的 HH:mm（没有 checkedAt 返回空串） */
  const checkedTime = ((): string => {
    if (!update?.checkedAt) return ''
    return new Date(update.checkedAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    })
  })()

  /** 更新行说明：把状态写清楚，失败给原因而不是只变红；能查到时间就带上 */
  const updateHint = ((): string | undefined => {
    if (!update) return undefined
    switch (update.stage) {
      case 'checking':
        return '正在向 GitHub 查询最新版本'
      case 'none':
        return checkedTime !== '' ? `已是最新 · ${checkedTime} 检查` : '已是最新'
      case 'available':
        return `新版本 ${update.version ?? ''} 可用${checkedTime !== '' ? ` · ${checkedTime} 检查` : ''}，确认后才会下载`
      case 'downloading':
        return `正在下载 ${update.percent ?? 0}%（可暂停或取消）`
      case 'paused':
        return `已暂停${update.percent ? `在 ${update.percent}%` : ''}，继续会从头下载`
      case 'ready':
        return `已下载 ${update.version ?? ''}，重启后生效`
      case 'error':
        return `${update.message ?? '检查更新失败'}${checkedTime !== '' ? ` · ${checkedTime} 检查` : ''}`
      case 'unsupported':
        return update.message ?? '开发版不检查更新'
      default:
        return '每 4 小时自动检查（睡眠唤醒后也会补查），也可以现在手动检查'
    }
  })()

  /** 下载中主按钮是「暂停」，去点它不能被当成「忙」而禁用 */
  const updateBusy = update?.stage === 'checking'

  /** 有目标版本时给出的浏览器直链入口；下载中不显示，避免一排三个按钮 */
  const canDirectDownload =
    (update?.stage === 'available' || update?.stage === 'paused' || update?.stage === 'error') &&
    !!update?.version

  const onUpdateAction = (): void => {
    if (!update || updateBusy) return
    if (update.stage === 'downloading') {
      void window.island.updatePause()
      return
    }
    if (update.stage === 'available' || update.stage === 'paused') {
      void window.island.updateDownload()
      return
    }
    if (update.stage === 'error' && update.version) {
      void window.island.updateDownload()
      return
    }
    if (update.stage === 'ready') {
      void window.island.updateInstall()
      return
    }
    void window.island.updateCheck()
  }

  return (
    <div className="set-root">
      <header className="set-titlebar">
        <span className="set-title">设置</span>
        <div className="set-winbtns">
          <button
            type="button"
            className="set-winbtn"
            title="最小化"
            aria-label="最小化"
            onClick={() => window.island.minimizeSettings()}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2.5 8.5h7" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="set-winbtn"
            title={maximized ? '还原' : '最大化'}
            aria-label={maximized ? '还原窗口' : '最大化窗口'}
            onClick={() => window.island.toggleMaximizeSettings()}
          >
            {maximized ? (
              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="2" y="3.6" width="6.4" height="6.4" rx="1" />
                <path d="M4.2 3.6V2.9a.9.9 0 0 1 .9-.9h4a.9.9 0 0 1 .9.9v4a.9.9 0 0 1-.9.9h-.7" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1" />
              </svg>
            )}
          </button>
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
        </div>
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
                {/* 更新行：左侧「标签 + 状态说明 + 加速器提示」，按钮组在右侧垂直居中
                    （2026-11-19 用户三次调整后的位置） */}
                <div className="set-row set-row-update">
                  <div className="set-row-text">
                    <div className="set-label">更新</div>
                    {updateHint ? <div className="set-hint">{updateHint}</div> : null}
                    {/* 用户 2026-11-19：连不上 GitHub / 加载失败基本都是没开加速器，
                        去掉仓库链接，改成一句说明；开了加速器再点「检查更新」即可 */}
                    <p className="set-update-fallback">
                      连不上？多半是没开加速器，开了再试。
                    </p>
                  </div>
                  <div className="set-update-ctl">
                    <button
                      type="button"
                      className={`set-btn${
                        update?.stage === 'available' || update?.stage === 'ready' ? ' set-btn-primary' : ''
                      }`}
                      disabled={!update || updateBusy || update.stage === 'unsupported'}
                      onClick={onUpdateAction}
                    >
                      {updateLabel}
                    </button>
                    {update?.stage === 'downloading' || update?.stage === 'paused' ? (
                      <button
                        type="button"
                        className="set-btn set-btn-quiet"
                        title="停止下载并删除已下载的半截文件"
                        onClick={() => {
                          void window.island.updateCancel()
                        }}
                      >
                        取消
                      </button>
                    ) : null}
                    {canDirectDownload ? (
                      <button
                        type="button"
                        className="set-btn set-btn-quiet"
                        title="用浏览器下载该版本安装包（应用内下载慢时可用）"
                        onClick={() => {
                          void window.island.updateOpenDownload()
                        }}
                      >
                        直接下载
                      </button>
                    ) : null}
                    {/* 停在「有新版本」时主按钮是下载，仍要能手动刷新版本号
                        （用户 2026-11-19：检查到 0.1.18 后 0.1.19 已发布，
                        设置页没有可点的「检查更新」，要等 4 小时周期） */}
                    {update?.stage === 'available' || (update?.stage === 'error' && update.version) ? (
                      <button
                        type="button"
                        className="set-btn set-btn-quiet"
                        title="重新向 GitHub 查询最新版本"
                        onClick={() => {
                          void window.island.updateCheck()
                        }}
                      >
                        检查更新
                      </button>
                    ) : null}
                  </div>
                </div>
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
                <Row label="导入数据" hint="从备份 JSON 合并待办和日程（不覆盖现有数据）">
                  <button
                    type="button"
                    className="set-btn"
                    disabled={importing}
                    onClick={runImport}
                  >
                    {importing ? '导入中…' : '导入…'}
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
                <div className="pet-set-head">时钟显示</div>
                {CLOCK_FORMATS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`pet-set-mode ${clockFormat === f ? 'on' : ''}`}
                    data-clock-format={f}
                    aria-pressed={clockFormat === f}
                    onClick={() => pickClockFormat(f)}
                  >
                    <span className="pet-set-mode-text">
                      <span className="pet-set-mode-name">{CLOCK_META[f].label}</span>
                      <span className="pet-set-mode-desc">{CLOCK_META[f].desc}</span>
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
              <div className="set-card">
                <Row
                  label="点「词」第二下打开桌面歌词"
                  hint="关掉后，「词」只在岛内开合歌词面板，不会去开网易云的桌面歌词。"
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={desktopLyric}
                    aria-label="点词第二下打开桌面歌词"
                    className={`set-switch ${desktopLyric ? 'on' : ''}`}
                    onClick={toggleDesktopLyric}
                  >
                    <span className="set-knob" />
                  </button>
                </Row>
              </div>
              {exportNote ? <div className="set-note">{exportNote}</div> : null}
              {importNote ? <div className="set-note">{importNote}</div> : null}
            </section>
          ) : section === 'appearance' ? (
            <section className="set-page">
              <h2 className="set-page-title">外观</h2>
              <div className="set-card">
                <div className="pet-set-head">岛的主题</div>
                <ThemeSection />
              </div>
            </section>
          ) : section === 'pages' ? (
            <section className="set-page">
              <h2 className="set-page-title">页面管理</h2>
              <div className="set-card set-card-plain">
                <PageManagerSection pagesCustom={pagesCustom} onChange={changePages} />
              </div>
            </section>
          ) : section === 'space' ? (
            <SpaceSection />
          ) : section === 'pet' ? (
            <section className="set-page">
              <h2 className="set-page-title">桌宠</h2>
              <DeskPetSection />
            </section>
          ) : section === 'about' ? (
            <section className="set-page">
              <h2 className="set-page-title">关于</h2>
              {/* 身份卡：图标/名称/版本居中，说明限制行宽（SPEC-settings-about） */}
              <div className="set-card about-card">
                <span className="about-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="3" y="7" width="18" height="10" rx="5" />
                    <circle cx="8.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
                  </svg>
                </span>
                <h3 className="about-name">灵动岛</h3>
                <p className="about-meta">
                  <span className="about-version">v{info ? info.version : '—'}</span>
                  <span className="about-sep">·</span>
                  <span>Windows 桌面版</span>
                </p>
                {/* 文案分工：tagline 管气质，facts 给硬事实（本地数据/无账号是产品事实） */}
                <p className="about-tagline">平时躺平，有事冒头。</p>
                <p className="about-facts">
                  <span>数据只在本机</span>
                  <span className="about-sep">·</span>
                  <span>无需账号</span>
                  <span className="about-sep">·</span>
                  <span>不打扰</span>
                </p>
              </div>
              {/* GitHub 链接卡：整行是一个按钮，地址固定在主进程 */}
              <button
                type="button"
                className="set-card about-link"
                title="用浏览器打开 GitHub 仓库"
                onClick={() => {
                  void window.island.openGithub()
                }}
              >
                <span className="about-link-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                </span>
                <span className="about-link-text">
                  <span className="about-link-title">XC-Jack / lingdong-island</span>
                  <span className="about-link-sub">源码、版本更新与问题反馈都在这里 · PolyForm 非商业许可</span>
                </span>
                <span className="about-link-arrow" aria-hidden="true">
                  ↗
                </span>
              </button>
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
