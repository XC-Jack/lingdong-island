import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 收起态可裁剪组件的键（与 App.tsx 的 COLLAPSED_KEYS 保持一致） */
const COLLAPSED_KEYS = ['pet', 'clock', 'battery', 'net', 'todo'] as const
type CollapsedKey = (typeof COLLAPSED_KEYS)[number]

interface PagesCustom {
  pages: number[]
  collapsed: Record<CollapsedKey, boolean>
}

interface PrefsShape {
  pagesCustom?: PagesCustom
  shelfView?: string
}

const EMPTY: PrefsShape = {}

let file: string

/** 校验并规整 pagesCustom；不合法一律返回 undefined（调用方回落默认） */
function normalizePagesCustom(v: unknown): PagesCustom | undefined {
  if (!v || typeof v !== 'object') return undefined
  const raw = v as Partial<PagesCustom>
  // 顺序即用户自定义的页面顺序（US-032 反馈）：只做去重 + 范围校验 + 非空，不排序。
  const pages = Array.isArray(raw.pages)
    ? [...new Set(raw.pages.filter((n) => Number.isInteger(n) && n >= 0 && n <= 3))]
    : []
  if (pages.length === 0) return undefined
  const collapsed: Record<CollapsedKey, boolean> = { pet: true, clock: true, battery: true, net: true, todo: true }
  if (raw.collapsed && typeof raw.collapsed === 'object') {
    const c = raw.collapsed as Record<string, unknown>
    for (const k of COLLAPSED_KEYS) {
      if (typeof c[k] === 'boolean') collapsed[k] = c[k] as boolean
    }
  }
  return { pages, collapsed }
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
    return out
  } catch {
    return { ...EMPTY }
  }
}

function save(data: PrefsShape): void {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * 界面偏好存储（US-032 页面自定义）：JSON 文件持久化在 userData 目录。
 * 为什么不用渲染层 localStorage：本机实测 file:// 来源的 localStorage 跨进程重启会丢失
 * （写入后优雅退出再启动读回为 null），页面裁剪偏好必须跨重启保留，故走主进程文件。
 */
export function setupPrefsStore(): void {
  file = join(app.getPath('userData'), 'prefs.json')
  mkdirSync(app.getPath('userData'), { recursive: true })

  ipcMain.handle('prefs:get', (): PrefsShape => load())

  ipcMain.handle('prefs:set', (_e, payload: unknown): PrefsShape => {
    const data = load()
    const { pagesCustom, shelfView } = (payload ?? {}) as { pagesCustom?: unknown; shelfView?: unknown }
    const pc = normalizePagesCustom(pagesCustom)
    if (pc) data.pagesCustom = pc
    else if (pagesCustom !== undefined) delete data.pagesCustom // 显式传 pagesCustom 才动它，未传保持原值
    const sv = normalizeShelfView(shelfView)
    if (sv) data.shelfView = sv
    else if (shelfView !== undefined) delete data.shelfView
    save(data)
    return data
  })
}
