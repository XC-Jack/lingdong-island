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
 * general=常规（自启/版本/数据目录）、pages=页面管理（US-032 能力搬过来）、
 * focus=专注·喝水（占位）、pet=桌宠（SPEC-deskpet-skin）
 */
export type SettingsSection = 'general' | 'pages' | 'focus' | 'pet'

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
}

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
