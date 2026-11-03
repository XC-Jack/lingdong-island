import { app, ipcMain } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Windows 通知历史读取（wpndatabase）。
 *
 * 库被系统的 wpnpushsvc 常驻锁住，但复制 db+wal+shm 三件套后可以只读打开。
 * toast 通知到达时写 Notification 表（Type='toast'），Payload 是 toast XML。
 * 全部读操作失败时返回空列表（防御式设计：读不到 = 暂无通知）。
 */

const WPN_DIR = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications')
const WPN_DB = join(WPN_DIR, 'wpndatabase.db')
const POLL_MS = 30_000
const MAX_ITEMS = 50

interface NotifyItem {
  id: number // Notification.Id（稳定标识）
  order: number // 全局递增序号（新通知 = 更大 Order）
  app: string // 应用名（AUMID 短名或原始值）
  title: string
  body: string
  arrival: number // 到达时间（Unix ms）
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let cached: NotifyItem[] = []
let tmpSeq = 0

/** FILETIME (100ns since 1601-01-01) → Unix ms */
function filetimeToMs(text: string): number {
  const v = Number(text)
  if (!Number.isFinite(v) || v <= 0) return 0
  return v / 10000 - 11644473600000
}

/** 从 toast XML 抽标题/正文：text id=1 是标题，id=2 是正文（不同模板可能只有一条） */
function parseToastXml(xml: string): { title: string; body: string } {
  const texts = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].trim()).filter(Boolean)
  if (texts.length === 0) return { title: '', body: '' }
  if (texts.length === 1) return { title: texts[0], body: '' }
  return { title: texts[0], body: texts.slice(1).join(' ') }
}

/** AUMID（如 Microsoft.Windows.Explorer!App 或 com.tencent.qq）→ 可读短名 */
function appShortName(aumid: string): string {
  const bang = aumid.split('!')
  const pkg = bang[0]
  const last = pkg.split('.').pop() ?? pkg
  return last || aumid
}

function readWpnDatabase(): NotifyItem[] {
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
        return {
          id: Number(r.Id),
          order: Number(r.Order),
          app: r.appId ? appShortName(r.appId) : '系统通知',
          title: title || '(无标题)',
          body,
          arrival: filetimeToMs(r.arrival),
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return [] // 任何读失败都当"暂无通知"，绝不冒数据
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
  cached = readWpnDatabase()
  return cached
}

/** 未读数：userData/notif-read.json 记录已读最大 Order */
function readMarkPath(): string {
  return join(app.getPath('userData'), 'notif-read.json')
}

function readMark(): number {
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(readMarkPath(), 'utf8'))
    return Number(raw.lastOrder) || 0
  } catch {
    return 0
  }
}

function writeMark(lastOrder: number): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    require('node:fs').writeFileSync(readMarkPath(), JSON.stringify({ lastOrder }))
  } catch {
    /* 写失败只影响红点 */
  }
}

export function unreadCount(): number {
  if (cached.length === 0) return 0
  const mark = readMark()
  return cached.filter((i) => i.order > mark).length
}

/** 标记全部已读（当前列表最大 Order） */
function markAllRead(): void {
  const maxOrder = cached.reduce((m, i) => Math.max(m, i.order), 0)
  if (maxOrder > 0) writeMark(maxOrder)
}

/** 通知来源打开：常见 AUMID 短名 → exe/URI。映射不到返回 false（UI 只标已读） */
function openSource(app_: string): boolean {
  const map: Record<string, string> = {
    Explorer: 'explorer.exe',
    Chrome: 'chrome.exe',
    msedge: 'msedge.exe',
    QQ: 'qq.exe',
    WeChat: 'wechat.exe',
    Weixin: 'weixin.exe',
    DingTalk: 'dingtalk.exe',
    Feishu: 'feishu.exe',
  }
  const exe = map[app_]
  if (!exe) return false
  const child = spawnSync('cmd.exe', ['/d', '/c', 'start', '', exe], { windowsHide: true, timeout: 5000 })
  return !child.error
}

export function setupNotifyStore(): void {
  void refresh()
  pollTimer = setInterval(() => void refresh(), POLL_MS)

  ipcMain.handle('notify:list', () => ({ items: cached, unread: unreadCount() }))
  ipcMain.handle('notify:mark-read', () => {
    markAllRead()
    return unreadCount()
  })
  ipcMain.handle('notify:refresh', () => refresh().then(() => ({ items: cached, unread: unreadCount() })))
  ipcMain.handle('notify:open-source', (_e, appName: string) => openSource(appName))
}

export function stopNotifyStore(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
