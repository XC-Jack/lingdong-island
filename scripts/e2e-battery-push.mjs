// scripts/e2e-battery-push.mjs：插拔电源即时刷新的通路 e2e（SPEC-battery-status-push 的 P3）
// 要证的事：主进程「重读 → 广播 → 渲染层更新」这条通路真的通，而不是靠 60 秒轮询。
// 做法（不动 src/，只改构建产物 out/main/index.js，跑完字节还原）：
//   1) 把电量行换成「读一个测试用文本文件」，于是主进程每次重读都读我们写的值；
//   2) 把 `powerMonitor.on("on-ac", scheduleRefresh)` 换成 `setTimeout(scheduleRefresh, 6000)`，
//      等价于「启动 6 秒后系统送来一次插电事件」，走的是同一条生产代码路径；
//   3) 先让界面显示 80（白），再改文件为 99|True，然后在 12 秒窗口内等界面自己变绿变 99。
//      60 秒轮询远大于这个窗口，所以只要变了就一定是广播推的。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const BUNDLE = join(ROOT, 'out', 'main', 'index.js')
const BACKUP = join(ROOT, '.tmp', 'e2e-battery-push-main-index.bak')
const VALUE_FILE = join(ROOT, '.tmp', 'e2e-push-value.txt')
const VALUE_FILE_BAK = join(ROOT, '.tmp', 'e2e-push-value.txt.bak')
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

// 每次调用开一条新 ws（同 e2e-battery-states 的做法，简单可靠）
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
// 事件注册行：换成一次定时器，等价于「6 秒后系统送来 on-ac 事件」
const OLD_ONAC = 'electron.powerMonitor.on("on-ac", scheduleRefresh);'

function patchBundle() {
  let src = readFileSync(BACKUP, 'utf8')
  if (!src.includes(OLD_BATTERY)) throw new Error('电量行 patch 目标没找到（out/ 与 src 不同步？先 npm run build）')
  if (!src.includes(OLD_ONAC)) throw new Error('on-ac 注册行 patch 目标没找到（startWatch/setupStatus 变了？）')
  // 用正斜杠，PowerShell 认；省掉 JS 字符串里的反斜杠转义
  const psPath = VALUE_FILE.replace(/\\/g, '/')
  // bundle 里这段电量行是「双引号 JS 字符串」的内容，替换串里不能再出现双引号，
  // 否则会提前闭合 JS 字符串（第一版就因此报了 SyntaxError: Unexpected identifier 'D'）。
  // PS 侧用单引号包路径，最终命令是 (Get-Content -Raw 'D:/...').Trim()，输出形如 99|True，
  // 与真实电量行格式一致，主进程解析逻辑完全不用改。
  const replacement = `(Get-Content -Raw '${psPath}').Trim()`
  src = src.replace(OLD_BATTERY, replacement)
  src = src.replace(OLD_ONAC, 'setTimeout(scheduleRefresh, 6000);')
  writeFileSync(BUNDLE, src, 'utf8')
}

let child = null
async function boot() {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  const wsUrl = await connect()
  await sleep(1200)
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

const GREEN = 'rgba(75, 214, 130, 0.9)'
const WHITE = 'rgba(255, 255, 255, 0.85)'

const main = async () => {
  copyFileSync(BUNDLE, BACKUP)
  const before = readFileSync(BUNDLE)
  if (existsSync(VALUE_FILE)) copyFileSync(VALUE_FILE, VALUE_FILE_BAK)
  writeFileSync(VALUE_FILE, '80|False', 'utf8')
  try {
    patchBundle()
    const wsUrl = await boot()

    // 初始态：80、白弧、非充电
    const d0 = JSON.parse(await cdp(wsUrl, DOM_Q))
    console.log('[初始] snapshot:', JSON.stringify(d0))
    ok('P3-0 渲染层已挂上 onStatusChanged', d0.api === 'function', String(d0.api))
    ok('P3-1 初始数字 80', d0.num === '80', String(d0.num))
    ok('P3-2 初始非充电（白弧）', d0.stroke === WHITE, String(d0.stroke))
    ok('P3-3 初始 title 电量 80%', d0.title === '电量 80%', String(d0.title))

    // 改数据源 = 模拟「电源状态在两个采样点之间真的变了」
    writeFileSync(VALUE_FILE, '99|True', 'utf8')
    const t0 = Date.now()
    console.log('[注入] 已把取数值改为 99|True，开始等界面自己变（60 秒轮询还没到）')

    let d1 = null
    let elapsed = 0
    while (Date.now() - t0 < 12_000) {
      await sleep(200)
      d1 = JSON.parse(await cdp(wsUrl, DOM_Q))
      if (d1.has && d1.num === '99') { elapsed = Date.now() - t0; break }
    }
    console.log('[推送后] snapshot:', JSON.stringify(d1), '耗时', elapsed, 'ms')

    ok('P3-4 界面在 12 秒内自己更新了（不是靠 60 秒轮询）', d1 && d1.num === '99', `num=${d1?.num} 耗时=${elapsed}ms`)
    ok('P3-5 更新时 charging 类已加', !!d1 && d1.cls.includes('charging'), String(d1?.cls))
    ok('P3-6 更新后弧变绿', !!d1 && d1.stroke === GREEN, String(d1?.stroke))
    ok('P3-7 更新后 title 充电中', !!d1 && d1.title === '充电中 · 电量 99%', String(d1?.title))
    ok('P3-8 更新后 aria 同步', !!d1 && d1.aria === '充电中 · 电量 99%', String(d1?.aria))
    ok('P3-9 耗时明显小于 60 秒轮询间隔', elapsed > 0 && elapsed < 12_000, `${elapsed}ms`)

    await stop()
  } finally {
    await stop()
    if (existsSync(BACKUP)) { copyFileSync(BACKUP, BUNDLE); unlinkSync(BACKUP) }
    if (existsSync(VALUE_FILE_BAK)) { copyFileSync(VALUE_FILE_BAK, VALUE_FILE); unlinkSync(VALUE_FILE_BAK) }
    else if (existsSync(VALUE_FILE)) unlinkSync(VALUE_FILE)
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
  process.exit(1)
})
