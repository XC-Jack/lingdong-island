/** 单条待办（主进程与渲染进程共用） */
export interface Todo {
  id: string
  text: string
  done: boolean
  /** 创建时间戳（毫秒） */
  createdAt: number
}

/** 置物架里暂存的一个文件（主进程与渲染进程共用） */
export interface ShelfItem {
  id: string
  /** 文件完整路径 */
  path: string
  /** 显示名（文件名） */
  name: string
  /** 文件大小（字节） */
  size: number
  /** 拖入时间戳（毫秒） */
  addedAt: number
  /**
   * 原文件是否已经不在了（被移走/删除）。
   * 运行时由主进程查文件系统算出，**不写进 shelf.json**，读盘时一律视为 false。
   */
  missing?: boolean
}

/** 打开置物架条目的结果（结构化返回，避免把英文系统报错直接甩给用户） */
export interface ShelfOpenResult {
  /** 是否成功打开 */
  ok: boolean
  /** 失败原因分类：missing=文件已不在；empty=路径为空；failed=系统打开失败 */
  reason: 'ok' | 'missing' | 'empty' | 'failed'
  /** 系统返回的原始英文错误（仅在 reason==='failed' 时有值，只用于日志/兜底展示） */
  detail?: string
}

/** 「在文件夹中显示」的结果 */
export interface ShelfRevealResult {
  ok: boolean
  reason: 'ok' | 'missing' | 'empty'
}

/**
 * 设置窗口的左导航分区（SPEC-settings-shell）。
 * general=常规（自启/版本/数据目录）、appearance=外观（SPEC-settings-theme，换岛的主题）、
 * pages=页面管理（US-032 能力搬过来）、
 * space=空间（SPEC-space-cleanup，清理本应用自己的缓存）、focus=专注·喝水（占位）、
 * pet=桌宠（SPEC-deskpet-skin）、about=关于（SPEC-settings-about）
 */
/**
 * 分区清单必须与类型同一处维护：主进程 openSettings 用它校验菜单/外部传入的分区名，
 * 漏加一次就会出现「菜单点了却落在常规」（2026-11-24 加「外观」时踩过）。
 */
export const SETTINGS_SECTIONS = ['general', 'appearance', 'pages', 'space', 'focus', 'pet', 'about'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * 「空间」页的清理项目（SPEC-space-cleanup）。
 *
 * 清单写死在主进程 `cleanupStore.ts`：渲染层只能传 id，主进程按白名单过滤，
 * 任何时候都不接受任意路径——清理功能一旦能被传入路径，就等于把删除权交给了页面。
 */
/**
 * 清理范围：app=灵动岛自己的缓存；system=Windows 与其它软件留下的系统垃圾。
 * 两组在设置页各占一块，互相独立，各自扫描、各自清理。
 */
export type CleanupScope = 'app' | 'system'

/** 灵动岛自己的清理项（SPEC-space-cleanup） */
export type AppCleanupId = 'update-cache' | 'web-cache' | 'lyrics' | 'logs'

/**
 * 系统垃圾清理项（SPEC-space-system-junk）。
 * 这一组全部不需要管理员权限；需要提权的 Windows 更新缓存 / Windows.old 明确不做。
 */
export type SystemCleanupId = 'temp' | 'crash-dumps' | 'thumb-cache' | 'recycle-bin'

export type CleanupTargetId = AppCleanupId | SystemCleanupId

/** 一条清理项的静态定义（标题、说明、默认勾选），大小另外逐项扫描 */
export interface CleanupItemDef {
  id: CleanupTargetId
  label: string
  hint: string
  defaultChecked: boolean
}

/** 单项扫描结果 */
export interface CleanupItemScan {
  /** 占用字节；0 表示没有可清理的字节 */
  bytes: number
  /**
   * 条目是否真实存在。回收站里只有空文件夹时 bytes 为 0 但 exists 为 true，
   * 界面据此允许勾选清理（否则会显示「无」且不可选）。
   */
  exists: boolean
}

/** 一条清理项的扫描结果 */
export interface CleanupItem {
  id: CleanupTargetId
  /** 显示名，如「更新安装包缓存」 */
  label: string
  /** 一句说明：这是什么、删了会怎样 */
  hint: string
  /** 当前占用字节；0 表示没有可清理内容 */
  bytes: number
  /** 默认是否勾选（安全项 true、诊断日志 false） */
  defaultChecked: boolean
  /** 目标是否存在（0 字节但文件仍在时为 true） */
  exists: boolean
}

/** 一次扫描的结果 */
export interface CleanupScanResult {
  /** 这一份结果属于哪一组（页面按它回填对应面板） */
  scope: CleanupScope
  items: CleanupItem[]
  /** 本组清理项的占用合计（字节） */
  totalBytes: number
  /** 扫描完成时间戳（毫秒） */
  scannedAt: number
}

/** 一次清理的结果 */
export interface CleanupRunResult {
  /** 是否执行完成（单项失败只进 warnings，不置 false） */
  ok: boolean
  /** 实际释放的字节（清理前后重新扫描的差值） */
  freedBytes: number
  /** 清理后重新扫描的结果，界面直接用它刷新 */
  scan: CleanupScanResult
  /** 未清理成功或被跳过的项，给用户看的中文说明 */
  warnings: string[]
}

/* ---------- 卸载残留（SPEC-space-residue） ---------- */

/**
 * 残留类别：
 * - uninstall=失效的卸载注册项（HKCU，卸载程序已不存在）
 * - shortcut=失效快捷方式（用户桌面 / 用户开始菜单，目标已不存在）
 * - folder=空的开始菜单文件夹（里面所有 .lnk 都是死链且无其它文件）
 */
export type ResidueKind = 'uninstall' | 'shortcut' | 'folder'

/** 一条残留。路径只用于展示与主进程内部操作，渲染层回传时只给 id */
export interface ResidueItem {
  id: string
  kind: ResidueKind
  /** 显示名：程序名 / 快捷方式名 / 文件夹名 */
  label: string
  /** 判定依据，例如「卸载程序 C:\...\unins000.exe 已不存在」 */
  detail: string
  /** 文件系统路径，或 `HKCU\Software\...\Uninstall\<子键>` */
  path: string
  /** 文件/目录占用字节；注册表项为 0 */
  bytes: number
}

export interface ResidueScanResult {
  items: ResidueItem[]
  scannedAt: number
  /** 扫描过程中没做成的部分（例如某段注册表读不到），给用户看的说明 */
  warnings: string[]
}

export interface ResidueCleanResult {
  ok: boolean
  /** 成功清理的项数 */
  removed: number
  /**
   * 移入备份的字节（文件/目录占用之和；注册表项算 0）。
   * 注意：备份默认在同一块盘上，这部分空间**清理时并没有释放**，
   * 要等用户在「备份与撤销」里删除备份才真正腾出来。
   */
  movedBytes: number
  /** 清理后重新扫描的结果 */
  scan: ResidueScanResult
  warnings: string[]
  /** 本次清理生成的备份批次；没清理任何东西时为 null */
  backupId: string | null
}

/** 备份批次（清理前把内容移到这里，撤销时搬回去） */
export interface ResidueBackup {
  id: string
  createdAt: number
  /** 文件 / 快捷方式 / 文件夹项数 */
  files: number
  /** 注册表项数 */
  registry: number
  /** 这批备份占用的字节 */
  bytes: number
  /** 是否已经撤销过 */
  restored: boolean
}

/* ---------- 软件残留检测（SPEC-space-software-residue） ---------- */

export type SoftwareResidueKind = 'service' | 'driver' | 'task' | 'process' | 'folder'

/**
 * 判断强度：
 * - definite：引用的程序文件已不存在，或空壳目录且无任何引用
 * - likely：同公司软件还在但路径旧了；第三方驱动无对应软件/进程
 * - check：判断不了归属，只提示
 */
export type SoftwareResidueLevel = 'definite' | 'likely' | 'check'

export interface SoftwareResidueItem {
  id: string
  kind: SoftwareResidueKind
  level: SoftwareResidueLevel
  /** 服务名 / 驱动名 / 任务名 / 进程名 / 目录名 */
  label: string
  /** 判定依据，直接展示给用户 */
  detail: string
  path: string
  company: string
  product: string
  /** 目录大小；非目录为 null */
  bytes: number | null
  /** 计划任务所在的容器路径（以 \ 结尾）；只有 task 项有 */
  taskPath?: string
  /** 服务/驱动的原始启动方式（Auto / Manual / Disabled / System 等），撤销时重建用 */
  startMode?: string
  /** 服务的显示名，撤销时重建用 */
  displayName?: string
  /** 采集时是否在运行 */
  running: boolean
  /** 处理它是否需要管理员权限 */
  admin: boolean
  /** 是否允许清理（确定级的服务/计划任务/空目录）；主进程计算，界面只读 */
  cleanable: boolean
}

export interface SoftwareResidueScanResult {
  items: SoftwareResidueItem[]
  scannedAt: number
  /** 没扫成的部分（例如 PowerShell 报错），给用户看的说明 */
  warnings: string[]
}

/* ---------- 软件残留清理（SPEC-space-residue-cleanup） ---------- */

export interface ResidueCleanupItemResult {
  id: string
  label: string
  ok: boolean
  /** 单项说明：删掉了 / 跳过了 / 为什么失败 */
  message: string
}

export interface ResidueCleanupRunResult {
  ok: boolean
  /** 用户取消了 UAC，什么都没动 */
  canceled: boolean
  items: ResidueCleanupItemResult[]
  warnings: string[]
  /** 备份目录；没执行时为 '' */
  backupDir: string
  scan: SoftwareResidueScanResult
}

/** 软件残留的一批备份：`residue-backup/residue-<时间戳>-<随机>` 下的一个目录 */
export interface ResidueCleanupBackup {
  id: string
  createdAt: number
  count: number
  /** 前几项的显示名，给摘要用 */
  labels: string[]
  /** 已经撤销过 */
  restored: boolean
}

export interface ResidueUndoResult {
  ok: boolean
  canceled: boolean
  restored: number
  warnings: string[]
  scan: SoftwareResidueScanResult
  /** 操作的批次；编号无效时为空 */
  backupId: string
  backups: ResidueCleanupBackup[]
}

export interface ResidueDiscardBackupResult {
  ok: boolean
  warnings: string[]
  backups: ResidueCleanupBackup[]
}

/* ---------- 系统清理（需要管理员，SPEC-space-admin-cleanup） ---------- */

export type AdminCleanupId =
  | 'win-update-cache'
  | 'win-temp'
  | 'wer-system'
  | 'delivery-optimization'

/** 需要管理员权限的一项；known=false 表示不提权看不到大小 */
export interface AdminCleanupItem {
  id: AdminCleanupId
  label: string
  hint: string
  bytes: number
  known: boolean
  defaultChecked: boolean
}

export interface AdminCleanupScanResult {
  items: AdminCleanupItem[]
  scannedAt: number
}

export interface AdminCleanupRunItem {
  id: AdminCleanupId
  label: string
  /** 这一项释放了多少；没统计到就是 0 */
  freedBytes: number
  /** 提权脚本是否拿到了清理前后的大小（传递优化缓存的接口失败时为 false） */
  measured: boolean
}

export interface AdminCleanupRunResult {
  ok: boolean
  /** 用户拒绝了 UAC：什么都没删 */
  canceled: boolean
  /** 各项「清理前 − 清理后」之和；没统计到的项算 0 */
  freedBytes: number
  /** 逐项结果，界面用它说明哪几项没统计到大小 */
  items: AdminCleanupRunItem[]
  warnings: string[]
  scan: AdminCleanupScanResult
}

/**
 * 可选的桌宠皮肤 id（SPEC-deskpet-skin）。
 *
 * 为什么放在 shared 而不是渲染层：主进程 prefsStore 要在落盘前校验这个值
 * （`prefs:set` 收到的 payload 是渲染层传来的任意值），主进程 import 不到渲染层的
 * 皮肤模块，所以 id 清单必须落在两边都能引用的 shared 里。
 * 新增皮肤时要同时改这里和 `src/renderer/src/pet/index.tsx` 的清单。
 * ⚠️ 已落盘的 id 不能改：改了等于所有用户的选择静默丢失。
 */
export const PET_SKIN_IDS = ['capsule', 'bean', 'photo'] as const
export type PetSkinId = (typeof PET_SKIN_IDS)[number]

/**
 * 桌宠出现模式（SPEC-deskpet-skin / SPEC-deskpet-out / SPEC-deskpet-walk）。
 * island=只在岛里、window=独立小窗口（SPEC-deskpet-out 已实现）、
 * free=自由走动（SPEC-deskpet-walk 已实现，在独立窗口里横向溜达、走一段停一段）。
 * 三个值都生效，设置页三档都可选。
 */
export const PET_MODES = ['island', 'window', 'free'] as const
export type PetMode = (typeof PET_MODES)[number]

/**
 * 全屏避让策略（SPEC-avoid-mode-and-latency）。
 *
 * maximized=前台窗口最大化或真全屏都隐藏岛（默认，等于历史行为）；
 * fullscreen=只有真全屏才隐藏，最大化窗口保留岛；
 * off=一律不隐藏。
 *
 * 为什么放在 shared：主进程 prefsStore 落盘前要校验这个值（`prefs:set` 的 payload
 * 是渲染层传来的任意值），设置窗口也要按同一份清单渲染三档。
 * ⚠️ 已落盘的值不能改名，否则用户的选择会静默丢失。
 */
export const AVOID_MODES = ['maximized', 'fullscreen', 'off'] as const
export type AvoidMode = (typeof AVOID_MODES)[number]

/**
 * 桌宠独立小窗口的位置（SPEC-deskpet-out）。
 *
 * 为什么记 x/y 而不是「右下角 + 偏移」：用户把它拖到哪就该回到哪，
 * 记绝对坐标最直接。多显示器拔掉导致坐标越界时，由主进程 clamp 回工作区，
 * 所以这里不做「第几块屏」的记录（见 SPEC 第六节）。
 */
export interface PetWindowPos {
  x: number
  y: number
}

/** 设置窗口「常规」页要显示的本机信息 */
export interface AppInfo {
  /** package.json 的 version（打包版显示安装版本，dev 下是工程版本） */
  version: string
  /** 用户数据目录绝对路径（%APPDATA%\lingdong-island） */
  userData: string
}

/**
 * 音乐页要显示的一份播放快照（SPEC-music-page）。
 * 数据来自 Windows SMTC（系统媒体传输控制），由 `src/main/musicStore.ts` 每秒采一次，
 * 只有字段真的变了才广播，避免渲染层每秒重渲染。
 */
/**
 * 音乐页「音源」列表里的一项（SPEC-music-source-picker）。
 * 只包含当前挂着音频会话、且能读到窗口标题的进程；OBS/剪映等黑名单进程不在内。
 */
export interface MusicSource {
  /** 进程名，例如 `cloudmusic.exe` */
  exe: string
  /** 给人看的名字：已知播放器用中文名，其它应用用进程名（去扩展名） */
  name: string
  /** 是否正在出声（这一帧音频会话 state=1） */
  playing: boolean
}

export interface MusicState {
  /** 有没有可用的媒体会话；false 时其余字段都是空的，音乐页显示空态 */
  active: boolean
  /** 歌名（SMTC 的 Title，可能是文件名，播放器给什么就是什么） */
  title: string
  /** 歌手；很多本地文件没有标签，会是空串 */
  artist: string
  /** 专辑名；同上，可能为空 */
  album: string
  /** 当前播放位置（秒）；读不到时是 0 */
  position: number
  /** 总时长（秒）；流媒体/直播可能为 0 */
  duration: number
  /** 是否正在播放（暂停时为 false） */
  playing: boolean
  /** 播放器进程名，例如 `PotPlayerMini64.exe`；用于让用户知道是谁在放 */
  app: string
  /** 当前是否随机播放（来自 SMTC PlaybackInfo.IsShuffleActive） */
  shuffle: boolean
  /** 循环模式：0=不循环 / 1=单曲循环 / 2=列表循环（来自 SMTC AutoRepeatMode） */
  repeat: number
  /** 当前播放应用的音频会话音量 0..1（Core Audio ISimpleAudioVolume；对不上号时为 0 且 canVolume=false） */
  volume: number
  /** 当前会话是否支持拖进度（Controls.IsPlaybackPositionEnabled） */
  canSeek: boolean
  /** 当前会话是否支持随机（Controls.IsShuffleEnabled） */
  canShuffle: boolean
  /** 当前会话是否支持循环（Controls.IsRepeatEnabled） */
  canRepeat: boolean
  /** 是否成功对上当前播放应用的音频会话；false 时音量滑块置灰、不读写任何音量 */
  canVolume: boolean
  /** 当前歌曲的真实封面（data:image/png;base64,... 或 data:image/jpeg;base64,...）；取不到为空串，界面回落音符占位 */
  cover: string
  /**
   * 播放器窗口里那条进度条的已播比例 0..1；-1 表示没读到（用户 m07228）。
   *
   * 为什么要它：网易云（cloudmusic）实现了 SMTC 的歌名/歌手/封面，却把
   * IsPlaybackPositionEnabled 设为 false、Position/EndTime 恒 0、LastUpdatedTime 是
   * 1601-01-01，TryChangePlaybackPositionAsync 会返回 true 但什么都不做。这种情况下
   * SMTC 里没有任何真实进度可用，只能去它的窗口里看它自己画的那条进度条（已播段有颜色、
   * 未播段是灰的），用 PrintWindow 离屏读像素算出比例。
   */
  barPct: number
  /**
   * 能不能用「点播放器窗口里的进度条」来定位（barPct >= 0 即 true）。
   *
   * true 时渲染层允许拖进度条，但走的是 `{cmd:'barseek'}` 这条窗口点击通道，
   * 而不是 SMTC 的 seek——后者对这类播放器是谎言（返回成功、位置不动）。
   */
  barOk: boolean
  /**
   * 是否已连上网易云的调试接口（CDP，Chromium DevTools 协议）。
   *
   * true 时进度、时长、seek、播放键全部由它直接操作网易云页面，**不需要网易云窗口
   * 显示在桌面上**，也完全不依赖像素识别。false 且当前播放器是网易云时，界面会给出
   * 「一键重启开启」的入口——调试端口只能在网易云启动时打开。
   */
  neteaseCdp: boolean
  /** 正在重启网易云以开启调试接口，界面据此显示「正在重启…」并禁用按钮 */
  neteaseCdpBusy: boolean
  /** 网易云进程是否在运行（不依赖它是不是当前播放器），用于决定是否显示开启入口 */
  neteaseRunning: boolean
  /**
   * 网易云后台控制策略（SPEC-netease-cdp-mode）：
   * auto=端口缺失时自动重启；manual=只在音乐页提示、用户点了才重启；
   * off=不重启也不提示。缺失按 auto 处理。
   */
  neteaseCdpMode: NeteaseCdpMode
  /**
   * 网易云桌面歌词是否开着（读它页面里的 desktop-lyric 按钮状态）。
   * null = 没有 CDP 或读不到（界面不据此做「关闭」动作）。
   */
  desktopLyric: boolean | null
  /** 当前所有可选音源（音源选择器）；桥接未启动 / 读不到时为空数组 */
  sources: MusicSource[]
  /** 用户锁定的音源（小写进程名，如 `cloudmusic`）；'' = 自动跟随播放 */
  pinnedExe: string
  /** 锁定的音源当前没在运行；界面据此显示「未运行」，不自动换源 */
  pinnedMissing: boolean
}

/** 时钟显示档位（SPEC-clock-date-format）：仅时间 / 日期+时间 / 日期+星期+时间 */
export type ClockFormat = 'time' | 'date' | 'dateWeek'
export const CLOCK_FORMATS: ClockFormat[] = ['time', 'date', 'dateWeek']

/**
 * 岛的主题（SPEC-island-themes）。
 * glass-light=亮色乳白玻璃（默认，用户 2026-11-24 选定）／glass-dark=纯黑玻璃／
 * mono=纯黑极简／glass-clear=透明玻璃（SPEC-glass-clear，2026-11-25 新增，玻璃不染色）。
 * 值直接作为 `<html data-theme>` 的取值，渲染层的 CSS 按它取变量。
 * ⚠️ 已落盘的值不能改名，否则用户的选择会静默丢失。
 */
export const ISLAND_THEMES = ['glass-light', 'glass-dark', 'mono', 'glass-clear'] as const
export type IslandTheme = (typeof ISLAND_THEMES)[number]

/** 网易云后台控制的三档策略（SPEC-netease-cdp-mode） */
export type NeteaseCdpMode = 'auto' | 'manual' | 'off'

/**
 * 音乐控制命令（渲染层 → 主进程 → SMTC）。
 * 纯文本命令沿用桥接脚本原有的行协议；带参数的新命令用一行 JSON 传输。
 * 见 docs/Spec/SPEC-music-controls.md「控制命令（混合行协议，最小改动）」。
 */
export type MusicCommand =
  | 'toggle'
  | 'next'
  | 'prev'
  | { cmd: 'seek'; value: number }
  | { cmd: 'shuffle'; value: boolean }
  | { cmd: 'repeat'; value: 0 | 1 | 2 }
  | { cmd: 'volume'; value: number }
  /**
   * 通过「点播放器窗口里的进度条」定位（用户 m07228）。
   * value 是目标位置占整首的比例 0..1，不是秒——因为算不出秒：播放器根本不报时长，
   * 我们手上的时长来自歌词库，它跟播放器的真实时长可能差几秒，用它换算成秒再点会偏。
   * 直接用比例点，播放器自己按它的真实时长换算。
   */
  | { cmd: 'barseek'; value: number }
  /**
   * 重启网易云并带调试端口，开启后台精确控制（用户 m0xxxx「网易云必须显示才能控」）。
   * 会让网易云中断几秒；成功后进度/seek 不再依赖窗口可见。
   */
  | { cmd: 'netease-enable' }

/**
 * 歌词（SPEC-music-lyric）。
 *
 * 为什么不从播放器里直接读：Windows SMTC（System Media Transport Controls，系统媒体
 * 传输控制）只暴露 歌名/歌手/专辑/进度/时长/播放状态/封面，**没有歌词字段**；
 * 汽水音乐的本地缓存是私有压缩二进制（`LUNA` 头），解不开也随版本失效。
 * 所以歌词要另外去 lrclib.net（公开免费、无需 key）按 歌名+歌手+专辑+时长 查。
 */
export interface LyricLine {
  /** 这一句开始的时间（秒，从 0 起算） */
  time: number
  /** 这一句的文本；时间标记后面没字的行会被解析阶段丢掉，不会出现空串 */
  text: string
}

/** 歌词查询结果：拿到就 ok=true 且 lines 非空；拿不到就给一句具体原因，绝不编造 */
export interface LyricResult {
  /** 是否拿到了带时间轴的歌词行 */
  ok: boolean
  /** 查询用的曲名（回显，便于排查对错了歌） */
  title: string
  /** 查询用的歌手 */
  artist: string
  /** 来源：cache=本地缓存命中、netease=网易云、lrclib=备用库、none=没拿到 */
  source: 'cache' | 'netease' | 'lrclib' | 'none'
  /** 歌词行，按时间升序；ok=false 时为空数组 */
  lines: LyricLine[]
  /** ok=false 时给用户看的一句话原因（如「没搜到这首歌」「纯音乐」），界面直接显示它 */
  reason: string
  /**
   * 这首歌的真实总时长（秒），来自歌词库那条记录。
   *
   * 为什么需要：网易云（cloudmusic.exe）不往系统媒体接口写时间轴，拿到的 duration 恒为 0，
   * 进度条就算不出来（用户 m05794「你用这个我怎么看播放时间」）。
   * 歌词库里同一条记录带准确时长，正好补上这个缺口。
   */
  duration?: number
}

/** 歌词查询入参（渲染层把当前播放快照里的这四个字段发过去） */
export interface LyricQuery {
  title: string
  artist: string
  album: string
  /** 总时长（秒）；用来排除同名不同版本（差 8 秒以上基本不是同一版） */
  duration: number
}

/**
 * 自动更新状态（SPEC-auto-update）。主进程维护唯一一份，设置页订阅广播。
 *
 * 设计要点：只有一个单向状态机，渲染层不自己推断「有没有新版」，
 * 避免「按钮说能更、实际没有下载文件」这类状态漂移。
 */
export type UpdateStage =
  /** 还没检查过 */
  | 'idle'
  /** 正在检查 */
  | 'checking'
  /** 已是最新 */
  | 'none'
  /** 发现新版本，等用户点下载 */
  | 'available'
  /** 正在下载 */
  | 'downloading'
  /** 用户暂停了下载（继续会从头开始，electron-updater 不支持断点续传） */
  | 'paused'
  /** 下载完成，等用户点重启安装 */
  | 'ready'
  /** 检查或下载失败 */
  | 'error'
  /** 当前形态不支持（开发版未打包） */
  | 'unsupported'

export interface UpdateState {
  stage: UpdateStage
  /** 当前已安装版本（app.getVersion()） */
  current: string
  /** 可用的新版本号（stage=available/downloading/ready 时有值） */
  version?: string
  /** 下载进度 0–100（stage=downloading/ready 时有值） */
  percent?: number
  /** 最近一次完成检查的时间戳（毫秒），用于显示「几点检查的」 */
  checkedAt?: number
  /** 失败或不可用原因（中文短语，界面直接显示） */
  message?: string
  /** 原始错误文本，只用于排查 */
  detail?: string
}
