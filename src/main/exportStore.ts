import { app, dialog, ipcMain, Notification, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * US-029 数据导出：把待办 + 日程打包成一个 JSON 文件，用户自选位置保存。
 *
 * 设计取向（见 docs/Spec/SPEC-us-029-data-export.md）：
 * - 只导出待办与日程。置物架存的是本机文件绝对路径（换机器必失效）、
 *   通知是只读外部系统库（wpndatabase），导出它们没有意义。
 * - 导出对象字段与 store 落盘格式一致（todos 数组 / items 数组原样字段），
 *   不做加工，将来做导入时可以直接按键拼回。
 * - 入口在设置窗口「常规 → 导出数据」（2026-11-11 用户要求搬进来，原右键/托盘菜单项已删），
 *   主进程原生另存为对话框，渲染层按钮只负责触发与显示结果；同时用系统通知反馈
 *   （岛可能正处于收起态，设置窗口也可能已经关掉）。
 */

export interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  reason?: 'canceled' | 'empty' | 'failed'
  detail?: string
}

interface ExportPayload {
  app: 'lingdong-island'
  version: 1
  exportedAt: string
  todos: unknown[]
  schedule: unknown[]
}

/** 本地时区的 ISO 风格时间戳（toISOString 是 UTC，会差 8 小时，不用） */
function localIso(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${pad(abs / 60)}:${pad(abs % 60)}`
  )
}

/** 文件名时间戳：灵动岛备份-20261106-120000.json */
function stampName(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `灵动岛备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`
}

/** 读一个 store 的 JSON；文件不存在或解析失败按空数组处理（防御式，与 store 行为一致） */
function readStoreArray(file: string, key: string): unknown[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const list = raw[key]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function buildPayload(): ExportPayload {
  const userData = app.getPath('userData')
  const todos = readStoreArray(join(userData, 'todos.json'), 'todos')
  const schedule = readStoreArray(join(userData, 'schedule.json'), 'items')
  return {
    app: 'lingdong-island',
    version: 1,
    exportedAt: localIso(),
    todos,
    schedule
  }
}

/** 用系统通知反馈结果（岛收起时用户也看得见）；通知不可用就静默 */
function notifyResult(title: string, body: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show()
    }
  } catch {
    /* 通知失败不影响导出结果 */
  }
}

export function setupExportStore(): void {
  ipcMain.handle('app:export-data', async (event): Promise<ExportResult> => {
    // 默认目录取「文档」；拿不到就退回 userData，反正对话框允许用户改
    let defaultDir = app.getPath('userData')
    try {
      defaultDir = app.getPath('documents')
    } catch {
      /* 个别环境无文档目录，退回 userData */
    }
    // 模态挂在**发起调用的那个窗口**上（2026-11-11 起入口在设置窗口里；以前固定取
    // getAllWindows()[0] 会挂到岛窗口上，对话框跑偏）。取不到就弹独立对话框。
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const opts = {
      title: '导出灵动岛数据',
      defaultPath: join(defaultDir, stampName()),
      filters: [{ name: '灵动岛备份', extensions: ['json'] as string[] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<'createDirectory' | 'showOverwriteConfirmation'>
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false, canceled: true, reason: 'canceled' }
    try {
      const payload = buildPayload()
      mkdirSync(join(r.filePath, '..'), { recursive: true })
      writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8')
      notifyResult('灵动岛', `已导出到 ${r.filePath}`)
      return { ok: true, path: r.filePath }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      notifyResult('灵动岛', `导出失败：${detail}`)
      return { ok: false, reason: 'failed', detail }
    }
  })
}
