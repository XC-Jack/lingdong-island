#!/usr/bin/env node
/**
 * 全屏避让**误判**修复 e2e（对应 docs/Spec/SPEC-fix-fullscreen-misjudge.md 的 F1-F5）。
 *
 * 背景：US-041 的旧判据只看「前台窗口矩形是否覆盖整个主屏」，于是把 DWM 已 cloak 的
 * 壳层窗口（TextInputHost 的 Windows.UI.Core.CoreWindow，用户根本看不见它）和桌面
 * Progman 都当成全屏应用 → 岛在自己消失、且不会自动回来（2026-11-08 用户实测上报）。
 *
 * F1 真全屏应用置前 → 岛隐藏（原有行为不回退）
 * F5 关掉全屏 → 岛自动恢复（旧 commit() 只在判定翻转时动作，误判后就不回来）
 * F2 TextInputHost 的 cloak 窗口置前 → 岛保持可见
 * F3 桌面 Progman 置前 → 岛保持可见
 * F4 最大化普通应用置前 → 岛隐藏（US-041 原设计如此，本机 WorkArea==Bounds，作回归保护）
 *
 * 踩坑继承自 e2e-fullscreen-avoid.mjs：
 * ①ps() 只收 stdout（stderr 的 CLIXML 进度流会污染输出）；
 * ②岛可见性必须用 Win32 EnumWindows(pid∈electron + class=Chrome_WidgetWin_1 + 高度过滤)
 *   + IsWindowVisible，`MainWindowHandle` 与 CDP visibilityState 都不可靠；
 * ③spawn 的 electron 必须删 ELECTRON_RUN_AS_NODE，否则会退化成 node 跑不起来。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(ELECTRON)) {
  console.error('electron.exe not found at', ELECTRON)
  process.exit(1)
}
const PORT = 9351
const TICK = '`"'
const results = []
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}
const skip = (name, why) => {
  results.push({ name, pass: true, skipped: true, detail: why })
  console.log(`  – ${name}  SKIP（${why}）`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`withTimeout: ${tag} 超时 ${ms}ms`)), ms))
  ])
}

/** 跑一段 PowerShell（-EncodedCommand 传多行脚本，老坑：压平成 -Command 会被转义炸）。
 * 只收 stdout：stderr 的 CLIXML 进度流会污染判据。 */
function ps(script, timeoutMs = 20000) {
  return withTimeout(
    new Promise((resolve) => {
      const enc = Buffer.from(script, 'utf16le').toString('base64')
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
        windowsHide: true
      })
      let out = ''
      p.stdout.on('data', (d) => (out += d.toString()))
      p.on('exit', () => resolve(out.trim()))
    }),
    timeoutMs,
    'ps()'
  )
}

/** 岛可见性（Win32 层真相）：pid ∈ electron 进程 且 class=Chrome_WidgetWin_1 且高度 60~300。
 * 高度过滤用来排除顶部 4px 感应窗的宿主外壳（它同样属于 electron、同一类名）。 */
function islandVisible() {
  const script = [
    'Add-Type "using System; using System.Text; using System.Runtime.InteropServices; public class WV { public delegate bool EnumProc(IntPtr h, IntPtr lp); [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ')] public static extern bool EnumWindows(EnumProc cb, IntPtr lp); [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n); [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ')] public static extern bool IsWindowVisible(IntPtr h); [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ')] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; } }"',
    '$script:found = 0',
    '$cb = [WV+EnumProc]{ param($h, $lp)',
    '  $p2 = 0; [void][WV]::GetWindowThreadProcessId($h, [ref]$p2)',
    '  if ($script:epids -contains $p2) {',
    '    $sb = New-Object System.Text.StringBuilder 256; [void][WV]::GetClassNameW($h, $sb, 256)',
    '    if ($sb.ToString() -eq "Chrome_WidgetWin_1") {',
    '      $r = New-Object WV+RECT; [void][WV]::GetWindowRect($h, [ref]$r)',
    '      $hgt = $r.B - $r.T',
    '      if ($hgt -gt 60 -and $hgt -lt 300 -and [WV]::IsWindowVisible($h)) { $script:found++ }',
    '    }',
    '  }',
    '  return $true',
    '}',
    '$script:epids = (Get-Process electron -ErrorAction SilentlyContinue).Id',
    '[void][WV]::EnumWindows($cb, [IntPtr]::Zero)',
    '"VIS=$script:found"'
  ].join('; ')
  return ps(script).then((out) => out.includes('VIS=1'))
}

/** 造一个受控前台窗口。kind：full（无边框铺满主屏 + TopMost）、max（普通窗口最大化）。
 * 返回子进程，调用方 kill 掉即可关窗（pwsh 死 → ShowDialog 的窗体跟着消失）。 */
function makeWindow(kind) {
  const cls = 'MK' + kind
  const cs = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class ' + cls + ' {',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool SetForegroundWindow(IntPtr h);',
    '}'
  ].join(' ')
  const lines = [
    'Add-Type "' + cs + '"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$f = New-Object System.Windows.Forms.Form',
    '$f.Text = "' + cls + '"',
    '$f.ShowInTaskbar = $false',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(24,24,32)'
  ]
  if (kind === 'full') {
    lines.push('$f.FormBorderStyle = "None"')
    lines.push('$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds')
    lines.push('$f.TopMost = $true')
  } else {
    lines.push('$f.WindowState = "Maximized"')
  }
  lines.push('$f.Add_Shown({ [void][' + cls + ']::SetForegroundWindow($f.Handle) })')
  lines.push('[void]$f.ShowDialog()')
  const enc = Buffer.from(lines.join('; '), 'utf16le').toString('base64')
  // 用 kill 关窗，避免依赖窗体自身计时器
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
    windowsHide: true,
    stdio: 'ignore'
  })
}

/** 强制把某个「铺满整屏但不是全屏应用」的系统窗口置前，并回报它到底有没有被置前。
 * kind：tih（TextInputHost 的 Windows.UI.Core.CoreWindow）、progman（桌面）。 */
function forceShellForeground(kind) {
  const cs = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class SF {',
    'public delegate bool EnumProc(IntPtr h, IntPtr lp);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetForegroundWindow();',
    // 桌面窗口用 GetShellWindow() 取：FindWindowW 若漏了 CharSet = CharSet.Unicode，
    // 字符串会按 ANSI 传给宽字符 API，匹配不上返回零句柄（[实测] 因此 F3 一直报 FG=False）
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetShellWindow();',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    'public struct RECT { public int L, T, R, B; }',
    'public static IntPtr Find(uint[] pids, string cls, int sw, int sh) {',
    '  IntPtr hit = IntPtr.Zero;',
    '  EnumWindows((h, l) => {',
    '    foreach (uint pid in pids) {',
    '      uint p; GetWindowThreadProcessId(h, out p);',
    '      if (p != pid) continue;',
    '      StringBuilder sb = new StringBuilder(256); GetClassNameW(h, sb, 256);',
    '      if (sb.ToString() != cls) continue;',
    '      RECT r; if (!GetWindowRect(h, out r)) continue;',
    '      if (r.L <= 0 && r.T <= 0 && r.R >= sw && r.B >= sh) { hit = h; return false; }',
    '    }',
    '    return true;',
    '  }, IntPtr.Zero);',
    '  return hit;',
    '}',
    '}'
  ].join(' ')

  const target =
    kind === 'progman'
      ? '$h=[SF]::GetShellWindow()'
      : '$pids=(Get-Process TextInputHost -ErrorAction SilentlyContinue).Id; $h=[SF]::Find([uint32[]]$pids,"Windows.UI.Core.CoreWindow",$b.Width,$b.Height)'

  const script = [
    'Add-Type "' + cs + '"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    target,
    // 零句柄判定必须走 ToInt64：IntPtr 用 -eq 与 [IntPtr]::Zero 比较不可靠（[实测] 曾漏判）
    'if ($h.ToInt64() -eq 0) { "NO-TARGET"; exit }',
    '[void][SF]::SetForegroundWindow($h)',
    'Start-Sleep -Milliseconds 400',
    // 用 ToInt64 比较：IntPtr 直接 -eq 在部分情况下不按数值比较（[实测] 曾出现 Progman
    // 已置前却报 FG=False，换成整数比较后稳定）
    '"FG=" + ([SF]::GetForegroundWindow().ToInt64() -eq $h.ToInt64())'
  ].join('; ')
  return ps(script)
}

// ---- 起 dev electron（干净 userData）----
const userDir = mkdtempSync(join(tmpdir(), 'island-fsmis-'))
const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`,
    // e2e 稳定性：GPU / disk cache 在 DSH 环境偶发「拒绝访问」刷屏并伴随 CDP 卡死
    '--disable-gpu', '--disk-cache-size=1'
  ],
  {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_USER_DATA: userDir, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'inherit', 'inherit']
  }
)

/** 等岛可见性变成期望值，最多等 timeoutMs；返回最后一次实测值。 */
async function waitVisible(want, timeoutMs, stepMs = 700) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await islandVisible()
    if (last === want) return last
    await sleep(stepMs)
  }
  return last
}

const wins = []
try {
  await sleep(7000)

  // F0 起手：常态岛应可见（否则后续断言无意义）
  const v0 = await waitVisible(true, 8000)
  ok('F0 常态岛可见', v0 === true, String(v0))

  // F1 真全屏 → 隐藏（判定 1s + 去抖 300ms，留足余量）
  const full = makeWindow('full')
  wins.push(full)
  await sleep(3500)
  const v1 = await waitVisible(false, 4000)
  ok('F1 真全屏→岛隐藏', v1 === false, String(v1))

  // F5 关全屏 → 自动恢复（旧代码误判后不回来，这一条是修复的正面证据）
  full.kill()
  const v5 = await waitVisible(true, 6000)
  ok('F5 关全屏→岛自动恢复', v5 === true, String(v5))

  // F2 TextInputHost 的 cloak 窗口置前 → 岛保持可见（旧判据在此会 hide）
  const tih = await forceShellForeground('tih')
  if (tih.includes('NO-TARGET')) {
    skip('F2 cloak 壳层窗口→岛保持可见', '本机未运行 TextInputHost')
  } else {
    const fg = tih.includes('FG=True')
    await sleep(3000)
    const v2 = await islandVisible()
    ok('F2 cloak 壳层窗口→岛保持可见', fg && v2 === true, `force=${fg} vis=${v2}`)
  }

  // F3 桌面 Progman 置前 → 岛保持可见
  const pm = await forceShellForeground('progman')
  const pmFg = pm.includes('FG=True')
  await sleep(3000)
  const v3 = await islandVisible()
  ok('F3 桌面 Progman→岛保持可见', pmFg && v3 === true, `force=${pmFg} vis=${v3}`)

  // F4 最大化普通应用 → 仍隐藏（US-041 原设计：最大化占满屏幕也避让）
  const max = makeWindow('max')
  wins.push(max)
  await sleep(3500)
  const v4 = await waitVisible(false, 4000)
  ok('F4 最大化应用→岛隐藏（原设计不回退）', v4 === false, String(v4))

  // 收尾：关掉窗口，岛必须能自己回来
  max.kill()
  const vEnd = await waitVisible(true, 6000)
  ok('F6 收尾：关窗口后岛自动恢复', vEnd === true, String(vEnd))
} catch (err) {
  console.error('e2e error:', err)
} finally {
  for (const w of wins) {
    try {
      w.kill()
    } catch {
      /* noop */
    }
  }
  if (process.platform === 'win32') {
    // child.kill() 对 electron 不够：渲染/GPU 子进程会挂住 stdio，整个 e2e 卡住不退
    try {
      const { execSync } = await import('node:child_process')
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* noop */
    }
  } else {
    child.kill()
  }
}

const failed = results.filter((r) => !r.pass)
const passed = results.length - failed.length
console.log(`\n== 全屏误判 e2e：${passed} 过 / ${failed.length} 败 ==`)
process.exit(failed.length === 0 ? 0 : 1)
