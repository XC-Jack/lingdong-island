import { app, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type {
  AdminCleanupId,
  AdminCleanupItem,
  AdminCleanupRunItem,
  AdminCleanupRunResult,
  AdminCleanupScanResult
} from '../shared/types'
import { adminTargets, buildAdminScript } from './adminScript'
import type { AdminTarget } from './adminScript'
import { errText, rawFs } from './fsUtil'
import { runPowerShell } from './runPs'

/**
 * 空间页「系统清理（需要管理员）」（SPEC-space-admin-cleanup）。
 *
 * 这些目录普通用户删不动，所以清理要提权：主进程按白名单拼一份固定脚本，
 * 用 `Start-Process -Verb RunAs` 让系统弹一次 UAC 执行，执行完读回结果。
 *
 * 安全边界：
 * - 脚本内容只由 `adminScript.ts` 按 id 生成，**没有任何来自渲染层的路径或文本**。
 * - 提权执行的脚本用 `-EncodedCommand` 直接放在命令行里，**不落成可写的 .ps1 文件**。
 *   早先的写法是把脚本写进 `%APPDATA%` 再让管理员执行那个文件，中间隔着 UAC 等待窗：
 *   同用户的进程可以在用户点「是」之前把文件换掉，用户同意的是清理、实际执行的却是别的代码。
 *   编码进命令行后，提权进程收到的内容与发起时完全一致，没有可替换的中间文件。
 * - 结果文件是唯一落盘产物：文件名随机，读取前确认是普通文件（防预先放符号链接），跑完就删。
 * - 只删目录里的内容，不删目录本身。
 * - 浏览与扫描不提权、不弹 UAC。
 */

function targets(): AdminTarget[] {
  return adminTargets(
    process.env.WINDIR || 'C:\\Windows',
    process.env.ProgramData || 'C:\\ProgramData'
  )
}

function isTargetId(v: unknown): v is AdminCleanupId {
  return typeof v === 'string' && targets().some((t) => t.id === v)
}

interface DirStats {
  bytes: number
  /** 有一处读不到就为 false：不提权的话这个数字不完整，界面按「需管理员」显示 */
  readable: boolean
}

/** 递归统计；任何一层没权限都把 readable 置 false */
async function dirStats(p: string): Promise<DirStats> {
  let st
  try {
    st = await rawFs.lstat(p)
  } catch {
    return { bytes: 0, readable: true } // 不存在 = 0，不算读不到
  }
  if (st.isSymbolicLink()) return { bytes: 0, readable: true }
  if (!st.isDirectory()) return { bytes: st.size, readable: true }

  let entries: Dirent[]
  try {
    entries = await rawFs.readdir(p, { withFileTypes: true })
  } catch {
    return { bytes: 0, readable: false }
  }
  let bytes = 0
  let readable = true
  for (const e of entries) {
    const full = join(p, e.name)
    if (e.isDirectory()) {
      const r = await dirStats(full)
      bytes += r.bytes
      readable = readable && r.readable
    } else if (e.isFile()) {
      try {
        bytes += (await rawFs.lstat(full)).size
      } catch {
        readable = false
      }
    }
  }
  return { bytes, readable }
}

async function measure(dirs: string[]): Promise<DirStats> {
  let bytes = 0
  let readable = true
  for (const d of dirs) {
    const r = await dirStats(d)
    bytes += r.bytes
    readable = readable && r.readable
  }
  return { bytes, readable }
}

export async function scanAdminCleanup(): Promise<AdminCleanupScanResult> {
  const items: AdminCleanupItem[] = []
  for (const t of targets()) {
    if (!t.dirs) {
      items.push({ id: t.id, label: t.label, hint: t.hint, bytes: 0, known: false, defaultChecked: true })
      continue
    }
    const m = await measure(t.dirs)
    items.push({
      id: t.id,
      label: t.label,
      hint: t.hint,
      bytes: m.bytes,
      known: m.readable,
      defaultChecked: true
    })
  }
  return { items, scannedAt: Date.now() }
}

/* ---------- 清理 ---------- */

interface RawResult {
  id?: string
  before?: number
  after?: number
  warnings?: string[]
}

/** 只接受普通文件：符号链接/目录一律当「没有结果」，避免被重定向到别的路径 */
async function readRegularFile(p: string): Promise<string | null> {
  try {
    const st = await fs.lstat(p)
    if (st.isSymbolicLink() || !st.isFile()) return null
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

export async function runAdminCleanup(rawIds: unknown): Promise<AdminCleanupRunResult> {
  const ids = (Array.isArray(rawIds) ? rawIds : []).filter(isTargetId)
  if (ids.length === 0) {
    return {
      ok: false,
      canceled: false,
      freedBytes: 0,
      items: [],
      warnings: ['没有选中任何项目。'],
      scan: await scanAdminCleanup()
    }
  }

  const list = targets()
  const dir = join(app.getPath('userData'), 'admin-cleanup')
  await fs.mkdir(dir, { recursive: true })
  // 随机名：让同用户进程没法提前猜到路径去占位（放符号链接或旧结果）
  const resultPath = join(dir, `result-${randomBytes(8).toString('hex')}.json`)

  const cleanupTemp = async (): Promise<void> => {
    await fs.rm(resultPath, { force: true })
  }

  // 提权执行：等它结束并拿退出码。UAC 被拒绝时 Start-Process 会抛错（1223 /「已被用户取消」）
  let exitCode = 0
  try {
    // 脚本以 UTF-16LE + Base64 放进命令行，提权进程执行的正是这段内容，没有可替换的中间文件。
    // 四个管理员项全选时编码后 13,016 字符，远低于 Windows 命令行 32,767 字符上限（实测见 SPEC）。
    const encoded = Buffer.from(buildAdminScript(ids, list, resultPath), 'utf16le').toString('base64')
    const out = await runPowerShell(
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' -Verb RunAs -Wait -PassThru; [Console]::Out.Write([string]$p.ExitCode)`,
      600_000
    )
    const n = Number.parseInt(out.trim(), 10)
    if (Number.isFinite(n)) exitCode = n
  } catch (e) {
    await cleanupTemp()
    const msg = errText(e)
    // UAC 取消：中文系统报「操作已被用户取消」，英文系统是
    // "The operation was canceled by the user."，错误码 1223；三种都认。
    const canceled = /取消|cancel|1223/i.test(msg)
    return {
      ok: false,
      canceled,
      freedBytes: 0,
      items: [],
      warnings: [canceled ? '已取消管理员授权，没有删除任何东西。' : `提权执行失败：${msg}`],
      scan: await scanAdminCleanup()
    }
  }

  const warnings: string[] = []
  const items: AdminCleanupRunItem[] = []
  let freed = 0
  let raw: RawResult[] = []
  try {
    const file = await readRegularFile(resultPath)
    if (file === null) throw new Error('result is not a regular file')
    const parsed = JSON.parse(file.replace(/^\uFEFF/, '')) as RawResult | RawResult[]
    raw = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    warnings.push('提权脚本没有留下结果文件，这次清理的结果无法确认。')
  }
  await cleanupTemp()

  const haveResult = raw.length > 0
  for (const id of ids) {
    const r = raw.find((x) => x.id === id)
    const t = list.find((x) => x.id === id)
    if (!r) {
      if (haveResult) warnings.push(`「${t?.label ?? id}」没有返回结果，可能没清成。`)
      continue
    }
    if (r.warnings && r.warnings.length > 0) {
      for (const w of r.warnings) warnings.push(`${t?.label ?? id}：${w}`)
    }
    const before = typeof r.before === 'number' ? r.before : -1
    const after = typeof r.after === 'number' ? r.after : -1
    // before/after 都为 -1 表示这次没拿到大小（传递优化缓存的系统接口失败），不算 0 释放
    const measured = before >= 0 && after >= 0
    const itemFreed = measured && after <= before ? before - after : 0
    freed += itemFreed
    items.push({ id, label: t?.label ?? id, freedBytes: itemFreed, measured })
  }
  if (exitCode !== 0) warnings.push(`提权脚本退出码 ${exitCode}，可能有项目没清完。`)

  return {
    ok: true,
    canceled: false,
    freedBytes: freed,
    items,
    warnings,
    scan: await scanAdminCleanup()
  }
}

/** 注册 IPC，必须在 app.whenReady 后调用 */
export function setupAdminCleanupStore(): void {
  ipcMain.handle('adminclean:scan', () => scanAdminCleanup())
  ipcMain.handle('adminclean:run', (_e, ids: unknown) => runAdminCleanup(ids))
}
