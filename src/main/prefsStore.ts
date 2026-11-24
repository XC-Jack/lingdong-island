import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AVOID_MODES, CLOCK_FORMATS, ISLAND_THEMES, PET_MODES, PET_SKIN_IDS } from '../shared/types'
import type {
  AvoidMode,
  ClockFormat,
  IslandTheme,
  NeteaseCdpMode,
  PetMode,
  PetSkinId,
  PetWindowPos
} from '../shared/types'

/** 收起态可裁剪组件的键（与 App.tsx 的 COLLAPSED_KEYS 保持一致） */
const COLLAPSED_KEYS = ['pet', 'clock', 'battery', 'net', 'todo', 'bell'] as const
type CollapsedKey = (typeof COLLAPSED_KEYS)[number]

/** 收起态组件的默认顺序（美化-02）：电量 → 岛仔 → 时钟 → 网络 → 待办 → 铃铛 */
const DEFAULT_ORDER: CollapsedKey[] = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

interface PagesCustom {
  pages: number[]
  collapsed: Record<CollapsedKey, boolean>
  /** 收起态组件从左到右的顺序（美化-02）；缺失/不合法一律回落默认 */
  order: CollapsedKey[]
}

interface PrefsShape {
  pagesCustom?: PagesCustom
  shelfView?: string
  /**
   * 音乐页一次性补入标记（SPEC-music-page）。
   * 老版本的 pages 只可能是 0..3，升级后要把新的音乐页（索引 4）补进去；
   * 但用户如果自己手动关掉音乐页，绝不能下次启动又冒出来——所以补完就置 true，
   * 以后不再补。缺字段视为「还没补过」。
   */
  musicIntro?: boolean
  /**
   * 桌宠皮肤（SPEC-deskpet-skin）。缺失 = 用默认 `capsule`（升级前的老形象），
   * 而不是落盘写死 capsule——这样以后改默认皮肤，老用户跟着变。
   */
  petSkin?: PetSkinId
  /** 桌宠出现模式（SPEC-deskpet-skin）。缺失 = `island`（只在岛里，现有行为） */
  petMode?: PetMode
  /**
   * 桌宠独立小窗口的位置（SPEC-deskpet-out）。缺失 = 首次出现时给默认位置（右下角）。
   * 只记坐标不记显示器，越界时由 `clampPetPos` 拉回工作区。
   */
  petWindowPos?: PetWindowPos
  /**
   * 全屏避让策略（SPEC-avoid-mode-and-latency）。缺失 = `maximized`
   * （最大化与真全屏都避让，等于引入本字段之前的既有行为）。
   */
  avoidMode?: AvoidMode
  /**
   * 网易云后台控制策略（SPEC-netease-cdp-mode）。缺失 = `auto`（自动重启，
   * 与引入该字段之前的行为一致）。
   */
  neteaseCdpMode?: NeteaseCdpMode
  /**
   * 时钟显示档位（SPEC-clock-date-format）。缺失 = `time`（仅时间），
   * 与引入该字段之前的行为一致。
   */
  clockFormat?: ClockFormat
  /**
   * 「词」按钮第二下是否召唤网易云桌面歌词（SPEC-desktop-lyric-setting）。
   * 缺失 = true（保持刚做完的三态行为）。
   */
  desktopLyricEnabled?: boolean
  /**
   * 用户锁定的音源（SPEC-music-source-strategy）。存小写进程名（不带 .exe），
   * 缺失 / 空串 = 自动跟随播放。
   */
  musicSourcePin?: string
  /**
   * 用户在音源选择器里点选过的播放器（SPEC-music-source-strategy 的「软白名单」）。
   * 点选即记住：下次这些进程在跑时和内置已知播放器一样参与自动选源。
   */
  musicKnownPlayers?: string[]
  /**
   * 岛的主题（SPEC-island-themes）。缺失 = `glass-light`（用户选定的默认）。
   * 与其它字段一样不在缺失时写盘，这样以后改默认主题，老用户能跟着变。
   */
  islandTheme?: IslandTheme
}

/** 页面索引的合法上限：0 待办 / 1 置物架 / 2 通知 / 3 日程 / 4 音乐 */
const MAX_PAGE_INDEX = 4
/** 音乐页索引（SPEC-music-page） */
const MUSIC_PAGE = 4

const EMPTY: PrefsShape = {}

let file: string

/**
 * 规整收起态组件顺序（美化-02）：只保留合法键并去重，再把缺失的键按默认顺序补到末尾。
 * 为什么必须补全而不是丢弃：顺序数组是「渲染清单」——少一个键就等于该组件永远不显示，
 * 用户升级（旧 prefs 没有 order）或手改坏了也不该丢掉组件，宁可按默认位置补回。
 */
function normalizeOrder(v: unknown): CollapsedKey[] {
  const arr = Array.isArray(v) ? v : []
  const seen = new Set<CollapsedKey>()
  const out: CollapsedKey[] = []
  for (const item of arr) {
    if (typeof item === 'string' && (COLLAPSED_KEYS as readonly string[]).includes(item)) {
      const k = item as CollapsedKey
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  for (const k of DEFAULT_ORDER) if (!seen.has(k)) out.push(k)
  return out
}

/** 校验并规整 pagesCustom；不合法一律返回 undefined（调用方回落默认） */
function normalizePagesCustom(v: unknown): PagesCustom | undefined {
  if (!v || typeof v !== 'object') return undefined
  const raw = v as Partial<PagesCustom>
  // 顺序即用户自定义的页面顺序（US-032 反馈）：只做去重 + 范围校验 + 非空，不排序。
  const pages = Array.isArray(raw.pages)
    ? [...new Set(raw.pages.filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_PAGE_INDEX))]
    : []
  if (pages.length === 0) return undefined
  const collapsed: Record<CollapsedKey, boolean> = {
    pet: true,
    clock: true,
    battery: true,
    net: true,
    todo: true,
    bell: true
  }
  if (raw.collapsed && typeof raw.collapsed === 'object') {
    const c = raw.collapsed as Record<string, unknown>
    for (const k of COLLAPSED_KEYS) {
      if (typeof c[k] === 'boolean') collapsed[k] = c[k] as boolean
    }
  }
  const order = normalizeOrder((raw as { order?: unknown }).order)
  return { pages, collapsed, order }
}

/** 置物架视图记忆（US-037）：只认四个合法值；不合法返回 undefined（调用方回落默认） */
function normalizeShelfView(v: unknown): string | undefined {
  return v === 'lg' || v === 'md' || v === 'sm' || v === 'list' ? v : undefined
}

/**
 * 校验桌宠皮肤 id（SPEC-deskpet-skin）。
 * 白名单而不是「是字符串就收」：prefs.json 是明文文件，用户手改出
 * `petSkin: "不存在的皮肤"` 时渲染层会拿到一个查不到的 id，必须在这里挡掉回落默认，
 * 否则岛仔会渲染成空白（看起来像「宠物不见了」）。
 */
function normalizePetSkin(v: unknown): PetSkinId | undefined {
  return typeof v === 'string' && (PET_SKIN_IDS as readonly string[]).includes(v)
    ? (v as PetSkinId)
    : undefined
}

/** 校验桌宠模式（SPEC-deskpet-skin）：同样白名单；未实现的模式也允许存，只是不生效 */
function normalizePetMode(v: unknown): PetMode | undefined {
  return typeof v === 'string' && (PET_MODES as readonly string[]).includes(v)
    ? (v as PetMode)
    : undefined
}

/** 校验避让策略；非法/缺失一律返回 undefined（调用方回落默认 maximized） */
function normalizeAvoidMode(v: unknown): AvoidMode | undefined {
  return typeof v === 'string' && (AVOID_MODES as readonly string[]).includes(v) ? (v as AvoidMode) : undefined
}

/** 网易云后台控制档位（SPEC-netease-cdp-mode）：白名单，手改坏了按缺失处理（= auto） */
const NETEASE_CDP_MODES: NeteaseCdpMode[] = ['auto', 'manual', 'off']
function normalizeNeteaseCdpMode(v: unknown): NeteaseCdpMode | undefined {
  return typeof v === 'string' && (NETEASE_CDP_MODES as readonly string[]).includes(v)
    ? (v as NeteaseCdpMode)
    : undefined
}

/** 时钟显示档位（SPEC-clock-date-format）：白名单，手改坏了按缺失处理（= 仅时间） */
function normalizeClockFormat(v: unknown): ClockFormat | undefined {
  return typeof v === 'string' && (CLOCK_FORMATS as readonly string[]).includes(v)
    ? (v as ClockFormat)
    : undefined
}

/** 主题（SPEC-island-themes）：白名单，手改坏了按缺失处理（= 默认亮色玻璃） */
function normalizeIslandTheme(v: unknown): IslandTheme | undefined {
  return typeof v === 'string' && (ISLAND_THEMES as readonly string[]).includes(v)
    ? (v as IslandTheme)
    : undefined
}

/**
 * 规整进程名（音乐音源锁定 / 已知播放器表）：小写、去 `.exe`，只允许文件名安全字符。
 * 不合法返回空串。主进程与音乐模块共用，避免两处各写一套规则。
 */
export function normalizeExeName(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim().toLowerCase().replace(/\.exe$/, '')
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) ? s : ''
}

/** 规整「已知播放器」列表：逐项校验、去重、上限 40 项（够用且防手改刷屏） */
function normalizeKnownPlayers(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const name = normalizeExeName(item)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= 40) break
  }
  return out
}

/**
 * 校验桌宠窗口位置（SPEC-deskpet-out）。
 *
 * 只做「是不是两个有限数」的校验，**不做范围裁剪**：这里在 load 阶段调用，
 * 而 `screen` 模块要等 app ready 之后才可用。越界统一交给 `clampPetPos()`，
 * 在真正要开窗口时按当时的显示器布局算。
 */
function normalizePetWindowPos(v: unknown): PetWindowPos | undefined {
  if (!v || typeof v !== 'object') return undefined
  const raw = v as Partial<PetWindowPos>
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return undefined
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined
  return { x: Math.round(raw.x), y: Math.round(raw.y) }
}

/**
 * 桌宠图片在 190×250 窗口内的透明留白（窗口像素）。
 *
 * 来源 [已核验]：`src/renderer/src/pet/skinPhoto.tsx:45–63,339–358` 的 SVG
 * viewBox 160×160、PAD_TOP=10、IMG_H=140、正面比例 310/515；
 * `src/renderer/src/petwin/petwin.css` 把 190×190 内容区居中、上下各留 30px。
 * scale = 190/160 = 1.1875，换算图片在窗口内约左 45、右 145、顶 42、底 208。
 *
 * 2026-11-14 用户反馈「独立小窗口也碰不到边」（m02380/m02389）后，
 * 自由走动与独立小窗口统一改用这两个值算边界：让留白越出工作区，
 * 图片边缘正好贴住屏幕边。两个模式共用一份常量，不会再出现两套边界。
 */
export const PET_IMG_PAD_X = 45
export const PET_IMG_PAD_Y = 42

/**
 * 把桌宠窗口坐标钳到「桌宠图片可见」的范围（SPEC-deskpet-out ／
 * SPEC-deskpet-walk-polish 统一边界）。
 *
 * 为什么需要：坐标是绝对值，用户拔掉副屏、改分辨率、或者手改 prefs.json
 * 都可能留下一个屏幕外的坐标。不 clamp 的话窗口开在看不见的地方，
 * 用户会以为「桌宠丢了」且再也点不到它。
 *
 * 按「桌宠图片」算而不是「整窗」：窗口四周有 PET_IMG_PAD_* 的透明留白，
 * 按整窗钳进工作区时桌宠看起来离屏幕边还差一截（用户反馈「碰不到边」）。
 * 允许这段留白越出工作区，图片边缘正好贴住屏幕边；拖动、重启、自动走动
 * 三种入口都走这里（自动走动的 walkLimits 用同一组常量算 min/max）。
 *
 * 落在哪块屏：取离该坐标最近的显示器（`getDisplayNearestPoint`），
 * 而不是主显示器——用户把宠物拖到副屏，重启后应该还在副屏。
 */
export function clampPetPos(pos: PetWindowPos, w: number, h: number): PetWindowPos {
  let area: Electron.Rectangle
  try {
    area = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y }).workArea
  } catch {
    // screen 不可用（理论上只在 ready 前）——退回主显示器，保证有值
    area = screen.getPrimaryDisplay().workArea
  }
  return {
    x: Math.round(Math.min(area.x + area.width - (w - PET_IMG_PAD_X), Math.max(area.x - PET_IMG_PAD_X, pos.x))),
    y: Math.round(Math.min(area.y + area.height - (h - PET_IMG_PAD_Y), Math.max(area.y - PET_IMG_PAD_Y, pos.y)))
  }
}

/**
 * 首次出现时的默认位置：主显示器工作区右下角，留一点边距（SPEC-deskpet-out）。
 * 选右下角是因为它离岛（贴顶居中）最远，不会一出现就叠在一起。
 */
export function defaultPetPos(w: number, h: number): PetWindowPos {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - w - 24),
    y: Math.round(workArea.y + workArea.height - h - 24)
  }
}

function load(): PrefsShape {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PrefsShape
    const out: PrefsShape = {}
    const pc = normalizePagesCustom(parsed.pagesCustom)
    if (pc) out.pagesCustom = pc
    const sv = normalizeShelfView(parsed.shelfView)
    if (sv) out.shelfView = sv
    // musicIntro 必须原样带出去：prefs:set 是「load → 改 → save」，
    // 这里丢了标记，下一次任何偏好写入就会把「已补过音乐页」的事实抹掉，
    // 用户手动关掉的音乐页会再次冒出来。
    if (parsed.musicIntro === true) out.musicIntro = true
    const ps = normalizePetSkin(parsed.petSkin)
    if (ps) out.petSkin = ps
    const pm = normalizePetMode(parsed.petMode)
    if (pm) out.petMode = pm
    const pw = normalizePetWindowPos(parsed.petWindowPos)
    if (pw) out.petWindowPos = pw
    const am = normalizeAvoidMode(parsed.avoidMode)
    if (am) out.avoidMode = am
    const nm = normalizeNeteaseCdpMode(parsed.neteaseCdpMode)
    if (nm) out.neteaseCdpMode = nm
    const cf = normalizeClockFormat(parsed.clockFormat)
    if (cf) out.clockFormat = cf
    const th = normalizeIslandTheme(parsed.islandTheme)
    if (th) out.islandTheme = th
    if (typeof parsed.desktopLyricEnabled === 'boolean') {
      out.desktopLyricEnabled = parsed.desktopLyricEnabled
    }
    const pin = normalizeExeName(parsed.musicSourcePin)
    if (pin) out.musicSourcePin = pin
    const known = normalizeKnownPlayers(parsed.musicKnownPlayers)
    if (known && known.length > 0) out.musicKnownPlayers = known
    return out
  } catch {
    return { ...EMPTY }
  }
}

function save(data: PrefsShape): void {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * 偏好变更广播（SPEC-settings-shell）：设置窗口和岛是两个独立的渲染进程，
 * 一边改了另一边必须当场跟上（改设置窗口里的勾选，岛上的组件立刻变）。
 * 用 BrowserWindow.getAllWindows() 而不是只发给主窗口——设置窗口也是其中一个。
 */
function broadcastPrefs(data: PrefsShape): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('prefs:changed', data)
  }
}

/**
 * 界面偏好存储（US-032 页面自定义）：JSON 文件持久化在 userData 目录。
 * 为什么不用渲染层 localStorage：本机实测 file:// 来源的 localStorage 跨进程重启会丢失
 * （写入后优雅退出再启动读回为 null），页面裁剪偏好必须跨重启保留，故走主进程文件。
 */
/**
 * 老用户一次性补上音乐页（SPEC-music-page）。
 *
 * 为什么需要它：音乐页是第 5 页（索引 4），而老版本 prefs.json 里的 pages 只可能
 * 是 [0,1,2,3]，且 defaultPagesCustom 只在「没有 prefs」时才生效——不给老数据补一刀，
 * 存量用户升级后永远看不到音乐页。
 *
 * 为什么要 musicIntro 标记：只补一次。用户补完之后自己把音乐页关掉，
 * 下次启动不能又冒出来（那就是「关不掉的功能」）。
 *
 * 补的条件：有 pagesCustom（说明是老用户有自定义记录）且标记不是 true 且当前没勾音乐页。
 * 没有 pagesCustom 的（全新安装）由渲染层 defaultPagesCustom 直接带上音乐页，不需要补。
 */
function migrateMusicPage(): void {
  const data = load()
  if (data.musicIntro === true) return
  if (!data.pagesCustom) return
  if (data.pagesCustom.pages.includes(MUSIC_PAGE)) {
    // 已经在显示音乐页（理论上不会发生，除非用户手改过），只落标记
    data.musicIntro = true
    save(data)
    return
  }
  data.pagesCustom = { ...data.pagesCustom, pages: [...data.pagesCustom.pages, MUSIC_PAGE] }
  data.musicIntro = true
  save(data)
  console.log('[prefs] 已为老用户补上音乐页（第 5 页）')
}

export function setupPrefsStore(): void {
  file = join(app.getPath('userData'), 'prefs.json')
  mkdirSync(app.getPath('userData'), { recursive: true })

  migrateMusicPage()

  ipcMain.handle('prefs:get', (): PrefsShape => load())

  ipcMain.handle('prefs:set', (_e, payload: unknown): PrefsShape => {
    const data = applyPatch(payload)
    if (data) {
      broadcastPrefs(data)
      // 主进程内部的订阅者也要收到（SPEC-deskpet-out：设置窗口把 petMode 改成 window 时，
      // 宠物窗口的开关是主进程在管，只听渲染层广播收不到这次变化）。
      emitPrefsWritten(data)
    }
    return load()
  })
}

/**
 * 落盘一批偏好字段并返回新状态；**没有实际变化时返回 null**（SPEC-deskpet-out 抽出）。
 *
 * 为什么从 `prefs:set` 的处理函数里抽出来：主进程自己也要写偏好
 * （宠物窗口拖动结束后记位置、点「回到岛里」把 petMode 改回去），
 * 走不了 IPC。抽成一个函数，两条路都走同一份校验与落盘逻辑，
 * 不会出现「渲染层写的能校验、主进程写的忘了校验」。
 */
function applyPatch(payload: unknown): PrefsShape | null {
  const data = load()
  // 快照一份用于事后比较（load() 每次返回新对象，直接引用会被后续赋值改掉）
  const before = JSON.stringify(data)
  const { pagesCustom, shelfView, musicIntro, petSkin, petMode, petWindowPos, avoidMode, neteaseCdpMode, clockFormat, islandTheme, desktopLyricEnabled, musicSourcePin, musicKnownPlayers } =
    (payload ?? {}) as {
      pagesCustom?: unknown
      shelfView?: unknown
      musicIntro?: unknown
      petSkin?: unknown
      petMode?: unknown
      petWindowPos?: unknown
      avoidMode?: unknown
      neteaseCdpMode?: unknown
      clockFormat?: unknown
      islandTheme?: unknown
      desktopLyricEnabled?: unknown
      musicSourcePin?: unknown
      musicKnownPlayers?: unknown
    }
  const pc = normalizePagesCustom(pagesCustom)
  if (pc) data.pagesCustom = pc
  else if (pagesCustom !== undefined) delete data.pagesCustom // 显式传 pagesCustom 才动它，未传保持原值
  const sv = normalizeShelfView(shelfView)
  if (sv) data.shelfView = sv
  else if (shelfView !== undefined) delete data.shelfView
  if (typeof musicIntro === 'boolean') {
    if (musicIntro) data.musicIntro = true
    else delete data.musicIntro
  }
  const ps = normalizePetSkin(petSkin)
  if (ps) data.petSkin = ps
  else if (petSkin !== undefined) delete data.petSkin
  const pm = normalizePetMode(petMode)
  if (pm) data.petMode = pm
  else if (petMode !== undefined) delete data.petMode
  const pw = normalizePetWindowPos(petWindowPos)
  if (pw) data.petWindowPos = pw
  else if (petWindowPos !== undefined) delete data.petWindowPos
  const am = normalizeAvoidMode(avoidMode)
  if (am) data.avoidMode = am
  else if (avoidMode !== undefined) delete data.avoidMode
  const nm = normalizeNeteaseCdpMode(neteaseCdpMode)
  if (nm) data.neteaseCdpMode = nm
  else if (neteaseCdpMode !== undefined) delete data.neteaseCdpMode
  const cf = normalizeClockFormat(clockFormat)
  if (cf) data.clockFormat = cf
  else if (clockFormat !== undefined) delete data.clockFormat
  const th = normalizeIslandTheme(islandTheme)
  if (th) data.islandTheme = th
  else if (islandTheme !== undefined) delete data.islandTheme
  if (typeof desktopLyricEnabled === 'boolean') data.desktopLyricEnabled = desktopLyricEnabled
  else if (desktopLyricEnabled !== undefined) delete data.desktopLyricEnabled
  const pin = normalizeExeName(musicSourcePin)
  if (pin) data.musicSourcePin = pin
  else if (musicSourcePin !== undefined) delete data.musicSourcePin
  if (musicKnownPlayers !== undefined) {
    const known = normalizeKnownPlayers(musicKnownPlayers) ?? []
    if (known.length > 0) data.musicKnownPlayers = known
    else delete data.musicKnownPlayers
  }
  save(data)
  return JSON.stringify(before) !== JSON.stringify(data) ? data : null
}

/** 主进程内部读偏好（SPEC-deskpet-out：启动时决定要不要开宠物窗口） */
export function getPrefs(): PrefsShape {
  return load()
}

/**
 * 主进程内部写偏好（SPEC-deskpet-out）。
 *
 * 与 `prefs:set` 的差别：这里**一定**把变化广播出去，而且主进程自己的订阅者
 * （`onPrefsWritten`）也会收到——宠物窗口拖动结束记位置、点「回到岛里」
 * 把模式改回去，都靠这条路径让岛和设置窗口当场跟上。
 */
export function patchPrefs(payload: Partial<PrefsShape>): PrefsShape {
  const data = applyPatch(payload)
  if (data) {
    broadcastPrefs(data)
    emitPrefsWritten(data)
  }
  return load()
}

/** 主进程内部的偏好写入监听者（宠物窗口开关跟着 petMode 走） */
const writtenCbs: ((p: PrefsShape) => void)[] = []

function emitPrefsWritten(p: PrefsShape): void {
  for (const cb of writtenCbs) cb(p)
}

/**
 * 订阅主进程内部的偏好写入（SPEC-deskpet-out）。
 * 只回调**真正变化过**的写入，与 `prefs:changed` 广播同源。
 */
export function onPrefsWritten(cb: (p: PrefsShape) => void): void {
  writtenCbs.push(cb)
}
