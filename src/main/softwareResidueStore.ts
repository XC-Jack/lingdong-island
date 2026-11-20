import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  SoftwareResidueItem,
  SoftwareResidueKind,
  SoftwareResidueLevel,
  SoftwareResidueScanResult
} from '../shared/types'
import { runPowerShellRaw } from './runPs'
import { errText, existsConservative, rawFs } from './fsUtil'

/**
 * 软件残留检测（SPEC-space-software-residue）。
 *
 * 只读：只采集服务和进程信息、读文件属性、算目录大小；不停止、不删除、不改注册表。
 *
 * 判断原则：
 * - 「没有卸载登记」本身不是删除理由，必须给出正向证据；
 * - 微软组件、商店应用、OEM 工具、开发工具一律排除；
 * - 共享驱动和判断不了归属的只标「需确认」。
 */

/* ---------- 采集结果的原始结构 ---------- */

interface RawApp {
  name: string
  loc: string
  icon: string
  publisher: string
  company: string
  product: string
}
interface RawStore {
  name: string
  loc: string
}
interface RawService {
  name: string
  display: string
  state: string
  startMode: string
  exe: string
  company: string
}
interface RawDriver {
  name: string
  display: string
  state: string
  startMode: string
  path: string
  company: string
}
interface RawTask {
  task: string
  path: string
  exe: string
}
interface RawProc {
  name: string
  pid: number
  path: string
  company: string
  product: string
}
interface RawShortcut {
  lnk: string
  target: string
}
interface RawData {
  apps: RawApp[]
  store: RawStore[]
  services: RawService[]
  drivers: RawDriver[]
  tasks: RawTask[]
  procs: RawProc[]
  shortcuts: RawShortcut[]
  drives: string[]
}

/**
 * 一次 PowerShell 采集所有来源，输出一个 JSON。
 *
 * 每一段都单独 try/catch：注册表、商店应用、WMI、计划任务里任何一段读失败，
 * 都不能让整次扫描作废——宁可少一类证据，也要把能拿到的结果交给判断逻辑。
 */
const SCAN_PS = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
function Get-Exe($cmd){
  if(-not $cmd){ return '' }
  if($cmd -match '^"([^"]+)"'){ return $matches[1] }
  if($cmd -match '^([^\s]+?\.exe)'){ return $matches[1] }
  return ''
}
function Get-VI($exe){
  if($exe -and (Test-Path -LiteralPath $exe)){
    try { $v=(Get-Item -LiteralPath $exe).VersionInfo; return @([string]$v.CompanyName,[string]$v.ProductName) } catch { }
  }
  return @('','')
}
$appOut=@()
try {
  $apps=@()
  foreach($k in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')){
    $apps += Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
  }
  foreach($a in @($apps | Where-Object { $_.DisplayName })){
    $icon=[string]$a.DisplayIcon
    if($icon){ $icon=$icon -replace '^"',''; $icon=$icon -replace '",.*$','' }
    # 图标程序的版本信息里通常写着发行公司，比显示名更能对上目录名
    $vi=Get-VI $icon
    $appOut += [pscustomobject]@{ name=[string]$a.DisplayName; loc=[string]$a.InstallLocation; icon=$icon; publisher=[string]$a.Publisher; company=$vi[0]; product=$vi[1] }
  }
} catch { }
$storeOut=@()
try {
  foreach($s in @(Get-AppxPackage -ErrorAction SilentlyContinue)){
    $storeOut += [pscustomobject]@{ name=[string]$s.Name; loc=[string]$s.InstallLocation }
  }
} catch { }
$svcOut=@()
try {
  foreach($s in @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue)){
    $exe=Get-Exe $s.PathName
    $vi=Get-VI $exe
    $svcOut += [pscustomobject]@{ name=[string]$s.Name; display=[string]$s.DisplayName; state=[string]$s.State; startMode=[string]$s.StartMode; exe=$exe; company=$vi[0] }
  }
} catch { }
$drvOut=@()
try {
  foreach($d in @(Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue)){
    $p=[string]$d.PathName
    if($p.StartsWith('\??\')){ $p=$p.Substring(4) }
    $vi=Get-VI $p
    $drvOut += [pscustomobject]@{ name=[string]$d.Name; display=[string]$d.DisplayName; state=[string]$d.State; startMode=[string]$d.StartMode; path=$p; company=$vi[0] }
  }
} catch { }
$taskOut=@()
try {
  foreach($t in @(Get-ScheduledTask -ErrorAction SilentlyContinue)){
    foreach($a in @($t.Actions)){
      $e=[string]$a.Execute
      if($e){ $taskOut += [pscustomobject]@{ task=[string]$t.TaskName; path=[string]$t.TaskPath; exe=$e } }
    }
  }
} catch { }
$procOut=@()
try {
  foreach($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)){
    $exe=[string]$p.ExecutablePath
    if(-not $exe){ continue }
    $vi=Get-VI $exe
    $procOut += [pscustomobject]@{ name=[string]$p.Name; pid=[int]$p.ProcessId; path=$exe; company=$vi[0]; product=$vi[1] }
  }
} catch { }
$shOut=@()
try {
  $sh=New-Object -ComObject WScript.Shell
  $roots=@([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
  foreach($r in $roots){
    if(-not $r -or -not (Test-Path -LiteralPath $r)){ continue }
    foreach($f in @(Get-ChildItem -LiteralPath $r -Filter *.lnk -Recurse -ErrorAction SilentlyContinue)){
      try { $sc=$sh.CreateShortcut($f.FullName); $shOut += [pscustomobject]@{ lnk=[string]$f.FullName; target=[string]$sc.TargetPath } } catch { }
    }
  }
} catch { }
$driveOut=@()
try {
  $driveOut=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.DeviceID })
} catch { }
$out=[pscustomobject]@{ apps=@($appOut); store=@($storeOut); services=@($svcOut); drivers=@($drvOut); tasks=@($taskOut); procs=@($procOut); shortcuts=@($shOut); drives=@($driveOut) }
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Depth 6 -Compress))
`

const asArray = <T>(v: T[] | T | undefined | null): T[] =>
  Array.isArray(v) ? v : v ? [v] : []

const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

function under(p: string, root: string): boolean {
  const a = norm(p)
  const b = norm(root)
  if (!a || !b) return false
  return a === b || a.startsWith(b + '\\')
}

const isAbs = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || /^\\\\/.test(p)

/** 归一化名称：去掉空格、标点，用来比较「目录名」和「软件名 / 发行商」 */
function nkey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** 启动方式中文化（WMI 给的是 Auto / Manual / Disabled / Unknown） */
function startModeText(mode: string): string {
  const m = (mode || '').toLowerCase()
  if (m === 'auto') return '自动启动'
  if (m === 'manual') return '手动启动'
  if (m === 'disabled') return '已禁用'
  if (m === 'boot') return '引导启动'
  if (m === 'system') return '系统启动'
  return '启动方式未知'
}

function idOf(kind: SoftwareResidueKind, path: string): string {
  return createHash('sha1').update(`${kind}\0${path.toLowerCase()}`).digest('hex').slice(0, 16)
}

/** 系统与厂商目录：这些目录本身永远不算「无主目录」 */
function protectedRoots(): string[] {
  const win = process.env.WINDIR ?? 'C:\\Windows'
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const pd = process.env.ProgramData ?? 'C:\\ProgramData'
  const home = app.getPath('home')
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return [
    win,
    join(pf, 'WindowsApps'),
    join(pf, 'Common Files'),
    join(pf86, 'Common Files'),
    join(pf, 'Microsoft'),
    join(pf86, 'Microsoft'),
    join(pd, 'Microsoft'),
    join(pd, 'Package Cache'),
    join(local, 'Microsoft'),
    join(roaming, 'Microsoft'),
    join(home, '.vscode'),
    join(home, '.cache'),
    app.getAppPath(),
    dirname(process.execPath)
  ]
}

/** 这些名字的顶层目录直接跳过，不进入「无主目录」候选 */
const PROTECTED_NAMES = new Set(
  [
    'microsoft',
    'common files',
    'windowsapps',
    'modifiablewindowsapps',
    'packages',
    'temp',
    'intel',
    'honor',
    'nvidia',
    'nvidia corporation',
    'amd',
    'realtek',
    'windows defender',
    'windows mail',
    'windows media player',
    'windows multimedia platform',
    'windows nt',
    'windows photo viewer',
    'windows portable devices',
    'windows security',
    'windows sidebar',
    'windows system apps',
    'dotnet',
    '.net',
    'package cache',
    'assembly',
    'reference assemblies',
    'msbuild',
    'internet explorer',
    'windowspowershell',
    'windowsapps',
    'usoprivate',
    'usoshared',
    'users',
    'program files',
    'program files (x86)',
    'programdata',
    'perflogs',
    'recovery',
    'system volume information',
    'documents and settings',
    'msocache',
    'config.msi',
    'onedrivetemp',
    'softwaredistribution',
    'deliveryoptimization',
    'wudownloadcache',
    'uninstall information',
    'oem links',
    'ssh',
    'comms',
    'virtualstore',
    'peerdistrepub',
    'boost_interprocess',
    'hihonornote',
    'nahimic',
    'a-volute',
    'goodix',
    'arcsoft'
  ].map((s) => s.toLowerCase())
)

/** 名字以这些开头的目录一律跳过（Windows 自己的组件、MSI 安装缓存） */
const PROTECTED_PREFIX = /^(windows|microsoft|regid\.|\$|config\.msi|msdownld)/i

/** 厂商签名：这些公司的驱动属于系统/硬件配套，不算残留 */
const VENDOR_COMPANY =
  /^(microsoft|intel|amd|advanced micro devices|nvidia|realtek|qualcomm|apple|lsi|avago|broadcom|vmware|promise|via technologies|microsemi|microchip|silicon integrated|emulex|pmc-sierra|qlogic|mellanox|chelsio|marvell|hewlett|lenovo|dell|honor|windows)/i

/** 硬件/OEM 厂商目录：装在这里的服务和进程属于驱动配套，不算残留 */
const VENDOR_DIR = /^(intel|honor|nvidia|amd|realtek|qualcomm|dell|lenovo|asus|acer|msi|samsung)(\b|[ (])/i
const underVendorDir = (p: string): boolean => p.split(/[\\/]/).some((seg) => VENDOR_DIR.test(seg))

/** 多个软件共用的驱动：只标「需确认」，不能凭它下结论 */
const SHARED_DRIVER = /^(wintun|tap0901|tap-?windows|npcap|npf|winpcap|usbip|wintun6)$/i

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await rawFs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * 服务 / 计划任务登记的程序路径是否存在。
 *
 * Win32_Service 的 PathName 有时省略扩展名（如 `...\WsxService`），
 * 直接判断会把在用的服务误报成「程序已不存在」，这里补一次 `.exe` 试探。
 */
async function exeExists(p: string): Promise<boolean> {
  if (await existsConservative(p)) return true
  if (!/\.[a-z0-9]{1,5}$/i.test(p)) return existsConservative(`${p}.exe`)
  return false
}

/** 目录里有像卸载程序的文件时，视为「有主」，不列为候选 */
async function hasUninstaller(dir: string): Promise<boolean> {
  try {
    const entries = await rawFs.readdir(dir, { withFileTypes: true })
    return entries.some((e) => e.isFile() && /^(unins|uninstall|卸载)/i.test(e.name))
  } catch {
    return false
  }
}

/** 目录是不是真正的空目录（读不到也按「不空」算，避免误报） */
async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await rawFs.readdir(dir)).length === 0
  } catch {
    return false
  }
}

/**
 * 统计目录占用，但带时间预算。
 *
 * 候选目录可能落在任意盘符上（比如 D:\kingsoft），有的几十 GB，
 * 严格统计会让扫描卡住。超时就把已算出的部分当作下限返回，界面标「约」。
 */
async function sizeWithin(
  dir: string,
  budgetMs: number
): Promise<{ bytes: number; truncated: boolean }> {
  const deadline = Date.now() + budgetMs
  let bytes = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    if (Date.now() > deadline) return { bytes, truncated: true }
    const cur = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await rawFs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const full = join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        bytes += (await rawFs.lstat(full)).size
      } catch {
        /* 读不到的文件不计入 */
      }
    }
  }
  return { bytes, truncated: false }
}

async function topLevelDirs(root: string): Promise<string[]> {
  try {
    const entries = await rawFs.readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => join(root, e.name))
  } catch {
    return []
  }
}

async function classify(raw: RawData): Promise<SoftwareResidueScanResult> {
  const warnings: string[] = []
  const apps = asArray(raw.apps)
  const store = asArray(raw.store)
  const services = asArray(raw.services)
  const drivers = asArray(raw.drivers)
  const tasks = asArray(raw.tasks)
  const procs = asArray(raw.procs)
  const shortcuts = asArray(raw.shortcuts)

  const protectedPrefixes = protectedRoots()
  const appNames = [...apps.map((a) => a.name), ...store.map((s) => s.name)].filter(Boolean)
  // 目录名大多对不上软件显示名（「Tencent」vs「QQ」），发行商和图标程序的版本信息往往能对上
  const publisherNames = apps.flatMap((a) => [a.publisher, a.company, a.product]).filter(Boolean)
  const ownerKeys = [...appNames, ...publisherNames].map(nkey).filter((k) => k.length >= 2)

  const appLocCandidates = [
    ...apps.map((a) => a.loc),
    ...apps.map((a) => (a.icon ? dirname(a.icon) : '')),
    ...store.map((s) => s.loc)
  ].filter((p) => p && isAbs(p))

  const appLocs: string[] = []
  for (const p of new Set(appLocCandidates)) {
    if (await dirExists(p)) appLocs.push(p)
  }

  const selfPrefixes = [app.getAppPath(), dirname(process.execPath)].filter(Boolean)
  const isSelf = (p: string): boolean => selfPrefixes.some((s) => under(p, s))
  const isProtected = (p: string): boolean => protectedPrefixes.some((r) => under(p, r))

  const runningCompanies = new Set<string>()
  for (const s of services) {
    if (s.state === 'Running' && s.company) runningCompanies.add(s.company.toLowerCase())
  }
  for (const p of procs) {
    if (p.company) runningCompanies.add(p.company.toLowerCase())
  }
  const companyClaimed = (company: string): boolean => {
    const c = company.toLowerCase().trim()
    if (!c) return false
    if (runningCompanies.has(c)) return true
    const k = nkey(c)
    if (k.length < 3) return false
    return ownerKeys.some((n) => n === k || (k.length >= 4 && n.includes(k)) || (n.length >= 4 && k.includes(n)))
  }

  const items: SoftwareResidueItem[] = []
  const push = (
    kind: SoftwareResidueKind,
    level: SoftwareResidueLevel,
    label: string,
    path: string,
    detail: string,
    opts: { company?: string; product?: string; bytes?: number | null; running?: boolean; admin?: boolean } = {}
  ): void => {
    items.push({
      id: idOf(kind, path),
      kind,
      level,
      label,
      detail,
      path,
      company: opts.company ?? '',
      product: opts.product ?? '',
      bytes: opts.bytes ?? null,
      running: opts.running ?? false,
      admin: opts.admin ?? false
    })
  }

  /* ---------- 1. 服务 ---------- */
  for (const s of services) {
    if (!s.exe || !isAbs(s.exe)) continue
    const gone = !(await exeExists(s.exe))
    if (gone) {
      const ownerLoc = appLocs.find((l) => under(s.exe, l))
      const level: SoftwareResidueLevel = ownerLoc ? 'likely' : 'definite'
      const tail = ownerLoc ? `；同公司软件仍安装在 ${ownerLoc}` : ''
      const owner = s.company ? `；公司：${s.company}` : ''
      push(
        'service',
        level,
        s.name,
        s.exe,
        `服务程序已不存在（${s.state}，${startModeText(s.startMode)}）${owner}${tail}`,
        {
          company: s.company,
          running: s.state === 'Running',
          admin: true
        }
      )
      continue
    }
    if (s.state !== 'Running') continue
    if (isProtected(s.exe) || isSelf(s.exe) || underVendorDir(s.exe)) continue
    if (appLocs.some((l) => under(s.exe, l))) continue
    if (companyClaimed(s.company)) continue
    push('service', 'check', s.name, s.exe, `未找到对应软件（公司：${s.company || '未知'}）`, {
      company: s.company,
      running: true,
      admin: true
    })
  }

  /* ---------- 2. 驱动 ---------- */
  for (const d of drivers) {
    const p = d.path
    if (!p || !isAbs(p)) continue
    const gone = !(await existsConservative(p))
    if (gone) {
      push(
        'driver',
        'definite',
        d.name,
        p,
        `驱动文件已不存在（${d.state}，${startModeText(d.startMode)}）${d.company ? `；公司：${d.company}` : ''}`,
        {
          company: d.company,
          running: d.state === 'Running',
          admin: true
        }
      )
      continue
    }
    // 只关心 System32\drivers 下的第三方驱动；DriverStore 由系统管理
    if (!/\\windows\\system32\\drivers\\/i.test(p)) continue
    if (!d.company || VENDOR_COMPANY.test(d.company)) continue
    if (companyClaimed(d.company)) continue
    // 驱动归属只能靠公司名推断，Windows 自带和 OEM 很多都查不到，
    // 所以一律标「需确认」，不给「很可能」的结论
    const shared = SHARED_DRIVER.test(d.name)
    const tail = shared ? '；这类驱动常被多个软件共用，不能仅凭它判断' : ''
    push(
      'driver',
      'check',
      d.name,
      p,
      `第三方驱动（${d.state}，${startModeText(d.startMode)}），公司：${d.company}，未找到同公司的软件、服务或进程${tail}`,
      { company: d.company, running: d.state === 'Running', admin: true }
    )
  }

  /* ---------- 3. 计划任务 ---------- */
  for (const t of tasks) {
    if (!t.exe || !isAbs(t.exe)) continue
    if (/^\\Microsoft\\/i.test(t.path)) continue
    if (await exeExists(t.exe)) continue
    push('task', 'definite', t.task, t.exe, `计划任务「${t.path}${t.task}」的动作程序已不存在`, {
      admin: true
    })
  }

  /* ---------- 4. 运行中的进程 ---------- */
  const me = process.pid
  for (const p of procs) {
    if (!p.path || !isAbs(p.path)) continue
    if (p.pid === me) continue
    if (isSelf(p.path) || isProtected(p.path) || underVendorDir(p.path)) continue
    if (appLocs.some((l) => under(p.path, l))) continue
    if (companyClaimed(p.company)) continue
    push('process', 'check', p.name, p.path, `运行中，但未找到对应软件（${p.company || '未知'} / ${p.product || '未知'}）`, {
      company: p.company,
      product: p.product,
      running: true,
      admin: true
    })
  }

  /* ---------- 5. 无主目录 ---------- */
  const referenced = [
    ...services.map((s) => s.exe),
    ...tasks.map((t) => t.exe),
    ...procs.map((p) => p.path),
    ...drivers.map((d) => d.path),
    ...shortcuts.map((s) => s.target),
    ...appLocs
  ].filter((p) => p && isAbs(p))

  const isReferenced = (dir: string): boolean => referenced.some((r) => under(r, dir))

  // 常看的固定目录 + 每个本地盘的根目录（D:\kingsoft 这类残留就落在盘根下）
  const systemDrive = (process.env.SystemDrive ?? 'C:').toUpperCase()
  // emptyOnly：这些目录下多半是用户资料或各软件的正常缓存，只报空目录（能明确判断的）
  const roots: { path: string; admin: boolean; emptyOnly: boolean }[] = [
    { path: process.env.ProgramFiles ?? 'C:\\Program Files', admin: true, emptyOnly: false },
    { path: process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', admin: true, emptyOnly: false },
    { path: process.env.ProgramData ?? 'C:\\ProgramData', admin: true, emptyOnly: false },
    { path: process.env.LOCALAPPDATA ?? '', admin: false, emptyOnly: true },
    { path: process.env.APPDATA ?? '', admin: false, emptyOnly: true },
    ...asArray(raw.drives).map((d) => {
      const letter = d.replace(/\\+$/, '').toUpperCase()
      const isSystem = letter === systemDrive
      return { path: `${letter}\\`, admin: isSystem, emptyOnly: !isSystem }
    })
  ].filter((r) => r.path)

  const nameClaimed = (name: string): boolean => {
    const k = nkey(name)
    if (k.length < 2) return true // 名字短到没法判断，宁可放过
    return ownerKeys.some(
      (n) => n === k || (k.length >= 4 && n.includes(k)) || (n.length >= 4 && k.includes(n))
    )
  }

  const seen = new Set<string>()
  for (const root of roots) {
    for (const dir of await topLevelDirs(root.path)) {
      const base = basename(dir)
      const key = norm(dir)
      if (seen.has(key)) continue
      seen.add(key)
      if (PROTECTED_NAMES.has(base.toLowerCase()) || PROTECTED_PREFIX.test(base)) continue
      if (isProtected(dir) || isSelf(dir)) continue
      if (isReferenced(dir)) continue
      if (nameClaimed(base)) continue
      if (await hasUninstaller(dir)) continue
      if (await isEmptyDir(dir)) {
        push('folder', 'definite', base, dir, '空目录：没有任何文件，也没有被软件、服务或任务引用', {
          bytes: 0,
          admin: root.admin
        })
        continue
      }
      // 非系统盘根目录、AppData 下多半是用户资料或各软件的正常缓存，
      // 不列出来免得吓人；只报「空目录」这种能明确判断的
      if (root.emptyOnly) continue
      const { bytes, truncated } = await sizeWithin(dir, 2000)
      push(
        'folder',
        'check',
        base,
        dir,
        truncated
          ? '没有被已安装软件、服务、计划任务或快捷方式引用；目录太大，占用按已统计部分估算'
          : '没有被已安装软件、服务、计划任务或快捷方式引用；但安装登记不一定写全路径，需要你自己确认',
        { bytes, admin: root.admin }
      )
    }
  }

  if (items.length === 0) warnings.push('没有发现软件残留。')

  const order: Record<SoftwareResidueLevel, number> = { definite: 0, likely: 1, check: 2 }
  const kindOrder: Record<SoftwareResidueKind, number> = { driver: 0, service: 1, task: 2, folder: 3, process: 4 }
  items.sort(
    (a, b) =>
      order[a.level] - order[b.level] ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      a.label.localeCompare(b.label, 'zh-CN')
  )

  return { items, scannedAt: Date.now(), warnings }
}

export async function scanSoftwareResidue(): Promise<SoftwareResidueScanResult> {
  const warnings: string[] = []
  try {
    const r = await runPowerShellRaw(SCAN_PS, 180_000)
    // 采集脚本某一段失败时退出码会非 0，但只要最后的 JSON 写出来了就照常判断
    if (!r.stdout) throw new Error(r.stderr || `PowerShell 退出码 ${r.code}`)
    const raw = JSON.parse(r.stdout) as RawData
    if (r.code !== 0) warnings.push('部分系统信息没读全，结果可能不全。')
    if (asArray(raw.store).length === 0) warnings.push('没读到应用商店应用清单，结果可能偏多。')
    const res = await classify(raw)
    return { ...res, warnings: [...warnings, ...res.warnings] }
  } catch (e) {
    return { items: [], scannedAt: Date.now(), warnings: [`扫描失败：${errText(e)}`] }
  }
}

/** 注册 IPC，必须在 app.whenReady 后调用 */
export function setupSoftwareResidueStore(): void {
  ipcMain.handle('software-residue:scan', () => scanSoftwareResidue())
}
