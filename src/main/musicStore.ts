import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SMTC_SCRIPT } from './smtcScript'
import {
  clickNetease,
  enableNeteaseDebugPort,
  fetchNeteaseCover,
  isNeteaseCdpReady,
  isNeteaseRunning,
  readNeteaseState,
  seekNetease,
  setNeteaseDesktopLyric,
  type NeteaseCdpState
} from './neteaseCdp'
import { startupLog } from './startupLog'
import { getPrefs, normalizeExeName, onPrefsWritten, patchPrefs } from './prefsStore'
import type { MusicCommand, MusicSource, MusicState, NeteaseCdpMode } from '../shared/types'

/**
 * 音乐页数据源（SPEC-music-page / US-031）。
 *
 * 为什么不接第三方播放器 API：Windows 自带 SMTC（System Media Transport Controls，
 * 系统媒体传输控制——任何播放器只要实现了它，系统「正在播放」里就能看到，
 * 媒体键也就能控制）。读这一层不绑死任何一家播放器，也不会被某家改接口打断。
 *
 * 为什么是一个常驻 PowerShell 子进程而不是每秒起一个：
 * 实测单次 `powershell.exe` 启动约 755ms，每秒起进程既卡又费内存；
 * 常驻后单次往返约 19ms。代价是常驻进程约占 50MB 内存，所以**懒启动**：
 * 只有渲染层第一次要数据（也就是用户翻到音乐页）时才把子进程拉起来。
 *
 * 为什么脚本要落盘成 .ps1 而不是 `-EncodedCommand`：
 * PS 5.1 用 -EncodedCommand 时，脚本里的反引号与 CLIXML 进度流会让
 * `[System.WindowsRuntimeSystemExtensions]` 的反射查找失败。落盘还有一个好处：
 * 出问题时可以直接拿这个文件手跑一遍定位。
 */

const POLL_MS = 1000
/** 子进程无响应超时：超过这个时间没有任何回包就重拉，避免界面卡死在旧数据上 */
const STALE_MS = 5000

/**
 * 网易云自动开启调试端口（SPEC-netease-auto-cdp）。
 * 调试端口只能在进程启动时打开，用户普通重开/更新网易云后端口就没了；
 * 这里在「网易云在跑但端口没开」持续一小段时间后自动重启一次，省掉手动点按钮。
 */
const AUTO_CDP_DELAY_MS = 1500
/** 两次自动尝试之间的硬性间隔（成功也算）：网易云自身重启时端口会短暂消失，避免连续重启它 */
const AUTO_CDP_RETRY_MS = 60_000
/** 连续失败上限；超过后不再自动尝试，等网易云重启或用户手动点 */
const AUTO_CDP_MAX_FAILS = 3
/** e2e 用：scripts/isolate-userdata.mjs 会置 1，避免测试重启用户真实的网易云 */
const AUTO_CDP_DISABLED = process.env.ISLAND_NO_NETEASE_AUTO === '1'

const EMPTY_STATE: MusicState = {
  active: false,
  title: '',
  artist: '',
  album: '',
  position: 0,
  duration: 0,
  playing: false,
  app: '',
  shuffle: false,
  repeat: 0,
  volume: 0,
  canSeek: false,
  canShuffle: false,
  canRepeat: false,
  canVolume: false,
  cover: '',
  barPct: -1,
  barOk: false,
  neteaseCdp: false,
  neteaseCdpBusy: false,
  neteaseRunning: false,
  neteaseCdpMode: 'auto',
  desktopLyric: null,
  sources: [],
  pinnedExe: '',
  pinnedMissing: false
}

let child: ChildProcessWithoutNullStreams | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 当前对外状态（桥接 + CDP 合并后的结果）；music:get 直接返回它 */
let cache: MusicState = { ...EMPTY_STATE }
/** 桥接子进程最近一次报的原始状态 */
let bridgeState: MusicState = { ...EMPTY_STATE }
/** 网易云 CDP 最近一次读到的状态；null = 没连上（端口没开 / 进程没起） */
let cdpState: NeteaseCdpState | null = null
/** CDP 拿到的封面（data URL）及其对应的歌，免每秒重复下载 */
let cdpCover = ''
let cdpCoverKey = ''
/**
 * 封面请求状态（用户 2026-11-19「网易云切歌时有时封面加载不出来」）：
 * 原来只在换歌那一刻抓一次，超时/网络抖一下就整首空白。现在同一首没拿到就重试，
 * 最多 6 次；换歌重置。
 */
let cdpCoverAt = 0
let cdpCoverTries = 0
let cdpCoverBusy = false
let cdpTimer: ReturnType<typeof setInterval> | null = null
let cdpPolling = false
let cdpBusy = false
let neteaseRunning = false
/**
 * 网易云后台控制档位（SPEC-netease-cdp-mode）：auto=自动重启 / manual=只提示 /
 * off=不重启也不提示。启动时从 prefs 读，设置窗口改动经 onPrefsWritten 热更新。
 */
let cdpMode: NeteaseCdpMode = 'auto'
/** 自动开启状态机：首次发现「在跑但没端口」的时间；0 = 条件不成立 */
let autoCdpNoPortSince = 0
/** 最近一次自动尝试的时间（冷却用） */
let autoCdpLastAt = 0
/** 连续失败次数 */
let autoCdpFails = 0
/**
 * 最近一次从 CDP 读到的「是否在播」。
 * 自动重启发生时 cdpState 已经被轮询置空，桥接又认不出网易云（它不注册 SMTC），
 * 只靠 cache.playing 会丢掉「重启前在播」，导致重启后停在暂停态。
 */
let lastCdpPlaying = false
let lastCdpPlayingAt = 0
/** 重启后用它判断「重启前在播」；窗口太短会在慢机器上失效，太长会把很久前的状态当现在 */
const AUTO_RESUME_WINDOW_MS = 60_000
/** 网易云进程自己的音频会话音量（0..1）；null=没读到（界面置灰） */
let neteaseVol: number | null = null
/**
 * 用户锁定的音源（小写进程名、不带 .exe；SPEC-music-source-strategy）。
 * '' = 自动跟随播放。启动时从 prefs 读，选择器改动经 onPrefsWritten 热更新。
 */
let pinExe = ''
/** 用户在音源选择器里点选过的播放器（= prefs.musicKnownPlayers），同步给桥接当软白名单 */
let knownPlayers: string[] = []
/** 桥接报的「锁定目标进程还活着」；用来区分「未运行」和「在跑但没歌」 */
let pinAlive = false
/** 最近一次收到任何回包的时间（毫秒），用于判断子进程是不是挂了 */
let lastAliveAt = 0
/** 子进程正在启动（避免重复 spawn） */
let starting = false
/** 应用正在退出时不要再重拉子进程 */
let stopping = false

/**
 * 把脚本写到 userData 下的固定文件名，UTF-8 **带 BOM**。
 * BOM 不是可选项：不带 BOM 时 PS 5.1 按系统 ANSI 解码脚本里的中文注释，
 * 类型名会被解坏，报「找不到类型 [System.Runtime.WindowsRuntimeSystemExtensions]」。
 */
function writeBridgeScript(): string {
  const dir = join(app.getPath('userData'), 'music')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'smtc-bridge.ps1')
  // writeFileSync 的 'utf8' 不写 BOM，所以这里手动拼一个 UTF-8 BOM 头（EF BB BF）
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  writeFileSync(file, Buffer.concat([bom, Buffer.from(SMTC_SCRIPT, 'utf8')]))
  return file
}

/** 把一份状态推给所有还活着的窗口（与 prefsStore / statusStore 同模式） */
function broadcast(s: MusicState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // 已销毁的窗口（设置窗口关掉、全屏避让的 4px 边缘窗）必须先判，否则 send 抛异常
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('music:state', s)
  }
}

/**
 * 封面缓存（SPEC-music-source-picker 衍生问题）。
 *
 * 桥接只在「换歌」时发完整封面，其余帧发 null 表示沿用。切换音源时中间会经过
 * 另一播放器的状态（网易云降级路径固定发 cover=""），把主进程里那张封面冲掉；
 * 切回来时桥接又判断「这首歌没变、不重发」，封面就再也回不来了（用户 2026-11-19 截图：
 * 锁定汽水后封面一直是音符占位）。这里按「应用|歌名|歌手|专辑」留住最近一张，
 * 只有键完全一致时才恢复，避免把上一首/上一播放器的封面张冠李戴。
 */
const COVER_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/
let lastCoverKey = ''
let lastCoverData = ''

function coverKeyOf(msg: Record<string, unknown>): string {
  return [msg.app, msg.title, msg.artist, msg.album].map((v) => String(v ?? '')).join('|')
}

/** 把桥接回包的 cover 字段解析成渲染层可用的 data URL（空串 = 这首确实没封面） */
function resolveCover(msg: Record<string, unknown>): string {
  if (!Boolean(msg.active)) return ''
  const raw = msg.cover
  if (raw === null || raw === undefined) {
    // 桥接说「这首歌没变、不重发」：只有缓存里正是同一首才恢复；
    // 对不上说明缓存丢了，宁可不显示也不要拿别的歌/别的播放器的封面顶上。
    const key = coverKeyOf(msg)
    return key === lastCoverKey ? lastCoverData : ''
  }
  if (typeof raw === 'string' && COVER_RE.test(raw)) {
    lastCoverKey = coverKeyOf(msg)
    lastCoverData = raw
    return raw
  }
  // 桥接明确发了 ""：这首歌没有封面（或换了歌还没取到），不能沿用上一首的
  return ''
}

/** 收桥接回来的 sources（音源选择器数据）；坏条目直接丢，坏一条不影响其它 */
function parseSources(raw: unknown): MusicSource[] {
  if (!Array.isArray(raw)) return []
  const out: MusicSource[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const exe = typeof r.exe === 'string' ? r.exe : ''
    if (!exe) continue
    out.push({
      exe,
      name: typeof r.name === 'string' && r.name !== '' ? r.name : exe.replace(/\.exe$/i, ''),
      playing: r.playing === true
    })
  }
  return out
}

/** 音源列表按顺序逐项比（名字、在播状态都算变化），顺序由桥接固定，不会来回抖 */
function sameSources(a: MusicSource[], b: MusicSource[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].exe !== b[i].exe || a[i].name !== b[i].name || a[i].playing !== b[i].playing) return false
  }
  return true
}

function sameState(a: MusicState, b: MusicState): boolean {
  return (
    a.active === b.active &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.playing === b.playing &&
    a.app === b.app &&
    a.shuffle === b.shuffle &&
    a.repeat === b.repeat &&
    a.volume === b.volume &&
    a.canSeek === b.canSeek &&
    a.canShuffle === b.canShuffle &&
    a.canRepeat === b.canRepeat &&
    a.canVolume === b.canVolume &&
    a.cover === b.cover &&
    a.neteaseCdp === b.neteaseCdp &&
    a.neteaseCdpBusy === b.neteaseCdpBusy &&
    a.neteaseRunning === b.neteaseRunning &&
    a.neteaseCdpMode === b.neteaseCdpMode &&
    a.desktopLyric === b.desktopLyric &&
    a.pinnedExe === b.pinnedExe &&
    a.pinnedMissing === b.pinnedMissing &&
    sameSources(a.sources, b.sources) &&
    // 只比 barOk（以及两档精度下的 barPct），不比逐位 barPct：正常播放器 barPct 恒 -1，
    // 比对是空操作；只有降级路径（播放器不报时间轴、position 恒 0）才靠 barPct 变化
    // 触发广播——那种情况若也不广播，界面就永远拿不到新的进度，钟也就没法校准。
    a.barOk === b.barOk &&
    Math.round(a.barPct * 100) === Math.round(b.barPct * 100) &&
    // 进度按整秒比：SMTC 给的是带小数的秒，每毫秒都在变，逐位比会每秒重渲染
    Math.round(a.position) === Math.round(b.position) &&
    Math.round(a.duration) === Math.round(b.duration)
  )
}

/** 收一行子进程输出：state 更新缓存并（真变了才）广播；ack / ready 只记时间 */
function handleLine(text: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(text) as Record<string, unknown>
  } catch {
    return // 非 JSON 行（PS 的杂项输出）直接忽略
  }
  lastAliveAt = Date.now()
  // 桥接脚本启动完（类型都加载好了）再同步「已知播放器 / 锁定」，避免命令打在初始化之前
  if (msg.type === 'ready') {
    syncBridgeConfig()
    return
  }
  if (msg.type === 'error') {
    // 桥接脚本里的异常（读媒体属性失败等）：打到控制台留证，界面这一轮不发空态以外的变化
    console.warn('[music] 桥接报错：', String(msg.msg ?? '').slice(0, 300))
    return
  }
  // 按进程读回来的音量（CDP 控制网易云时用；最小化后没有 SMTC 会话也能读）
  if (msg.type === 'ack' && msg.cmd === 'appvol') {
    const v = Number(msg.value)
    const next = Number.isFinite(v) && v >= 0 ? Math.min(1, v) : null
    if (next !== neteaseVol) {
      neteaseVol = next
      recompute()
    }
    return
  }
  if (msg.type !== 'state') return
  // 锁定目标进程是否活着（桥接按 focus 算的）；空态回包里也会带
  pinAlive = msg.pinAlive === true
  const next: MusicState = {
    active: Boolean(msg.active),
    title: String(msg.title ?? ''),
    artist: String(msg.artist ?? ''),
    album: String(msg.album ?? ''),
    position: Number(msg.position ?? 0) || 0,
    duration: Number(msg.duration ?? 0) || 0,
    playing: Boolean(msg.playing),
    app: String(msg.app ?? ''),
    shuffle: Boolean(msg.shuffle),
    repeat: Math.min(2, Math.max(0, Number(msg.repeat ?? 0) || 0)),
    volume: Math.min(1, Math.max(0, Number(msg.volume ?? 0) || 0)),
    canSeek: Boolean(msg.canSeek),
    canShuffle: Boolean(msg.canShuffle),
    canRepeat: Boolean(msg.canRepeat),
    canVolume: Boolean(msg.canVolume),
    // 播放器窗口里进度条的已播比例（用户 m07228）。-1 = 没读到；只在播放器压根不报
    // 时长时桥接才会去读它，正常播放器一直是 -1。
    // 注意别用 `Number(x) || 0`：-1 是有效值（表示没读到），NaN 才该落到 -1。
    barPct: (() => {
      const n = Number(msg.barPct)
      if (!Number.isFinite(n) || n < 0) return -1
      return Math.min(1, n)
    })(),
    barOk: Boolean(msg.barOk),
    // 封面：桥接只在「换歌」时回传完整 data URL（或 "" 表示这张没封面）；
    // 未换歌时回 null，沿用缓存。缓存按歌曲存（见 resolveCover），切音源再来回切也不会丢。
    cover: resolveCover(msg),
    // 桥接原始状态不带这两个字段，合并时由 recompute() 统一决定
    neteaseCdp: false,
    neteaseCdpBusy: false,
    neteaseRunning: false,
    neteaseCdpMode: cdpMode,
    desktopLyric: null,
    // 音源列表由桥接每帧给全量；锁定字段由 recompute() 统一决定
    sources: parseSources(msg.sources),
    pinnedExe: pinExe,
    pinnedMissing: false
  }
  bridgeState = next
  recompute()
}

/** 进程名归一：桥接/系统给的可能是 `cloudmusic.exe`，锁定值统一是小写无扩展名 */
function exeOf(app: string): string {
  return app.trim().toLowerCase().replace(/\.exe$/, '')
}

/** 音源显示名（与桥接 / 渲染层同一套）；未知进程直接用进程名 */
const SOURCE_NAMES: Record<string, string> = {
  cloudmusic: '网易云音乐',
  qqmusic: 'QQ 音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  spotify: 'Spotify',
  potplayermini64: 'PotPlayer',
  potplayermini: 'PotPlayer',
  // 汽水音乐：进程 SodaMusic.exe，SMTC 的 AUMID 是中文「汽水音乐」（2026-11-19 实测）
  '汽水音乐': '汽水音乐',
  sodamusic: '汽水音乐'
}

function sourceLabel(app: string): string {
  const key = exeOf(app)
  return SOURCE_NAMES[key] ?? (key || app)
}

/** 同一应用可能有两种身份（进程名 / SMTC 的中文应用名），按显示名认定为同一个 */
function sameSource(a: string, b: string): boolean {
  if (!a || !b) return false
  if (exeOf(a) === exeOf(b)) return true
  return sourceLabel(a).toLowerCase() === sourceLabel(b).toLowerCase()
}

/**
 * 把选择器点选的标识解析成可锁定的进程名。
 *
 * 正常情况下传进来就是进程名（SodaMusic.exe）；但 SMTC 可能只暴露中文应用名
 * （汽水音乐实测 AUMID 就是「汽水音乐」），这种标识不能直接当进程名用——
 * 先在当前 sources 里找同名项，再按内置显示名反查。
 */
function resolveSourceExe(raw: string): string {
  const direct = normalizeExeName(raw)
  if (direct) return direct
  const key = raw.trim().toLowerCase().replace(/\.exe$/, '')
  if (!key) return ''
  const hit = cache.sources.find((s) => exeOf(s.exe) === key || s.name.trim().toLowerCase() === key)
  const viaHit = hit ? normalizeExeName(hit.exe) : ''
  if (viaHit) return viaHit
  for (const [exe, name] of Object.entries(SOURCE_NAMES)) {
    if (name.toLowerCase() !== key) continue
    const n = normalizeExeName(exe)
    if (n) return n
  }
  return ''
}

/**
 * 合并桥接状态与网易云 CDP 状态，得到对外的一份快照。
 *
 * 选用规则：CDP 在播、或桥接那边没有在播、或桥接认出的就是网易云时用 CDP
 * （它给的位置/时长是网易云页面里真实的）。否则（比如汽水音乐在放、网易云只是暂停着）
 * 用桥接，避免把正在听的另一个播放器盖掉。
 */
function recompute(): void {
  const c = cdpState
  const pin = pinExe
  const pinnedNetease = pin === 'cloudmusic'
  const bridgeIsNetease = /cloudmusic/i.test(bridgeState.app)
  let next: MusicState
  // 「桥接里有别的东西 active」不能直接当真：实测 NxDock（Nexus.exe）会挂着一条
  // state=1 的音频会话却没有在放歌，标题也不像「歌名 - 歌手」。只有它**真的在播**时才让位；
  // 暂停的杂项应用不该把已经能精确控制的网易云盖掉。
  //
  // 锁定（SPEC-music-source-strategy）改变优先级：
  //  · 锁网易云：CDP 有就用（暂停也照样显示暂停态），不再看谁在播；
  //  · 锁别的播放器：一律不用 CDP，哪怕网易云正在播。
  const useCdp =
    c !== null && (pinnedNetease || (pin === '' && (c.playing || !bridgeState.playing || bridgeIsNetease)))
  if (c && useCdp) {
    const sameSong = bridgeState.title === c.title && c.title !== ''
    next = {
      ...bridgeState,
      active: true,
      title: c.title || bridgeState.title,
      artist: c.artist || bridgeState.artist,
      album: sameSong ? bridgeState.album : '',
      position: c.pos,
      duration: c.dur,
      playing: c.playing,
      app: 'cloudmusic.exe',
      canSeek: c.dur > 0,
      canShuffle: false,
      canRepeat: false,
      // 音量仍走按应用的音频会话。网易云最小化后没有主窗口标题，桥接的降级识别会跳过它，
      // 但它自己的音频会话还在——所以 CDP 生效时另用「按进程读音量」那条路（appvol），
      // 桥接能直接对上时优先用桥接的值。
      volume: bridgeIsNetease && bridgeState.canVolume ? bridgeState.volume : (neteaseVol ?? 0),
      canVolume: (bridgeIsNetease && bridgeState.canVolume) || neteaseVol !== null,
      cover: cdpCover || (sameSong ? bridgeState.cover : ''),
      // 有真实时间轴了，不再需要「读窗口像素 / 点窗口坐标」那套兜底
      barPct: -1,
      barOk: false,
      neteaseCdp: true,
      neteaseCdpBusy: cdpBusy,
      neteaseRunning: true,
      neteaseCdpMode: cdpMode,
      desktopLyric: c.desktopLyric
    }
  } else if (pin !== '' && !(bridgeState.active && sameSource(bridgeState.app, pin))) {
    // 锁定的音源不在桥接状态里（退出了 / 桥接还没认到它）：不回落到别人，
    // 直接给空态。pinnedMissing 由下面的统一计算决定，界面据此显示「未运行」。
    next = {
      ...EMPTY_STATE,
      neteaseCdpBusy: cdpBusy,
      neteaseRunning,
      neteaseCdpMode: cdpMode,
      sources: bridgeState.sources
    }
  } else {
    next = {
      ...bridgeState,
      neteaseCdp: false,
      neteaseCdpBusy: cdpBusy,
      neteaseRunning,
      neteaseCdpMode: cdpMode,
      desktopLyric: null
    }
  }
  next.pinnedExe = pin
  next.pinnedMissing = pin !== '' && !next.active && !pinAlive
  // 当前音源可能不在桥接的 sources 里（网易云暂停会撤掉音频会话，或桥接还没认到它）：
  // 选择器至少要能选到它，否则「锁定当前音源」无从下手。
  if (next.active && next.app) {
    // 按「同一应用」比而不是只比 exe：汽水音乐在 sources 里是 SodaMusic.exe、
    // 当前音源的 app 却是 SMTC 的中文 AUMID「汽水音乐」，只比 exe 会多出一行。
    if (!next.sources.some((s) => sameSource(s.exe, next.app))) {
      next.sources = [...next.sources, { exe: next.app, name: sourceLabel(next.app), playing: next.playing }]
    }
  }
  if (sameState(cache, next)) return
  cache = next
  broadcast(cache)
}

/**
 * 主进程内部专用的桥接命令：额外带 `exe`，按进程名直接操作音频会话。
 * 不放进 `MusicCommand`（渲染层不该能指定任意进程名）。
 */
type BridgeCommand =
  | MusicCommand
  | { cmd: 'known'; value: string[] }
  | { cmd: 'focus'; value: string }
  | { cmd: 'volume'; value: number; exe: string }
  | { cmd: 'appvol'; exe: string }

/**
 * 写一行命令到桥接子进程。
 * 纯文本命令（poll / toggle / next / prev / resync）沿用原行协议；
 * 带参数的新命令序列化成一行 JSON（见 SPEC-music-controls「混合行协议」）。
 */
function send(cmd: string | BridgeCommand): void {
  if (!child || !child.stdin.writable) return
  try {
    const line = typeof cmd === 'string' ? cmd : JSON.stringify(cmd)
    child.stdin.write(line + '\n')
  } catch {
    /* 管道已断：交给看门狗重拉 */
  }
}

/**
 * 把主进程的音源配置同步给桥接（SPEC-music-source-strategy）：
 * `known` = 选择器学到的已知播放器，`focus` = 当前锁定（'' 表示自动）。
 * 桥接每 frame 都靠这两个值决定「谁有资格被选中」，所以启动、重连、prefs 变化时都要发。
 */
function syncBridgeConfig(): void {
  send({ cmd: 'known', value: knownPlayers })
  send({ cmd: 'focus', value: pinExe })
}

/** IPC 边界的运行时校验：渲染层传来的东西不能原样拼进子进程 stdin */
function isValidCommand(cmd: unknown): cmd is MusicCommand {
  if (cmd === 'toggle' || cmd === 'next' || cmd === 'prev') return true
  if (!cmd || typeof cmd !== 'object') return false
  const c = cmd as Record<string, unknown>
  switch (c.cmd) {
    case 'seek':
      return typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0
    case 'shuffle':
      return typeof c.value === 'boolean'
    case 'repeat':
      return c.value === 0 || c.value === 1 || c.value === 2
    case 'volume':
      return typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0 && c.value <= 1
    case 'barseek':
      // 比例，不是秒：播放器不报时长，我们手上的时长来自歌词库，换算成秒会偏。
      return typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0 && c.value <= 1
    case 'netease-enable':
      return true
    default:
      return false
  }
}

/**
 * 拉一次网易云 CDP 状态。没开调试端口时 cdpState=null，对外自动回落桥接。
 * 每秒一次，和桥接轮询并行；CDP 单次往返通常不到 20ms。
 */
async function pollCdp(): Promise<void> {
  if (cdpPolling) return
  cdpPolling = true
  try {
    neteaseRunning = await isNeteaseRunning()
    const s = await readNeteaseState()
    cdpState = s
    if (s) {
      lastCdpPlaying = s.playing
      lastCdpPlayingAt = Date.now()
    }
    // 自动开启调试端口：只在「进程在跑、端口确实没开」时考虑；
    // 端口已开但页面还没加载出来不算（避免刚重启又被重启的死循环）。
    if (!AUTO_CDP_DISABLED) {
      if (!neteaseRunning || s !== null) {
        resetAutoCdp()
      } else if (await isNeteaseCdpReady()) {
        autoCdpNoPortSince = 0
      } else if (cdpMode === 'auto') {
        maybeAutoEnableCdp()
      } else {
        // manual / off：不自动重启。清零计时，免得从关闭切回自动时立刻触发一次
        autoCdpNoPortSince = 0
      }
    }
    // 最小化后网易云没有 SMTC 会话 / 主窗口标题，桥接的降级识别认不出它；
    // 但它的音频会话还在，所以按进程名单独读一次音量（1 秒一次）。
    if (neteaseRunning) send({ cmd: 'appvol', exe: 'cloudmusic.exe' })
    if (s) {
      neteaseRunning = true
      // 缓存键用封面地址，不用曲名：曲名解析失败（空串）时键会恒为 "|"，封面就永远
      // 停在第一首（2026-11-19 用户反馈）。地址跟着页面里的 <img> 走，换歌必变。
      const key = s.coverUrl || `${s.title}|${s.artist}`
      if (key !== cdpCoverKey) {
        cdpCoverKey = key
        cdpCover = ''
        cdpCoverTries = 0
        cdpCoverAt = 0
      }
      // 封面还没拿到（请求超时 / 网络抖动 / 刚换歌时地址还没就绪）时重试：前 3 次隔 3 秒，
      // 之后隔 10 秒，同一首歌最多 6 次。换歌会重置计数；成功后 cdpCover 非空，自然不再请求。
      const coverSpacing = cdpCoverTries < 3 ? 3000 : 10000
      if (
        s.coverUrl &&
        cdpCover === '' &&
        !cdpCoverBusy &&
        cdpCoverTries < 6 &&
        Date.now() - cdpCoverAt > coverSpacing
      ) {
        const url = s.coverUrl
        const keyAtStart = key
        cdpCoverTries += 1
        cdpCoverAt = Date.now()
        cdpCoverBusy = true
        void fetchNeteaseCover(url).then((data) => {
          cdpCoverBusy = false
          if (cdpCoverKey === keyAtStart && data) {
            cdpCover = data
            recompute()
          }
        })
      }
    }
    recompute()
  } finally {
    cdpPolling = false
  }
}

function startCdp(): void {
  if (cdpTimer !== null) return
  cdpTimer = setInterval(() => {
    void pollCdp()
  }, POLL_MS)
  void pollCdp()
}

/**
 * 重启网易云并开启调试端口。
 * 重启前正在播就恢复播放（网易云重启后会停在同一首歌的暂停态）。
 * 返回 true 表示端口/页面已就绪（不要求立刻读到最后一次播放状态）。
 */
async function enableCdp(): Promise<boolean> {
  if (cdpBusy) return false
  // 重启前是否在播：cdpState 在自动触发时已被轮询置空，桥接又认不出网易云，
  // 所以回落到最近一次 CDP 读数（60 秒内有效），最后才是桥接状态。
  const wasPlaying =
    cdpState?.playing ??
    (Date.now() - lastCdpPlayingAt < AUTO_RESUME_WINDOW_MS ? lastCdpPlaying : cache.playing)
  cdpBusy = true
  recompute()
  let ok = false
  try {
    ok = await enableNeteaseDebugPort()
    if (ok) {
      // 端口/页面就绪即算成功；进度控件可能晚几百毫秒，交给常规轮询补，
      // 避免网易云停在首页 / 没放歌时白等到 20 秒。
      let s = await readNeteaseState()
      if (!s) {
        await new Promise((r) => setTimeout(r, 400))
        s = await readNeteaseState()
      }
      // 需要恢复播放时多等一会儿：页面刚出来时播放栏可能还没渲染，读不到状态就点不到按钮。
      for (let i = 0; i < 10 && wasPlaying && !s; i += 1) {
        await new Promise((r) => setTimeout(r, 300))
        s = await readNeteaseState()
      }
      if (s) {
        cdpState = s
        lastCdpPlaying = s.playing
        lastCdpPlayingAt = Date.now()
        if (wasPlaying && !s.playing && !(await clickNetease('play'))) {
          startupLog('[music] 自动恢复播放失败：播放按钮没找到')
        }
      }
    }
  } catch (err) {
    console.warn('[music] 开启网易云精确控制失败：', err)
  } finally {
    cdpBusy = false
    await pollCdp()
  }
  if (!ok) console.warn('[music] 网易云调试端口未就绪（可能没在运行）')
  return ok
}

/**
 * 条件消失（网易云退出 / CDP 恢复）时清空「条件持续时长」与失败计数。
 * 故意不清 `autoCdpLastAt`：那是两次自动尝试之间的硬性间隔，
 * 成功也要遵守——网易云重启时端口会短暂消失，否则会连续重启它。
 */
function resetAutoCdp(): void {
  autoCdpNoPortSince = 0
  autoCdpFails = 0
}

/**
 * 条件满足足够久才触发：网易云刚启动/更新后页面要几秒才出来，
 * 太早判断会导致「刚拉起又被打断」。
 */
function maybeAutoEnableCdp(): void {
  if (cdpBusy) return
  if (autoCdpFails >= AUTO_CDP_MAX_FAILS) return
  const now = Date.now()
  if (autoCdpNoPortSince === 0) {
    autoCdpNoPortSince = now
    return
  }
  if (now - autoCdpNoPortSince < AUTO_CDP_DELAY_MS) return
  if (now - autoCdpLastAt < AUTO_CDP_RETRY_MS) return
  autoCdpLastAt = now
  void autoEnableCdp()
}

async function autoEnableCdp(): Promise<void> {
  startupLog(`[music] 自动开启网易云后台控制（第 ${autoCdpFails + 1} 次）：进程在跑但 9222 无页面`)
  const ok = await enableCdp()
  if (ok) {
    autoCdpFails = 0
    autoCdpNoPortSince = 0
    startupLog('[music] 自动开启成功')
  } else {
    autoCdpFails += 1
    startupLog(`[music] 自动开启失败（连续 ${autoCdpFails} 次）`)
  }
}

/** 执行一条控制命令；CDP 可用时直接操作网易云页面，否则走原来的桥接通道 */
async function applyControl(cmd: MusicCommand): Promise<boolean> {
  startBridge()
  startCdp()
  const useCdp = cache.neteaseCdp && cdpState !== null
  if (typeof cmd === 'string') {
    if (useCdp) {
      const ok = await clickNetease(cmd === 'toggle' ? 'play' : cmd)
      if (ok) {
        setTimeout(() => {
          void pollCdp()
        }, 250)
        return true
      }
    }
    send(cmd)
    return true
  }
  if (cmd.cmd === 'netease-enable') {
    void enableCdp()
    return true
  }
  if (cmd.cmd === 'volume' && useCdp) {
    // 直接按进程名找网易云的音频会话：不依赖桥接有没有把它认成当前播放器，
    // 也不要求窗口可见（最小化后它的 SMTC 会话/窗口标题都会消失）。
    send({ cmd: 'volume', value: cmd.value, exe: 'cloudmusic.exe' })
    setTimeout(() => send({ cmd: 'appvol', exe: 'cloudmusic.exe' }), 200)
    return true
  }
  if (cmd.cmd === 'seek' && useCdp && cdpState) {
    const ok = await seekNetease(cdpState.dur > 0 ? cmd.value / cdpState.dur : 0)
    if (ok) {
      setTimeout(() => {
        void pollCdp()
      }, 250)
      return true
    }
  }
  if (cmd.cmd === 'barseek' && useCdp) {
    const ok = await seekNetease(cmd.value)
    if (ok) {
      setTimeout(() => {
        void pollCdp()
      }, 250)
      return true
    }
  }
  send(cmd)
  return true
}

/** 杀掉子进程并清掉轮询（重启时也走这里） */
function killBridge(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const c = child
  child = null
  if (!c) return
  try {
    c.stdin.end()
  } catch {
    /* ignore */
  }
  try {
    c.kill()
  } catch {
    /* ignore */
  }
}

/** 启动常驻桥接子进程（幂等；已在运行则直接返回） */
function startBridge(): void {
  if (child || starting || stopping) return
  starting = true
  let ps1: string
  try {
    ps1 = writeBridgeScript()
  } catch (err) {
    starting = false
    console.error('[music] 写桥接脚本失败：', err)
    return
  }

  let c: ChildProcessWithoutNullStreams
  try {
    c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      windowsHide: true
    })
  } catch (err) {
    starting = false
    console.error('[music] 启动 PowerShell 失败：', err)
    return
  }

  child = c
  starting = false
  lastAliveAt = Date.now()

  let buf = ''
  c.stdout.setEncoding('utf8')
  c.stdout.on('data', (chunk: string) => {
    buf += chunk
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) handleLine(line)
      idx = buf.indexOf('\n')
    }
  })
  // stderr 不往界面甩（用户看不懂 CLIXML），只在诊断日志里留一行
  c.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8').trim()
    if (s) console.warn('[music] ps stderr:', s.slice(0, 400))
  })
  c.on('exit', () => {
    if (child === c) {
      child = null
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      // 非退出流程下的意外死亡：5 秒后再拉一次（播放器刚启动/系统媒体服务重启都可能触发）
      if (!stopping) setTimeout(() => startBridge(), 5000).unref?.()
    }
  })
  c.on('error', () => {
    if (child === c) {
      child = null
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  })

  pollTimer = setInterval(() => {
    // 子进程挂了或长时间没回包：重拉，别让界面停在旧歌上无限显示
    if (!child) return
    if (Date.now() - lastAliveAt > STALE_MS) {
      console.warn('[music] 桥接进程无响应，重启')
      killBridge()
      setTimeout(() => startBridge(), 1000).unref?.()
      return
    }
    send('poll')
  }, POLL_MS)

  // 先把音源配置（已知播放器 / 锁定）送进去，再要第一帧状态
  syncBridgeConfig()
  send('poll')
}

export function setupMusicStore(): void {
  // 网易云后台控制档位（SPEC-netease-cdp-mode）：启动读一次，之后跟着 prefs 广播热更新。
  const bootPrefs = getPrefs()
  cdpMode = bootPrefs.neteaseCdpMode ?? 'auto'
  // 音源锁定 / 已知播放器（SPEC-music-source-strategy）：同样启动读一次、随 prefs 热更新
  pinExe = normalizeExeName(bootPrefs.musicSourcePin ?? '')
  knownPlayers = bootPrefs.musicKnownPlayers ?? []
  onPrefsWritten((p) => {
    const next = p.neteaseCdpMode ?? 'auto'
    if (next !== cdpMode) {
      cdpMode = next
      autoCdpNoPortSince = 0
    }
    const nextPin = normalizeExeName(p.musicSourcePin ?? '')
    const nextKnown = p.musicKnownPlayers ?? []
    if (nextPin !== pinExe || JSON.stringify(nextKnown) !== JSON.stringify(knownPlayers)) {
      pinExe = nextPin
      knownPlayers = nextKnown
      // 桥接在跑就把新配置送过去；它没跑时下次启动会从 prefs 读同一份
      syncBridgeConfig()
    }
    // 档位/锁定决定音乐页显示什么，立刻推一帧，不用等下一次轮询
    recompute()
  })

  // CDP 轮询从启动就跑：自动开启网易云调试端口（SPEC-netease-auto-cdp）需要
  // 「进程在跑但没开端口」这个条件持续可见，不能等用户翻到音乐页才开始看。
  // 它只挂 1 秒定时器（tasklist 有 4 秒缓存、端口没开时 fetch 立即失败），
  // 不会拉起 50MB 的桥接子进程——那个仍然由 music:get 懒启动。
  startCdp()

  ipcMain.handle('music:get', (): MusicState => {
    // 首次调用（用户翻到音乐页）时懒启动子进程，避免没人用音乐页也常驻 50MB
    startBridge()
    startCdp()
    return cache
  })

  ipcMain.handle('music:control', async (_e, cmd: unknown): Promise<boolean> => {
    if (!isValidCommand(cmd)) return false
    return applyControl(cmd)
  })

  // 音源选择（SPEC-music-source-strategy）：null = 自动，进程名 = 锁定。
  // 点选即记住：把该进程加进「已知播放器」，以后它单独在播时也能自动显示。
  ipcMain.handle('music:set-source', (_e, exe: unknown): MusicState => {
    let next = ''
    if (typeof exe === 'string' && exe.trim() !== '') {
      next = resolveSourceExe(exe)
      // 解析不出进程名就直接忽略，绝不能当成「解除锁定」
      if (!next) return cache
    } else if (exe !== null && exe !== undefined) {
      return cache
    }
    startBridge()
    if (next === '') {
      patchPrefs({ musicSourcePin: '' })
      return cache
    }
    const known = getPrefs().musicKnownPlayers ?? []
    const nextKnown = known.includes(next) ? known : [...known, next].slice(0, 40)
    patchPrefs({ musicSourcePin: next, musicKnownPlayers: nextKnown })
    return cache
  })

  // 桌面歌词（SPEC-music-desktop-lyric）：「词」按钮第二态。
  // 没有 CDP 时返回 null，渲染层据此只做面板开合。
  ipcMain.handle('music:desktop-lyric', async (_e, on: unknown): Promise<boolean | null> => {
    // e2e 隔离：测试机上跑着用户真实的网易云，点「词」第二下不能真去开它的桌面歌词
    // （isolate-userdata.mjs 设置该变量，与 ISLAND_NO_NETEASE_AUTO 同一思路）。
    if (process.env.ISLAND_NO_DESKTOP_LYRIC === '1') return null
    if (typeof on !== 'boolean') return null
    const base = cdpState
    if (base === null) return null
    const v = await setNeteaseDesktopLyric(on)
    if (v !== null) {
      cdpState = { ...base, desktopLyric: v }
      recompute()
    }
    return v
  })
}

/** 退出时收摊（与 stopStatus / stopNotifyStore 同型） */
export function stopMusicStore(): void {
  stopping = true
  killBridge()
  if (cdpTimer !== null) {
    clearInterval(cdpTimer)
    cdpTimer = null
  }
  cdpState = null
  cdpBusy = false
  neteaseVol = null
  pinAlive = false
  lastCoverKey = ''
  lastCoverData = ''
  bridgeState = { ...EMPTY_STATE }
  cache = { ...EMPTY_STATE }
}
