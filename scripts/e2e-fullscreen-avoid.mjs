#!/usr/bin/env node
/**
 * US-041 全屏自动避让 e2e。
 * A1 常态可见 / A2 造全屏窗口 → 岛 2s 内隐藏 / A3 关全屏 → 恢复
 * A4 摸边唤回（光标移 y=0，**最大化场景**；真全屏下摸边已被禁用）/ A5 移开回隐 / A6 手动隐藏摸边无效+托盘恢复（托盘点击难模拟，改为 IPC 等价路径）
 * A7 全屏时发通知 → 横幅期临时可见。
 * 前置：dev electron（--remote-debugging-port=9321）；Cleared ELECTRON_RUN_AS_NODE。
 * 踩坑：①ps() 只收 stdout——stderr 的 CLIXML 进度流会污染输出；②Add-Type 单行双引号版最稳
 * （多行 here-string 嵌套必炸）；③透明无边框窗口有 MainWindowHandle（非 0）。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(ELECTRON)) {
  console.error('electron.exe not found at', ELECTRON)
  process.exit(1)
}
const PORT = 9341
const results = []
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// PowerShell helper: run via -EncodedCommand (多行脚本不能压扁，老坑)。
// 只收 stdout：stderr 的 CLIXML 进度流（#< CLIXML）会污染输出导致断言假败（实测踩坑）。
function ps(script) {
  return withTimeout(new Promise((resolve) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('exit', () => resolve(out))
  }), 20000, 'ps()')
}

// 可见性断言走 CDP document.visibilityState。
// 踩坑（实测）：IsWindowVisible(MainWindowHandle) 对 hide() 后的 Electron 透明无边框窗口**仍返回 True**——
// MainWindowHandle 指向的宿主外壳窗口不随 BrowserWindow.hide() 隐藏；visibilityState 才是可靠判据
// （实测 normal=visible、全屏避让后=hidden）。tag 参数保留占位（历史断言签名）。

// 超时包装：ps()/makeFullscreen 的 pwsh 偶发挂死（DSH 环境实测，e2e 卡死连环毁后续轮次）。
// 任何一步超时就 throw，走 finally taskkill 清场，不让孤儿拖累后续。
function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`withTimeout: ${tag} 超时 ${ms}ms`)), ms))
  ])
}

// 造受控窗口。kind：
//  'full'  —— 无边框铺满主屏（真全屏应用）
//  'small' —— 500×400 普通窗（用来把前台从「用户自己的最大化窗口」换成普通窗口）
//
// 两点实测教训（2026-11-17）：
// ①**不要**给 full 加 TopMost：Electron 在 Windows 上 setAlwaysOnTop(true,'screen-saver') 的
//   level 参数是 macOS 专用、Windows 只有 topmost 一个档位，于是两者同桶、按创建顺序压叠；
//   若 full 比顶部 4px 感应带更晚置顶，就会盖住感应带 → A4 摸边唤回收不到 mouseenter（假失败）。
//   前台靠 Steal()（attach + SetForegroundWindow + SwitchToThisWindow）拿，不需要 TopMost。
// ②抢前台必须重试：用户正在敲键盘/前台是最大化窗口时，单次 SetForegroundWindow 会被系统拒绝。
function makeWin(tag, kind) {
  const cls = 'AW' + tag
  const cs =
    'using System; using System.Runtime.InteropServices; public class ' + cls + ' { ' +
    '[DllImport(`"user32.dll`")] public static extern bool SetForegroundWindow(IntPtr h); ' +
    '[DllImport(`"user32.dll`")] public static extern IntPtr GetForegroundWindow(); ' +
    '[DllImport(`"user32.dll`")] public static extern void SwitchToThisWindow(IntPtr h, bool alt); ' +
    '[DllImport(`"user32.dll`")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); ' +
    '[DllImport(`"user32.dll`")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); ' +
    '[DllImport(`"kernel32.dll`")] public static extern uint GetCurrentThreadId(); ' +
    'public static bool Steal(IntPtr h) { uint p; uint ftid = GetWindowThreadProcessId(GetForegroundWindow(), out p); uint me = GetCurrentThreadId(); AttachThreadInput(me, ftid, true); bool ok = SetForegroundWindow(h); AttachThreadInput(me, ftid, false); SwitchToThisWindow(h, true); return ok; } }'
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type "' + cs + '"',
    '$f = New-Object System.Windows.Forms.Form',
    "$f.Text = '" + cls + "'",
    '$f.ShowInTaskbar = $false',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(30,30,40)'
  ]
  if (kind === 'full') {
    lines.push("$f.FormBorderStyle = 'None'")
    lines.push('$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds')
  } else if (kind === 'max') {
    lines.push("$f.WindowState = 'Maximized'")
  } else {
    lines.push("$f.StartPosition = 'Manual'")
    lines.push('$f.Bounds = New-Object System.Drawing.Rectangle(300,300,500,400)')
  }
  lines.push('$f.Add_Shown({ [void][' + cls + ']::Steal($f.Handle) })')
  lines.push('$tm = New-Object System.Windows.Forms.Timer')
  lines.push('$tm.Interval = 400')
  lines.push('$n = 0')
  lines.push('$tm.Add_Tick({ $script:n++; if ([' + cls + ']::GetForegroundWindow().ToInt64() -eq $f.Handle.ToInt64() -or $script:n -gt 10) { $tm.Stop() } else { [void][' + cls + ']::Steal($f.Handle) } })')
  lines.push('$tm.Start()')
  lines.push('[void]$f.ShowDialog()')
  const enc = Buffer.from(lines.join('; '), 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { stdio: 'ignore' })
}

// 摸边：光标移 (屏宽/2, 0) 或任意位置，并**等光标真的到位**。
// 踩坑双重：①引用 [System.Windows.Forms.Screen] 必须先 Add-Type -AssemblyName（否则 TypeNotFound 光标不动）；
// ②pwsh 冷启动 + Add-Type ≈ 1~2s，调用方如果只 sleep 固定时间，查询时光标可能还没到 → 断言假败。
// 故 SetCursorPos 后轮询 Cursor.Position 直到匹配（x 容差 60px 给 DPI 取整，y 精确）或超时 6s。
async function moveCursor(xExpr, y) {
  const script = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type "using System; using System.Runtime.InteropServices; public class M' + y + ' { [DllImport(`"user32.dll`")] public static extern bool SetCursorPos(int x, int y); }"; $sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [void][M' + y + ']::SetCursorPos(' + xExpr + ', ' + y + '); $tx = ' + xExpr + '; $deadline=(Get-Date).AddSeconds(6); while((Get-Date) -lt $deadline) { $c=[System.Windows.Forms.Cursor]::Position; if([Math]::Abs($c.X - $tx) -le 60 -and $c.Y -eq ' + y + ') { "settled $($c.X),$($c.Y)"; break }; Start-Sleep -Milliseconds 100 }; if((Get-Date) -ge $deadline -and -not (Get-Variable -Name settled -ErrorAction SilentlyContinue)) { "timeout" }'
  const out = (await ps(script)).trim()
  if (!out.includes('settled')) console.log(`  [warn] moveCursor 未确认到位: ${out.slice(0, 80)}`)
}

// CDP minimal client
async function cdpConnect() {
  // 踩坑：electron 起来后 devtools 端口就绪可能慢于固定 sleep；且偶发 ECONNRESET（端口已听但
  // 服务未就绪）。轮询重试 15 次 × 1s，每次 fetch 带 3s AbortSignal 超时，防整卡。
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })
      const targets = await res.json()
      // ⚠ 不能「取第一个 page」：岛一进避让态就会多出一个 4px 感应窗的 page 目标
      // （data:text/html，nodeIntegration 直连 ipc，没有 preload → window.island 不存在），
      // 它常常排在岛前面，取错了后面 window.island.manualHide() 直接不是同一个页面
      // （[实测] 2026-11-17：表现为 CDP eval 永不返回、脚本卡死）。按 URL 精确挑岛。
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
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('cdpConnect: 15 次重试仍失败')
}

async function cdpEval(cdp, expr, timeoutMs = 8000) {
  // 带超时：历史上偶发过「Runtime.evaluate 永不返回」把整轮 e2e 卡死（根因见 cdpConnect 的注释）。
  // 超时就直接报错，让 finally 清场，别让孤儿进程拖累后面的轮次。
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`cdpEval 超时 ${timeoutMs}ms: ${expr}`)), timeoutMs))
  ])
  return r.result?.result?.value
}

// 预检（必须放在 spawn 之前）：清掉残留 electron。所有 e2e 共用同一个隔离 userData 与
// 同一个心跳文件，残留实例的岛窗口会被 islandVisible() 一起数进去，两个实例还会互相覆盖
// 心跳（[实测] 2026-11-17：上一轮手动起的实例没关，A1/A4/A3 全假失败）。
if (process.platform === 'win32') {
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 没有残留 */
  }
  await sleep(700)
}

// ---- start dev electron ----
// 数据目录隔离由 ./isolate-userdata.mjs 的 spawn 包装统一加 --user-data-dir。
// 早期这里设过一个自以为能改路径的环境变量，实测它不改变 app.getPath('userData')，已删除。
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`,
  // e2e 稳定性：GPU/disk cache 在 DSH 环境偶发「拒绝访问」刷屏并伴随 renderer/CDP 卡死
  // （diag 实录：A2 apply(true) 已执行但 v2 的 Runtime.evaluate 永不返回）。绕开这两个子系统。
  '--disable-gpu', '--disk-cache-size=1'
], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'inherit', 'inherit']
})

let cdp
// 可见性查询：Win32 EnumWindows 层真相（pid∈electron + class=Chrome_WidgetWin_1 + 高度过滤排除 4px 感应窗）。
// 实测踩坑（US-041 排障终局）：
// ①IsWindowVisible(MainWindowHandle) 不可靠——MainWindowHandle 指向宿主外壳，不随 hide() 变；
// ②CDP document.visibilityState 也不可靠——avoided 态下岛现身（revealWindow 三连后物理可见）时，
//   Chromium occlusion tracking 仍判定「被前台全屏窗口遮挡」→ visibilityState=hidden 误报
//   （物理截图实锤岛在屏上、visibilityState 却报 hidden）。Win32 IsWindowVisible 对真实
//   BrowserWindow 类名 Chrome_WidgetWin_1 反映 hide()/showInactive() 的 win32 层真相。
function islandVisible() {
  return win32IslandVisible()
}
async function win32IslandVisible() {
  const out = await ps(watchIslandVisScript())
  return out.trim().includes('VIS=1')
}
function watchIslandVisScript() {
  // ⚠ 2026-11-17 重写（原来恒返回 false，A3/A4 等「岛应可见」的断言全部假失败）：
  // 旧实现用「PowerShell 脚本块当 EnumWindows 回调 + $script:found++」，而上面初始化的
  // 是 `$found = 0`（少了 $script: 前缀）——两个变量根本不是同一个，计数永远传到外面是空，
  // 于是 VIS= 恒为空。同类写法在 e2e-fullscreen-misjudge.mjs 也翻过车：回调里的脚本块
  // 在 -EncodedCommand 下连字符串输出都被丢弃。结论：枚举逻辑写进 C#，别用 PS 回调。
  const TICK = '`"'
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
  return [
    'Add-Type "' + cs + '"',
    '$pids = [uint32[]]@((Get-Process electron -ErrorAction SilentlyContinue).Id)',
    '"VIS=" + [WV]::Count($pids)'
  ].join('; ')
}
try {
  await sleep(7000)
  cdp = await cdpConnect()

  // A1 常态可见。注意：不能指望「起来就该可见」——本机若用户前台正开着一个**最大化**窗口，
  // 修正后的判据（基准=工作区）会正确判定避让，起手就是隐藏态（2026-11-17 实测）。
  // 先用一个普通小窗把前台换过来，再断言。
  const baseWin = makeWin('a1', 'small')
  await sleep(3500)
  const v1 = await islandVisible('A1')
  ok('A1 常态岛可见', v1 === true, String(v1))
  baseWin.kill()

  // A2 造全屏窗口 → 2s 内岛隐藏（判定 1s + 去抖 300ms + 余量）
  // 光标先复位：上轮测试残留的光标位置（若停在顶部感应区）会让 probe 提前命中、污染后续断言
  await moveCursor('400', 500)
  await sleep(600)
  const fullWin = makeWin('a2', 'full')
  await sleep(4000)
  const v2 = await islandVisible('A2')
  ok('A2 全屏→岛隐藏', v2 === false, String(v2))

  // A4 摸边唤回。⚠ 2026-11-18 起**真全屏（F）下摸边自动唤回被禁用**（SPEC-no-reveal-in-fullscreen：
  // 游戏里视角上移会把光标顶到屏幕边，一唤回就把独占全屏游戏最小化，用户实测「玩几分钟突然切到桌面」）。
  // 所以这里换成「最大化窗口（Z）」来测摸边——那是它现在仍然生效的场景。
  fullWin.kill()
  await moveCursor('400', 500)
  await sleep(800)
  const maxWin = makeWin('a4max', 'max')
  await sleep(3000)
  const v4a = await islandVisible('A4pre')
  ok('A4 前置：最大化窗口→岛隐藏', v4a === false, String(v4a))
  await moveCursor('[int]($sw/2)', 0)
  await sleep(2500)
  const v4 = await islandVisible('A4')
  ok('A4 摸边唤回（最大化场景）', v4 === true, String(v4))

  // A5 移开回隐
  await moveCursor('400', 500)
  await sleep(2500)
  const v5 = await islandVisible('A5')
  ok('A5 移开回隐', v5 === false, String(v5))

  // A3 关掉那个最大化窗口 → 恢复。同样要先把前台交给一个普通窗口：只关窗口的话，前台可能回到
  // 用户自己那个最大化窗口，按修正后的判据岛就该继续藏着（那不是 bug）。
  maxWin.kill()
  const backWin = makeWin('a3', 'small')
  await sleep(3000)
  const v3 = await islandVisible('A3')
  ok('A3 退出全屏→恢复', v3 === true, String(v3))
  backWin.kill()

  // A6 手动隐藏 → 摸边无效 → IPC 等价托盘恢复
  await cdpEval(cdp, `window.island.manualHide(); 1`)
  await sleep(1500)
  const v6a = await islandVisible('A6a')
  const hiddenByManual = v6a === false
  await moveCursor('[int]($sw/2)', 0)
  await sleep(2000)
  const v6b = await islandVisible('A6b')
  const stillHidden = v6b === false
  await cdpEval(cdp, `window.island.manualRestore(); 1`)
  await sleep(1500)
  const v6c = await islandVisible('A6c')
  ok('A6 手动隐藏+摸边无效+托盘恢复', hiddenByManual && stillHidden && v6c === true,
    `hide=${v6a} edgeNoop=${v6b} restore=${v6c}`)
  await moveCursor('400', 500)
  await sleep(500)

  // A7 全屏时横幅临时现身 + 结束回隐（temp-show 通道等价验证；真实横幅链路 notify-live 已覆盖）
  const fullWin2 = makeWin('a7', 'full')
  await sleep(4000)
  await cdpEval(cdp, `window.island.requestTempShow(true); 1`)
  await sleep(1000)
  const v7a = await islandVisible('A7a')
  await cdpEval(cdp, `window.island.requestTempShow(false); 1`)
  await sleep(1000)
  const v7b = await islandVisible('A7b')
  fullWin2.kill()
  ok('A7 全屏横幅临时现身+结束回隐', v7a === true && v7b === false,
    `show=${v7a} backHide=${v7b}`)

  // A8 判定机制（SPEC-avoid-mode-and-latency，2026-11-17 起替代 SPEC-perf-poll-throttle 的自适应轮询）：
  // 常驻辅助进程 + 心跳文件；且必须保留「心跳超时回退单发轮询」这条安全带。
  // 只看源码，不依赖时序（运行时行为由 e2e-avoid-mode.mjs 覆盖）。
  const watchSrc = readFileSync(join(ROOT, 'src', 'main', 'fullscreenWatch.ts'), 'utf8')
  ok('A8 判定已改为常驻辅助进程+心跳(留回退)',
    /avoid-mode-beat/.test(watchSrc) &&
      /HELPER_TICK_MS\s*=\s*120/.test(watchSrc) &&
      /HEARTBEAT_STALE_MS\s*=\s*5000/.test(watchSrc) &&
      /function startFallback|const startFallback/.test(watchSrc) &&
      /stdio: \['ignore', 'ignore', 'ignore'\]/.test(watchSrc),
    '源码 src/main/fullscreenWatch.ts')
} catch (err) {
  console.error('e2e error:', err)
} finally {
  cdp?.close()
  // 踩坑：child.kill() 对 electron 不够（主进程死了渲染/GPU 子进程还挂着 stdio inherit，
  // e2e 进程跟着卡住不退）——Windows 下用 taskkill 强杀整个进程树。
  if (process.platform === 'win32') {
    try { require('node:child_process').execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* noop */ }
  } else {
    child.kill()
  }
}

const pass = results.filter((r) => r.pass).length
console.log(`\n== 结果：${pass} 过 / ${results.length - pass} 败 ==`)
process.exit(pass === results.length ? 0 : 1)







