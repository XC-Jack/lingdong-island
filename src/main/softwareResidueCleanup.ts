import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  ResidueCleanupItemResult,
  ResidueCleanupRunResult,
  ResidueUndoResult,
  SoftwareResidueItem,
  SoftwareResidueScanResult
} from '../shared/types'
import { errText } from './fsUtil'
import { runPowerShell } from './runPs'
import { getLastResidueScan, scanSoftwareResidue } from './softwareResidueStore'

/**
 * 软件残留清理（SPEC-space-residue-cleanup）。
 *
 * 只处理三类「确定」项：程序已不存在的服务、程序已不存在的计划任务、真正的空目录。
 * 驱动、非空目录、需确认项一律不碰。
 *
 * 安全边界：
 * - 渲染层只传 id，主进程拿最近一次扫描结果核对；不接受任何路径或名字。
 * - 删之前先备份（服务导出注册表、任务导出 XML），备份失败就不删。
 * - 提权脚本用 -EncodedCommand 传入，不落 .ps1 中间文件（同 SPEC-space-admin-cleanup）。
 * - 结果文件随机名，读前确认是普通文件，读完即删。
 */

type CleanKind = 'service' | 'task' | 'folder'

interface ManifestEntry {
  id: string
  kind: CleanKind
  label: string
  /** 服务名 / 任务名 / 目录路径 */
  name: string
  /** 任务容器路径，服务与目录为空 */
  taskPath: string
  /** 服务动作程序 / 任务动作程序；目录为空 */
  exe: string
  /** 备份文件名（相对备份目录）；目录为空 */
  backup: string
  /** 服务：原始启动方式与显示名，撤销时用 New-Service 重建 */
  startMode?: string
  displayName?: string
}

interface RawResult {
  id?: string
  ok?: boolean
  message?: string
}

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** 哪些项允许被清理：主进程扫描时已经算好，这里只做二次把关 */
export function isCleanable(it: SoftwareResidueItem): boolean {
  if (!it.cleanable) return false
  return (
    it.level === 'definite' &&
    (it.kind === 'service' || it.kind === 'task' || (it.kind === 'folder' && it.bytes === 0))
  )
}

function buildScript(entries: ManifestEntry[], backupDir: string, resultPath: string): string {
  const lines: string[] = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$ErrorActionPreference = 'Continue'",
    '$results = New-Object System.Collections.ArrayList',
    `$backup = ${psq(backupDir)}`,
    'New-Item -ItemType Directory -Force -Path $backup | Out-Null'
  ]

  entries.forEach((e, i) => {
    lines.push(`# --- ${i + 1}. ${e.kind} ${e.label} ---`)
    const add = (ok: boolean, message: string): string =>
      `[void]$results.Add([pscustomobject]@{ id = ${psq(e.id)}; ok = $${ok ? 'true' : 'false'}; message = ${psq(message)} })`
    // 带 PowerShell 变量的消息不能整段当字符串字面量，单独拼表达式
    const addExpr = (ok: boolean, expr: string): string =>
      `[void]$results.Add([pscustomobject]@{ id = ${psq(e.id)}; ok = $${ok ? 'true' : 'false'}; message = (${expr}) })`

    if (e.kind === 'service') {
      lines.push(
        `$svcName = ${psq(e.name)}`,
        `if (Test-Path -LiteralPath ${psq(e.exe)}) {`,
        `  ${add(false, '程序文件又出现了，已跳过')}`,
        '} else {',
        `  $reg = Join-Path $backup ${psq(e.backup)}`,
        `  & reg.exe export ('HKLM\\SYSTEM\\CurrentControlSet\\Services\\' + $svcName) $reg /y | Out-Null`,
        '  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $reg)) {',
        `    ${add(false, '注册表备份失败，没有删除')}`,
        '  } else {',
        '    & sc.exe delete $svcName | Out-Null',
        '    $code = $LASTEXITCODE',
        '    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue',
        '    if ($code -eq 0 -and $null -eq $svc) {',
        `      ${add(true, '服务登记已删除，备份在备份目录里')}`,
        '    } elseif ($code -eq 0) {',
        `      ${add(true, '已标记删除，重启后消失')}`,
        '    } else {',
        `      ${addExpr(false, "'sc delete 失败，退出码 ' + $code")}`,
        '    }',
        '  }',
        '}'
      )
      return
    }

    if (e.kind === 'task') {
      lines.push(
        `$taskName = ${psq(e.name)}`,
        `$taskPath = ${psq(e.taskPath)}`,
        `$xmlFile = Join-Path $backup ${psq(e.backup)}`,
        `if (Test-Path -LiteralPath ${psq(e.exe)}) {`,
        `  ${add(false, '程序文件又出现了，已跳过')}`,
        '} else {',
        '  try {',
        '    $xml = Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop',
        '  } catch { $xml = $null }',
        '  if (-not $xml) {',
        `    ${add(false, '读不到任务定义，没有删除')}`,
        '  } else {',
        '    [System.IO.File]::WriteAllText($xmlFile, $xml, (New-Object System.Text.UTF8Encoding($false)))',
        '    try {',
        '      Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop',
        `      ${add(true, '计划任务已删除，备份在备份目录里')}`,
        '    } catch {',
        `      ${addExpr(false, "'删除失败：' + $_.Exception.Message")}`,
        '    }',
        '  }',
        '}'
      )
      return
    }

    lines.push(
      `$dir = ${psq(e.name)}`,
      'if (-not (Test-Path -LiteralPath $dir)) {',
      `  ${add(true, '目录已经不存在')}`,
      '} elseif (@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue).Count -gt 0) {',
      `  ${add(false, '目录里又出现了文件，已跳过')}`,
      '} else {',
      '  try {',
      '    Remove-Item -LiteralPath $dir -Force -ErrorAction Stop',
      `    ${add(true, '空目录已删除')}`,
      '  } catch {',
      `    ${addExpr(false, "'删除失败：' + $_.Exception.Message")}`,
      '  }',
      '}'
    )
  })

  lines.push(
    '$json = ConvertTo-Json -InputObject $results.ToArray() -Depth 4 -Compress',
    `[System.IO.File]::WriteAllText(${psq(resultPath)}, $json, (New-Object System.Text.UTF8Encoding($false)))`
  )
  return lines.join('\n')
}

function buildUndoScript(entries: ManifestEntry[], backupDir: string, resultPath: string): string {
  const lines: string[] = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$ErrorActionPreference = 'Continue'",
    '$results = New-Object System.Collections.ArrayList',
    `$backup = ${psq(backupDir)}`
  ]
  entries.forEach((e, i) => {
    lines.push(`# --- ${i + 1}. ${e.kind} ${e.label} ---`)
    const add = (ok: boolean, message: string): string =>
      `[void]$results.Add([pscustomobject]@{ id = ${psq(e.id)}; ok = $${ok ? 'true' : 'false'}; message = ${psq(message)} })`
    const addExpr = (ok: boolean, expr: string): string =>
      `[void]$results.Add([pscustomobject]@{ id = ${psq(e.id)}; ok = $${ok ? 'true' : 'false'}; message = (${expr}) })`

    if (e.kind === 'service') {
      const startMap: Record<string, string> = {
        auto: 'Automatic',
        manual: 'Manual',
        disabled: 'Disabled'
      }
      const startupType = startMap[(e.startMode ?? '').toLowerCase()] ?? 'Manual'
      lines.push(
        `$reg = Join-Path $backup ${psq(e.backup)}`,
        'try {',
        // 直接 reg import 只是把键写回去，SCM 不会重新登记（sc query 仍报未安装），
        // 所以优先用 New-Service 走 SCM 重建；失败再退回 reg import。
        `  New-Service -Name ${psq(e.name)} -BinaryPathName ${psq(e.exe)} -DisplayName ${psq(
          e.displayName || e.name
        )} -StartupType ${startupType} -ErrorAction Stop | Out-Null`,
        `  ${add(true, '服务登记已重建')}`,
        '} catch {',
        '  if (Test-Path -LiteralPath $reg) {',
        '    & reg.exe import $reg | Out-Null',
        '    if ($LASTEXITCODE -eq 0) {',
        `      ${add(true, '服务登记已恢复（重启后生效）')}`,
        '    } else {',
        `      ${addExpr(false, "'恢复失败：' + $_.Exception.Message")}`,
        '    }',
        '  } else {',
        `    ${addExpr(false, "'恢复失败：' + $_.Exception.Message")}`,
        '  }',
        '}'
      )
      return
    }

    if (e.kind === 'task') {
      lines.push(
        `$xmlFile = Join-Path $backup ${psq(e.backup)}`,
        'if (-not (Test-Path -LiteralPath $xmlFile)) {',
        `  ${add(false, '备份文件不在了')}`,
        '} else {',
        '  try {',
        '    $xml = [System.IO.File]::ReadAllText($xmlFile)',
        `    Register-ScheduledTask -Xml $xml -TaskName ${psq(e.name)} -TaskPath ${psq(e.taskPath)} -Force -ErrorAction Stop | Out-Null`,
        `    ${add(true, '计划任务已重新登记')}`,
        '  } catch {',
        `    ${addExpr(false, "'恢复失败：' + $_.Exception.Message")}`,
        '  }',
        '}'
      )
      return
    }

    lines.push(
      `$dir = ${psq(e.name)}`,
      'if (Test-Path -LiteralPath $dir) {',
      `  ${add(true, '目录已经存在，无需恢复')}`,
      '} else {',
      '  try {',
      '    New-Item -ItemType Directory -Force -Path $dir | Out-Null',
      `    ${add(true, '空目录已恢复')}`,
      '  } catch {',
      `    ${addExpr(false, "'恢复失败：' + $_.Exception.Message")}`,
      '  }',
      '}'
    )
  })
  lines.push(
    '$json = ConvertTo-Json -InputObject $results.ToArray() -Depth 4 -Compress',
    `[System.IO.File]::WriteAllText(${psq(resultPath)}, $json, (New-Object System.Text.UTF8Encoding($false)))`
  )
  return lines.join('\n')
}

/** 只接受普通文件：符号链接/目录一律当「没有结果」 */
async function readRegularFile(p: string): Promise<string | null> {
  try {
    const st = await fs.lstat(p)
    if (st.isSymbolicLink() || !st.isFile()) return null
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

interface ElevatedOutcome {
  canceled: boolean
  error: string
  raw: RawResult[]
}

/** 用一次 UAC 执行脚本，返回解析后的逐项结果 */
async function runElevated(script: string, resultPath: string): Promise<ElevatedOutcome> {
  const cleanupTemp = async (): Promise<void> => {
    await fs.rm(resultPath, { force: true })
  }
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    await runPowerShell(
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' -Verb RunAs -Wait -PassThru; [Console]::Out.Write([string]$p.ExitCode)`,
      600_000
    )
  } catch (e) {
    await cleanupTemp()
    const msg = errText(e)
    const canceled = /取消|cancel|1223/i.test(msg)
    return { canceled, error: canceled ? '' : msg, raw: [] }
  }

  let raw: RawResult[] = []
  try {
    const file = await readRegularFile(resultPath)
    if (file === null) throw new Error('result is not a regular file')
    const parsed = JSON.parse(file.replace(/^﻿/, '')) as RawResult | RawResult[]
    raw = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return { canceled: false, error: '提权脚本没有留下结果文件，这次操作的结果无法确认。', raw: [] }
  } finally {
    await cleanupTemp()
  }
  return { canceled: false, error: '', raw }
}

function backupRoot(): string {
  return join(app.getPath('userData'), 'residue-backup')
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`
}

export async function runResidueCleanup(rawIds: unknown): Promise<ResidueCleanupRunResult> {
  const ids = (Array.isArray(rawIds) ? rawIds : []).filter((x): x is string => typeof x === 'string')
  const last = getLastResidueScan()
  const empty = async (warnings: string[]): Promise<ResidueCleanupRunResult> => ({
    ok: false,
    canceled: false,
    items: [],
    warnings,
    backupDir: '',
    scan: last ?? (await scanSoftwareResidue())
  })

  if (!last) return empty(['请先扫描一次，再选择要清理的项。'])
  if (ids.length === 0) return empty(['没有选中任何项目。'])

  const picked: SoftwareResidueItem[] = []
  for (const id of ids) {
    const it = last.items.find((x) => x.id === id)
    // 不在上次扫描结果里、或不属于可清理类型，一律忽略
    if (it && isCleanable(it)) picked.push(it)
  }
  if (picked.length === 0) return empty(['选中的项目不在可清理范围内（只支持确定级的服务、计划和空目录）。'])

  const backupDir = join(backupRoot(), `residue-${stamp()}`)
  await fs.mkdir(backupDir, { recursive: true })
  const workDir = join(app.getPath('userData'), 'residue-cleanup')
  await fs.mkdir(workDir, { recursive: true })
  const resultPath = join(workDir, `result-${randomBytes(8).toString('hex')}.json`)

  const entries: ManifestEntry[] = picked.map((it, i) => ({
    id: it.id,
    kind: it.kind as CleanKind,
    label: it.label,
    name: it.kind === 'folder' ? it.path : it.label,
    taskPath: it.taskPath ?? '',
    exe: it.kind === 'folder' ? '' : it.path,
    backup:
      it.kind === 'service'
        ? `service-${i + 1}.reg`
        : it.kind === 'task'
          ? `task-${i + 1}.xml`
          : '',
    startMode: it.startMode ?? '',
    displayName: it.displayName ?? ''
  }))

  await fs.writeFile(
    join(backupDir, 'manifest.json'),
    JSON.stringify({ createdAt: Date.now(), entries }, null, 2),
    'utf8'
  )

  const outcome = await runElevated(buildScript(entries, backupDir, resultPath), resultPath)
  const scan = await scanSoftwareResidue()

  if (outcome.canceled) {
    return {
      ok: false,
      canceled: true,
      items: [],
      warnings: ['已取消管理员授权，没有删除任何东西。'],
      backupDir,
      scan
    }
  }

  const warnings: string[] = []
  if (outcome.error) warnings.push(outcome.error)
  const items: ResidueCleanupItemResult[] = picked.map((it) => {
    const r = outcome.raw.find((x) => x.id === it.id)
    if (!r) {
      warnings.push(`「${it.label}」没有返回结果，可能没处理成。`)
      return { id: it.id, label: it.label, ok: false, message: '没有返回结果' }
    }
    return { id: it.id, label: it.label, ok: Boolean(r.ok), message: String(r.message ?? '') }
  })

  return { ok: true, canceled: false, items, warnings, backupDir, scan }
}

async function newestBackupDir(): Promise<string | null> {
  try {
    const root = backupRoot()
    const names = (await fs.readdir(root)).filter((n) => n.startsWith('residue-')).sort()
    if (names.length === 0) return null
    return join(root, names[names.length - 1])
  } catch {
    return null
  }
}

export async function undoLastResidueCleanup(): Promise<ResidueUndoResult> {
  const dir = await newestBackupDir()
  const scan = async (): Promise<SoftwareResidueScanResult> => await scanSoftwareResidue()
  if (!dir) {
    return { ok: false, canceled: false, restored: 0, warnings: ['没有找到可撤销的备份。'], scan: await scan() }
  }

  let entries: ManifestEntry[] = []
  try {
    const text = await readRegularFile(join(dir, 'manifest.json'))
    if (!text) throw new Error('manifest missing')
    const parsed = JSON.parse(text.replace(/^﻿/, '')) as { entries?: ManifestEntry[] }
    entries = Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return {
      ok: false,
      canceled: false,
      restored: 0,
      warnings: ['备份清单读不到，无法撤销。'],
      scan: await scan()
    }
  }
  if (entries.length === 0) {
    return { ok: false, canceled: false, restored: 0, warnings: ['备份里没有可恢复的项。'], scan: await scan() }
  }

  const workDir = join(app.getPath('userData'), 'residue-cleanup')
  await fs.mkdir(workDir, { recursive: true })
  const resultPath = join(workDir, `undo-${randomBytes(8).toString('hex')}.json`)

  const outcome = await runElevated(buildUndoScript(entries, dir, resultPath), resultPath)
  const after = await scan()
  if (outcome.canceled) {
    return { ok: false, canceled: true, restored: 0, warnings: ['已取消管理员授权，没有恢复任何东西。'], scan: after }
  }

  const warnings: string[] = []
  if (outcome.error) warnings.push(outcome.error)
  let restored = 0
  for (const e of entries) {
    const r = outcome.raw.find((x) => x.id === e.id)
    if (r?.ok) restored += 1
    else if (!r) warnings.push(`「${e.label}」没有返回结果。`)
    else if (r.message) warnings.push(`「${e.label}」：${r.message}`)
  }

  return { ok: true, canceled: false, restored, warnings, scan: after }
}
