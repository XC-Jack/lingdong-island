import { app, ipcMain, session } from 'electron'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CleanupItem,
  CleanupItemDef,
  CleanupRunResult,
  CleanupScanResult,
  CleanupScope,
  CleanupTargetId
} from '../shared/types'
import { getUpdateStage } from './updater'
import { runPowerShell } from './runPs'

/**
 * 设置「空间」页的扫描与清理（SPEC-space-cleanup / SPEC-space-system-junk）。
 *
 * 设计原则：
 * - **白名单写死在这里**，渲染层只传 scope + id；任何路径都不从页面传进来。
 * - 分两组：app=灵动岛自己的缓存；system=Windows 与其它软件留下的垃圾。
 * - system 组只做不需要管理员权限的项目；需要提权的更新缓存 / Windows.old 明确不做。
 * - 删除全部是「尽力而为」：被占用的文件跳过并汇报数量，不让整组失败。
 * - `freedBytes` 用「清理前后重新扫描的差值」算，不拿勾选时的旧数字冒充结果。
 */

/** 用户数据目录（%APPDATA%\lingdong-island） */
function userDataDir(): string {
  return app.getPath('userData')
}

/** %LOCALAPPDATA%（Electron 没有直接给这个路径的 getPath） */
function localAppDataDir(): string {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
}

/**
 * electron-updater 的缓存目录。
 * 路径规则与 `updater.ts` 的 `updateCacheDir()` 保持一致：
 * Windows 下是 %LOCALAPPDATA%\<app.name>-updater，里面有完整安装包和 pending 半截文件。
 */
function updateCacheDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, `${app.name}-updater`)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 递归求一个路径的占用；不存在或读不到都算 0，不抛错 */
async function pathSize(target: string): Promise<number> {
  let st
  try {
    st = await fs.lstat(target)
  } catch {
    return 0
  }
  // 符号链接只算链接本身，不跟进去（避免指向系统目录时扫出天文数字）
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size

  let entries: Dirent[]
  try {
    entries = await fs.readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    total += await pathSize(join(target, e.name))
  }
  return total
}

async function sumPaths(paths: string[]): Promise<number> {
  let total = 0
  for (const p of paths) total += await pathSize(p)
  return total
}

/** 删除一个文件/目录；返回失败原因（成功为 null） */
async function removePath(target: string): Promise<string | null> {
  try {
    await fs.rm(target, { recursive: true, force: true })
    return null
  } catch (e) {
    return errText(e)
  }
}

/**
 * 清空一个目录里的内容（不删目录本身）。
 * 被占用的文件（EBUSY/EPERM/EACCES/ENOTEMPTY）记为「跳过」，其它错误原样汇报。
 */
async function removeChildren(dir: string): Promise<{ skipped: number; warnings: string[] }> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { skipped: 0, warnings: [] }
  }
  let skipped = 0
  const warnings: string[] = []
  for (const e of entries) {
    try {
      await fs.rm(join(dir, e.name), { recursive: true, force: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') {
        skipped += 1
      } else {
        warnings.push(errText(err))
      }
    }
  }
  return { skipped, warnings }
}

/* ---------- 缩略图 / 图标缓存 ---------- */

function explorerCacheDir(): string {
  return join(localAppDataDir(), 'Microsoft', 'Windows', 'Explorer')
}

const THUMB_FILE_RE = /^(thumbcache|iconcache).*\.db$/i

async function thumbCacheFiles(): Promise<string[]> {
  const dir = explorerCacheDir()
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const e of entries) {
      if (e.isFile() && THUMB_FILE_RE.test(e.name)) files.push(join(dir, e.name))
    }
    return files
  } catch {
    return []
  }
}

/* ---------- 回收站（PowerShell + Shell COM） ---------- */

/** 用 Shell 的回收站命名空间统计总大小（Namespace(10) = 回收站） */
async function recycleBinSize(): Promise<number> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$shell = New-Object -ComObject Shell.Application',
    '$sum = 0',
    'foreach ($i in $shell.Namespace(10).Items()) { $sum += $i.Size }',
    '[Console]::Out.Write([string]$sum)'
  ].join('; ')
  try {
    const out = await runPowerShell(script)
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

async function emptyRecycleBin(): Promise<string[]> {
  const script = ["$ErrorActionPreference='Stop'", 'Clear-RecycleBin -Force -Confirm:$false'].join('; ')
  try {
    await runPowerShell(script, 60_000)
    return []
  } catch (e) {
    return [`回收站没清干净：${errText(e)}`]
  }
}

/* ---------- 清理项目录 ---------- */

interface Target {
  id: CleanupTargetId
  scope: CleanupScope
  label: string
  hint: string
  defaultChecked: boolean
  /** 当前占用（字节） */
  scan: () => Promise<number>
  /** 执行清理，返回给用户看的失败/跳过说明 */
  clean: () => Promise<string[]>
}

const TARGETS: Target[] = [
  /* ===== 灵动岛自己的缓存 ===== */
  {
    id: 'update-cache',
    scope: 'app',
    label: '更新安装包缓存',
    hint: '可以删。下载新版本时留下的安装包，通常一百多 MB；删了不影响已安装的版本，下次更新重新下载。',
    defaultChecked: true,
    scan: () => sumPaths([updateCacheDir()]),
    clean: async () => {
      const err = await removePath(updateCacheDir())
      return err ? [`更新安装包缓存没清干净：${err}`] : []
    }
  },
  {
    id: 'web-cache',
    scope: 'app',
    label: '网页缓存',
    hint: '可以删。界面渲染用的网页与脚本缓存；删了不影响数据，下次打开会自己重建。',
    defaultChecked: true,
    scan: () => sumPaths([join(userDataDir(), 'Cache'), join(userDataDir(), 'Code Cache')]),
    clean: async () => {
      // 运行中的 Chromium 缓存文件可能被占用，用官方 API 清，不直接删目录
      try {
        const ses = session.defaultSession
        await ses.clearCache()
        await ses.clearCodeCaches({})
        return []
      } catch (e) {
        return [`网页缓存没清干净：${errText(e)}`]
      }
    }
  },
  {
    id: 'lyrics',
    scope: 'app',
    label: '歌词缓存',
    hint: '可以删。查过的歌词存在本机；删了下次播放时联网重查，断网时会暂时显示「暂无歌词」。',
    defaultChecked: true,
    scan: () => sumPaths([join(userDataDir(), 'lyrics')]),
    clean: async () => {
      const err = await removePath(join(userDataDir(), 'lyrics'))
      return err ? [`歌词缓存没清干净：${err}`] : []
    }
  },
  {
    id: 'logs',
    scope: 'app',
    label: '诊断日志',
    hint: '可以删，删了不影响使用；但以后真出故障时就没有记录可查，所以默认没勾。',
    defaultChecked: false,
    scan: () =>
      sumPaths([join(userDataDir(), 'startup.log'), join(userDataDir(), 'collapse-log.txt')]),
    clean: async () => {
      const warnings: string[] = []
      for (const p of [join(userDataDir(), 'startup.log'), join(userDataDir(), 'collapse-log.txt')]) {
        const err = await removePath(p)
        if (err) warnings.push(`诊断日志没清干净：${err}`)
      }
      return warnings
    }
  },

  /* ===== 系统垃圾（不需要管理员权限） ===== */
  {
    id: 'temp',
    scope: 'system',
    label: '临时文件',
    hint: '可以删。各类软件运行时留下的临时文件；正在被使用的会自动跳过。',
    defaultChecked: true,
    scan: () => sumPaths([app.getPath('temp')]),
    clean: async () => {
      const { skipped, warnings } = await removeChildren(app.getPath('temp'))
      const out = [...warnings]
      if (skipped > 0) out.push(`临时文件里有 ${skipped} 个正在被其他程序使用，已跳过。`)
      return out
    }
  },
  {
    id: 'crash-dumps',
    scope: 'system',
    label: '崩溃转储与错误报告',
    hint: '可以删。程序崩溃时生成的记录文件，删了不影响系统和其他软件。',
    defaultChecked: true,
    scan: () =>
      sumPaths([
        join(localAppDataDir(), 'CrashDumps'),
        join(localAppDataDir(), 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
        join(localAppDataDir(), 'Microsoft', 'Windows', 'WER', 'ReportQueue')
      ]),
    clean: async () => {
      const warnings: string[] = []
      for (const p of [
        join(localAppDataDir(), 'CrashDumps'),
        join(localAppDataDir(), 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
        join(localAppDataDir(), 'Microsoft', 'Windows', 'WER', 'ReportQueue')
      ]) {
        const err = await removePath(p)
        if (err) warnings.push(`崩溃转储没清干净：${err}`)
      }
      return warnings
    }
  },
  {
    id: 'thumb-cache',
    scope: 'system',
    label: '缩略图缓存',
    hint: '可以删。资源管理器为图片和视频生成的预览图；被资源管理器占用的会自动跳过。',
    defaultChecked: true,
    scan: async () => {
      const files = await thumbCacheFiles()
      let total = 0
      for (const f of files) {
        try {
          total += (await fs.lstat(f)).size
        } catch {
          /* 文件刚好被回收，跳过 */
        }
      }
      return total
    },
    clean: async () => {
      let skipped = 0
      const warnings: string[] = []
      for (const f of await thumbCacheFiles()) {
        try {
          await fs.rm(f, { force: true })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? ''
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') skipped += 1
          else warnings.push(errText(err))
        }
      }
      if (skipped > 0) {
        warnings.push(`缩略图缓存有 ${skipped} 个文件正被资源管理器占用，已跳过；关掉资源管理器窗口后再试。`)
      }
      return warnings
    }
  },
  {
    id: 'recycle-bin',
    scope: 'system',
    label: '回收站',
    hint: '会永久删除你放进回收站的文件，清空后不能恢复，所以默认没勾。',
    defaultChecked: false,
    scan: () => recycleBinSize(),
    clean: () => emptyRecycleBin()
  }
]

/**
 * 最近一次扫描到的各项大小（键 `scope:id`）。
 *
 * 为什么需要：`%TEMP%` 大的时候递归统计要好几秒（本机实测 10.7 GB / 约 7 秒）。
 * 清理时如果为了算「释放了多少」再扫一遍，点击后要干等同样的时间。
 * 页面刚扫过的数字直接拿来当「清理前」的基准，清理后只重扫一次，就够准了。
 */
const lastSizes = new Map<string, number>()

function sizeKey(scope: CleanupScope, id: CleanupTargetId): string {
  return `${scope}:${id}`
}

function normalizeScope(v: unknown): CleanupScope {
  return v === 'system' ? 'system' : 'app'
}

/** 某一组的清理项定义（不含大小）；页面先拿它渲染，「计算中…」逐项替换成实际数字 */
export function cleanupItems(rawScope: unknown): CleanupItemDef[] {
  const scope = normalizeScope(rawScope)
  return TARGETS.filter((t) => t.scope === scope).map(({ id, label, hint, defaultChecked }) => ({
    id,
    label,
    hint,
    defaultChecked
  }))
}

/** 扫描某一项；不存在或不属于该组时返回 0 */
export async function scanCleanupItem(rawScope: unknown, rawId: unknown): Promise<number> {
  const scope = normalizeScope(rawScope)
  if (!isTargetId(rawId)) return 0
  const t = TARGETS.find((x) => x.id === rawId && x.scope === scope)
  if (!t) return 0
  const bytes = await t.scan()
  lastSizes.set(sizeKey(scope, t.id), bytes)
  return bytes
}

function isTargetId(v: unknown): v is CleanupTargetId {
  return typeof v === 'string' && TARGETS.some((t) => t.id === v)
}

/** 扫描某一组的全部清理项；页面进入时与清理后各调一次 */
export async function scanCleanup(rawScope: unknown): Promise<CleanupScanResult> {
  const scope = normalizeScope(rawScope)
  const items: CleanupItem[] = []
  for (const t of TARGETS) {
    if (t.scope !== scope) continue
    const bytes = await t.scan()
    lastSizes.set(sizeKey(scope, t.id), bytes)
    items.push({
      id: t.id,
      label: t.label,
      hint: t.hint,
      bytes,
      defaultChecked: t.defaultChecked,
      exists: bytes > 0
    })
  }
  return {
    scope,
    items,
    totalBytes: items.reduce((n, i) => n + i.bytes, 0),
    scannedAt: Date.now()
  }
}

/**
 * 执行清理。ids 来自渲染层（任意值），这里按 scope + 白名单过滤；
 * 不在白名单里的 id 一律忽略，不会拼出任何路径。
 */
export async function runCleanup(rawScope: unknown, rawIds: unknown): Promise<CleanupRunResult> {
  const scope = normalizeScope(rawScope)
  const wanted = new Set<CleanupTargetId>(
    Array.isArray(rawIds) ? rawIds.filter(isTargetId) : []
  )
  const warnings: string[] = []

  // 下载中 / 暂停 / 已下好等安装：更新缓存目录正被使用，跳过而不是删半截
  const stage = getUpdateStage()
  if (
    wanted.has('update-cache') &&
    (stage === 'downloading' || stage === 'paused' || stage === 'ready')
  ) {
    wanted.delete('update-cache')
    warnings.push('更新包正在下载或已下好等着安装，这一项这次没清。')
  }

  const selected = TARGETS.filter((t) => t.scope === scope && wanted.has(t.id))

  // 「清理前」优先用页面刚扫描到的数字；没有缓存才退回实测。
  // 慢目录（%TEMP%）只在页面打开时扫一次，点清理不再干等一遍。
  let beforeTotal = 0
  let haveAll = selected.length > 0
  for (const t of selected) {
    const cached = lastSizes.get(sizeKey(scope, t.id))
    if (cached === undefined) {
      haveAll = false
      break
    }
    beforeTotal += cached
  }
  if (!haveAll) {
    beforeTotal = 0
    for (const t of selected) beforeTotal += await t.scan()
  }

  for (const t of selected) {
    warnings.push(...(await t.clean()))
  }

  const after = await scanCleanup(scope)
  const afterById = new Map(after.items.map((i) => [i.id, i.bytes]))
  let afterTotal = 0
  for (const t of selected) afterTotal += afterById.get(t.id) ?? 0

  return {
    ok: true,
    freedBytes: Math.max(0, beforeTotal - afterTotal),
    scan: after,
    warnings
  }
}

/** 注册 IPC，必须在 app.whenReady 后调用 */
export function setupCleanupStore(): void {
  ipcMain.handle('cleanup:items', (_e, scope: unknown) => cleanupItems(scope))
  ipcMain.handle('cleanup:scan-item', (_e, scope: unknown, id: unknown) => scanCleanupItem(scope, id))
  ipcMain.handle('cleanup:run', (_e, scope: unknown, ids: unknown) => runCleanup(scope, ids))
}
