// e2e-todo-day-pick.mjs：待办页「选日期再添加」+ 日程页「只看当天任务」
// 覆盖（2026-11-24 用户要求）：
//   D1 待办页新增日期按钮，默认「今天」，没有提示行
//   D2 点开是月历浮层，选一个非今天的日期 → 按钮变该日期、提示行出现、占位符跟着变
//   D3 添加的任务不进「今天」列表（列表仍只列今天）
//   D4 日程页点到那一天，能看到这条任务；日程页不再有可见的添加输入行
//   D5 日历格子是正方形（不是椭圆），选中态 50% 圆角
// 用法：node scripts/e2e-todo-day-pick.mjs（自动启动 electron，CDP 端口 9341）
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9341
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起 */
    }
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000)
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      if (data.result?.exceptionDetails) {
        reject(new Error('页面异常: ' + (data.result.exceptionDetails.exception?.description ?? data.result.exceptionDetails.text)))
      } else {
        resolve(data.result?.result?.value)
      }
      ws.close()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('ws error'))
    }
  })
}

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''))
  }
}

// 目标日期：同月内取今天的前一天或后一天（避免跨月翻页）
const now = new Date()
const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
const targetD = now.getDate() < daysInMonth ? now.getDate() + 1 : now.getDate() - 1
const targetLabel = `选择 ${now.getMonth() + 1} 月 ${targetD} 日`
const targetHuman = `${now.getMonth() + 1}月${targetD}日`
const TASK = 'e2e-选日期加的任务'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env,
  stdio: 'ignore',
})

try {
  const wsUrl = await connect()
  await sleep(1000)

  // 展开 → 待办页
  await cdp(wsUrl, `(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1)`)
  await sleep(900)

  // ---------- D1 ----------
  const d1 = JSON.parse(
    await cdp(
      wsUrl,
      `JSON.stringify({ btn: document.querySelector('.todo-day-btn')?.textContent, hint: !!document.querySelector('.todo-day-hint'), pop: !!document.querySelector('.todo-day-pop') })`
    )
  )
  ok('D1a 待办页有日期按钮且默认「今天」', d1.btn === '今天', `btn=${d1.btn}`)
  ok('D1b 默认不显示跨日提示', d1.hint === false)
  ok('D1c 日期浮层默认收起', d1.pop === false)

  // ---------- D2 ----------
  await cdp(wsUrl, `document.querySelector('.todo-day-btn').click(); 1`)
  await sleep(400)
  const opened = await cdp(wsUrl, `!!document.querySelector('.todo-day-pop .cal-day')`)
  ok('D2a 点日期按钮打开月历浮层', opened === true)
  const hit = await cdp(
    wsUrl,
    `(() => {
      const hit = [...document.querySelectorAll('.todo-day-pop .cal-day')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(targetLabel)})
      if (!hit) return false
      hit.click()
      return true
    })()`
  )
  ok('D2b 月历里能找到目标日期并点选', hit === true, targetLabel)
  await sleep(400)
  const d2 = JSON.parse(
    await cdp(
      wsUrl,
      `JSON.stringify({
        btn: document.querySelector('.todo-day-btn')?.textContent,
        hint: document.querySelector('.todo-day-hint')?.textContent ?? '',
        placeholder: document.querySelector('.todo-input')?.placeholder ?? '',
        pop: !!document.querySelector('.todo-day-pop')
      })`
    )
  )
  ok('D2c 按钮显示所选日期', d2.btn === targetHuman, `btn=${d2.btn}`)
  ok('D2d 出现「加到哪天、去哪看」提示', d2.hint.includes(targetHuman) && d2.hint.includes('日程'), d2.hint)
  ok('D2e 输入框占位符跟着变', d2.placeholder.includes(targetHuman), d2.placeholder)
  ok('D2f 选完自动收起浮层', d2.pop === false)

  // ---------- D3 ----------
  const d3 = await cdp(
    wsUrl,
    `(async () => {
      const input = document.querySelector('.todo-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(TASK)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.todo-add .todo-add-btn').click()
      await new Promise(r => setTimeout(r, 500))
      return JSON.stringify([...document.querySelectorAll('.todo-list .todo-text')].map(e => e.textContent))
    })()`
  )
  const todayTexts = JSON.parse(d3)
  ok('D3 加到未来日期后，今天列表里不出现', !todayTexts.includes(TASK), JSON.stringify(todayTexts))

  // ---------- D4 + D5 ----------
  await cdp(wsUrl, `document.querySelector('.panel-back').click(); 1`)
  await sleep(700)
  await cdp(wsUrl, `document.querySelector('.widget[data-page="3"]')?.click(); 1`)
  await sleep(900)

  const d5 = JSON.parse(
    await cdp(
      wsUrl,
      `(() => {
        const sel = document.querySelector('.cal-day.selected')
        const r = sel.getBoundingClientRect()
        const cs = getComputedStyle(sel)
        return JSON.stringify({ w: +r.width.toFixed(1), h: +r.height.toFixed(1), radius: cs.borderRadius })
      })()`
    )
  )
  ok('D5 日历格子是正方形（不是椭圆）', Math.abs(d5.w - d5.h) <= 1, `${d5.w}×${d5.h}`)
  ok('D5b 选中态仍为 50% 圆角', d5.radius === '50%', d5.radius)

  const addVisible = await cdp(
    wsUrl,
    `(() => {
      const el = document.querySelector('.sched-add')
      if (!el) return 'missing'
      return getComputedStyle(el).display
    })()`
  )
  ok('D4a 日程页没有可见的添加输入行', addVisible === 'none', String(addVisible))

  const clicked = await cdp(
    wsUrl,
    `(() => {
      const hit = [...document.querySelectorAll('.cal-day')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(targetLabel)})
      if (!hit) return 'missing'
      hit.click()
      return 'ok'
    })()`
  )
  ok('D4b 点目标日期能打开当日浮层', clicked === 'ok', String(clicked))
  await sleep(500)
  const d4 = JSON.parse(
    await cdp(
      wsUrl,
      `JSON.stringify({
        sub: document.querySelector('.sched-day-sub')?.textContent ?? '',
        texts: [...document.querySelectorAll('.sched-list .todo-text')].map(e => e.textContent),
        hiddenInputDisplay: (() => { const el = document.querySelector('.sched-day .sched-input'); return el ? getComputedStyle(el.closest('.sched-add')).display : 'missing' })()
      })`
    )
  )
  ok('D4c 浮层副标题是所选日期', d4.sub.includes(targetHuman), d4.sub)
  ok('D4d 能看当天任务（含刚加的那条）', d4.texts.includes(TASK), JSON.stringify(d4.texts))
  ok('D4e 兼容用的添加行对用户不可见', d4.hiddenInputDisplay === 'none', String(d4.hiddenInputDisplay))

  // 清理测试数据
  await cdp(
    wsUrl,
    `(async () => { const l = await window.island.scheduleList(); for (const it of l) { if (it.text === ${JSON.stringify(TASK)}) await window.island.scheduleRemove(it.id) } return 1 })()`
  )
} catch (e) {
  fail++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  try {
    child.kill()
  } catch {}
}

console.log(`\nE2E TODO-DAY-PICK: ${fail === 0 ? 'PASS' : 'FAIL'}（${pass} 过 / ${fail} 败）`)
process.exit(fail === 0 ? 0 : 1)
