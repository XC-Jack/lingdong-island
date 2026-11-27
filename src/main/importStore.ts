import { app, dialog, ipcMain, Notification, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendToIsland } from './islandWindowRef'
import { mergeTodos } from './todoStore'
import { mergeSchedule, type ScheduleItem } from './scheduleStore'
import type { Todo } from '../shared/types'

/**
 * 数据导入（SPEC-data-import）：把 US-029 导出的备份 JSON 合并回本机。
 *
 * 设计取向：
 * - **只合并，不覆盖**。用户拿到备份是为了「把数据带回来」，不是「换掉现在这些」；
 *   一个手滑的替换模式等于给了删库按钮，所以本模块没有替换分支。
 * - **整体校验、逐条规范化**。文件级错误（不是 JSON / app 不对 / 版本不认）整份拒绝，
 *   不动任何数据；条目级错误（缺 text、day 非法）只丢这一条，不让一条脏数据毁掉整份备份。
 * - **合并必须走各 store 自己的入口**（mergeTodos / mergeSchedule），不能直接写文件：
 *   scheduleStore 有内存态 items 在跑每分钟提醒检查，直接写盘会被下一次操作覆盖。
 * - **reminded 一律重置为 false**：导入的是「过去的提醒状态」，带回来只会在导入瞬间
 *   弹出一堆早已过期的通知。重置后按新时间重新计算。
 *
 * 范围与导出对称：只处理待办与日程。置物架存本机绝对路径（换机器必失效）、通知是只读
 * 外部系统库，两者导入都没有意义。
 */

export interface ImportResult {
  ok: boolean
  canceled?: boolean
  added?: { todos: number; schedule: number }
  skipped?: { todos: number; schedule: number }
  reason?: 'canceled' | 'invalid' | 'failed'
  detail?: string
}

/** 备份文件里单条待办的原始形状（字段都不可信，逐字段校验） */
interface RawTodo {
  id?: unknown
  text?: unknown
  done?: unknown
  createdAt?: unknown
}

interface RawSchedule {
  id?: unknown
  text?: unknown
  day?: unknown
  time?: unknown
  done?: unknown
  createdAt?: unknown
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{1,2}:\d{2}$/

/** 本地时区的 'YYYY-MM-DD'（与 scheduleStore 同口径，不能用 toISOString） */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把一条原始待办规范化成 Todo；文字为空返回 null（该条丢弃）。
 * 这里刻意不抛异常：一条坏数据不该让整份备份导入失败。
 */
function normalizeTodo(raw: RawTodo): Todo | null {
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    text,
    done: Boolean(raw.done),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  }
}

/** 同 normalizeTodo，日程多校验 day / time；reminded 强制 false（见文件头注释） */
function normalizeSchedule(raw: RawSchedule): ScheduleItem | null {
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return null
  const dayRaw = typeof raw.day === 'string' ? raw.day.trim() : ''
  const day = DAY_RE.test(dayRaw) ? dayRaw : todayKey()
  const timeRaw = typeof raw.time === 'string' ? raw.time.trim() : ''
  const time = TIME_RE.test(timeRaw) ? timeRaw.padStart(5, '0') : null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    text,
    day,
    time,
    done: Boolean(raw.done),
    reminded: false,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  }
}

/** 用系统通知反馈结果（岛收起时用户也看得见）；通知不可用就静默 */
function notifyResult(title: string, body: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show()
    }
  } catch {
    /* 通知失败不影响导入结果 */
  }
}

/** 校验并解析备份文件；返回 null 表示文件级无效（reason 给出中文原因） */
function parseBackup(raw: string): { todos: RawTodo[]; schedule: RawSchedule[] } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { error: '文件不是有效的 JSON' }
  }
  if (!data || typeof data !== 'object') return { error: '备份内容不是对象' }
  const obj = data as Record<string, unknown>
  if (obj.app !== 'lingdong-island') return { error: '这不是灵动岛的备份文件' }
  if (obj.version !== 1) return { error: `备份版本不支持（${String(obj.version)}），本版只认 version 1` }
  const todos = Array.isArray(obj.todos) ? (obj.todos as RawTodo[]) : null
  const schedule = Array.isArray(obj.schedule) ? (obj.schedule as RawSchedule[]) : null
  // 两个数组都不存在 = 没有任何可导入内容，按无效处理，避免「导入成功但 0 条」误导用户
  if (!todos && !schedule) return { error: '备份里没有待办或日程数据' }
  return { todos: todos ?? [], schedule: schedule ?? [] }
}

export function setupImportStore(): void {
  ipcMain.handle('app:import-data', async (event): Promise<ImportResult> => {
    // e2e 隔离口：原生「打开」对话框无法在脚本里点，设了 ISLAND_IMPORT_PATH 就直接用它，
    // 跳过对话框、其余链路（校验/规范化/合并/落盘）完全走真实代码。
    // 与 ISLAND_NO_NETEASE_AUTO / ISLAND_NO_DESKTOP_LYRIC 同一思路，仅 e2e 设，生产环境不设。
    const forcedPath = process.env.ISLAND_IMPORT_PATH
    let filePath: string
    if (forcedPath) {
      filePath = forcedPath
    } else {
      let defaultDir = app.getPath('userData')
      try {
        defaultDir = app.getPath('documents')
      } catch {
        /* 个别环境无文档目录，退回 userData */
      }
      // 模态挂发起调用的那个窗口（与导出同款，取不到就弹独立对话框）
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const opts = {
        title: '导入灵动岛数据',
        defaultPath: join(defaultDir),
        filters: [{ name: '灵动岛备份', extensions: ['json'] as string[] }],
        properties: ['openFile'] as Array<'openFile'>
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, reason: 'canceled' }
      filePath = r.filePaths[0]
    }
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      notifyResult('灵动岛', `导入失败：读不到文件（${detail}）`)
      return { ok: false, reason: 'failed', detail }
    }

    const parsed = parseBackup(raw)
    if ('error' in parsed) {
      notifyResult('灵动岛', `导入失败：${parsed.error}`)
      return { ok: false, reason: 'invalid', detail: parsed.error }
    }

    try {
      // 逐条规范化后再合并：坏条目在这里被丢掉，不影响同批其它条目
      const todos = parsed.todos.map(normalizeTodo).filter((t): t is Todo => t !== null)
      const schedule = parsed.schedule
        .map(normalizeSchedule)
        .filter((s): s is ScheduleItem => s !== null)
      const todoRes = mergeTodos(todos)
      const schedRes = mergeSchedule(schedule)
      const added = { todos: todoRes.added, schedule: schedRes.added }
      const skipped = { todos: todoRes.skipped, schedule: schedRes.skipped }

      const body =
        `已导入待办 ${added.todos} 条、日程 ${added.schedule} 条` +
        (skipped.todos + skipped.schedule > 0
          ? `（跳过重复 ${skipped.todos + skipped.schedule} 条）`
          : '')
      notifyResult('灵动岛', body)
      // 通知岛窗口刷新：它可能正停在待办/日程页，需要立刻重拉列表
      sendToIsland('data:imported')
      return { ok: true, added, skipped }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      notifyResult('灵动岛', `导入失败：${detail}`)
      return { ok: false, reason: 'failed', detail }
    }
  })
}
