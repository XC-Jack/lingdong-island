import { app, ipcMain, session } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CleanupItem,
  CleanupItemDef,
  CleanupItemScan,
  CleanupRunResult,
  CleanupScanResult,
  CleanupScope,
  CleanupTargetId
} from '../shared/types'
import { getUpdateStage } from './updater'
import { runPowerShell } from './runPs'
import { errText, rawFs, removeChildren, sumPaths } from './fsUtil'

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

/** 删除一个文件/目录；返回失败原因（成功为 null） */
async function removePath(target: string): Promise<string | null> {
  try {
    await rawFs.rm(target, { recursive: true, force: true })
    return null
  } catch (e) {
    return errText(e)
  }
}

/* ---------- 缩略图 / 图标缓存 ---------- */

function explorerCacheDir(): string {
  return join(localAppDataDir(), 'Microsoft', 'Windows', 'Explorer')
}

const THUMB_FILE_RE = /^(thumbcache|iconcache).*\.db$/i

async function thumbCacheFiles(): Promise<string[]> {
  const dir = explorerCacheDir()
  try {
    const entries = await rawFs.readdir(dir, { withFileTypes: true })
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

/**
 * 用 Shell 的回收站命名空间统计条目数与总大小（Namespace(10) = 回收站）。
 *
 * Shell 对**文件夹**的 `Size` 恒为 0（里面有文件也一样），所以文件夹改用显式栈
 * 递归累加文件大小；遇到 reparse point（junction / 符号链接）不进入，避免循环。
 * 输出 `条目数;字节数`，条目数用来判断「0 字节但确实有东西」（如空文件夹）。
 */
async function recycleBinStats(): Promise<{ bytes: number; exists: boolean }> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$items = @($shell.Namespace(10).Items())
$sum = 0
foreach ($i in $items) {
  if ($i.IsFolder) {
    $stack = New-Object System.Collections.Stack
    $stack.Push($i.Path)
    while ($stack.Count -gt 0) {
      $d = $stack.Pop()
      try { $di = [System.IO.DirectoryInfo]::new($d) } catch { continue }
      try { foreach ($f in $di.EnumerateFiles()) { $sum += $f.Length } } catch { }
      try { foreach ($sd in $di.EnumerateDirectories()) { if (($sd.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { $stack.Push($sd.FullName) } } } catch { }
    }
  } else {
    $sum += $i.Size
  }
}
[Console]::Out.Write([string]$items.Count + ';' + [string]$sum)
`
  try {
    const out = await runPowerShell(script, 60_000)
    const [countText, sizeText] = out.split(';')
    const count = Number.parseInt(countText ?? '', 10)
    const bytes = Number.parseInt(sizeText ?? '', 10)
    return {
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
      exists: Number.isFinite(count) && count > 0
    }
  } catch {
    return { bytes: 0, exists: false }
  }
}

async function emptyRecycleBin(): Promise<string[]> {
  // 回收站已经是空的时候，Clear-RecycleBin 会抛「系统找不到指定的文件」
  // （FailedToClearRecycleBin），这是误报。先看条目数；清完再确认一次。
  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
if (@($shell.Namespace(10).Items()).Count -eq 0) { [Console]::Out.Write('EMPTY'); exit 0 }
try {
  Clear-RecycleBin -Force -Confirm:$false
  [Console]::Out.Write('CLEARED')
} catch {
  $after = New-Object -ComObject Shell.Application
  if (@($after.Namespace(10).Items()).Count -eq 0) { [Console]::Out.Write('CLEARED') }
  else { [Console]::Error.Write('FAILED: ' + $_.Exception.Message); exit 1 }
}
`
  try {
    await runPowerShell(script, 60_000)
    return []
  } catch (e) {
    // 只留第一行原因，不把整段 PowerShell 堆栈丢给用户
    const firstLine = errText(e).split(/\r?\n/)[0].replace(/^FAILED:\s*/, '')
    return [`回收站没清干净：${firstLine}`]
  }
}

/* ---------- 清理项目录 ---------- */

interface Target {
  id: CleanupTargetId
  scope: CleanupScope
  label: string
  hint: string
  defaultChecked: boolean
  /** 当前占用；exists 用来区分「0 字节但条目还在」（回收站空文件夹） */
  scan: () => Promise<CleanupItemScan>
  /** 执行清理，返回给用户看的失败/跳过说明 */
  clean: () => Promise<string[]>
}

/** 只关心字节的扫描：exists 按「有字节」判断 */
function bytesOnly(scan: () => Promise<number>): () => Promise<CleanupItemScan> {
  return async () => {
    const bytes = await scan()
    return { bytes, exists: bytes > 0 }
  }
}

const TARGETS: Target[] = [
  /* ===== 灵动岛自己的缓存 ===== */
  {
    id: 'update-cache',
    scope: 'app',
    label: '更新安装包缓存',
    hint: '可以删。下载新版本时留下的安装包，通常一百多 MB；删了不影响已安装的版本，下次更新重新下载。',
    defaultChecked: true,
    scan: bytesOnly(() => sumPaths([updateCacheDir()])),
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
    scan: bytesOnly(() =>
      sumPaths([join(userDataDir(), 'Cache'), join(userDataDir(), 'Code Cache')])
    ),
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
    scan: bytesOnly(() => sumPaths([join(userDataDir(), 'lyrics')])),
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
    scan: bytesOnly(() =>
      sumPaths([join(userDataDir(), 'startup.log'), join(userDataDir(), 'collapse-log.txt')])
    ),
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
    scan: bytesOnly(() => sumPaths([app.getPath('temp')])),
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
    scan: bytesOnly(() =>
      sumPaths([
        join(localAppDataDir(), 'CrashDumps'),
        join(localAppDataDir(), 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
        join(localAppDataDir(), 'Microsoft', 'Windows', 'WER', 'ReportQueue')
      ])
    ),
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
    scan: bytesOnly(async () => {
      const files = await thumbCacheFiles()
      let total = 0
      for (const f of files) {
        try {
          total += (await rawFs.lstat(f)).size
        } catch {
          /* 文件刚好被回收，跳过 */
        }
      }
      return total
    }),
    clean: async () => {
      let skipped = 0
      const warnings: string[] = []
      for (const f of await thumbCacheFiles()) {
        try {
          await rawFs.rm(f, { force: true })
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
    scan: recycleBinStats,
    clean: () => emptyRecycleBin()
  }
]

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

/** 扫描某一项；不存在或不属于该组时返回空结果 */
export async function scanCleanupItem(rawScope: unknown, rawId: unknown): Promise<CleanupItemScan> {
  const scope = normalizeScope(rawScope)
  if (!isTargetId(rawId)) return { bytes: 0, exists: false }
  const t = TARGETS.find((x) => x.id === rawId && x.scope === scope)
  if (!t) return { bytes: 0, exists: false }
  return t.scan()
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
    const { bytes, exists } = await t.scan()
    items.push({
      id: t.id,
      label: t.label,
      hint: t.hint,
      bytes,
      defaultChecked: t.defaultChecked,
      exists
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

  // 「清理前」现场重测，不复用页面打开时扫到的数字。
  // 复用会让外部在页面停留期间删掉/新增的文件算进本次释放量（虚报或漏报）；
  // 代价只是点「清理选中项」后多等这一次统计（本机 %TEMP% 约 7 秒）。
  let beforeTotal = 0
  for (const t of selected) beforeTotal += (await t.scan()).bytes

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
