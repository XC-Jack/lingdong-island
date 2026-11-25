#!/usr/bin/env node
/**
 * 岛内右键菜单期间不收起（SPEC-app-menu-collapse，2026-11-25 用户报障）。
 *
 * 用户场景：岛展开时右键 → 原生菜单弹出 → 鼠标移向「暂时隐藏灵动岛」的过程中，
 * 岛先缩回收起态（菜单超出岛窗口下沿，光标离开窗口触发 mouseleave 收起定时器）。
 *
 * 覆盖：
 *   N1 展开态右键 → 原生菜单确实弹出（岛的进程多出一个 Chrome_WidgetWin_1 窗口）
 *   N2 菜单开着 2.5s、光标已离开岛窗口 → 岛保持展开
 *   N3 点菜单外空白关闭 → 菜单消失、岛按「鼠标移开」口径收起
 *
 * 踩坑：
 *  - 岛可能正因前台最大化/全屏处于避让隐藏态，窗口不会展开；先造一个普通前景窗把前台换走。
 *  - SetCursorPos 是物理像素，渲染层 screenX/outerWidth 是 DIP，必须乘 devicePixelRatio
 *    （本机 1.25），否则右键会点空——岛根本收不到 contextmenu。
 *  - Electron 45 的原生菜单**不是** Win32 的 `#32768`，而是 Chromium 自己的
 *    `Chrome_WidgetWin_1` 窗口（[实测] 2026-11-25），只能按「进程内多出一个该类的可见窗口」判断。
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
const PORT = 9361
const TICK = '`"'
const results = []
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 跑一段 PowerShell（-EncodedCommand 传多行脚本，只收 stdout）。 */
function ps(script) {
  return new Promise((resolve) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('exit', () => resolve(out))
  })
}

/** 造一个 400×300 的普通前景窗，把前台从用户自己的窗口换走，让岛回到 normal 态并可见。 */
function makeSmallWin() {
  const cs =
    'using System; using System.Runtime.InteropServices; public class NW { ' +
    '[DllImport(`"user32.dll`")] public static extern bool SetForegroundWindow(IntPtr h); ' +
    '[DllImport(`"user32.dll`")] public static extern IntPtr GetForegroundWindow(); ' +
    '[DllImport(`"user32.dll`")] public static extern void SwitchToThisWindow(IntPtr h, bool a); ' +
    '[DllImport(`"user32.dll`")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); ' +
    '[DllImport(`"user32.dll`")] public static extern bool AttachThreadInput(uint a, uint b, bool c); ' +
    '[DllImport(`"kernel32.dll`")] public static extern uint GetCurrentThreadId(); ' +
    'public static bool Steal(IntPtr h) { uint p; uint f = GetWindowThreadProcessId(GetForegroundWindow(), out p); uint me = GetCurrentThreadId(); AttachThreadInput(me, f, true); bool ok = SetForegroundWindow(h); AttachThreadInput(me, f, false); SwitchToThisWindow(h, true); return ok; } }'
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type "' + cs + '"',
    '$f = New-Object System.Windows.Forms.Form',
    "$f.Text = 'NMENU'",
    '$f.StartPosition = `"Manual`"',
    '$f.Bounds = New-Object System.Drawing.Rectangle(300, 300, 400, 300)',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(30,30,40)',
    '$f.Add_Shown({ [void][NW]::Steal($f.Handle) })',
    '[void]$f.ShowDialog()'
  ]
  const enc = Buffer.from(lines.join('; '), 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { stdio: 'ignore' })
}

/** 统计岛进程里可见的 Chrome_WidgetWin_1 窗口数：1=只有岛，2=岛+原生菜单。 */
function winCountScript() {
  const cs = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class CW {',
    'public delegate bool EP(IntPtr h, IntPtr l);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool EnumWindows(EP cb, IntPtr l);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool IsWindowVisible(IntPtr h);',
    'public struct RECT { public int L, T, R, B; }',
    'public static int Count(uint[] pids) {',
    '  int n = 0;',
    '  EnumWindows((h, l) => {',
    '    uint p; GetWindowThreadProcessId(h, out p);',
    '    if (Array.IndexOf(pids, p) < 0) return true;',
    '    var sb = new StringBuilder(256); GetClassNameW(h, sb, 256);',
    '    if (sb.ToString() != ' + TICK + 'Chrome_WidgetWin_1' + TICK + ') return true;',
    '    RECT r; GetWindowRect(h, out r); int hg = r.B - r.T;',
    '    if (hg > 40 && IsWindowVisible(h)) n++;',
    '    return true;',
    '  }, IntPtr.Zero);',
    '  return n;',
    '}',
    '}'
  ].join(' ')
  return 'Add-Type "' + cs + '"; $pids = [uint32[]]@((Get-Process electron -ErrorAction SilentlyContinue).Id); "W=" + [CW]::Count($pids)'
}

/** 右键（可选先左键聚焦）并等菜单出现，返回窗口数。坐标是**物理像素**。 */
async function rightClick(x, y) {
  const cs =
    'using System; using System.Runtime.InteropServices; public class RC { ' +
    '[DllImport(`"user32.dll`")] public static extern bool SetCursorPos(int x, int y); ' +
    '[DllImport(`"user32.dll`")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e); ' +
    '[DllImport(`"user32.dll`")] public static extern bool SetProcessDPIAware(); ' +
    'public static void L(int x, int y) { SetCursorPos(x, y); mouse_event(2,0,0,0,IntPtr.Zero); mouse_event(4,0,0,0,IntPtr.Zero); } ' +
    'public static void R(int x, int y) { SetCursorPos(x, y); mouse_event(8,0,0,0,IntPtr.Zero); mouse_event(16,0,0,0,IntPtr.Zero); } }'
  return ps('Add-Type "' + cs + '"; [void][RC]::SetProcessDPIAware(); [RC]::L(' + x + ',' + y + '); Start-Sleep -Milliseconds 350; [RC]::R(' + x + ',' + y + '); Start-Sleep -Milliseconds 900; ' + winCountScript())
}

async function leftClick(x, y) {
  const cs =
    'using System; using System.Runtime.InteropServices; public class LC { ' +
    '[DllImport(`"user32.dll`")] public static extern bool SetCursorPos(int x, int y); ' +
    '[DllImport(`"user32.dll`")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e); ' +
    '[DllImport(`"user32.dll`")] public static extern bool SetProcessDPIAware(); ' +
    'public static void Go(int x, int y) { SetCursorPos(x, y); mouse_event(2,0,0,0,IntPtr.Zero); mouse_event(4,0,0,0,IntPtr.Zero); } }'
  return ps('Add-Type "' + cs + '"; [void][LC]::SetProcessDPIAware(); [LC]::Go(' + x + ',' + y + '); "ok"')
}

// ---- CDP（只用来点展开、读岛状态与窗口坐标）----
async function cdpConnect() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })
      const targets = await res.json()
      const pages = targets.filter((t) => t.type === 'page' && !/devtools/i.test(t.url))
      const page = pages.find((t) => /index\.html/.test(t.url)) ?? pages.find((t) => !/^data:/.test(t.url))
      if (!page) throw new Error('no page target')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
      let id = 0
      const pending = new Map()
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      }
      return {
        send(method, params = {}) {
          return new Promise((resolve) => {
            const mid = ++id
            pending.set(mid, resolve)
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        close() { ws.close() }
      }
    } catch {
      await sleep(1000)
    }
  }
  throw new Error('cdpConnect: 15 次重试仍失败')
}
async function evalJs(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

// 预检：清掉残留 electron（共用隔离 userData，残留实例会污染窗口计数）
if (process.platform === 'win32') {
  try { execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' }) } catch { /* 没有残留 */ }
  await sleep(700)
}

const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--disk-cache-size=1'], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'inherit', 'inherit']
})
const smallWin = makeSmallWin()
let cdp
try {
  await sleep(7000)
  cdp = await cdpConnect()
  await sleep(2500)

  const state = async () => String(await evalJs(cdp, `document.querySelector('.island')?.className || 'none'`)).trim()
  // 展开（DOM 点击等价于用户点一下岛；主进程按 measured size 调整窗口）
  await evalJs(cdp, `document.querySelector('.island').click(); 1`)
  await sleep(1800)
  const expanded = (await state()).includes('expanded')
  ok('N0 前置：点击后岛展开', expanded, await state())

  const rect = await evalJs(cdp, `({x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, d: window.devicePixelRatio})`)
  const cx = Math.round((rect.x + rect.w / 2) * rect.d)
  const cy = Math.round((rect.y + rect.h / 2) * rect.d)
  const before = (await ps(winCountScript())).trim()
  const clicked = (await rightClick(cx, cy)).trim()
  const wm = /W=(\d+)/.exec(clicked)
  ok('N1 右键后原生菜单弹出（进程多出一个可见窗口）',
    wm && Number(wm[1]) >= 2,
    `${before} → ${clicked}  岛窗口=${JSON.stringify(rect)} 右键物理坐标=${cx},${cy}`)

  // 菜单开着 2.5 秒：光标在岛窗口外（菜单超出岛下沿），岛必须保持展开
  await sleep(2500)
  const during = await state()
  ok('N2 菜单打开期间岛不收起', during.includes('expanded'), during)

  // 点菜单外空白 → 菜单关闭 → 岛按鼠标移开口径收起
  await leftClick(400, 850)
  await sleep(2000)
  const after = await state()
  const wAfter = (await ps(winCountScript())).trim()
  ok('N3 关闭菜单后菜单消失、岛收起',
    !after.includes('expanded') && Number((/W=(\d+)/.exec(wAfter) || [0, 9])[1]) <= 1,
    `${after}  ${wAfter}`)
} catch (err) {
  console.error('e2e error:', err)
} finally {
  cdp?.close()
  try { smallWin.kill() } catch { /* noop */ }
  if (process.platform === 'win32') {
    try { require('node:child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* noop */ }
  } else {
    child.kill()
  }
}

const pass = results.filter((r) => r.pass).length
console.log(`\n== 结果：${pass} 过 / ${results.length - pass} 败 ==`)
process.exit(pass === results.length ? 0 : 1)
