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
 * F4 最大化普通应用置前 → 岛隐藏（US-041 原设计如此）
 * W1 F4 的显式前提记录：判据基准是**工作区**（WorkingArea），任务栏显示时 workarea < bounds，
 *    本机当前就是这种状态（2026-11-17 实测 bounds 1536x960 / work 1536x912）——旧判据在这里必失败
 * W3 贴边但未最大化的普通窗置前 → 岛保持可见（保证 8px 容差没有把手动拉大的窗口误收）
 *
 * 踩坑继承自 e2e-fullscreen-avoid.mjs：
 * ①ps() 只收 stdout（stderr 的 CLIXML 进度流会污染输出）；
 * ②岛可见性必须用 Win32 EnumWindows(pid∈electron + class=Chrome_WidgetWin_1 + 高度过滤)
 *   + IsWindowVisible，`MainWindowHandle` 与 CDP visibilityState 都不可靠；
 * ③spawn 的 electron 必须删 ELECTRON_RUN_AS_NODE，否则会退化成 node 跑不起来。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync } from 'node:fs'
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
 * 高度过滤用来排除顶部 4px 感应窗的宿主外壳（它同样属于 electron、同一类名）。
 *
 * ⚠ 2026-11-17 重写：原来用「PowerShell 脚本块当 EnumWindows 回调 + $script:found++」，
 * 实测在 -EncodedCommand 里回调内的计数**不生效**（同逻辑写成 .ps1 文件跑就正常，
 * callback 内的字符串输出也被丢弃），表现为 islandVisible() 恒返回 false、
 * 于是所有「岛应该可见」的断言假失败、所有「岛应该隐藏」的断言假通过。
 * 改为在 C# 里枚举（与 .tmp/fgsteal/wins.ps1 同一套写法，已实测有效）。 */
function islandVisible() {
  const cs = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class WV {',
    'public delegate bool EnumProc(IntPtr h, IntPtr lp);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool IsWindowVisible(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    'public struct RECT { public int L, T, R, B; }',
    'public static int Count(uint[] pids) {',
    '  int found = 0;',
    '  EnumWindows((h, l) => {',
    '    uint p; GetWindowThreadProcessId(h, out p);',
    '    if (Array.IndexOf(pids, p) < 0) return true;',
    '    var sb = new StringBuilder(256); GetClassNameW(h, sb, 256);',
    '    if (sb.ToString() != ' + TICK + 'Chrome_WidgetWin_1' + TICK + ') return true;',
    '    RECT r; GetWindowRect(h, out r);',
    '    int hgt = r.B - r.T;',
    '    if (hgt > 60 && hgt < 300 && IsWindowVisible(h)) found++;',
    '    return true;',
    '  }, IntPtr.Zero);',
    '  return found;',
    '}',
    '}'
  ].join(' ')
  const script = [
    'Add-Type "' + cs + '"',
    '$pids = [uint32[]]@((Get-Process electron -ErrorAction SilentlyContinue).Id)',
    '"VIS=" + [WV]::Count($pids)'
  ].join('; ')
  return ps(script).then((out) => /VIS=[1-9]/.test(out))
}

/** 前台窗口的可读摘要（类名/标题/矩形/是否最大化）——断言失败时用来定位到底是谁在前台。 */
function foregroundInfo() {
  const cs = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class FGI {',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetForegroundWindow();',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool IsZoomed(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
    'public struct RECT { public int L, T, R, B; }',
    'public static string Info() {',
    '  IntPtr h = GetForegroundWindow();',
    '  var c = new StringBuilder(256); GetClassNameW(h, c, 256);',
    '  var t = new StringBuilder(256); GetWindowTextW(h, t, 256);',
    '  RECT r; GetWindowRect(h, out r);',
    '  return c + ' + TICK + '/ ' + TICK + ' + t + ' + TICK + ' rect=' + TICK + ' + r.L + ' + TICK + ',' + TICK + ' + r.T + ' + TICK + ',' + TICK + ' + r.R + ' + TICK + ',' + TICK + ' + r.B + ' + TICK + ' zoom=' + TICK + ' + IsZoomed(h);',
    '}',
    '}'
  ].join(' ')
  return ps('Add-Type "' + cs + '"; [FGI]::Info()')
}

/** 主屏尺寸（bounds / workarea）——用来记录「工作区 < 整屏」这个前提是否成立。 */
function screenMetrics() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '"bounds=$($b.Width)x$($b.Height) work=$($w.Width)x$($w.Height)"'
  ].join('; ')
  return ps(script)
}

/** 造一个受控前台窗口。kind：
 *  full  —— 无边框铺满主屏 + TopMost（真全屏）
 *  max   —— 普通窗口最大化（本机工作区 < 整屏，正好是本次要修的场景）
 *  near  —— 普通窗口铺到整屏内缩 40px（贴边但不最大化，应当**不**触发避让）
 *  cloak —— 先铺满主屏，再用 DwmSetWindowAttribute(DWMWA_CLOAK=13) 把它 cloak 掉：
 *           对应用户看不到、却可能占着前台的那类壳层窗口（TextInputHost），
 *           合成版不依赖本机是否真的在跑 TextInputHost。
 * 返回子进程，调用方 kill 掉即可关窗（pwsh 死 → ShowDialog 的窗体跟着消失）。 */
function makeWindow(kind) {
  const cls = 'MK' + kind
  const cs = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class ' + cls + ' {',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetForegroundWindow();',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '[DllImport(' + TICK + 'kernel32.dll' + TICK + ')] public static extern uint GetCurrentThreadId();',
    '[DllImport(' + TICK + 'dwmapi.dll' + TICK + ')] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);',
    // DWMWA_CLOAK = 13：让窗口被 DWM 隐藏（对用户不可见），但 IsWindowVisible 仍为 True、
    // 矩形不变——这正是 TextInputHost 那个 Windows.UI.Core.CoreWindow 的状态。
    'public static void CloakIt(IntPtr h) { int v = 1; DwmSetWindowAttribute(h, 13, ref v, 4); }',
    // 抢前台三道保险：单靠 SetForegroundWindow 在「用户正在敲键盘」时会被系统静默拒绝
    // （[实测] 2026-11-17：同一脚本时而 FG 成功时而不成，故 attach + SwitchToThisWindow 兼顾）。
    'public static bool Steal(IntPtr h) {',
    '  uint p; uint ftid = GetWindowThreadProcessId(GetForegroundWindow(), out p);',
    '  uint me = GetCurrentThreadId();',
    '  AttachThreadInput(me, ftid, true);',
    '  bool ok = SetForegroundWindow(h);',
    '  AttachThreadInput(me, ftid, false);',
    '  SwitchToThisWindow(h, true);',
    '  return ok;',
    '}',
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
  if (kind === 'full' || kind === 'cloak') {
    lines.push('$f.FormBorderStyle = "None"')
    lines.push('$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds')
    lines.push('$f.TopMost = $true')
  } else if (kind === 'near') {
    // 带边框的普通窗口，四边内缩 40px：左/上都 > 8px 容差，判据必须拒绝它
    lines.push('$f.StartPosition = "Manual"')
    lines.push('$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds')
    lines.push('$f.Bounds = New-Object System.Drawing.Rectangle(($b.Left + 40), ($b.Top + 40), ($b.Width - 80), ($b.Height - 80))')
    lines.push('$f.TopMost = $true')
  } else {
    lines.push('$f.WindowState = "Maximized"')
  }
  lines.push(
    kind === 'cloak'
      ? '$f.Add_Shown({ [void][' + cls + ']::Steal($f.Handle); Start-Sleep -Milliseconds 300; [void][' + cls + ']::Steal($f.Handle); Start-Sleep -Milliseconds 600; [void][' + cls + ']::CloakIt($f.Handle) })'
      : '$f.Add_Shown({ [void][' + cls + ']::Steal($f.Handle) })'
  )
  // 后台进程抢前台会偶发被系统拒绝（实测：本机有窗口最大化/用户正在输入时，只调一次会失败，
  // 岛保持隐藏 → F0/W3 误报）。每 400ms 重抢，抢到即停，最多 10 次。
  lines.push('$tm = New-Object System.Windows.Forms.Timer')
  lines.push('$tm.Interval = 400')
  lines.push('$n = 0')
  lines.push('$tm.Add_Tick({ $script:n++; if ([' + cls + ']::GetForegroundWindow().ToInt64() -eq $f.Handle.ToInt64() -or $script:n -gt 10) { $tm.Stop() } else { [void][' + cls + ']::Steal($f.Handle) } })')
  lines.push('$tm.Start()')
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
function forceShellForeground(kind, holdMs = 0) {
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
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '[DllImport(' + TICK + 'kernel32.dll' + TICK + ')] public static extern uint GetCurrentThreadId();',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    'public struct RECT { public int L, T, R, B; }',
    'public static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }',
    'public static bool Steal(IntPtr h) {',
    '  uint p; uint ftid = GetWindowThreadProcessId(GetForegroundWindow(), out p);',
    '  uint me = GetCurrentThreadId();',
    '  AttachThreadInput(me, ftid, true);',
    '  bool ok = SetForegroundWindow(h);',
    '  AttachThreadInput(me, ftid, false);',
    '  SwitchToThisWindow(h, true);',
    '  return ok;',
    '}',
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
    'Add-Type -AssemblyName System.Drawing',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    target,
    // 零句柄判定必须走 ToInt64：IntPtr 用 -eq 与 [IntPtr]::Zero 比较不可靠（[实测] 曾漏判）
    'if ($h.ToInt64() -eq 0) { "NO-TARGET"; exit }',
    // 关键：后台进程直接 SetForegroundWindow(Progman/TIH) 会被系统拒绝（[实测] 2026-11-17 FG=False，
    // 且脚本一退出前台就被用户那个最大化窗口抢回）。改为「二传手」：
    // 先造一个我们自己的 8x8 小窗（新窗口天然有前台权）抢到前台，再作为**当前前台进程**把前台
    // 交给目标窗口——这样就合法了；脚本再 hold 一段时间，采样期间前台不会被抢走。
    '$f = New-Object System.Windows.Forms.Form',
    '$f.FormBorderStyle = "None"',
    '$f.ShowInTaskbar = $false',
    '$f.TopMost = $true',
    '$f.StartPosition = "Manual"',
    '$f.Bounds = New-Object System.Drawing.Rectangle(0,0,8,8)',
    '$f.Show()',
    'Start-Sleep -Milliseconds 300',
    '[void][SF]::Steal($f.Handle)',
    'Start-Sleep -Milliseconds 250',
    '[void][SF]::SetForegroundWindow($h)',
    '$f.Hide()',
    'Start-Sleep -Milliseconds 400',
    '$ok = [SF]::GetForegroundWindow().ToInt64() -eq $h.ToInt64()',
    '$cls = [SF]::Cls([SF]::GetForegroundWindow())',
    'Start-Sleep -Milliseconds ' + holdMs,
    // FGCLS 是关键证据：断言必须确认采样期间前台确实是目标类名，
    // 不能只凭「岛可见」——小窗或别的非全屏窗口在前台也会让岛可见（假阳性）。
    '"FG=" + $ok + " FGCLS=" + $cls + " FGEND=" + ([SF]::GetForegroundWindow().ToInt64() -eq $h.ToInt64()) + " FGENDCLS=" + [SF]::Cls([SF]::GetForegroundWindow())'
  ].join('; ')
  return ps(script)
}

// ---- 起 dev electron（隔离 userData）----
// 数据目录隔离由 ./isolate-userdata.mjs 的 spawn 包装统一加 --user-data-dir。
// 早期这里设过一个自以为能改路径的环境变量，实测它不改变 app.getPath('userData')，已删除。
// 预检（必须放在 spawn 之前！放后面会把刚起的被测实例一起杀掉，于是全程没有岛窗口、
// 所有「岛应可见」断言假失败）：清掉残留 electron。e2e 共用同一个隔离 userData，
// 残留实例的岛窗口会被 islandVisible() 一并数进去（它按进程名 electron 枚举）。
if (process.platform === 'win32') {
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 没有残留 */
  }
  // 同一次会话里跑多遍时，上次被强硬中断的 MK* 测试窗口（pwsh 没死）会留在前台，
  // 它们本身就是「最大化/铺满屏」，会把 F0 基线弄脏。按类名+标题精确关掉。
  const cs = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'using System.Text.RegularExpressions;',
    'public class KC {',
    'public delegate bool EnumProc(IntPtr h, IntPtr lp);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);',
    'public static int CloseStale() {',
    '  int n = 0;',
    '  EnumWindows((h, l) => {',
    '    var c = new StringBuilder(256); GetClassNameW(h, c, 256);',
    '    if (!c.ToString().StartsWith(' + TICK + 'WindowsForms10' + TICK + ')) return true;',
    '    var t = new StringBuilder(256); GetWindowTextW(h, t, 256);',
    '    if (!Regex.IsMatch(t.ToString(), ' + TICK + '^MK(full|max|near|cloak)$' + TICK + ')) return true;',
    '    PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++;',
    '    return true;',
    '  }, IntPtr.Zero);',
    '  return n;',
    '}',
    '}'
  ].join(' ')
  const enc = Buffer.from('Add-Type "' + cs + '"; "STALE=" + [KC]::CloseStale()', 'utf16le').toString('base64')
  try {
    execSync('powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + enc, { stdio: 'ignore' })
  } catch {
    /* 清理失败不影响测试 */
  }
  await new Promise((r) => setTimeout(r, 600))
}

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`,
    // e2e 稳定性：GPU / disk cache 在 DSH 环境偶发「拒绝访问」刷屏并伴随 CDP 卡死
    '--disable-gpu', '--disk-cache-size=1'
  ],
  {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
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

  // 基准量：判据基准是工作区，先把 bounds / workarea 打印出来（工作区 < 整屏时 F4 才算真的覆盖到本 bug）
  const metrics = await screenMetrics()
  console.log('  · 屏幕 ' + metrics)

  // F0/W3 起手基线：用一个「贴边但未最大化」的普通窗口占住前台。
  // 不能只靠「起手时岛应可见」——本机用户开着最大化 VS Code 时判据（修正后）会正确判定避让，
  // 实例一起来就是隐藏态。2026-11-17 实测：不主动拿前台时 F0 / waitVisible 必失败。
  const near = makeWindow('near')
  wins.push(near)
  await sleep(4000)
  const fg0 = await foregroundInfo()
  const v0 = await waitVisible(true, 6000)
  // W3 与 F0 合并：near 窗口四边内缩 40px，8px 容差不得把它当全屏（否则岛会藏起来）。
  // 同时要求前台确实是 MKnear——否则这条断言没意义（抢不到前台时 island 值不可解释）。
  const nearFg = fg0.includes('MKnear')
  ok('F0/W3 贴边未最大化→岛保持可见', nearFg && v0 === true, `island=${v0} fg=${fg0}`)
  near.kill()

  // F1 真全屏 → 隐藏（判定 1s + 去抖 300ms，留足余量）
  const full = makeWindow('full')
  wins.push(full)
  await sleep(3500)
  const v1 = await waitVisible(false, 6000)
  ok('F1 真全屏→岛隐藏', v1 === false, `island=${v1} fg=${await foregroundInfo()}`)

  // F5 关全屏 → 自动恢复（旧代码误判后不回来，这一条是修复的正面证据）。
  // 必须同时把前台交给一个普通窗口：只 kill 的话前台可能回到用户那个最大化窗口，
  // 那岛上不来才是对的（2026-11-17 实测就是这样，旧写法在这里假失败）。
  full.kill()
  const near5 = makeWindow('near')
  wins.push(near5)
  await sleep(2000)
  const v5 = await waitVisible(true, 6000)
  ok('F5 关全屏→岛自动恢复', v5 === true, `island=${v5} fg=${await foregroundInfo()}`)
  near5.kill()

  // F2 cloak 壳层窗口置前 → 岛保持可见（旧判据在此会 hide）
  // 用合成 cloak 窗口而不是真 TextInputHost：后者要 IME 在跑才存在，且**系统不允许把已被
  // cloak 的窗口抢为前台**（[实测] 2026-11-17 force 始终 FG=False），无法稳定复现。
  // 合成窗口四边铺满整屏、cloaked=1、自己活着保住前台，与 TextInputHost 的状态等价。
  const cloakWin = makeWindow('cloak')
  wins.push(cloakWin)
  await sleep(3500)
  const v2 = await waitVisible(true, 4000)
  ok('F2 cloak 壳层窗口→岛保持可见', v2 === true, `island=${v2} fg=${await foregroundInfo()}`)
  cloakWin.kill()

  // F3 桌面 Progman 置前 → 岛保持可见
  const pmP = forceShellForeground('progman', 4500)
  await sleep(2600)
  const v3 = await islandVisible()
  const pm = await pmP
  const pmFg = /FGCLS=(Progman|WorkerW)/.test(pm)
  ok('F3 桌面 Progman→岛保持可见', pmFg && v3 === true, `island=${v3} ${pm.replace(/\s+/g, ' ')}`)

  // F4/W1 最大化普通应用 → 仍隐藏（US-041 原设计：最大化占满屏幕也避让）
  const max = makeWindow('max')
  wins.push(max)
  await sleep(3500)
  const v4 = await waitVisible(false, 8000)
  ok('F4/W1 最大化应用→岛隐藏', v4 === false, `island=${v4} screen=${metrics} fg=${await foregroundInfo()}`)

  // 收尾：关掉窗口，前台回到普通窗口（near），岛必须能自己回来。
  // 不能只 kill 后等：杀完前台可能直接回到用户那个最大化窗口，岛就又该藏起来了。
  max.kill()
  const near2 = makeWindow('near')
  wins.push(near2)
  await sleep(2500)
  const vEnd = await waitVisible(true, 6000)
  ok('F6 收尾：关全屏窗+前台回普通窗→岛自动恢复', vEnd === true, `island=${vEnd} fg=${await foregroundInfo()}`)
  near2.kill()
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
