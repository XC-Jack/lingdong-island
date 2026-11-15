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
  /** 系统主音量 0..1（来自 Core Audio IAudioEndpointVolume，不是单个播放器的音量） */
  volume: number
  /** 当前会话是否支持拖进度（Controls.IsPlaybackPositionEnabled） */
  canSeek: boolean
  /** 当前会话是否支持随机（Controls.IsShuffleEnabled） */
  canShuffle: boolean
  /** 当前会话是否支持循环（Controls.IsRepeatEnabled） */
  canRepeat: boolean
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
