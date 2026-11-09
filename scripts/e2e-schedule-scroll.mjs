// e2e-schedule-scroll.mjs —— 补验证：待办页混排在「今天日程很多（超过一屏）」时的表现（状态页未验证项）
// 流程：备份 schedule.json/todos.json → 注入 20 条今日日程 + 8 条待办 → 启动 dev → 展开切待办页
// → 断言：列表容器可滚动（scrollHeight > clientHeight）、全部条目渲染（20 日程 + 8 待办）、
//   日程带 sched-badge 且排在待办上方（时间早的在前）→ 还原数据。
import { spawn } from './isolate-userdata.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/Users/honor/Documents/Project/灵动岛'
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PORT = 9321

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

const schedPath = join(USER_DATA, 'schedule.json')
const todosPath = join(USER_DATA, 'todos.json')
const schedBak = existsSync(schedPath) ? readFileSync(schedPath, 'utf8') : null
const todosBak = existsSync(todosPath) ? readFileSync(todosPath, 'utf8') : null

const now = new Date()
const y = now.getFullYear(), m = now.getMonth(), d = now.getDate()
const today = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

// 20 条今日日程（时间从 08:00 到 17:30 递增）+ 8 条待办
const items = []
for (let i = 0; i < 20; i++) {
  const hh = String(8 + Math.floor(i / 2)).padStart(2, '0')
  const mm = i % 2 === 0 ? '00' : '30'
  items.push({ id: `s-${i}`, text: `滚动测试日程 ${i + 1}`, day: today, time: `${hh}:${mm}`, done: false, reminded: false, createdAt: Date.now() + i })
}
writeFileSync(schedPath, JSON.stringify({ items }), 'utf8')
const todos = []
for (let i = 0; i < 8; i++) {
  todos.push({ id: `t-${i}`, text: `滚动测试待办 ${i + 1}`, done: false, createdAt: Date.now() + i })
}
writeFileSync(todosPath, JSON.stringify({ todos }), 'utf8')

const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronExe, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

async function cdpEval(expr) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const r = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data))
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return r.result?.result?.value
}

try {
  await new Promise((r) => setTimeout(r, 6000))
  await cdpEval(`document.querySelector('.island').click()`)
  await new Promise((r) => setTimeout(r, 800))
  // 待办页 = dot[0]，默认就在；保险再点一次
  await cdpEval(`document.querySelectorAll('.dot')[0].dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  await new Promise((r) => setTimeout(r, 1500))

  // 列表容器 = ul.todo-list 本体（todoListRef 挂在它上面，src/App.tsx:504）
  const scroll = await cdpEval(`(() => {
    const el = document.querySelector('.todo-list')
    if (!el) return null
    return { sh: el.scrollHeight, ch: el.clientHeight, cls: el.className }
  })()`)
  console.log('  容器:', JSON.stringify(scroll))

  const nItems = await cdpEval(`document.querySelectorAll('.todo-list .todo-item').length`)
  const nSched = await cdpEval(`document.querySelectorAll('.todo-list .sched-badge').length`)
  const nTodos = await cdpEval(`Array.from(document.querySelectorAll('.todo-list .todo-item')).filter(el => el.textContent.includes('滚动测试待办')).length`)
  ok('S1 全部条目渲染(20日程+8待办=28)', nItems >= 28, `n=${nItems}`)
  ok('S2 日程徽标 20 个', nSched === 20, `n=${nSched}`)
  ok('S3 待办 8 条', nTodos === 8, `n=${nTodos}`)
  if (scroll) {
    ok('S4 列表可滚动(内容超一屏)', scroll.sh > scroll.ch, `sh=${scroll.sh} ch=${scroll.ch}`)
  } else {
    ok('S4 列表可滚动', false, '容器未找到')
  }
  // 顺序：第一个 .todo-sched 徽标时间应是最早 08:00，最后一个日程在最前段（日程排在待办上方）
  const firstBadge = await cdpEval(`document.querySelector('.todo-list .sched-badge')?.textContent`)
  ok('S5 日程按时间排序(首个徽标 08:00)', firstBadge === '08:00', `first=${firstBadge}`)
  // 滚动到底不报错
  await cdpEval(`(() => { const el = document.querySelector('.todo-list'); if (el) el.scrollTop = el.scrollHeight; return true })()`)
  await new Promise((r) => setTimeout(r, 300))
  const lastVisible = await cdpEval(`(() => {
    const els = Array.from(document.querySelectorAll('.todo-list .todo-item'))
    const last = els[els.length - 1]
    const r = last.getBoundingClientRect()
    return r.top < window.innerHeight
  })()`)
  ok('S6 滚动到底后最后一条可见', lastVisible === true)
} catch (e) {
  fail++
  console.log('  ✗ 异常:', e.message)
} finally {
  child.kill()
  if (schedBak !== null) writeFileSync(schedPath, schedBak, 'utf8')
  else if (existsSync(schedPath)) writeFileSync(schedPath, '{"items":[]}', 'utf8')
  if (todosBak !== null) writeFileSync(todosPath, todosBak, 'utf8')
  else if (existsSync(todosPath)) writeFileSync(todosPath, '{"todos":[]}', 'utf8')
  console.log(`\n结果: ${pass} 过 / ${fail} 败`)
  process.exit(fail > 0 ? 1 : 0)
}
