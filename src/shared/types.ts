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
 * general=常规（自启/版本/数据目录）、pages=页面管理（US-032 能力搬过来）、focus=专注·喝水（占位）
 */
export type SettingsSection = 'general' | 'pages' | 'focus'

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
}

/** 音乐控制命令（渲染层 → 主进程 → SMTC） */
export type MusicCommand = 'toggle' | 'next' | 'prev'
