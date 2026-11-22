import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runPowerShellArgs, runPowerShellRaw } from './runPs'

/**
 * 通知来源应用图标解析（US 通知图标）。
 *
 * 通知库 wpndatabase 里每条通知只有 AUMID 短名（如 ScreenSketch、Chrome、QQ），
 * 没有「应用图标」这个字段。要拿到图标有三条路（本机实测验证过的）：
 *   1. UWP 应用：C:\Program Files\WindowsApps\<包名>\AppxManifest.xml 声明了
 *      Square44x44Logo，包目录下有全套 targetsize-48.png 变体，普通用户态可直接读。
 *   2. Win32 应用：App Paths 注册表（HKLM/HKCU ...\App Paths\<短名>.exe）或开始
 *      菜单 .lnk 定位到 exe，再用 SHGetFileInfo 提 32px 图标转 PNG。
 *   3. 自家灵动岛：项目自带图标。
 *   4. 已知系统应用别名表：AUMID 短名与 exe 名对不上时（如 SecurityCenter），
 *      直接指向 %SystemRoot%\System32 下的系统 exe，再走第 2 条的提图标。
 *
 * 全部失败返回 null（渲染层退回应用名文字徽标 + 首字占位方块）。解析结果按短名缓存在
 * userData/icon-cache/notify-<短名>.png；解析失败的短名记入内存 Set，不再重试。
 *
 * **2026-11-22 改异步 + 队列（SPEC-perf-no-sync-ps）**：原来这四条路线各用一次
 * `spawnSync`，一段 280–600 ms，一个没见过的应用要串 4 段 ≈ 1.5–2.5 s，这期间
 * **主进程整个冻结**（窗口动画、IPC、输入全停）。它发生在启动、新通知到达、
 * 以及切到通知页的时刻，正是用户说的「用着用着卡一下」。
 * 现在拆成两半：
 *   · `appIconCached()` —— 纯内存/磁盘查缓存，**永不起进程**，给列表渲染用；
 *   · `ensureAppIcon()` —— 把没图标的短名塞进队列，后台一次只解析一个，
 *     完成后通过 `initIconCache()` 注册的回调通知调用方补图。
 */

/** 图标缓存目录与失败短名表（setup 时初始化） */
let iconDir = ''
const failed = new Set<string>()/** 短名 → 缓存 PNG 路径的内存缓存（命省重复扫描） */
const resolved = new Map<string, string | null>()
/** 图标解析完成回调（notifyStore 用它重读列表并推给渲染层） */
type IconListener = (shortName: string, png: string | null) => void
let onIconResolved: IconListener | null = null

/* ------------------------------------------------------------------ */
/* UWP 路线：WindowsApps 包目录 + AppxManifest                         */
/* ------------------------------------------------------------------ */

interface UwpLogo {
  dir: string
  logoRel: string
}

/** 在 WindowsApps 目录里找包名前缀匹配的 UWP 包，读出图标声明。
 *  WindowsApps 目录本身对普通用户是枚举受限的：existsSync/enumerate 单个已知包名
 *  目录可以，但 readdir 整个根目录会失败——所以用 PowerShell 的 Get-AppxPackage，
 *  它跑在用户上下文里拿得到完整清单。 */
async function findUwpLogo(pkgPrefix: string): Promise<UwpLogo | null> {
  const script = [
    // 包夹匹配：AUMID 第一段（如 ScreenSketch）只是真包名（Microsoft.ScreenSketch）的尾巴，
    // Get-AppxPackage -Name 是「开头前缀」匹配，必须用 *<前缀>* 才能命中
    "$p = Get-AppxPackage -Name ('*' + '" + pkgPrefix.replace(/'/g, "''") + "' + '*') | Select-Object -First 1",
    'if (-not $p) { exit 1 }',
    '$mf = Join-Path $p.InstallLocation "AppxManifest.xml"',
    'if (-not (Test-Path $mf)) { exit 1 }',
    '[xml]$x = Get-Content $mf -Raw',
    '$ve = $x.Package.Applications.Application.VisualElements | Select-Object -First 1',
    'if (-not $ve) { exit 1 }',
    '$logo = $ve.Square44x44Logo',
    'if (-not $logo) { $logo = $ve.Square150x150Logo }',
    'if (-not $logo) { exit 1 }',
    'Write-Output ($p.InstallLocation + "|" + $logo)'
  ].join('; ')
  let out = ''
  try {
    out = await runPowerShellRaw(script, 15_000).then((r) => r.stdout)
  } catch {
    return null
  }
  if (!out.includes('|')) return null
  const sep = out.indexOf('|')
  const dir = out.slice(0, sep)
  const logoRel = out.slice(sep + 1)
  if (!dir || !logoRel) return null
  return { dir, logoRel }
}

/** 按 UWP 图标命名约定挑最佳变体：优先 targetsize-48，其次任意 targetsize，再退回裸名 */
function pickUwpVariant(dir: string, logoRel: string): string | null {
  const base = join(dir, logoRel)
  if (existsSync(base)) return base
  // logoRel 可能带子目录（Assets\xxx.png）：变体都和裸名文件同目录同名，只加后缀，
  // 所以 stem 只取文件名段，目录用 parent（否则会拼出 Assets\Assets\ 双层路径）
  const fileName = logoRel.split('\\').pop() ?? logoRel
  const stem = fileName.replace(/\.png$/i, '')
  const parent = join(dir, logoRel.includes('\\') ? logoRel.slice(0, logoRel.lastIndexOf('\\')) : '')
  const candidates = [
    join(parent, `${stem}.targetsize-48.png`),
    join(parent, `${stem}.targetsize-48_altform-unplated.png`),
    join(parent, `${stem}.scale-200.png`),
    join(parent, `${stem}.scale-100.png`)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Win32 路线：exe 定位 + SHGetFileInfo                                */
/* ------------------------------------------------------------------ */

/** App Paths 注册表 / 开始菜单 lnk 找 exe */
async function findWin32Exe(shortName: string): Promise<string | null> {
  const exeName = `${shortName}.exe`
  // 1) App Paths 注册表（HKLM 与 HKCU 两处）
  for (const root of ['HKLM', 'HKCU']) {
    const script = [
      `$k = '${root}:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}'`,
      'if (Test-Path $k) { $v = (Get-ItemProperty $k)."(default)"; if ($v) { Write-Output $v } }'
    ].join('; ')
    let p = ''
    try {
      p = (await runPowerShellRaw(script, 10_000)).stdout
    } catch {
      p = ''
    }
    if (p && existsSync(p)) return p
  }
  // 2) 开始菜单 .lnk 兜底（ProgramData + APPDATA 两处，名字含短名即命中）
  const script2 = [
    '$sh = New-Object -ComObject WScript.Shell',
    '$name = "' + shortName.replace(/"/g, '') + '"',
    'foreach ($d in @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")) {',
    '  $lnk = Get-ChildItem $d -Recurse -Filter ("*" + $name + "*.lnk") -ErrorAction SilentlyContinue | Select-Object -First 1',
    '  if ($lnk) { $t = $sh.CreateShortcut($lnk.FullName).TargetPath; if ($t -and (Test-Path $t)) { Write-Output $t; break } }',
    '}'
  ].join('; ')
  let p2 = ''
  try {
    p2 = (await runPowerShellRaw(script2, 20_000)).stdout
  } catch {
    p2 = ''
  }
  if (p2 && existsSync(p2)) return p2
  return null
}

/** 用 PowerShell SHGetFileInfo 提 32px 图标 → PNG（与置物架 shelfStore 同款机制） */
const EXTRACT_ICON_PS1 = [
  'param([string]$Target)',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class NotifyIcon {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]',
  '  public struct SHFILEINFO {',
  '    public IntPtr hIcon; public int iIcon; public uint dwAttributes;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName;',
  '  }',
  '  [DllImport("shell32.dll", CharSet=CharSet.Auto)]',
  '  public static extern IntPtr SHGetFileInfo(string pszPath, uint fa, ref SHFILEINFO sfi, uint cb, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);',
  '}',
  '"@',
  '$i = New-Object NotifyIcon+SHFILEINFO',
  '$cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][NotifyIcon+SHFILEINFO])',
  '[void][NotifyIcon]::SHGetFileInfo($Target, 0, [ref]$i, $cb, 0x100)',
  'if ($i.hIcon -eq [IntPtr]::Zero) { exit 1 }',
  '$b = [System.Drawing.Icon]::FromHandle($i.hIcon).ToBitmap()',
  '$m = New-Object System.IO.MemoryStream',
  '$b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png)',
  '[void][NotifyIcon]::DestroyIcon($i.hIcon)',
  '[Convert]::ToBase64String($m.ToArray())'
].join('\n')

async function exeIconPng(exePath: string, cacheKey: string): Promise<string | null> {
  const png = join(iconDir, `notify-${cacheKey}.png`)
  if (existsSync(png)) return png
  try {
    mkdirSync(iconDir, { recursive: true })
    const ps1 = join(iconDir, 'extract-notify-icon.ps1')
    if (!existsSync(ps1)) writeFileSync(ps1, EXTRACT_ICON_PS1, 'utf8')
    const r = await runPowerShellArgs(['-File', ps1, '-Target', exePath], 8000)
    const b64 = (r.stdout ?? '').trim()
    if (r.code !== 0 || !b64 || b64.length < 100) return null
    writeFileSync(png, Buffer.from(b64, 'base64'))
    return png
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 总入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 已知「短名 → 系统自带 exe」别名表（SPEC-notify-icon-and-single-group）。
 * 有些系统通知的 AUMID 短名和真实 exe 名对不上，App Paths / 开始菜单 lnk 都查不到：
 *   Windows.Defender.SecurityCenter → 短名 SecurityCenter，
 *   图标其实在 %SystemRoot%\System32\SecurityHealthSystray.exe（本机实测存在）。
 * 只补实测确认过的映射，命中后复用 exeIconPng() 的 SHGetFileInfo，不新增机制。
 */
const SYSTEM_EXE_ALIASES: Record<string, string> = {
  SecurityCenter: join(
    process.env.SystemRoot ?? 'C:/Windows',
    'System32',
    'SecurityHealthSystray.exe'
  )
}

/** 文件缓存路径（与历史实现完全一致，老用户的缓存图继续命中） */
function cachedPngPath(shortName: string): string {
  return join(iconDir, `notify-${shortName}.png`)
}

/**
 * **同步**查图标：只查内存表与磁盘缓存，**永不起进程**。
 * 给「渲染通知列表」这种不能等的路径用；没有就返回 null（界面显示文字徽标），
 * 需要图的短名交给 `ensureAppIcon()` 后台补。
 */
export function appIconCached(shortName: string): string | null {
  if (iconDir === '' || !shortName) return null
  const got = resolved.get(shortName)
  if (got !== undefined) return got
  if (failed.has(shortName)) return null
  // 自家灵动岛：项目自带图标
  if (shortName === 'lingdong-island') {
    const mine = join(__dirname, '../../build/icon.png')
    if (existsSync(mine)) {
      resolved.set(shortName, mine)
      return mine
    }
  }
  const cached = cachedPngPath(shortName)
  if (existsSync(cached)) {
    resolved.set(shortName, cached)
    return cached
  }
  return null
}

/**
 * 真正解析一个短名（异步，可能起 1–4 个 PowerShell）。
 * 只在后台队列里被调用，绝不在 IPC / 渲染路径上同步等待。
 */
async function resolveIcon(shortName: string): Promise<string | null> {
  if (iconDir === '' || !shortName) return null

  let result: string | null = null

  // 0) 磁盘缓存（上次解析成功过；队列虽已去重，这里仍兜一层并发/重启情况）
  const cached = cachedPngPath(shortName)
  if (existsSync(cached)) return cached

  // 0.5) 自家灵动岛：项目自带图标
  if (shortName === 'lingdong-island') {
    const mine = join(__dirname, '../../build/icon.png')
    if (existsSync(mine)) result = mine
  }

  // 1) 已知系统应用别名：短名与 exe 对不上时直接指向系统自带 exe（省掉 UWP 无效扫描）
  if (result === null && SYSTEM_EXE_ALIASES[shortName]) {
    const exe = SYSTEM_EXE_ALIASES[shortName]
    if (existsSync(exe)) result = await exeIconPng(exe, shortName)
  }

  // 2) UWP：短名即 AUMID 去 !App 段（ScreenSketch_8wekyb3d8bbwe!App → ScreenSketch_8wekyb3d8bbwe）。
  //    包名 = publisher hash（_8wekyb3d8bbwe 等 13 位哈希）之前的部分；Get-AppxPackage 的
  //    -Name 是前缀匹配，必须从真包名开头匹配（ScreenSketch* 匹配不到 Microsoft.ScreenSketch）。
  //    启发式：短名含下划线或以大写字母开头才走这条重路线。
  if (result === null && (shortName.includes('_') || /^[A-Z]/.test(shortName))) {
    // 去掉 publisher hash 后缀：短名形如 <包名>_<哈希>（哈希段固定 13 位 alnum 或带 . 前缀段）
    const stem = shortName.replace(/_[0-9a-zA-Z]{8,20}$/, '')
    const logo = await findUwpLogo(stem)
    if (!logo && stem !== shortName) {
      // 截断后还匹配不到就退回全短名试一次
      const alt = await findUwpLogo(shortName)
      if (alt) {
        const png = pickUwpVariant(alt.dir, alt.logoRel)
        if (png) {
          try {
            mkdirSync(iconDir, { recursive: true })
            writeFileSync(cachedPngPath(shortName), readFileSync(png))
            result = cachedPngPath(shortName)
          } catch {
            result = png
          }
        }
      }
    } else if (logo) {
      const png = pickUwpVariant(logo.dir, logo.logoRel)
      if (png) {
        try {
          mkdirSync(iconDir, { recursive: true })
          writeFileSync(cachedPngPath(shortName), readFileSync(png))
          result = cachedPngPath(shortName)
        } catch {
          result = png // 缓存失败就直接用原路径
        }
      }
    }
  }

  // 3) Win32：App Paths / 开始菜单 lnk → exe → SHGetFileInfo
  if (result === null) {
    const exe = await findWin32Exe(shortName)
    if (exe) result = await exeIconPng(exe, shortName)
  }

  return result
}

/* ------------------------------------------------------------------ */
/* 后台队列：一次只解析一个，完成即回调                                  */
/* ------------------------------------------------------------------ */

const queue: string[] = []
const queued = new Set<string>()
let pumping = false

/**
 * 把「还没有图标的短名」排进后台队列。
 * 已解析过 / 已失败过 / 已在队列里的直接跳过（失败也会进 `failed`，不会无限重试）。
 */
export function ensureAppIcon(shortName: string): void {
  if (iconDir === '' || !shortName) return
  if (resolved.has(shortName) || failed.has(shortName) || queued.has(shortName)) return
  queued.add(shortName)
  queue.push(shortName)
  void pump()
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      const name = queue.shift() as string
      queued.delete(name)
      let png: string | null = null
      try {
        png = await resolveIcon(name)
      } catch {
        png = null
      }
      if (png) resolved.set(name, png)
      else failed.add(name)
      try {
        onIconResolved?.(name, png)
      } catch {
        /* 回调异常不影响后续解析 */
      }
    }
  } finally {
    pumping = false
  }
}

/** 是否已经解析过（成功或失败）——调用方据此决定要不要再排队 */
export function isAppIconSettled(shortName: string): boolean {
  return resolved.has(shortName) || failed.has(shortName)
}

/** setup 时初始化缓存目录；回调在每张图解析完成时触发（可能成功也可能失败） */
export function initIconCache(onResolved?: IconListener): void {
  iconDir = join(app.getPath('userData'), 'icon-cache')
  mkdirSync(iconDir, { recursive: true })
  onIconResolved = onResolved ?? null
}
