// e2e-pages-custom.mjs：US-032 页面自定义 e2e
// P1 默认基线 / P2 收起态组件显隐+页面裁剪 / P3 圆点数 / P4 轮播循环 / P5 恢复默认
// P6 页面顺序持久化：prefs.json 里 pages: [3,0,1,2]（日程排第一）→ 重启后
//    第一个 dot 应是日程页（dots 渲染顺序跟 enabledPages 走）。
// 偏好写入方式：杀应用后直接写 userData/prefs.json 再启动（离线写）。
// 为什么不用运行中 CDP 调 prefsSet 再 reload：实测 CDP resolve 与主进程 save 和
// mount 回填存在竞态（save 时间戳晚于 reload 后的 load），离线写零竞态。
// 注意：e2e 前必须先 npm run build（dev 加载 out/ 旧产物）。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exitCode = 1 }
const ok = (msg) => { console.log(`[PASS] ${msg}`); passed++ }

const PREF_PATH = join(process.env.APPDATA, 'lingdong-island', 'prefs.json')
// musicIntro: true —— 这三份都是「故意裁剪」的页面集合。不带这个标记，主进程的
// migrateMusicPage() 会给老数据补上音乐页（索引 4），圆点数就不再是脚本期望的值。
const PREF_CLOCK_OFF = JSON.stringify({ musicIntro: true, pagesCustom: { pages: [0, 1, 2], collapsed: { pet: true, clock: false, battery: true, net: true, todo: true } } }, null, 2)
const PREF_DEFAULT = JSON.stringify({ musicIntro: true, pagesCustom: { pages: [0, 1, 2, 3], collapsed: { pet: true, clock: true, battery: true, net: true, todo: true } } }, null, 2)
// 页面顺序调整（日程提到最前）+ 其余默认
const PREF_REORDER = JSON.stringify({ musicIntro: true, pagesCustom: { pages: [3, 0, 1, 2], collapsed: { pet: true, clock: true, battery: true, net: true, todo: true } } }, null, 2)

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9321/json')
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
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 15000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
    ws.onmessage = (ev) => { const d = JSON.parse(ev.data); if (d.id !== 1) return; clearTimeout(timer); resolve(d.result?.result?.value); ws.close() }
  })
}

// 离线写偏好 → 启动应用 → 等 mount+回填 → 返回 wsUrl
async function startWithPref(prefJson) {
  if (prefJson !== null) writeFileSync(PREF_PATH, prefJson, 'utf8')
  const child = spawn(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--remote-debugging-port=9321'], { cwd: ROOT, env: startWithPref.env, stdio: 'ignore' })
  const wsUrl = await connect()
  await sleep(1500) // mount + prefsGet 回填
  return { child, wsUrl }
}

startWithPref.env = { ...process.env }
delete startWithPref.env.ELECTRON_RUN_AS_NODE

async function stopApp(child) {
  child.kill()
  await sleep(1200) // 等进程退干净、端口释放
}

const { child: c1, wsUrl: ws1 } = await startWithPref(null) // 不写文件：沿用当前内容；先清成默认
writeFileSync(PREF_PATH, PREF_DEFAULT, 'utf8')
await stopApp(c1)
const { child: child1, wsUrl: ws1b } = await startWithPref(PREF_DEFAULT)
try {
  // P1 默认基线：收起态有时钟
  const c0 = await cdp(ws1b, "document.querySelector('.collapsed-clock') ? 'yes' : 'no'")
  if (c0 === 'yes') ok('P1a 默认收起态有时钟') ; else fail(`P1a 默认收起态应有时钟，got ${c0}`)
} catch (e) {
  fail(e.message)
} finally {
  await stopApp(child1)
}

// P2~P4：时钟关 + 裁掉日程页
const { child: child2, wsUrl: ws2 } = await startWithPref(PREF_CLOCK_OFF)
try {
  // P2 收起态时钟消失
  const c1 = await cdp(ws2, "document.querySelector('.collapsed-clock') ? 'yes' : 'no'")
  if (c1 === 'no') ok('P2a 关掉时钟后收起态无时钟') ; else fail(`P2a 时钟应消失，got ${c1}`)

  // P3 dots 数量 = 3（日程被裁）
  await cdp(ws2, "document.querySelector('.island')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))")
  await sleep(400)
  const dots = await cdp(ws2, "document.querySelectorAll('.dots .dot').length")
  if (dots === 3) ok('P3a 裁掉日程后圆点 3 个') ; else fail(`P3a 圆点应 3 个，got ${dots}`)

  // P4 从最后保留页再往后翻应停住（2026-11-11 用户要求改成不循环）
  await cdp(ws2, "document.querySelectorAll('.dots .dot')[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))")
  await sleep(300)
  await cdp(ws2, "document.querySelectorAll('.pager-arrow')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })); 'clicked'")
  await sleep(300)
  const activeIdx = await cdp(ws2, "Array.from(document.querySelectorAll('.dots .dot')).findIndex(d => d.classList.contains('active'))")
  if (activeIdx === 2) ok('P4a 最后一页再往后翻会停住（不循环回第一页）') ; else fail(`P4a 应停在最后一页(下标 2)，got ${activeIdx}`)
} catch (e) {
  fail(e.message)
} finally {
  await stopApp(child2)
}

// P5：恢复默认全开 → 时钟回来
const { child: child3, wsUrl: ws3 } = await startWithPref(PREF_DEFAULT)
try {
  const c2 = await cdp(ws3, "document.querySelector('.collapsed-clock') ? 'yes' : 'no'")
  if (c2 === 'yes') ok('P5a 恢复默认后时钟回来') ; else fail(`P5a 时钟应恢复，got ${c2}`)
} catch (e) {
  fail(e.message)
} finally {
  await stopApp(child3)
}

// P6：页面顺序持久化 —— pages: [3,0,1,2]（日程第一），重启后第一个 dot 的
// title/aria 应指向日程。dots 渲染 enabledPages.map，dot 的 title 取 PAGE_META[i].label。
const { child: child4, wsUrl: ws4 } = await startWithPref(PREF_REORDER)
try {
  await cdp(ws4, "document.querySelector('.island')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))")
  await sleep(400)
  const firstDot = await cdp(
    ws4,
    "document.querySelectorAll('.dots .dot')[0]?.getAttribute('title') || document.querySelectorAll('.dots .dot')[0]?.getAttribute('aria-label') || ''"
  )
  if (firstDot.includes('日程')) ok('P6a 页面顺序持久化：第一个圆点是日程（pages:[3,0,1,2] 跨重启生效）') ; else fail(`P6a 第一个圆点应是日程，got "${firstDot}"`)
} catch (e) {
  fail(e.message)
} finally {
  await stopApp(child4)
  writeFileSync(PREF_PATH, '{}', 'utf8') // 清理偏好
}

console.log(`\nE2E PAGES-CUSTOM: ${process.exitCode ? 'FAIL' : 'PASS'}（${passed} 项通过）`)
process.exit(process.exitCode ? 1 : 0)
