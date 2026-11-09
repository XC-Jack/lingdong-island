// US-036 日程条目编辑 e2e：双击改名 → UI 与磁盘一致；Escape 取消；空文本不覆盖。
// 约定：先备份 schedule.json，结束时还原；CDP 9321。
import { spawn } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(import.meta.dirname, '..')
const PORT = 9321
const USER_DATA = join(process.env.APPDATA ?? '', 'lingdong-island')
const SCHED = join(USER_DATA, 'schedule.json')
let backup = null // null = 原来没有 schedule.json

function httpJson(path) {
  return fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => r.json())
}

async function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  try {
    const reply = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('cdp timeout')), 15000)
      ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data)
        if (data.id === 1) { clearTimeout(t); res(data) }
      }
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? 'page exception')
    return reply.result?.result?.value
  } finally { ws.close() }
}

async function main() {
  // 备份真实数据
  if (existsSync(SCHED)) {
    backup = readFileSync(SCHED, 'utf8')
  }

  // 预置一条日程（旧版数据结构直接写盘，主进程 load 时正常读）
  mkdirSync(USER_DATA, { recursive: true })
  const seed = {
    items: [
      { id: 'us036-a', text: '原始名称甲', day: '2026-11-05', time: null, done: false, reminded: false, createdAt: 1 },
      { id: 'us036-b', text: '原始名称乙', day: '2026-11-05', time: '09:30', done: false, reminded: false, createdAt: 2 },
    ],
  }
  writeFileSync(SCHED, JSON.stringify(seed, null, 2), 'utf8')

  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE // DSH 宿主 shell 里带了这个值，不清掉 electron 会退化成纯 Node 秒退
  const child = spawn(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, stdio: 'ignore',
    env: childEnv,
  })
  // 模块级 finally 的 restore 需要等本进程退出后才能写回真实数据（US-036 踩坑：
  // electron 退出时会 save() 内存态，restore 先跑会被它覆盖）
  globalThis.__e2eChild = child

  // 等 CDP 就绪
  let wsUrl = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const list = await httpJson('/json')
      const page = list.find((x) => x.type === 'page')
      if (page) { wsUrl = page.webSocketDebuggerUrl; break }
    } catch { /* not ready */ }
  }
  if (!wsUrl) throw new Error('CDP page not found')

  const evalJs = (expr) => cdp(wsUrl, expr)

  // 展开岛 → 切日程页（第 4 个点）
  await evalJs(`document.querySelector('.island').click()`)
  await new Promise((r) => setTimeout(r, 400))
  await evalJs(`document.querySelectorAll('.dot')[3].click()`)
  await new Promise((r) => setTimeout(r, 400))

  // A1 初始列表两条
  const a1 = await evalJs(`(() => {
    const texts = [...document.querySelectorAll('.sched-list .todo-item .todo-text')].map(x => x.textContent)
    return { count: texts.length, texts }
  })()`)
  if (a1.count !== 2 || !a1.texts.includes('原始名称甲')) throw new Error(`A1 初始列表不对: ${JSON.stringify(a1)}`)
  console.log(`[A1] 初始列表: ${JSON.stringify(a1.texts)}`)

  // A2 双击列表第一条进入编辑，输入框出现且值为该条原文（排序后第一条可能是任一条）
  const a2 = await evalJs(`(() => {
    const span = document.querySelector('.sched-list .todo-item .todo-text')
    window.__us036Target = span.textContent
    span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return null
  })()`)
  void a2
  await new Promise((r) => setTimeout(r, 200))
  const a2v = await evalJs(`(() => {
    const inp = document.querySelector('.sched-list .todo-edit')
    return { present: !!inp, value: inp ? inp.value : null, target: window.__us036Target }
  })()`)
  if (!a2v.present || a2v.value !== a2v.target) throw new Error(`A2 编辑框未出现: ${JSON.stringify(a2v)}`)
  console.log(`[A2] 双击进入编辑, 目标 = ${a2v.target}, 输入框值 = ${a2v.value}`)

  // A3 改名并回车 → UI 更新
  await evalJs(`(() => {
    const inp = document.querySelector('.sched-list .todo-edit')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(inp, '改名后的日程')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return null
  })()`)
  await evalJs(`(() => {
    const inp = document.querySelector('.sched-list .todo-edit')
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return null
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  const a3 = await evalJs(`(() => {
    const texts = [...document.querySelectorAll('.sched-list .todo-item .todo-text')].map(x => x.textContent)
    return {
      texts,
      editing: !!document.querySelector('.sched-list .todo-edit'),
      hasList: !!document.querySelector('.sched-list'),
      hasIsland: !!document.querySelector('.island'),
      title: document.querySelector('.panel-title')?.textContent ?? null,
      err: window.__us036Err ?? null
    }
  })()`)
  if (!a3.texts.includes('改名后的日程') || a3.editing) throw new Error(`A3 改名未生效: ${JSON.stringify(a3)}`)
  console.log(`[A3] 回车改名成功: ${JSON.stringify(a3.texts)}`)

  // A4 磁盘同步（A2 记录了被双击那条的原文 __us036Target；排序后第一条可能是 a 或 b）
  const onDisk = JSON.parse(readFileSync(SCHED, 'utf8'))
  const a4 = onDisk.items.find((x) => x.text === '改名后的日程')
  const a4others = onDisk.items.filter((x) => x.text !== '改名后的日程')
  if (!a4) throw new Error(`A4 磁盘未落新名: ${JSON.stringify(onDisk.items)}`)
  const expectedOther = a4.id === 'us036-a' ? '原始名称乙' : '原始名称甲'
  if (a4others.length !== 1 || a4others[0].text !== expectedOther) {
    throw new Error(`A4 另一条被误改: ${JSON.stringify(onDisk.items)}`)
  }
  // 对照基准是本脚本预置的 seed（不是 backup——那是用户的真实数据）
  const orig = seed.items.find((x) => x.id === a4.id)
  for (const k of ['day', 'time', 'done', 'reminded', 'createdAt']) {
    if (a4[k] !== orig[k]) throw new Error(`A4 其余字段 ${k} 被意外改动: ${JSON.stringify(a4)}`)
  }
  console.log(`[A4] 磁盘已更新(${a4.id}), 其余字段不变`)

  // A5 Escape 取消：双击另一条（原始名称甲）→ 输入新字 → Esc → 原文保留
  await evalJs(`(() => {
    const spans = [...document.querySelectorAll('.sched-list .todo-item .todo-text')]
    const target = spans.find(s => s.textContent === '原始名称甲')
    if (!target) return 'MISSING'
    window.__us036Target2 = target.textContent
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return null
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  await evalJs(`(() => {
    const inp = document.querySelector('.sched-list .todo-edit')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(inp, '这条不该保存')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return null
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  const a5 = await evalJs(`(() => {
    const texts = [...document.querySelectorAll('.sched-list .todo-item .todo-text')].map(x => x.textContent)
    return { texts }
  })()`)
  if (!a5.texts.includes('原始名称甲') || a5.texts.includes('这条不该保存')) throw new Error(`A5 Escape 未取消: ${JSON.stringify(a5)}`)
  console.log(`[A5] Escape 取消, 原文保留: ${JSON.stringify(a5.texts)}`)

  // A6 空文本回车 = 取消不覆盖
  await evalJs(`(() => {
    const spans = [...document.querySelectorAll('.sched-list .todo-item .todo-text')]
    const target = spans.find(s => s.textContent === '原始名称甲')
    if (!target) return 'MISSING'
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return null
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  await evalJs(`(() => {
    const inp = document.querySelector('.sched-list .todo-edit')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(inp, '   ')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return null
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  const a6 = await evalJs(`(() => {
    const texts = [...document.querySelectorAll('.sched-list .todo-item .todo-text')].map(x => x.textContent)
    return { texts }
  })()`)
  if (!a6.texts.includes('原始名称甲')) throw new Error(`A6 空文本覆盖了原文: ${JSON.stringify(a6)}`)
  const a6disk = JSON.parse(readFileSync(SCHED, 'utf8')).items.find((x) => x.text === '原始名称甲')
  if (!a6disk) throw new Error('A6 磁盘被空文本覆盖: 原始名称甲 消失')
  console.log(`[A6] 空文本回车视为取消, 磁盘原文保留`)

  // A7 界面存活
  const a7 = await evalJs(`!!document.querySelector('.island')`)
  if (!a7) throw new Error('A7 界面白屏')
  console.log('[A7] 界面存活')

  // A8 输入框里的空格/回车不收岛（US-036 真凶防回归：岛根 onKeyDown 见 Enter/空格 toggle()，
  // 输入框必须 stopPropagation。派发 bubbles keydown 模拟冒泡路径）
  const a8 = await evalJs(`(async () => {
    const input = document.querySelector('.sched-input')
    input.focus()
    const fire = (key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    fire(' ')
    fire('Enter')
    await new Promise((r) => setTimeout(r, 250))
    return { expanded: !!document.querySelector('.sched-input'), alive: !!document.querySelector('.island') }
  })()`)
  if (!a8.expanded || !a8.alive) throw new Error(`A8 输入框空格/回冒泡收岛: ${JSON.stringify(a8)}`)
  console.log(`[A8] 输入框空格/回车冒泡后岛保持展开: ${JSON.stringify(a8)}`)

  console.log('E2E SCHEDULE-EDIT PASS')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('E2E SCHEDULE-EDIT FAIL:', e.message)
    process.exitCode = 1
  })
  .finally(() => {
    // 还原真实数据。必须先等 electron 子进程完全退出——它退出时会 save() 内存态，
    // 若 restore 先跑，进程退出时的 save 会把种子数据写回去，覆盖用户真实数据（US-036 踩坑）。
    const child = globalThis.__e2eChild
    try {
      if (child && child.exitCode === null) {
        child.kill()
        // 轮询等待进程真正退出（最多 5 秒）
        const deadline = Date.now() + 5000
        while (child.exitCode === null && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        }
      }
    } catch { /* 进程可能已退出 */ }
    try {
      if (backup === null) {
        if (existsSync(SCHED)) renameSync(SCHED, join(tmpdir(), `us036-sched-del-${Date.now()}.json`))
      } else {
        writeFileSync(SCHED, backup, 'utf8')
      }
    } catch (e) { console.error('[restore] 失败:', e.message) }
  })
