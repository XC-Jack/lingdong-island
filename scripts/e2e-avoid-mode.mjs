#!/usr/bin/env node
/**
 * 避让三档策略 + 隐藏延迟 e2e（对应 docs/Spec/SPEC-avoid-mode-and-latency.md 的 M1-M5、M7）。
 *
 * 背景：用户 2026-11-17 要求「设置页加三个选项（全屏隐藏 / 最大化隐藏 / 不隐藏），
 * 隐藏延迟从 1.5 秒降到 0.75 秒」。三档存在 prefs.json 的 avoidMode：
 *   maximized（默认）= 最大化与真全屏都隐藏
 *   fullscreen       = 只有真全屏隐藏，最大化窗口保留岛
 *   off              = 一律不隐藏
 *
 * 断言：
 *  M1 默认值 = maximized（prefsGet 读回）
 *  M2 maximized：最大化窗口 → 隐藏；还原 → 现身
 *  M3 fullscreen：最大化窗口 → 保持可见；真全屏 → 隐藏
 *  M4 off：最大化/真全屏都保持可见
 *  M5 隐藏/现身延迟各 ≤ 1000ms（目标 750），把实测值打出来
 *  M7 辅助进程运行期间 DevTools /json/list 仍然秒回（不能复现「长驻子进程拖死 HTTP」事故）
 *
 * 踩坑继承（都踩过，别再踩）：
 * ①前台必须自己抢：后台进程单次 SetForegroundWindow 会被系统拒绝 → Steal() + 400ms 重试；
 * ②岛可见性用 C# 枚举（PowerShell 脚本块回调里计数在 -EncodedCommand 下不生效）；
 * ③CDP 要按 URL 挑岛页面：避让态会多出一个 4px 感应窗的 data: 页面；
 * ④预检 taskkill 必须在 spawn 之前，否则把刚起的被测实例一起杀掉；
 * ⑤光标别停在屏幕顶部 4px 感应带里——那会让岛一直「临时现身」，测延迟必假失败。
 */
import { spawn, execSync, USER_DATA } from './isolate-userdata.mjs'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(ELECTRON)) {
  console.error('electron.exe not found at', ELECTRON)
  process.exit(1)
}
const PORT = 9381
const TICK = '`"'
const results = []
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`withTimeout: ${tag} 超时 ${ms}ms`)), ms))
  ])
}

/** 跑一段 PowerShell（-EncodedCommand，多行脚本压平成 -Command 会炸）。只收 stdout。 */
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

/** 岛可见性（Win32 层真相）。枚举写在 C# 里，别用 PowerShell 脚本块回调。 */
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

async function waitVisible(want, timeoutMs, stepMs = 60) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await islandVisible()
    if (last === want) return { value: last, elapsed: timeoutMs - (deadline - Date.now()) }
    await sleep(stepMs)
  }
  return { value: last, elapsed: timeoutMs }
}

/** 造受控窗口。kind：max（最大化普通窗）/ full（无边框铺满整屏）。
 * 自带 Steal()（attach + SetForegroundWindow + SwitchToThisWindow）+ 400ms 重试。 */
function makeWindow(kind) {
  const cls = 'AM' + kind
  const cs = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class ' + cls + ' {',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetForegroundWindow();',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern void SwitchToThisWindow(IntPtr h, bool a);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool AttachThreadInput(uint a, uint b, bool c);',
    '[DllImport(' + TICK + 'kernel32.dll' + TICK + ')] public static extern uint GetCurrentThreadId();',
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
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type "' + cs + '"',
    '$f = New-Object System.Windows.Forms.Form',
    "$f.Text = '" + cls + "'",
    '$f.ShowInTaskbar = $false',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(26,26,34)'
  ]
  if (kind === 'full') {
    lines.push('$f.FormBorderStyle = "None"')
    lines.push('$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds')
  } else {
    lines.push('$f.WindowState = "Maximized"')
  }
  lines.push('$f.Add_Shown({ [void][' + cls + ']::Steal($f.Handle) })')
  lines.push('$tm = New-Object System.Windows.Forms.Timer')
  lines.push('$tm.Interval = 400')
  lines.push('$n = 0')
  lines.push(
    '$tm.Add_Tick({ $script:n++; if ([' + cls + ']::GetForegroundWindow().ToInt64() -eq $f.Handle.ToInt64() -or $script:n -gt 10) { $tm.Stop() } else { [void][' + cls + ']::Steal($f.Handle) } })'
  )
  lines.push('$tm.Start()')
  lines.push('[void]$f.ShowDialog()')
  const enc = Buffer.from(lines.join('; '), 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { stdio: 'ignore' })
}

/** 把光标放到顶部 4px 感应带上（触发摸边临时现身）。 */
async function hoverTopEdge() {
  await ps(
    'Add-Type "using System; using System.Runtime.InteropServices; public class MCE { [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ')] public static extern bool SetCursorPos(int x, int y); }"; [void][MCE]::SetCursorPos(768, 0); "ok"'
  )
}

/** 光标移出顶部感应带：光标停在 y<4 会让岛「临时现身」，测隐藏延迟必假失败。 */
async function parkCursor() {
  await ps(
    'Add-Type "using System; using System.Runtime.InteropServices; public class MCP { [DllImport(' +
      TICK +
      'user32.dll' +
      TICK +
      ')] public static extern bool SetCursorPos(int x, int y); }"; [void][MCP]::SetCursorPos(300, 700); "ok"'
  )
}

// ---- CDP：改 prefs.avoidMode 用（设置窗口之外最接近真实的写入路径就是 prefs:set）----
let cdp = null
async function cdpConnect() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })
      const targets = await res.json()
      // 按 URL 挑岛：避让态会多出 4px 感应窗的 data: 页面，它没有 preload → window.island 不存在
      const pages = targets.filter((t) => t.type === 'page' && !/devtools/i.test(t.url))
      const page = pages.find((t) => /index\.html/.test(t.url)) ?? pages.find((t) => !/^data:/.test(t.url))
      if (!page) throw new Error('no page target')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r, j) => {
        ws.onopen = r
        ws.onerror = j
      })
      let id = 0
      const pending = new Map()
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m)
          pending.delete(m.id)
        }
      }
      const send = (method, params) =>
        new Promise((resolve, reject) => {
          const myId = ++id
          const t = setTimeout(() => {
            pending.delete(myId)
            reject(new Error(`CDP 超时: ${method}`))
          }, 8000)
          pending.set(myId, (m) => {
            clearTimeout(t)
            resolve(m)
          })
          ws.send(JSON.stringify({ id: myId, method, params }))
        })
      return { ws, send }
    } catch {
      await sleep(1000)
    }
  }
  throw new Error('CDP 连不上')
}

async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

const setMode = (m) => evalJs(`window.island.prefsSet({ avoidMode: ${JSON.stringify(m)} }).then(p => p.avoidMode)`)
const getMode = () => evalJs(`window.island.prefsGet().then(p => p.avoidMode || 'maximized')`)

// ---- 起 dev electron ----
// 预检必须在 spawn 之前：清掉残留 electron（共用隔离 userData + 同一个心跳文件，两个实例会打架）
if (process.platform === 'win32') {
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 没有残留 */
  }
  await sleep(700)
}
// 清掉上一轮留下的隔离偏好：M1 断言的是「字段缺失时的默认档」，上一轮结束时若把
// avoidMode 写成了别的值，这一轮就会假失败（[实测] 2026-11-17 就这么翻过一次车）。
// 只删隔离目录里的 prefs.json，真实用户数据在 %APPDATA% 下，这里完全不碰。
try {
  rmSync(join(USER_DATA, 'prefs.json'), { force: true })
} catch {
  /* 删不掉就按现状跑 */
}

const child = spawn(
  ELECTRON,
  ['.', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--disk-cache-size=1'],
  {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'inherit', 'inherit']
  }
)

const wins = []
try {
  await sleep(7000)
  cdp = await cdpConnect()

  // M1 默认值
  const def = await getMode()
  ok('M1 默认策略 = maximized', def === 'maximized', `avoidMode=${def}`)

  // 先把前台换成「最大化普通窗」，再看三档的表现差异
  await parkCursor()
  const maxWin = makeWindow('max')
  wins.push(maxWin)
  await sleep(2500)

  // M2 maximized：最大化 → 隐藏
  await setMode('maximized')
  await sleep(400)
  const m2hide = await waitVisible(false, 3000)
  ok('M2 maximized：最大化窗口 → 岛隐藏（≤1000ms）', m2hide.value === false && m2hide.elapsed <= 1000,
    `hide=${m2hide.elapsed}ms`)

  // M5（隐藏方向延迟另测一轮，见下）
  // M3 fullscreen：同一前台窗口 → 岛应该回来（最大化不算真全屏）
  await setMode('fullscreen')
  const m3show = await waitVisible(true, 3000)
  ok('M3 fullscreen：最大化窗口 → 岛保持可见', m3show.value === true, `show=${m3show.elapsed}ms`)

  // M3b fullscreen + 真全屏 → 隐藏
  const fullWin = makeWindow('full')
  wins.push(fullWin)
  await sleep(2500)
  const m3b = await waitVisible(false, 3000)
  ok('M3b fullscreen：真全屏 → 岛隐藏', m3b.value === false, `hide=${m3b.elapsed}ms`)
  fullWin.kill()
  await sleep(1500)

  // M4 off：真全屏也不隐藏
  await setMode('off')
  await parkCursor()
  const fullWin2 = makeWindow('full')
  wins.push(fullWin2)
  await sleep(2500)
  const m4 = await waitVisible(true, 3000)
  ok('M4 off：真全屏也不隐藏', m4.value === true, `island=${m4.value}`)
  fullWin2.kill()
  await sleep(1200)

  // M5 延迟实测：用「切策略」来驱动隐藏/现身，避免把造窗口 + 抢前台的 1~2 秒算进延迟里。
  // 前置：前台是那个最大化窗口（此时岛处于隐藏态）。
  const latWin = makeWindow('max')
  wins.push(latWin)
  await sleep(2500)
  await setMode('maximized')
  await sleep(400)
  const hideTimes = []
  const showTimes = []
  for (let i = 0; i < 3; i++) {
    // 现身方向：切到「不隐藏」→ 岛应该回来
    await setMode('off')
    const shown = await waitVisible(true, 3000)
    if (shown.value === true) showTimes.push(shown.elapsed)
    // 隐藏方向：切回「最大化也隐藏」→ 岛应该藏起来
    await setMode('maximized')
    const hid = await waitVisible(false, 3000)
    if (hid.value === false) hideTimes.push(hid.elapsed)
    await sleep(300)
  }
  latWin.kill()
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1)
  ok('M5 延迟 ≤1000ms（隐藏，目标 750）', hideTimes.length === 3 && Math.max(...hideTimes) <= 1000,
    `hide=${hideTimes.join(',')}ms avg=${avg(hideTimes)}`)
  ok('M5 延迟 ≤1000ms（现身）', showTimes.length === 3 && Math.max(...showTimes) <= 1000,
    `show=${showTimes.join(',')}ms avg=${avg(showTimes)}`)

  // M6 残留状态自愈（回归 2026-11-17 用户实测：按 F11 岛没藏）
  // 复现序列：最大化隐藏（avoided）→ 摸边临时现身 → 切成 fullscreen 档（期望变 false，但被
  // tempVisible 压制）→ 光标移开 → 此时 state 仍是 avoided 而岛可见 → 再来一次真全屏，
  // 旧代码的 commit(true) 因 state!=='normal' 静默失效，岛就一直亮着。新代码靠 reconcile 自愈。
  await setMode('maximized')
  await parkCursor()
  const staleWin = makeWindow('max')
  wins.push(staleWin)
  await sleep(2500)
  await waitVisible(false, 3000) // 先确认已隐藏（avoided，感应带存在）
  await hoverTopEdge()
  await sleep(1500)
  await setMode('fullscreen') // 判定 Z → 期望 false，但 tempVisible 压着不落地
  await parkCursor()
  await sleep(1500)
  const fullWin3 = makeWindow('full')
  wins.push(fullWin3)
  await sleep(2000)
  const healed = await waitVisible(false, 3000)
  ok('M6 摸边现有残留后进入真全屏 → 岛仍能自己藏起来（自愈）', healed.value === false, `hide=${healed.elapsed}ms`)
  fullWin3.kill()
  staleWin.kill()
  await sleep(1200)

  // M7 辅助进程运行期间 DevTools 必须仍然秒回（旧事故：长驻子进程 + 管道把 HTTP 拖死）
  const lat = []
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
    lat.push(Date.now() - t0)
    if (!r.ok) lat.push(99999)
    await sleep(200)
  }
  ok('M7 辅助进程运行中 DevTools /json/list 仍秒回', Math.max(...lat) < 2000, `latency=${lat.join(',')}ms`)

  // M8 判断路径的依赖面（SPEC-avoid-helper-robustness，2026-11-17）
  // 用户另一台机器上玩独占全屏游戏时弹过「powershell.exe - 系统错误 / 0xc0000005」，
  // 当时判断路径上有两个可疑面：①常驻脚本加载了 System.Windows.Forms（只为拿工作区尺寸）；
  // ②摸边临时现身期间每 400ms 再 spawn 一个 PowerShell 读光标。这两条都必须消失。
  const watchSrc = readFileSync(join(ROOT, 'src', 'main', 'fullscreenWatch.ts'), 'utf8')
  // 只看「真的去加载那个程序集」（注释里提到它不算）
  const noWinForms = !/-AssemblyName System\.Windows\.Forms/.test(watchSrc)
  const noCursorSpawn = !/CURSOR_WATCH_INTERVAL_MS/.test(watchSrc) && !/cursorScript/.test(watchSrc)
  ok('M8a 判断路径不再加载 System.Windows.Forms', noWinForms, noWinForms ? '' : '仍有 WinForms 引用')
  ok('M8b 摸边不再每 400ms spawn 一个 PowerShell', noCursorSpawn, noCursorSpawn ? '' : '仍存在光标轮询 spawn')

  // M8c 心跳文件必须带光标坐标：码|毫秒|x,y
  let beatRaw = ''
  try {
    beatRaw = readFileSync(join(USER_DATA, 'avoid-mode-beat.txt'), 'utf8').trim()
  } catch {
    beatRaw = ''
  }
  ok('M8c 心跳文件格式 = 码|毫秒|光标x,y', /^[FZN]\|\d+\|-?\d+,-?\d+$/.test(beatRaw), `beat=${beatRaw}`)

  // 收尾恢复默认，别把测试设置留在隔离 prefs 里给下一轮添乱（必须放在所有用例之后——
  // [实测] 2026-11-17 放早了：M6 把档位切成 fullscreen 后没再复位，害得 e2e-fullscreen-misjudge
  // 的 F4「最大化→隐藏」假失败）
  await setMode('maximized')
} catch (err) {
  console.error('e2e error:', err)
  results.push({ name: 'e2e 运行异常', pass: false, detail: String(err && err.message) })
} finally {
  cdp?.ws?.close()
  for (const w of wins) {
    try {
      w.kill()
    } catch {
      /* noop */
    }
  }
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* noop */
    }
  } else {
    try {
      child.kill()
    } catch {
      /* noop */
    }
  }
}

const failed = results.filter((r) => !r.pass).length
console.log(`\n== 避让三档 e2e：${results.length - failed} 过 / ${failed} 败 ==`)
process.exit(failed > 0 ? 1 : 0)
