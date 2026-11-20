import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import type {
  ResidueBackup,
  ResidueCleanResult,
  ResidueItem,
  ResidueKind,
  ResidueScanResult
} from '../shared/types'
import { runCommand, runPowerShell } from './runPs'
import { errText, existsConservative } from './fsUtil'

/**
 * 卸载残留（SPEC-space-residue）。
 *
 * 只做**当前用户**范围：HKCU 里失效的卸载注册项、用户桌面与用户开始菜单里
 * 目标已不存在的快捷方式、全部快捷方式都失效的开始菜单文件夹。
 *
 * 三条硬规则：
 * 1. 判定「不存在」必须保守：没权限看（EPERM/EACCES）一律当作存在，宁可漏判也不误删。
 * 2. 清理一律先进备份区（`userData/cleanup-backup/<批次>`），注册表先 `reg export` 再删。
 * 3. 渲染层只传 id，路径只存在主进程和上一份扫描结果里。
 */

/** reg.exe 的键路径（不带冒号） */
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
/** PowerShell 的注册表驱动器路径（必须带冒号，否则 Get-ChildItem 静默返回空） */
const UNINSTALL_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

interface RawUninstall {
  key: string
  name: string
  uninstall: string
  loc: string
}

interface RawShortcut {
  lnk: string
  target: string
}

/** 上一份扫描结果：清理时按 id 回查，渲染层无法凭空造路径 */
let lastScan = new Map<string, ResidueItem>()

function idOf(kind: ResidueKind, path: string): string {
  return createHash('sha1').update(`${kind}\0${path}`).digest('hex').slice(0, 16)
}

/** 备份区根目录：跟着应用数据走，卸载本应用不会自动删（见数据规则的声明） */
function backupRoot(): string {
  return join(app.getPath('userData'), 'cleanup-backup')
}

/**
 * 用户开始菜单。
 * 优先读 `%APPDATA%` 环境变量（与清理系统垃圾时读 `%LOCALAPPDATA%` 同一套做法，
 * 也让 E2E 能把根目录指到假目录）；没有才退回 Electron 的 appData。
 */
function startMenuDir(): string {
  const base = process.env.APPDATA || app.getPath('appData')
  return join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
}

/** Windows 用户桌面（走系统已知文件夹，不按 USERPROFILE 拼） */
function desktopDir(): string {
  return app.getPath('desktop')
}

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)
}

/** 从 UninstallString 里取出 exe 路径；取不出（winget、appx 等命令）返回 null */
function exeFromCommand(cmd: string): string | null {
  const s = cmd.trim()
  if (!s) return null
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    return end > 1 ? s.slice(1, end) : null
  }
  const m = /^(.+?\.exe)(?=\s|$)/i.exec(s)
  return m ? m[1] : null
}

/* ---------- 扫描 ---------- */

async function listUninstallEntries(): Promise<RawUninstall[]> {
  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$ErrorActionPreference='SilentlyContinue'",
    '$items = @()',
    `$root = '${UNINSTALL_PS}'`,
    'foreach ($k in Get-ChildItem $root) {',
    '  $p = Get-ItemProperty $k.PSPath',
    '  if (-not $p.DisplayName) { continue }',
    '  $items += [pscustomobject]@{ key = $k.PSChildName; name = [string]$p.DisplayName; uninstall = [string]$p.UninstallString; loc = [string]$p.InstallLocation }',
    '}',
    'if ($items.Count -eq 0) { [Console]::Out.Write("[]") }',
    'else { [Console]::Out.Write(($items | ConvertTo-Json -Compress -Depth 3)) }'
  ].join('\n')
  const out = await runPowerShell(script, 20_000)
  if (!out) return []
  const parsed = JSON.parse(out) as RawUninstall | RawUninstall[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function psLiteral(p: string): string {
  return `'${p.replaceAll("'", "''")}'`
}

async function listShortcuts(): Promise<RawShortcut[]> {
  const roots = [desktopDir(), startMenuDir()].map(psLiteral).join(', ')
  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$ErrorActionPreference='SilentlyContinue'",
    `$roots = @(${roots})`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$items = @()',
    'foreach ($r in $roots) {',
    '  if (-not (Test-Path -LiteralPath $r)) { continue }',
    '  foreach ($f in Get-ChildItem -LiteralPath $r -Filter *.lnk -Recurse -ErrorAction SilentlyContinue) {',
    '    $sc = $shell.CreateShortcut($f.FullName)',
    '    $items += [pscustomobject]@{ lnk = $f.FullName; target = [string]$sc.TargetPath }',
    '  }',
    '}',
    'if ($items.Count -eq 0) { [Console]::Out.Write("[]") }',
    'else { [Console]::Out.Write(($items | ConvertTo-Json -Compress -Depth 3)) }'
  ].join('\n')
  const out = await runPowerShell(script, 25_000)
  if (!out) return []
  const parsed = JSON.parse(out) as RawShortcut | RawShortcut[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * 判断一条卸载记录是不是失效。
 *
 * 只认「UninstallString 里写死了绝对 exe 路径」这一种：msiexec（`/X{GUID}`）、
 * winget（`winget uninstall ...`）这类命令本身不带程序位置，靠 InstallLocation 推断
 * 容易误判——本机就有 winget 登记项的包目录被删、但 ffmpeg 仍在 `~/bin` 里能用的情况。
 * 少报一点，比把还在用的软件登记项删掉好。
 */
async function judgeUninstall(e: RawUninstall): Promise<string | null> {
  const exe = exeFromCommand(e.uninstall)
  if (!exe || !isAbsolutePath(exe)) return null
  if (await existsConservative(exe)) return null
  const loc = e.loc.trim()
  if (loc && isAbsolutePath(loc) && (await existsConservative(loc))) return null
  return `卸载程序 ${exe} 已不存在`
}

/** 列出一个目录下所有文件（递归），用于判断「开始菜单文件夹是不是只剩死链」 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFilesRecursive(full)))
    else out.push(full)
  }
  return out
}

async function listStartMenuDirs(): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      out.push(full)
      await walk(full)
    }
  }
  await walk(startMenuDir())
  return out
}

export async function scanResidue(): Promise<ResidueScanResult> {
  const warnings: string[] = []
  const items: ResidueItem[] = []

  // 1. 失效卸载注册项
  let entries: RawUninstall[] = []
  try {
    entries = await listUninstallEntries()
  } catch (e) {
    warnings.push(`读取当前用户的卸载记录失败：${errText(e)}`)
  }
  for (const e of entries) {
    let reason: string | null = null
    try {
      reason = await judgeUninstall(e)
    } catch {
      reason = null
    }
    if (!reason) continue
    const keyPath = `${UNINSTALL_KEY}\\${e.key}`
    items.push({
      id: idOf('uninstall', keyPath),
      kind: 'uninstall',
      label: e.name,
      detail: reason,
      path: keyPath,
      bytes: 0
    })
  }

  // 2. 失效快捷方式
  let shortcuts: RawShortcut[] = []
  try {
    shortcuts = await listShortcuts()
  } catch (e) {
    warnings.push(`读取快捷方式失败：${errText(e)}`)
  }

  const deadLnks = new Set<string>()
  const deadList: { lnk: string; target: string }[] = []
  for (const s of shortcuts) {
    const t = s.target.trim()
    if (!t || !isAbsolutePath(t)) continue
    if (await existsConservative(t)) continue
    deadLnks.add(s.lnk.toLowerCase())
    deadList.push({ lnk: s.lnk, target: t })
  }

  // 3. 开始菜单里「整个文件夹都失效」的目录：折叠成一项，里面的死链不再单列
  const folded: string[] = []
  const dirs = await listStartMenuDirs()
  // 路径短的（靠上层）先判，父目录已折叠时子目录自动跳过
  dirs.sort((a, b) => a.length - b.length)
  for (const dir of dirs) {
    if (folded.some((f) => dir.toLowerCase().startsWith(f.toLowerCase() + sep))) continue
    const files = await listFilesRecursive(dir)
    if (files.length === 0) continue
    let allDead = true
    let bytes = 0
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.lnk')) {
        allDead = false
        break
      }
      if (!deadLnks.has(f.toLowerCase())) {
        allDead = false
        break
      }
      try {
        bytes += (await fs.stat(f)).size
      } catch {
        /* 文件刚好没了，按 0 计 */
      }
    }
    if (!allDead) continue
    folded.push(dir)
    items.push({
      id: idOf('folder', dir),
      kind: 'folder',
      label: basename(dir),
      detail: `${files.length} 个快捷方式全部失效`,
      path: dir,
      bytes
    })
  }

  for (const d of deadList) {
    if (folded.some((f) => d.lnk.toLowerCase().startsWith(f.toLowerCase() + sep))) continue
    items.push({
      id: idOf('shortcut', d.lnk),
      kind: 'shortcut',
      label: basename(d.lnk),
      detail: `目标 ${d.target} 已不存在`,
      path: d.lnk,
      bytes: 0
    })
  }

  lastScan = new Map(items.map((i) => [i.id, i]))
  return { items, scannedAt: Date.now(), warnings }
}

/* ---------- 清理与备份 ---------- */

interface ManifestEntry {
  kind: ResidueKind
  label: string
  path: string
  /** 文件类：备份里的实际位置 */
  backup?: string
  /** 注册表类：导出的 .reg 文件 */
  regFile?: string
}

interface Manifest {
  createdAt: number
  bytes: number
  files: ManifestEntry[]
  registry: ManifestEntry[]
  restored?: boolean
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function writeManifest(dir: string, m: Manifest): Promise<void> {
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8')
}

/** 移动（同盘 rename；跨盘退化成复制 + 删除） */
async function movePath(from: string, to: string): Promise<void> {
  await fs.mkdir(dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fs.cp(from, to, { recursive: true })
    await fs.rm(from, { recursive: true, force: true })
  }
}

export async function cleanResidue(rawIds: unknown): Promise<ResidueCleanResult> {
  const ids = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === 'string') : []
  const picked = ids
    .map((id) => lastScan.get(id))
    .filter((x): x is ResidueItem => Boolean(x))
  const warnings: string[] = []
  if (picked.length === 0) {
    return { ok: true, removed: 0, freedBytes: 0, warnings, backupId: null, scan: await scanResidue() }
  }

  // 批次目录：同一秒内重复清理时加序号，绝不覆盖已有备份
  const base = stamp()
  let batchId = base
  let dir = join(backupRoot(), batchId)
  for (let n = 2; await existsConservative(dir); n += 1) {
    batchId = `${base}-${n}`
    dir = join(backupRoot(), batchId)
  }
  await fs.mkdir(dir, { recursive: true })

  const manifest: Manifest = { createdAt: Date.now(), bytes: 0, files: [], registry: [] }
  let removed = 0
  let freed = 0
  let seq = 0

  for (const item of picked) {
    seq += 1
    if (item.kind === 'uninstall') {
      const regFile = join(dir, 'reg', `${seq}.reg`)
      await fs.mkdir(dirname(regFile), { recursive: true })
      try {
        await runCommand('reg.exe', ['export', item.path, regFile, '/y'])
      } catch (e) {
        warnings.push(`注册表项「${item.label}」没能备份，已跳过：${errText(e)}`)
        continue
      }
      try {
        await runCommand('reg.exe', ['delete', item.path, '/f'])
      } catch (e) {
        warnings.push(`注册表项「${item.label}」没删掉：${errText(e)}`)
        continue
      }
      manifest.registry.push({ kind: item.kind, label: item.label, path: item.path, regFile })
      removed += 1
    } else {
      if (!(await existsConservative(item.path))) {
        warnings.push(`「${item.label}」已经不在了，跳过。`)
        continue
      }
      const target = join(dir, 'files', String(seq), basename(item.path))
      try {
        await movePath(item.path, target)
      } catch (e) {
        warnings.push(`「${item.label}」没能移入备份，已跳过：${errText(e)}`)
        continue
      }
      manifest.files.push({ kind: item.kind, label: item.label, path: item.path, backup: target })
      manifest.bytes += item.bytes
      removed += 1
      freed += item.bytes
    }
    await writeManifest(dir, manifest)
  }

  if (removed === 0) {
    // 一项都没清成：别在备份区留下一个空批次
    await fs.rm(dir, { recursive: true, force: true })
    return { ok: true, removed: 0, freedBytes: 0, warnings, backupId: null, scan: await scanResidue() }
  }
  await writeManifest(dir, manifest)
  return {
    ok: true,
    removed,
    freedBytes: freed,
    warnings,
    backupId: batchId,
    scan: await scanResidue()
  }
}

/* ---------- 备份列表 / 撤销 ---------- */

const BATCH_ID_RE = /^\d{8}-\d{6}(-\d+)?$/

function validBatchId(v: unknown): v is string {
  return typeof v === 'string' && BATCH_ID_RE.test(v)
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8')
    return JSON.parse(raw) as Manifest
  } catch {
    return null
  }
}

export async function listResidueBackups(): Promise<ResidueBackup[]> {
  let names: string[] = []
  try {
    const entries = await fs.readdir(backupRoot(), { withFileTypes: true })
    names = entries.filter((e) => e.isDirectory() && BATCH_ID_RE.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const out: ResidueBackup[] = []
  for (const id of names) {
    const m = await readManifest(join(backupRoot(), id))
    if (!m) continue
    out.push({
      id,
      createdAt: m.createdAt,
      files: m.files.length,
      registry: m.registry.length,
      bytes: m.bytes,
      restored: Boolean(m.restored)
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function undoResidueBackup(
  rawId: unknown
): Promise<{ ok: boolean; warnings: string[]; backups: ResidueBackup[] }> {
  const warnings: string[] = []
  if (!validBatchId(rawId)) {
    return { ok: false, warnings: ['备份编号无效。'], backups: await listResidueBackups() }
  }
  const dir = join(backupRoot(), rawId)
  const m = await readManifest(dir)
  if (!m) {
    return { ok: false, warnings: ['这一批备份的清单读不到，没法撤销。'], backups: await listResidueBackups() }
  }
  if (m.restored) {
    return { ok: false, warnings: ['这一批已经撤销过了。'], backups: await listResidueBackups() }
  }

  for (const f of m.files) {
    if (!f.backup) continue
    // 上一次撤销已经把它搬回去了，这里跳过（允许修掉冲突后再点一次撤销）
    if (!(await existsConservative(f.backup))) continue
    if (await existsConservative(f.path)) {
      warnings.push(`「${f.label}」的原位置已经有同名文件，没有覆盖，备份仍保留。`)
      continue
    }
    try {
      await movePath(f.backup, f.path)
    } catch (e) {
      warnings.push(`「${f.label}」没能恢复：${errText(e)}`)
    }
  }
  for (const r of m.registry) {
    if (!r.regFile) continue
    try {
      await runCommand('reg.exe', ['import', r.regFile])
    } catch (e) {
      warnings.push(`注册表项「${r.label}」没能恢复：${errText(e)}`)
    }
  }

  // 只有全部恢复成功才标记已撤销；有没恢复的（比如原位置已有同名文件）就把批次留着，
  // 用户处理掉冲突后还能再点一次
  m.restored = warnings.length === 0
  await writeManifest(dir, m)
  return { ok: m.restored, warnings, backups: await listResidueBackups() }
}

export async function discardResidueBackup(
  rawId: unknown
): Promise<{ ok: boolean; warnings: string[]; backups: ResidueBackup[] }> {
  if (!validBatchId(rawId)) {
    return { ok: false, warnings: ['备份编号无效。'], backups: await listResidueBackups() }
  }
  try {
    await fs.rm(join(backupRoot(), rawId), { recursive: true, force: true })
    return { ok: true, warnings: [], backups: await listResidueBackups() }
  } catch (e) {
    return {
      ok: false,
      warnings: [`删除备份失败：${errText(e)}`],
      backups: await listResidueBackups()
    }
  }
}

/** 注册 IPC，必须在 app.whenReady 后调用 */
export function setupResidueStore(): void {
  ipcMain.handle('residue:scan', () => scanResidue())
  ipcMain.handle('residue:clean', (_e, ids: unknown) => cleanResidue(ids))
  ipcMain.handle('residue:backups', () => listResidueBackups())
  ipcMain.handle('residue:undo', (_e, id: unknown) => undoResidueBackup(id))
  ipcMain.handle('residue:discard', (_e, id: unknown) => discardResidueBackup(id))
}
