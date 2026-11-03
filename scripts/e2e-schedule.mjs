// e2e 日程页：自带启动+清理（与 e2e-m4 同模式）。切到第四页 → 加日程(带时间) → 列表出现 → 勾选 → 删除 → 空态
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CDP_PORT = process.env.CDP_PORT || '9321'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function ensureInstance() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
    const list = await r.json()
    if (list.some((t) => t.type === 'page' && !t.url.startsWith('devtools') && !t.url.startsWith('dsh://'))) return
  } catch {}
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  child.unref()
}

async function connect() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools') && !t.url.startsWith('dsh://'))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl) {
  let seq = 0
  const pending = new Map()
  const ws = new WebSocket(wsUrl)
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d.result?.result?.value)
      pending.delete(d.id)
    }
  }
  const send = (expr) => new Promise((res) => {
    const i = ++seq
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
  return { ws, send }
}

const main = async () => {
  await ensureInstance()
  await sleep(2000)
  const wsUrl = await connect()
  const { ws, send } = cdp(wsUrl)
  await new Promise((res) => { ws.onopen = res })

  // 展开岛（收起态点一下）
  await send(`document.querySelector('.island').click()`)
  await sleep(600)

  // 切到第四页（日程）
  const t0 = await send(`(() => { document.querySelectorAll('.dot')[3].click(); return true })()`)
  await sleep(700)
  const title = await send(`document.querySelector('.panel-title')?.textContent`)
  console.log('[1] 第四页标题:', title, t0 ? '' : '(click fail)')
  if (title !== '日程') throw new Error('fail: title != 日程')

  // 幂等清理：删掉历史残留（上次失败可能留下数据）
  await send(`(async () => {
    let l = await window.island.scheduleList()
    for (const it of l) await window.island.scheduleRemove(it.id)
    return true
  })()`)
  await sleep(400)

  // 加两条日程：一条带时间、一条不带
  await send(`(() => {
    const input = document.querySelector('.sched-input')
    const btn = document.querySelector('.todo-add-btn')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '写周报')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    btn.click()
    return true
  })()`)
  await sleep(400)
  await send(`(() => {
    const input = document.querySelector('.sched-input')
    const btn = document.querySelector('.todo-add-btn')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '团队例会')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    btn.click()
    return true
  })()`)
  await sleep(500)
  let texts = await send(`Array.from(document.querySelectorAll('.sched-list .todo-text')).map(e => e.textContent)`)
  console.log('[2] 加两条后列表:', JSON.stringify(texts))
  if (!Array.isArray(texts) || texts.length !== 2) throw new Error('fail: expect 2 items')

  // 勾选第一条（勾完它排到列表末尾——done 的排后面）
  await send(`document.querySelector('.sched-list .todo-check').click()`)
  await sleep(400)
  const doneState = await send(`(() => {
    const items = Array.from(document.querySelectorAll('.sched-list .todo-item'))
    return { total: items.length, done: items.filter((i) => i.className.includes('done')).length, last: items[items.length-1]?.className.includes('done') }
  })()`)
  console.log('[3] 勾选后 done 统计:', JSON.stringify(doneState))
  if (doneState.total !== 2 || doneState.done !== 1 || doneState.last !== true) throw new Error('fail: not done')

  // 删除一条
  await send(`document.querySelector('.sched-list .todo-del').click()`)
  await sleep(400)
  texts = await send(`Array.from(document.querySelectorAll('.sched-list .todo-text')).map(e => e.textContent)`)
  console.log('[4] 删一条后:', JSON.stringify(texts))
  if (!Array.isArray(texts) || texts.length !== 1) throw new Error('fail: expect 1 item')

  // 清空最后一条，验证空态
  await send(`document.querySelector('.sched-list .todo-del').click()`)
  await sleep(400)
  const empty = await send(`document.querySelector('.notify-empty')?.textContent ?? null`)
  console.log('[5] 空态提示:', empty)
  if (!empty || !empty.includes('今天还没有安排')) throw new Error('fail: empty state')

  console.log('E2E SCHEDULE PASS')
  ws.close()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
