import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
    const data = load()
    // 快照一份用于事后比较（load() 每次返回新对象，直接引用会被后续赋值改掉）
    const before = JSON.stringify(data)
    const { pagesCustom, shelfView, musicIntro } = (payload ?? {}) as {
      pagesCustom?: unknown
      shelfView?: unknown
      musicIntro?: unknown
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
    save(data)
    // 只在真正有变化时广播：prefs:set 的调用方常带「乐观更新」，无变化广播会让
    // 另一端把自己刚点的东西又写一遍（视觉上闪一下）
    if (JSON.stringify(before) !== JSON.stringify(data)) broadcastPrefs(data)
    return data
  })
}
