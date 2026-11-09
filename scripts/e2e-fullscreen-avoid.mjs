#!/usr/bin/env node
/**
 * US-041 全屏自动避让 e2e。
 * A1 常态可见 / A2 造全屏窗口 → 岛 2s 内隐藏 / A3 关全屏 → 恢复
 * A4 摸边唤回（光标移 y=0）/ A5 移开回隐 / A6 手动隐藏摸边无效+托盘恢复（托盘点击难模拟，改为 IPC 等价路径）
 * A7 全屏时发通知 → 横幅期临时可见。
 * 前置：dev electron（--remote-debugging-port=9321）；Cleared ELECTRON_RUN_AS_NODE。
 * 踩坑：①ps() 只收 stdout——stderr 的 CLIXML 进度流会污染输出；②Add-Type 单行双引号版最稳
 * （多行 here-string 嵌套必炸）；③透明无边框窗口有 MainWindowHandle（非 0）。
 */
import { spawn } from './isolate-userdata.mjs'
import { existsSync } from 'node:fs'
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

// 造一个全屏置顶 WinForms 窗口（覆盖主屏，SetForegroundWindow 强制抢前台 → 触发避让判定）。
// 踩坑：ShowDialog+Activate 抢不到前台（Windows 前台锁定策略），必须 SetForegroundWindow。
function makeFullscreen(tag) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type "using System; using System.Runtime.InteropServices; public class FG' + tag + ' { [DllImport(`"user32.dll`")] public static extern bool SetForegroundWindow(IntPtr h); }"',
    '$f = New-Object System.Windows.Forms.Form',
    "$f.FormBorderStyle = 'None'",
    '$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$f.TopMost = $true',
    '$f.ShowInTaskbar = $false',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(30,30,40)',
    '$f.Add_Shown({ [void][FG' + tag + ']::SetForegroundWindow($f.Handle) })',
    '[void]$f.ShowDialog()'
  ].join('; ')
  const enc = Buffer.from(script, 'utf16le').toString('base64')
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
      const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
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

async function cdpEval(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
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
  return [
    'Add-Type "using System; using System.Text; using System.Runtime.InteropServices; public class WV { public delegate bool EnumProc(IntPtr h, IntPtr lp); [DllImport(\`"user32.dll\`")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp); [DllImport(\`"user32.dll\`")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport(\`"user32.dll\`")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n); [DllImport(\`"user32.dll\`")] public static extern bool IsWindowVisible(IntPtr h); [DllImport(\`"user32.dll\`")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; } }"',
    '$found = 0',
    '$cb = [WV+EnumProc]{ param($h, $lp)',
    '  $p2 = 0; [void][WV]::GetWindowThreadProcessId($h, [ref]$p2)',
    '  if ($script:epids -contains $p2) {',
    '    $sb = New-Object System.Text.StringBuilder 256; [void][WV]::GetClassName($h, $sb, 256)',
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
}
try {
  await sleep(7000)
  cdp = await cdpConnect()

  // A1 常态可见
  await sleep(1500)
  const v1 = await islandVisible('A1')
  ok('A1 常态岛可见', v1 === true, String(v1))

  // A2 造全屏窗口 → 2s 内岛隐藏（判定 1s + 去抖 300ms + 余量）
  // 光标先复位：上轮测试残留的光标位置（若停在顶部感应区）会让 probe 提前命中、污染后续断言
  await moveCursor('400', 500)
  await sleep(600)
  const fullWin = makeFullscreen('a2')
  await sleep(4000)
  const v2 = await islandVisible('A2')
  ok('A2 全屏→岛隐藏', v2 === false, String(v2))

  // A4 摸边唤回：光标移到 (中, 0)，探测 300ms + 现身
  await moveCursor('[int]($sw/2)', 0)
  await sleep(2000)
  const v4 = await islandVisible('A4')
  ok('A4 摸边唤回', v4 === true, String(v4))

  // A5 移开回隐
  await moveCursor('400', 500)
  await sleep(2000)
  const v5 = await islandVisible('A5')
  ok('A5 移开回隐', v5 === false, String(v5))

  // A3 关全屏 → 恢复
  fullWin.kill()
  await sleep(4000)
  const v3 = await islandVisible('A3')
  ok('A3 退出全屏→恢复', v3 === true, String(v3))

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
  const fullWin2 = makeFullscreen('a7')
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







