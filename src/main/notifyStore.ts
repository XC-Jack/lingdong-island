import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, rmSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appIcon, initIconCache } from './notifyIconStore'

/**
 * Windows 通知历史读取（wpndatabase）。
 *
 * 库被系统的 wpnpushsvc 常驻锁住，但复制 db+wal+shm 三件套后可以只读打开。
 * toast 通知到达时写 Notification 表（Type='toast'），Payload 是 toast XML。
 * 全部读操作失败时返回空列表（防御式设计：读不到 = 暂无通知）。
 */

const WPN_DIR = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications')
const WPN_DB = join(WPN_DIR, 'wpndatabase.db')
const POLL_MS = 30_000 // 兜底轮询（防 watcher 漏事件）；实时性由 wpndatabase 文件监听保证
const FOLLOWUP_MS = 120 // 文件监听触发：立即读之后的补读间隔（读失败无害，压小让横幅更快）
const MAX_ITEMS = 50

interface NotifyItem {
  id: number // Notification.Id（稳定标识）
  order: number // 全局递增序号（新通知 = 更大 Order）
  app: string // 应用名（AUMID 短名或原始值）
  /** 应用图标 PNG 绝对路径（渲染层用 file:// 显示）；解析失败为 null（退回文字徽标） */
  icon: string | null
  title: string
  body: string
  arrival: number // 到达时间（Unix ms）
  /** toast 的 launch 深链（点击直达来源界面，如 QQ 聊天窗）；无属性/不可用为 null */
  launch: string | null
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let dbWatcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let cached: NotifyItem[] = []
let tmpSeq = 0
/** 横幅去重：已发过 island:notify-arrived 的通知 id（通知不会重复触发横幅） */
const bannerSent = new Set<number>()

/** FILETIME (100ns since 1601-01-01) → Unix ms */
function filetimeToMs(text: string): number {
  const v = Number(text)
  if (!Number.isFinite(v) || v <= 0) return 0
  return v / 10000 - 11644473600000
}

/** 从 toast XML 抽标题/正文：text id=1 是标题，id=2 是正文（不同模板可能只有一条） */
function parseToastXml(xml: string): { title: string; body: string } {
  const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => decodeEntities(m[1].trim())).filter(Boolean)
  if (texts.length === 0) return { title: '', body: '' }
  if (texts.length === 1) return { title: texts[0], body: '' }
  return { title: texts[0], body: texts.slice(1).join(' ') }
}

/** 抽 toast XML 的 launch 属性（点击通知时系统分发的深链）；无属性/解码失败返回 null
 *  2026-11-12 修：先解 XML 实体再 URL 解码。原来只做 decodeURIComponent，导致
 *  ScreenSketch 这类把 `&` 写成 `&amp;` 的应用拿到的深链是
 *  `ms-screensketch:edit?&amp;filePath=...`，交给 shell.openExternal 是坏 URI。
 *  顺序必须是「实体 → 百分号」：反过来 `&amp;` 里的 % 不受影响，但含 %26 的值会被二次解码。 */
function parseToastLaunch(xml: string): string | null {
  const m = xml.match(/\blaunch="([^"]*)"/)
  if (!m) return null
  const unescaped = decodeEntities(m[1])
  try {
    return decodeURIComponent(unescaped) || null
  } catch {
    return unescaped || null // 解码失败就用原始值（个别应用不做 URL 编码）
  }
}

/** 解码 toast XML 里的 HTML 实体（&lt;h&gt; → <h>）；toast 正文是 XML 转义过的，不解码会显示成乱码 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeFromCode(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** AUMID（如 Microsoft.Windows.Explorer!App 或 com.tencent.qq）→ 可读短名 */
function appShortName(aumid: string): string {
  const bang = aumid.split('!')
  const pkg = bang[0]
  const last = pkg.split('.').pop() ?? pkg
  return last || aumid
}

function readWpnDatabase(): NotifyItem[] | null {
  if (!existsSync(WPN_DB)) return []
  const stamp = `${process.pid}-${Date.now()}-${tmpSeq++}`
  const tmpDb = join(app.getPath('temp'), `wpn-copy-${stamp}.db`)
  try {
    copyFileSync(WPN_DB, tmpDb)
    const wal = `${WPN_DB}-wal`
    const shm = `${WPN_DB}-shm`
    if (existsSync(wal)) copyFileSync(wal, `${tmpDb}-wal`)
    if (existsSync(shm)) copyFileSync(shm, `${tmpDb}-shm`)
    const db = new DatabaseSync(tmpDb, { readOnly: true })
    try {
      const rows = db
        .prepare(
          `SELECT n.Id, n.[Order], h.PrimaryId AS appId, n.Payload,
                  CAST(n.ArrivalTime AS TEXT) AS arrival
           FROM Notification n
           LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId
           WHERE n.Type = 'toast' AND n.Payload IS NOT NULL
           ORDER BY n.[Order] DESC LIMIT ?`
        )
        .all(MAX_ITEMS) as unknown as {
        Id: number
        Order: number
        appId: string | null
        Payload: Buffer | Uint8Array
        arrival: string
      }[]
      return rows.map((r) => {
        const xml = Buffer.from(r.Payload).toString('utf8')
        const { title, body } = parseToastXml(xml)
        const app_ = r.appId ? appShortName(r.appId) : '系统通知'
        return {
          id: Number(r.Id),
          order: Number(r.Order),
          app: app_,
          icon: appIcon(app_),
          title: title || '(无标题)',
          body,
          arrival: filetimeToMs(r.arrival),
          launch: parseToastLaunch(xml),
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return null // 读失败（系统正写/快照不一致）返回 null，refresh 保留旧列表
  } finally {
    for (const p of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* temp 清理失败无碍 */
      }
    }
  }
}

async function refresh(): Promise<NotifyItem[]> {
  // node:sqlite 是同步 API；复制+查询都在毫秒级，放同步即可，但保持接口 async 备扩展
  const prev = cached
  const fresh = readWpnDatabase()
  if (fresh === null) {
    // 读库失败（多为系统正写、快照不一致）：保留旧列表，跳过本轮，绝不清空——
    // 否则下一轮会把历史全当「启动首轮」记 bannerSent，新消息的横幅就永远丢了
    return cached
  }
  cached = fresh

  // 新消息到岛横幅：找出本轮新增（之前不在 cached 里）且未读未隐藏的通知，
  // 逐条推给渲染层（收起态才显示横幅，展开态渲染层自己忽略）。
  // 应用刚启动的首轮 refresh 跳过（prev 为空时把 50 条历史全当新消息弹一遍）。
  if (prev.length > 0) {
    const prevIds = new Set(prev.map((i) => i.id))
    const mark = readMark()
    const hidden = readHidden()
    for (const it of [...cached].reverse()) {
      // 旧→新顺序遍历，最新一条最后发（多条并发到达时渲染层显示最后一条）
      if (prevIds.has(it.id) || bannerSent.has(it.id)) continue
      if (it.order <= mark || it.order <= hidden) continue
      bannerSent.add(it.id)
      if (bannerSent.size > 500) bannerSent.clear() // 防长期驻留无限增长
      BrowserWindow.getAllWindows()[0]?.webContents.send('island:notify-arrived', it)
    }
  } else {
    // 首轮：记录水位内已存在的 id，它们不算「新」
    for (const it of cached) bannerSent.add(it.id)
  }

  return cached
}

/** 未读/隐藏水位：userData/notif-read.json 记录 {lastOrder, hiddenUntil}
 *  lastOrder   —— 已读水位：order>lastOrder 算未读（收起态红点）
 *  hiddenUntil —— 清空水位：order<=hiddenUntil 的通知不再显示（wpndatabase 只读，清空=本地隐藏）
 *  旧文件只有 {lastOrder}，无 hiddenUntil 视为 0（向后兼容） */
function readMarkPath(): string {
  return join(app.getPath('userData'), 'notif-read.json')
}

interface MarkFile {
  lastOrder: number
  hiddenUntil: number
}

function readMarkFile(): MarkFile {
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(readMarkPath(), 'utf8')) as {
      lastOrder?: number
      hiddenUntil?: number
    }
    return { lastOrder: Number(raw.lastOrder) || 0, hiddenUntil: Number(raw.hiddenUntil) || 0 }
  } catch {
    return { lastOrder: 0, hiddenUntil: 0 }
  }
}

function readMark(): number {
  return readMarkFile().lastOrder
}

function readHidden(): number {
  return readMarkFile().hiddenUntil
}

function writeMarkFile(patch: Partial<MarkFile>): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const next = { ...readMarkFile(), ...patch }
    require('node:fs').writeFileSync(readMarkPath(), JSON.stringify(next))
  } catch {
    /* 写失败只影响红点/隐藏 */
  }
}

function writeMark(lastOrder: number): void {
  writeMarkFile({ lastOrder })
}

/** 列表可见性：order<=hiddenUntil 的通知被「清空」隐藏 */
function visibleItems(): NotifyItem[] {
  const hidden = readHidden()
  return cached.filter((i) => i.order > hidden)
}

export function unreadCount(): number {
  const items = visibleItems()
  if (items.length === 0) return 0
  const mark = readMark()
  return items.filter((i) => i.order > mark).length
}

/** 标记全部已读：写当前可见列表最大 Order；cached 为空时不动水位（防御：避免空列表把红点"标完"后又被旧通知弹回） */
function markAllRead(): void {
  const maxOrder = visibleItems().reduce((m, i) => Math.max(m, i.order), 0)
  if (maxOrder > readMark()) writeMark(maxOrder)
}

/** 清空：把隐藏水位提到当前最大 Order。旧通知（order<=水位）此后不再显示；新通知正常出现 */
function clearAll(): void {
  const maxOrder = visibleItems().reduce((m, i) => Math.max(m, i.order), 0)
  if (maxOrder > readHidden()) writeMarkFile({ hiddenUntil: maxOrder, lastOrder: Math.max(maxOrder, readMark()) })
}

/** launch 深链安全过滤：只放行合法 URI，拒绝危险协议（launch 由第三方应用写入通知库） */
function launchUsable(launch: string | null): launch is string {
  if (!launch) return false
  if (!/^[a-z][a-z0-9+.-]*:/i.test(launch)) return false
  const scheme = launch.slice(0, launch.indexOf(':')).toLowerCase()
  return !['file', 'javascript', 'data', 'vbscript'].includes(scheme)
}

/** 通知来源打开：优先 launch 深链（点击直达来源界面），映射不到兜底打开 Windows 通知设置（点击必有反应） */
function openSource(app_: string, launch: string | null): boolean {
  // 自家通知：聚焦灵动岛主窗口（没有独立窗口可开）
  if (app_ === 'lingdong-island') {
    const { BrowserWindow } = require('electron') as typeof import('electron')
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return true
    }
    return false
  }
  // 1) launch 深链：交给系统协议分发（QQ 的 ntqq-notification:// 由 QQ 注册到 timwp.exe）
  if (launchUsable(launch)) {
    void shell.openExternal(launch)
    return true
  }
  const map: Record<string, string> = {
    Explorer: 'explorer.exe',
    Chrome: 'chrome.exe',
    msedge: 'msedge.exe',
    QQ: 'qq.exe',
    WeChat: 'wechat.exe',
    Weixin: 'weixin.exe',
    DingTalk: 'dingtalk.exe',
    Feishu: 'feishu.exe',
    ScreenSketch: 'ms-screenclip:', // Windows 屏幕截图（Win+Shift+S）
    SnippingTool: 'SnippingTool.exe',
  }
  const exe = map[app_]
  if (exe) {
    if (exe.endsWith(':')) {
      void shell.openExternal(exe)
      return true
    }
    const child = spawnSync('cmd.exe', ['/d', '/c', 'start', '', exe], { windowsHide: true, timeout: 5000 })
    return !child.error
  }
  // 兜底：映射不到的应用 → 打开 Windows 通知设置（比"点了没反应"好）
  void shell.openExternal('ms-settings:notifications')
  return true
}

export function setupNotifyStore(): void {
  initIconCache()
  void refresh()
  pollTimer = setInterval(() => void refresh(), POLL_MS)
  watchDatabase()

  // lastOrder = 已读水位：渲染层用它判断「这一条是不是未读」（order > lastOrder 即未读），
  // 用来给未读条目画蓝点（美化-04）。只读暴露，读到什么就是什么。
  ipcMain.handle('notify:list', () => ({ items: visibleItems(), unread: unreadCount(), lastOrder: readMark() }))
  ipcMain.handle('notify:mark-read', () => {
    markAllRead()
    return unreadCount()
  })
  ipcMain.handle('notify:refresh', () =>
    refresh().then(() => ({ items: visibleItems(), unread: unreadCount(), lastOrder: readMark() }))
  )
  ipcMain.handle('notify:clear-all', () => {
    clearAll()
    return { items: visibleItems(), unread: unreadCount(), lastOrder: readMark() }
  })
  ipcMain.handle('notify:open-source', (_e, appName: string, launch: string | null) => openSource(appName, launch))
}

export function stopNotifyStore(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (dbWatcher) {
    dbWatcher.close()
    dbWatcher = null
  }
}

/** 实时监听：wpndatabase.db / -wal 一有写入就（去抖后）立刻 refresh，横幅接近即时弹出。
 *  监听失败不影响功能（还有 30s 兜底轮询）。 */
function watchDatabase(): void {
  try {
    if (!existsSync(WPN_DIR)) return
    let watching = false
    const start = (): void => {
      if (watching) return
      try {
        dbWatcher = watch(WPN_DIR, { persistent: false }, (_event, filename) => {
          const name = typeof filename === 'string' ? filename : ''
          // 只关心通知库本体和它的预写日志
          if (!name.startsWith('wpndatabase')) return
          scheduleRefresh()
        })
        watching = true
      } catch {
        /* 目录监听失败：静默退回轮询 */
      }
    }
    const scheduleRefresh = (): void => {
      // 双段读：立即读一次（若系统已写完 wal，横幅最快 ~300ms 弹出），
      // 再 120ms 后补读一次（兜住「立即读时 wal 还没写完」的情况）。
      // 读失败/读不全都无害：失败保留旧列表，补读再抓；30s 轮询最终兜底。
      void refresh()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void refresh(), FOLLOWUP_MS)
    }
    start()
  } catch {
    /* 任何监听异常都不冒错：轮询兜底 */
  }
}
