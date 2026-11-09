// scripts/e2e-battery-states.mjs：电量态 e2e（电量态轮次 2026-11-09）
// 验证四种组合：普通 / 充电 / 充电且低电 / 低电（不充电）。
// 注入方式 [实测]：改 out/main/index.js 的 PowerShell 电量行（渲染层 60s 轮询的最终数据源），
// out/ 在 .gitignore（.gitignore:3），src/ 一字不动；跑前备份、finally 还原 + 校验字节一致。
// 每次注入重启 electron（主进程 30s 缓存），CDP 断言渲染层 DOM：类名 / 数字 / title / aria / 闪电。
// 断言「弧颜色」走 computed style stroke（charging 绿 / low 红 / 普通 0.85 白）。
// 注意：低电注入用 15|false（PS 单引号），charging 注入用 15|True 与 99|True 两种都测。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const BUNDLE = join(ROOT, 'out', 'main', 'index.js')
const BACKUP = join(ROOT, '.tmp', 'e2e-battery-main-index.bak')
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
function cdp(wsUrl, expression, awaitPromise = false) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
    ws.onmessage = (ev) => { const data = JSON.parse(ev.data); if (data.id !== 1) return; clearTimeout(timer); resolve(data.result?.result?.value); ws.close() }
  })
}

// patch bundle：把电量行换成固定输出。psLine 是 PS 字面量（带 PS 单引号）。
const OLD = '$b=Get-CimInstance -ClassName Win32_Battery; if($b){\\"{0}|{1}\\" -f $b.EstimatedChargeRemaining, ($b.BatteryStatus -eq 2)}else{\\"null|false\\"}'
function patchBundle(psLine) {
  // 每次都从备份（原版）出发替换，避免上一场景的 patch 残留导致 OLD 找不到
  let src = readFileSync(BACKUP, 'utf8')
  if (!src.includes(OLD)) throw new Error('patch 目标串没找到（out/ 与 src 不同步？先 npm run build）')
  writeFileSync(BUNDLE, src.replace(OLD, `'${psLine}'`), 'utf8')
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

// 每个场景断言一次（收起态）
const DOM_Q = `(() => {
  const el = document.querySelector('.head-battery-ring')
  if (!el) return JSON.stringify({ has: false })
  const fg = el.querySelector('.ring-fg')
  const num = el.querySelector('.ring-num')
  const bolt = el.querySelector('.ring-bolt')
  const stroke = fg ? getComputedStyle(fg).stroke : null
  const numColor = num ? getComputedStyle(num).color : null
  return JSON.stringify({
    has: true,
    cls: String(el.className),
    num: num ? num.textContent : null,
    title: el.getAttribute('title'),
    aria: el.getAttribute('aria-label'),
    hasBolt: !!bolt,
    stroke,
    numColor
  })
})()`

const GREEN = 'rgba(75, 214, 130, 0.9)'
const RED = 'rgba(255, 107, 107, 0.9)'
const WHITE = 'rgba(255, 255, 255, 0.85)'
const REDNUM = 'rgba(255, 107, 107, 0.95)'

const scenarios = [
  { name: 'S1 普通（80% 不充电）', line: '80|false', patch: true,
    check: (d) => {
      ok('S1 渲染', d.has)
      ok('S1 无 low/charging 类', d.cls.trim() === 'head-battery-ring', d.cls)
      ok('S1 数字 80', d.num === '80', d.num)
      ok('S1 title 电量 80%', d.title === '电量 80%', d.title)
      ok('S1 aria 同 title', d.aria === '电量 80%', d.aria)
      ok('S1 无闪电', !d.hasBolt)
      ok('S1 弧白色', d.stroke === WHITE, d.stroke)
      ok('S1 数字非红', d.numColor !== REDNUM, d.numColor)
    } },
  { name: 'S2 充电（99% 充电中）', line: '99|True', patch: true,
    check: (d) => {
      ok('S2 渲染', d.has)
      ok('S2 charging 类', d.cls.includes('charging'), d.cls)
      ok('S2 无 low 类（充电压过低电阈值线以上）', !d.cls.includes('low'), d.cls)
      ok('S2 数字 99', d.num === '99', d.num)
      ok('S2 title 充电中', d.title === '充电中 · 电量 99%', d.title)
      ok('S2 aria 充电中', d.aria === '充电中 · 电量 99%', d.aria)
      ok('S2 有闪电', d.hasBolt)
      ok('S2 弧绿色', d.stroke === GREEN, d.stroke)
    } },
  { name: 'S3 充电且低电（15% 充电中）', line: '15|True', patch: true,
    check: (d) => {
      ok('S3 charging 类', d.cls.includes('charging'), d.cls)
      ok('S3 无 low 类（充电优先）', !d.cls.includes('low'), d.cls)
      ok('S3 title 充电中 15%', d.title === '充电中 · 电量 15%', d.title)
      ok('S3 aria 充电中 15%', d.aria === '充电中 · 电量 15%', d.aria)
      ok('S3 有闪电', d.hasBolt)
      ok('S3 弧绿（不是红）', d.stroke === GREEN, d.stroke)
      ok('S3 数字非红', d.numColor !== REDNUM, d.numColor)
    } },
  { name: 'S4 低电不充电（15% 没插电）', line: '15|false', patch: true,
    check: (d) => {
      ok('S4 low 类', d.cls.includes('low'), d.cls)
      ok('S4 无 charging 类', !d.cls.includes('charging'), d.cls)
      ok('S4 无闪电', !d.hasBolt)
      ok('S4 title 电量偏低', d.title === '电量偏低 · 15%', d.title)
      ok('S4 aria 电量偏低', d.aria === '电量偏低 · 15%', d.aria)
      ok('S4 弧红', d.stroke === RED, d.stroke)
      ok('S4 数字红', d.numColor === REDNUM, d.numColor)
    } }
]

const main = async () => {
  copyFileSync(BUNDLE, BACKUP)
  const before = readFileSync(BUNDLE)
  try {
    for (const sc of scenarios) {
      patchBundle(sc.line)
      const wsUrl = await boot()
      const raw = await cdp(wsUrl, DOM_Q)
      const d = JSON.parse(raw)
      console.log(`[${sc.name}] snapshot DOM:`, raw)
      sc.check(d)
      await stop()
    }
  } finally {
    await stop()
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, BUNDLE)
      unlinkSync(BACKUP)
    }
  }
  const after = readFileSync(BUNDLE)
  ok('R1 out/main/index.js 还原字节一致', Buffer.compare(before, after) === 0)
  console.log(`== 结果：${passed} 过 / ${failed} 败 ==`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch(async (e) => {
  console.error('E2E FAIL:', e.message ?? e)
  try { await stop() } catch {}
  if (existsSync(BACKUP)) { copyFileSync(BACKUP, BUNDLE); unlinkSync(BACKUP) }
  process.exit(1)
})
