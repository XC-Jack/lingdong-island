// scripts/e2e-battery-push.mjs：插拔电源「变色不等取数」的 e2e（SPEC-battery-status-push 的 P3）
//
// 要证的事：颜色由电源事件当场翻转并广播，不等那次约 1 秒的 PowerShell 取数。
// 做法（不动 src/，只改构建产物 out/main/index.js，跑完字节还原）：
//   1) 把电量行换成一个「故意很慢」的取数：先 Start-Sleep 2 秒再读测试文本文件。
//      这样取数耗时被拉大到 2 秒，事件与取数的时间差就肉眼可测。
//   2) 把 `powerMonitor.on("on-ac", ...)` 与 `powerMonitor.on("on-battery", ...)` 两条注册行
//      分别换成两个定时器：第 12 秒、第 22 秒各执行一次「改测试文件 + 调用同一个 applyPowerEvent」，
//      等价于系统分别送来一次插电、一次拔电事件。
//      ——两条都要换：独立验收 C2 指出早期版本只换了 `on-ac`，拔电方向的
//        `applyPowerEvent(false)` 是定时器直接调的，绕过了真实的事件注册，等于零覆盖。
//   3) 把两处 `powerMonitor.isOnBatteryPower()`（看门狗读电源）换成一个从测试文件旁路读的
//      假传感器，保证「假世界」自洽：事件、取数、看门狗三方说的是同一件事。
//      ——为什么要这一步：本机电池长期插着电，真实传感器永远说「接着交流电」，
//        拔电方向造不出来；不旁路的话看门狗会在 1 秒内把拔电状态改回插电。
//   4) 断言的核心不是「最终变了」，而是「颜色先变、百分比后到」：
//      变绿那一刻百分比还是旧的 80、变白那一刻百分比还是旧的 99（两侧都真断言），
//      约 2 秒后百分比才变成 99 / 15。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { near, parseCssColor, resolveTokensExpr } from './e2e-color.mjs'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const BUNDLE = join(ROOT, 'out', 'main', 'index.js')
const BACKUP = join(ROOT, '.tmp', 'e2e-battery-push-main-index.bak')
const VALUE_FILE = join(ROOT, '.tmp', 'e2e-push-value.txt')
const VALUE_FILE_BAK = join(ROOT, '.tmp', 'e2e-push-value.txt.bak')
const POWER_FILE = join(ROOT, '.tmp', 'e2e-push-power.txt')
const POWER_FILE_BAK = join(ROOT, '.tmp', 'e2e-push-power.txt.bak')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      resolve(data.result?.result?.value)
      ws.close()
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cdp ws error')) }
  })
}

// 电量行的原始串（与 e2e-battery-states.mjs 的 OLD 一致；要改判据时两处都要跟）
const OLD_BATTERY = '$b=Get-CimInstance -ClassName Win32_Battery; $w=@(Get-CimInstance -Namespace root\\\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue); if($b){\\"{0}|{1}\\" -f $b.EstimatedChargeRemaining, (($b.BatteryStatus -notin 1) -and -not [bool]($w|Where-Object {$_.Discharging}))}else{\\"null|false\\"}'
// 事件注册行：两条分别换成定时器，等价于「第 12 秒插电、第 22 秒拔电」。
// 两条都必须换：只换 on-ac 时，拔电走的是定时器直接调 applyPowerEvent(false)，
// 真实的事件注册行原样留在 bundle 里却从未触发，等于拔电方向零覆盖（独立验收 C2）。
const OLD_ONAC = 'electron.powerMonitor.on("on-ac", () => applyPowerEvent(true));'
const OLD_ONBATTERY = 'electron.powerMonitor.on("on-battery", () => applyPowerEvent(false));'
// 看门狗读电源的两处（startWatch 里的初始化与每秒比对）
const OLD_SENSOR = 'electron.powerMonitor.isOnBatteryPower()'
// 事件时刻是从「进程启动」算的，而脚本的 tStart 在 CDP 连上后才开始（约晚 1–2 秒），
// 所以留足余量：初始态必须在事件之前稳定可观测。
const EVENT_PLUG_MS = 12_000
const EVENT_UNPLUG_MS = 22_000
const SLOW_READ_MS = 2_000

function patchBundle() {
  let src = readFileSync(BACKUP, 'utf8')
  if (!src.includes(OLD_BATTERY)) throw new Error('电量行 patch 目标没找到（out/ 与 src 不同步？先 npm run build）')
  if (!src.includes(OLD_ONAC)) throw new Error('on-ac 注册行 patch 目标没找到（startWatch/setupStatus 变了？）')
  if (!src.includes(OLD_ONBATTERY)) throw new Error('on-battery 注册行 patch 目标没找到（setupStatus 变了？）')
  if (!src.includes(OLD_SENSOR)) throw new Error('isOnBatteryPower 调用没找到（看门狗改写法了？）')

  const psValuePath = VALUE_FILE.replace(/\\/g, '/')
  const jsValuePath = VALUE_FILE.replace(/\\/g, '/')
  const jsPowerPath = POWER_FILE.replace(/\\/g, '/')

  // 电量行→（先睡 2 秒再读文件）：拉大取数耗时，好测「颜色不等取数」。
  // 注意两件事：
  //   a) 这段是 bundle 里双引号 JS 字符串的内容，替换串里不能出现双引号，
  //      否则会提前闭合 JS 字符串（去年踩过 SyntaxError: Unexpected identifier 'D'）。
  //   b) PowerShell 里 `(A; B).Trim()` 是语法错（Missing closing ')'），必须是子表达式
  //      `$(A; B).Trim()`；写成圆括号会让取数整条命令解析失败、电量变 null，环根本不渲染。
  const replacement = `$(Start-Sleep -Milliseconds ${SLOW_READ_MS}; Get-Content -Raw '${psValuePath}').Trim()`
  src = src.replace(OLD_BATTERY, replacement)

  // 看门狗传感器→旁路读测试文件：文件后缀是 |False 就算「在用电池」，否则算「接着交流电」
  const fakeSensor = `__e2eFakeOnBattery()`
  src = src.split(OLD_SENSOR).join(fakeSensor)
  // 再把 helper 插在 require 块之后（bundle 顶部的最后一条 require 是 node:crypto）
  const anchor = 'let node_crypto = require("node:crypto");'
  if (!src.includes(anchor)) throw new Error('bundle 顶部 require 锚点没找到')
  const helper = `\nfunction __e2eFakeOnBattery(){ try { const t = require("node:fs").readFileSync(${JSON.stringify(jsPowerPath)}, "utf8").trim(); return t === "BAT" } catch { return false } }`
  src = src.replace(anchor, anchor + helper)

  // 事件：先改测试文件，再调用生产代码里的同一个 applyPowerEvent。
  // 两条注册行分别被「插电定时器」和「拔电定时器」顶替（bundle 里只剩空注释占位）。
  const plugCode = `setTimeout(() => { try { require("node:fs").writeFileSync(${JSON.stringify(jsValuePath)}, "99|True"); require("node:fs").writeFileSync(${JSON.stringify(jsPowerPath)}, "AC") } catch {} ; applyPowerEvent(true) }, ${EVENT_PLUG_MS});`
  const unplugCode = `setTimeout(() => { try { require("node:fs").writeFileSync(${JSON.stringify(jsValuePath)}, "15|False"); require("node:fs").writeFileSync(${JSON.stringify(jsPowerPath)}, "BAT") } catch {} ; applyPowerEvent(false) }, ${EVENT_UNPLUG_MS});`
  src = src.replace(OLD_ONAC, plugCode)
  src = src.replace(OLD_ONBATTERY, unplugCode)

  writeFileSync(BUNDLE, src, 'utf8')
}

let child = null
async function boot() {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  const wsUrl = await connect()
  return wsUrl
}
async function stop() {
  if (child) { child.kill(); child = null }
  await sleep(400)
}

const DOM_Q = `(() => {
  const el = document.querySelector('.head-battery-ring')
  if (!el) return JSON.stringify({ has: false, api: typeof window.island?.onStatusChanged })
  const fg = el.querySelector('.ring-fg')
  const num = el.querySelector('.ring-num')
  return JSON.stringify({
    has: true,
    api: typeof window.island?.onStatusChanged,
    cls: String(el.className),
    num: num ? num.textContent : null,
    title: el.getAttribute('title'),
    aria: el.getAttribute('aria-label'),
    stroke: fg ? getComputedStyle(fg).stroke : null
  })
})()`

// 2026-11-27（SPEC-fix-e2e-rot-2）：原先写死 WHITE/GREEN/RED 三个旧色值。
// 默认主题换成亮色乳白玻璃后（SPEC-island-themes）弧色全部变了，waitFor 永远等不到，
// 16 项断言级联失败。改为 boot 后读当前主题 token，按距离判定。
let TOK = {}

/** 轮询直到 predicate 成立或超时，返回 {v, at}（at=距 tStart 毫秒），at=0 表示没等到 */
async function waitFor(wsUrl, pred, timeoutAt) {
  while (Date.now() - tStart < timeoutAt) {
    await sleep(60)
    const v = JSON.parse(await cdp(wsUrl, DOM_Q))
    if (pred(v)) return { v, at: Date.now() - tStart }
  }
  return { v: null, at: 0 }
}

/** 弧色是否等于某 token（取不到 token 时恒 false，不做静默放行） */
const strokeIs = (v, token) => !!v && near(parseCssColor(v.stroke), TOK[token])

let tStart = 0

const main = async () => {
  if (existsSync(VALUE_FILE)) copyFileSync(VALUE_FILE, VALUE_FILE_BAK)
  if (existsSync(POWER_FILE)) copyFileSync(POWER_FILE, POWER_FILE_BAK)
  // 初始假世界：80%、没在充电、在用电池 —— 与事件①之前的取数、看门狗三方一致
  writeFileSync(VALUE_FILE, '80|False', 'utf8')
  writeFileSync(POWER_FILE, 'BAT', 'utf8')
  copyFileSync(BUNDLE, BACKUP)
  const before = readFileSync(BUNDLE)
  try {
    patchBundle()
    // tStart 取在 spawn 之前，这样 at 与 bundle 里定时器的基准（进程启动）基本对齐
    tStart = Date.now()
    const wsUrl = await boot()
    TOK = JSON.parse(await cdp(wsUrl, resolveTokensExpr(['--ink-1', '--ok', '--danger'])))

    // 初始态：取数要 2 秒，等它落地（必须早于第一次假事件）
    const init = await waitFor(wsUrl, (v) => v.has && v.num === '80', EVENT_PLUG_MS - 500)
    console.log('[初始]', JSON.stringify(init.v), '距 spawn', init.at, 'ms')
    ok('P3-0 渲染层已挂上 onStatusChanged', init.v?.api === 'function', String(init.v?.api))
    ok('P3-1 初始数字 80', init.v?.num === '80', String(init.v?.num))
    ok('P3-2 初始非充电（弧是主题文字色）', strokeIs(init.v, '--ink-1'), String(init.v?.stroke))
    ok('P3-3 初始 title 电量 80%', init.v?.title === '电量 80%', String(init.v?.title))

    // === 事件①：插电。紧随其后的取数要 2 秒才回来 ===
    const green = await waitFor(wsUrl, (v) => v.has && near(parseCssColor(v.stroke), TOK['--ok']), EVENT_PLUG_MS + 6_000)
    console.log('[插电事件后]', JSON.stringify(green.v), '距 spawn', green.at, 'ms')
    ok('P3-4 事件到达后弧变绿', !!green.v, `${green.at}ms`)
    ok('P3-5 变绿时 charging 类已加', !!green.v && green.v.cls.includes('charging'), String(green.v?.cls))
    // 铁证：变绿那一刻百分比还是事件之前的 80，说明颜色不是取数带回来的
    ok('P3-6 变绿时百分比还是旧的 80（颜色不等取数）', !!green.v && green.v.num === '80', String(green.v?.num))
    ok('P3-7 变绿时 title 已是充电中', !!green.v && green.v.title === '充电中 · 电量 80%', String(green.v?.title))
    ok(`P3-8 变绿时刻贴着事件（${EVENT_PLUG_MS}ms 后 1.5 秒内）`, green.at > 0 && green.at > EVENT_PLUG_MS - 300 && green.at < EVENT_PLUG_MS + 1_500, `${green.at}ms`)

    // 取数回来后百分比跟上
    const num99 = await waitFor(wsUrl, (v) => v.has && v.num === '99', 20_000)
    console.log('[取数返回后]', JSON.stringify(num99.v), '距启动', num99.at, 'ms')
    ok('P3-9 百分比随后更新到 99', num99.v?.num === '99', String(num99.v?.num))
    ok('P3-10 弧仍是绿', strokeIs(num99.v, '--ok'), String(num99.v?.stroke))
    ok('P3-11 title 充电中 99%', num99.v?.title === '充电中 · 电量 99%', String(num99.v?.title))
    ok('P3-12 aria 同步', num99.v?.aria === '充电中 · 电量 99%', String(num99.v?.aria))
    ok('P3-13 百分比比颜色晚到 1 秒以上（证明两段各走各的）', num99.at > 0 && green.at > 0 && num99.at - green.at > 1_000, `绿=${green.at}ms 数=${num99.at}ms`)

    // === 事件②：第 12 秒拔电，取数会读到 15|False（低电、没充电）===
    const white = await waitFor(wsUrl, (v) => v.has && near(parseCssColor(v.stroke), TOK['--ink-1']), EVENT_UNPLUG_MS + 6_000)
    console.log('[拔电事件后]', JSON.stringify(white.v), '距 spawn', white.at, 'ms')
    ok('P3-14 拔电事件后弧回到主题文字色', !!white.v, `${white.at}ms`)
    // 白态也要断言百分比还没跟上（独立验收 C3：早期版本白态只断言弧变白，
    // 「变白时数字还是 99」只是日志里的观察值，不是断言）。
    ok('P3-14b 变色时百分比还是旧的 99（颜色不等取数）', !!white.v && white.v.num === '99', String(white.v?.num))
    ok('P3-15 变色时 charging 类已撤', !!white.v && !white.v.cls.includes('charging'), String(white.v?.cls))
    // 窗口 1500ms：既给足 CDP 采样抖动（实测最大 885ms），又明显小于 SLOW_READ_MS=2000，
    // 所以「变色早于取数落地」依然成立。原先 600ms 裕量太薄（独立验收 C3 实测 12 次里 1 次假失败）。
    ok('P3-16 变色时刻贴着事件（拔电后 1.5 秒内）', white.at > 0 && white.at < EVENT_UNPLUG_MS + 1_500, `${white.at}ms`)

    // 红色要等事件②（22s）之后那次 2 秒的取数落地，截止时间按秒级余量给足
    const red = await waitFor(wsUrl, (v) => v.has && near(parseCssColor(v.stroke), TOK['--danger']), EVENT_UNPLUG_MS + 12_000)
    console.log('[取数返回后]', JSON.stringify(red.v), '距启动', red.at, 'ms')
    ok('P3-17 取数带回 15% 后弧变危险色（低电态）', !!red.v, String(red.v?.stroke))
    ok('P3-18 变红时 title 电量偏低', red.v?.title === '电量偏低 · 15%', String(red.v?.title))
    ok('P3-19 变红时数字也是 15', red.v?.num === '15', String(red.v?.num))
    ok('P3-20 变危险色比变回文字色晚 1 秒以上（同样不等取数）', red.at > 0 && white.at > 0 && red.at - white.at > 1_000, `白=${white.at}ms 红=${red.at}ms`)

    await stop()
  } finally {
    await stop()
    if (existsSync(BACKUP)) { copyFileSync(BACKUP, BUNDLE); unlinkSync(BACKUP) }
    if (existsSync(VALUE_FILE_BAK)) { copyFileSync(VALUE_FILE_BAK, VALUE_FILE); unlinkSync(VALUE_FILE_BAK) }
    else if (existsSync(VALUE_FILE)) unlinkSync(VALUE_FILE)
    if (existsSync(POWER_FILE_BAK)) { copyFileSync(POWER_FILE_BAK, POWER_FILE); unlinkSync(POWER_FILE_BAK) }
    else if (existsSync(POWER_FILE)) unlinkSync(POWER_FILE)
  }
  const after = readFileSync(BUNDLE)
  ok('P3-R1 out/main/index.js 还原字节一致', Buffer.compare(before, after) === 0)
  console.log(`== 结果：${passed} 过 / ${failed} 败 ==`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error('E2E FAIL:', e.message ?? e)
  try { await stop() } catch {}
  if (existsSync(BACKUP)) { copyFileSync(BACKUP, BUNDLE); unlinkSync(BACKUP) }
  if (existsSync(VALUE_FILE_BAK)) { copyFileSync(VALUE_FILE_BAK, VALUE_FILE); unlinkSync(VALUE_FILE_BAK) }
  else if (existsSync(VALUE_FILE)) unlinkSync(VALUE_FILE)
  if (existsSync(POWER_FILE_BAK)) { copyFileSync(POWER_FILE_BAK, POWER_FILE); unlinkSync(POWER_FILE_BAK) }
  else if (existsSync(POWER_FILE)) unlinkSync(POWER_FILE)
  process.exit(1)
})
