import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
 *
 * 全部失败返回 null（渲染层退回应用名文字徽标）。解析结果按短名缓存在
 * userData/icon-cache/notify-<短名>.png；解析失败的短名记入内存 Set，不再重试。
 */

/** 图标缓存目录与失败短名表（setup 时初始化） */
let iconDir = ''
const failed = new Set<string>()/** 短名 → 缓存 PNG 路径的内存缓存（命省重复扫描） */
const resolved = new Map<string, string | null>()

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
function findUwpLogo(pkgPrefix: string): UwpLogo | null {
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
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 15_000,
    windowsHide: true,
    encoding: 'utf8'
  })
  const out = (r.stdout ?? '').trim()
  if (r.status !== 0 || !out.includes('|')) return null
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
function findWin32Exe(shortName: string): string | null {
  const exeName = `${shortName}.exe`
  // 1) App Paths 注册表（HKLM 与 HKCU 两处）
  for (const root of ['HKLM', 'HKCU']) {
    const script = [
      `$k = '${root}:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}'`,
      'if (Test-Path $k) { $v = (Get-ItemProperty $k)."(default)"; if ($v) { Write-Output $v } }'
    ].join('; ')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 10_000,
      windowsHide: true,
      encoding: 'utf8'
    })
    const p = (r.stdout ?? '').trim()
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
  const r2 = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script2], {
    timeout: 20_000,
    windowsHide: true,
    encoding: 'utf8'
  })
  const p2 = (r2.stdout ?? '').trim()
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

function exeIconPng(exePath: string, cacheKey: string): string | null {
  const png = join(iconDir, `notify-${cacheKey}.png`)
  if (existsSync(png)) return png
  try {
    mkdirSync(iconDir, { recursive: true })
    const ps1 = join(iconDir, 'extract-notify-icon.ps1')
    if (!existsSync(ps1)) writeFileSync(ps1, EXTRACT_ICON_PS1, 'utf8')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ps1, '-Target', exePath], {
      timeout: 8000,
      windowsHide: true,
      encoding: 'utf8'
    })
    const b64 = (r.stdout ?? '').trim()
    if (r.status !== 0 || !b64 || b64.length < 100) return null
    writeFileSync(png, Buffer.from(b64, 'base64'))
    return png
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 总入口                                                              */
/* ------------------------------------------------------------------ */

/** 解析 AUMID 短名对应的图标 PNG 绝对路径；解析失败返回 null（带失败缓存不再重试） */
export function appIcon(shortName: string): string | null {
  if (iconDir === '') return null
  if (resolved.has(shortName)) return resolved.get(shortName) ?? null
  if (failed.has(shortName)) return null

  let result: string | null = null

  // 0) 自家灵动岛：项目自带图标
  if (shortName === 'lingdong-island') {
    const mine = join(__dirname, '../../build/icon.png')
    if (existsSync(mine)) result = mine
  }

  // 1) 先查文件缓存（上次解析成功过）
  if (result === null) {
    const cached = join(iconDir, `notify-${shortName}.png`)
    if (existsSync(cached)) {
      result = cached
    }
  }

  // 2) UWP：短名即 AUMID 去 !App 段（ScreenSketch_8wekyb3d8bbwe!App → ScreenSketch_8wekyb3d8bbwe）。
  //    包名 = publisher hash（_8wekyb3d8bbwe 等 13 位哈希）之前的部分；Get-AppxPackage 的
  //    -Name 是前缀匹配，必须从真包名开头匹配（ScreenSketch* 匹配不到 Microsoft.ScreenSketch）。
  //    启发式：短名含下划线或以大写字母开头才走这条重路线。
  if (result === null && (shortName.includes('_') || /^[A-Z]/.test(shortName))) {
    // 去掉 publisher hash 后缀：短名形如 <包名>_<哈希>（哈希段固定 13 位 alnum 或带 . 前缀段）
    const stem = shortName.replace(/_[0-9a-zA-Z]{8,20}$/, '')
    const logo = findUwpLogo(stem)
    if (!logo && stem !== shortName) {
      // 截断后还匹配不到就退回全短名试一次
      const alt = findUwpLogo(shortName)
      if (alt) {
        const png = pickUwpVariant(alt.dir, alt.logoRel)
        if (png) {
          try {
            mkdirSync(iconDir, { recursive: true })
            writeFileSync(join(iconDir, `notify-${shortName}.png`), readFileSync(png))
            result = join(iconDir, `notify-${shortName}.png`)
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
          writeFileSync(join(iconDir, `notify-${shortName}.png`), readFileSync(png))
          result = join(iconDir, `notify-${shortName}.png`)
        } catch {
          result = png // 缓存失败就直接用原路径
        }
      }
    }
  }

  // 3) Win32：App Paths / 开始菜单 lnk → exe → SHGetFileInfo
  if (result === null) {
    const exe = findWin32Exe(shortName)
    if (exe) {
      result = exeIconPng(exe, shortName)
    }
  }

  if (result) {
    resolved.set(shortName, result)
    return result
  }
  failed.add(shortName)
  return null
}

/** setup 时初始化缓存目录；早于 setup 的调用返回 null */
export function initIconCache(): void {
  iconDir = join(app.getPath('userData'), 'icon-cache')
  mkdirSync(iconDir, { recursive: true })
}
