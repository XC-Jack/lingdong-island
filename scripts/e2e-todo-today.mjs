// e2e-todo-today.mjs：验证 US-033「待办页同步今天的日程」
// 覆盖：只显示今天的日程（明天/昨天不出现） → 时间徽标只显示 HH:mm 不显示日期
//      → 待办 + 今天日程一起计数 → 在待办页勾选日程、日程页同步 → 在待办页新增（带时间）
//        落到今天的日程、不写进 todos.json → 收起态数字按同一口径 → 全部完成后收起标记消失
// 用法：node scripts/e2e-todo-today.mjs（自动启动 electron，CDP 端口 9321；Node 22+ 自带全局 WebSocket）
// 注意：会临时清空并改写用户的 todos.json / schedule.json，结束时原样恢复。
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const USER_DATA = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'lingdong-island')
const TODOS_JSON = join(USER_DATA, 'todos.json')
const SCHEDULE_JSON = join(USER_DATA, 'schedule.json')
const AUTO_COLLAPSE_MS = 700

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC） */
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const day0 = new Date()
const todayKey = localDay(day0)
const tomorrowKey = localDay(new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + 1))
const yesterdayKey = localDay(new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() - 1))

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
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      if (data.result?.exceptionDetails) {
        reject(
          new Error(
            '页面异常: ' +
              (data.result.exceptionDetails.exception?.description ?? data.result.exceptionDetails.text)
          )
        )
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

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

/** 等 React 状态落定再求值 */
async function settle(wsUrl, expression, ms = 400) {
  await cdp(wsUrl, `new Promise(r=>setTimeout(r,${ms})).then(()=>true)`)
  return cdp(wsUrl, expression)
}

/** 通过真实鼠标事件路径收起：派发原生 mouseout（合成 mouseleave 无效，实测踩坑） */
async function collapse(wsUrl) {
  await cdp(wsUrl, `document.querySelector('.island').dispatchEvent(new MouseEvent('mouseout', {bubbles:true})); 1`)
  await sleep(AUTO_COLLAPSE_MS + 250)
}

/** 点分页圆点切页（0=待办 1=置物架 2=通知 3=日程） */
async function gotoPage(wsUrl, index) {
  await cdp(wsUrl, `document.querySelectorAll('.dot')[${index}].click(); 1`)
  await sleep(500)
}

const listTexts = `Array.from(document.querySelectorAll('.todo-panel .todo-item .todo-text')).map(e => e.textContent)`

const main = async () => {
  // ---------- 备份用户真实数据 ----------
  const hadTodos = existsSync(TODOS_JSON)
  const todosBackup = hadTodos ? readFileSync(TODOS_JSON, 'utf8') : null
  const hadSchedule = existsSync(SCHEDULE_JSON)
  const scheduleBackup = hadSchedule ? readFileSync(SCHEDULE_JSON, 'utf8') : null
  console.log('[准备] todos.json / schedule.json 已备份')

  // ---------- 种子数据：今天 2 条（1 条带时间）+ 明天 1 条 + 昨天 1 条 + 待办 1 条 ----------
  // reminded 全部置 true，避免测试期间弹系统通知
  writeFileSync(
    SCHEDULE_JSON,
    JSON.stringify(
      {
        items: [
          { id: 'seed-today-1', text: '今天-九点的会', day: todayKey, time: '09:00', done: false, reminded: true, createdAt: 1 },
          { id: 'seed-today-2', text: '今天-交周报', day: todayKey, time: null, done: false, reminded: true, createdAt: 2 },
          { id: 'seed-tomorrow-1', text: '明天-买菜', day: tomorrowKey, time: null, done: false, reminded: true, createdAt: 3 },
          { id: 'seed-yesterday-1', text: '昨天-没做完的事', day: yesterdayKey, time: null, done: false, reminded: true, createdAt: 4 }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    TODOS_JSON,
    JSON.stringify(
      { todos: [{ id: 'seed-todo-1', text: '待办-一条', done: false, createdAt: 5 }] },
      null,
      2
    ),
    'utf8'
  )
  console.log('[准备] 已写入种子数据：今天 2 条日程 + 明天 1 条 + 昨天 1 条 + 待办 1 条')

  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })

  const restore = () => {
    try {
      if (todosBackup !== null) writeFileSync(TODOS_JSON, todosBackup, 'utf8')
      else if (existsSync(TODOS_JSON)) unlinkSync(TODOS_JSON)
      if (scheduleBackup !== null) writeFileSync(SCHEDULE_JSON, scheduleBackup, 'utf8')
      else if (existsSync(SCHEDULE_JSON)) unlinkSync(SCHEDULE_JSON)
      console.log('[收尾] todos.json / schedule.json 已恢复')
    } catch (e) {
      console.error('[收尾] 恢复失败:', e.message)
    }
  }

  try {
    const wsUrl = await connect()
    console.log('[0] 已连上 CDP')
    await sleep(900)

    // ---------- 展开，停在待办页 ----------
    await cdp(wsUrl, `document.querySelector('.island').click(); 1`)
    await sleep(700)
    const title = await cdp(wsUrl, `document.querySelector('.panel-title')?.textContent`)
    assert(title === '待办', 'A1 没进到待办页，标题 = ' + title)
    console.log('[1] A1 已进入待办页')

    // ---------- A2：只显示今天的日程，明天/昨天不出现 ----------
    const texts = await cdp(wsUrl, listTexts)
    assert(Array.isArray(texts), 'A2 列表取不到: ' + JSON.stringify(texts))
    assert(texts.includes('今天-九点的会'), 'A2 缺少今天的日程: ' + JSON.stringify(texts))
    assert(texts.includes('今天-交周报'), 'A2 缺少今天的日程: ' + JSON.stringify(texts))
    assert(texts.includes('待办-一条'), 'A2 待办没显示: ' + JSON.stringify(texts))
    assert(!texts.includes('明天-买菜'), 'A2 明天的日程不应出现: ' + JSON.stringify(texts))
    assert(!texts.includes('昨天-没做完的事'), 'A2 昨天的日程不应出现: ' + JSON.stringify(texts))
    assert(texts.length === 3, 'A2 待办页应有 3 条（2 日程 + 1 待办），实际 ' + JSON.stringify(texts))
    console.log('[2] A2 通过：只显示今天的日程 + 待办 =', JSON.stringify(texts))

    // ---------- A3：时间徽标只显示 HH:mm，不显示日期 ----------
    const badge = await cdp(
      wsUrl,
      `(() => {
        const li = Array.from(document.querySelectorAll('.todo-panel .todo-sched')).find(
          (x) => x.querySelector('.todo-text')?.textContent === '今天-九点的会'
        )
        const b = li?.querySelector('.sched-badge')
        return JSON.stringify({ text: b?.textContent ?? null, hasDate: /\\d{1,2}月|\\d{4}-/.test(b?.textContent ?? '') })
      })()`
    )
    const b = JSON.parse(badge)
    assert(b.text === '09:00', 'A3 时间徽标应为 09:00，实际 ' + JSON.stringify(b))
    assert(b.hasDate === false, 'A3 徽标里不应出现日期: ' + JSON.stringify(b))
    console.log('[3] A3 通过：时间徽标 =', b.text, '，无日期')

    // ---------- A4：计数 = 待办 + 今天日程（0/3） ----------
    const count0 = await cdp(wsUrl, `document.querySelector('.todo-stat .todo-count')?.textContent ?? ''`)
    assert(count0 === '0/3', 'A4 计数应为 0/3，实际 ' + JSON.stringify(count0))
    console.log('[4] A4 通过：完成度 =', count0)

    // ---------- A5：在待办页勾选日程 ----------
    await cdp(
      wsUrl,
      `(() => {
        const li = Array.from(document.querySelectorAll('.todo-panel .todo-sched')).find(
          (x) => x.querySelector('.todo-text')?.textContent === '今天-九点的会'
        )
        li.querySelector('.todo-check').click()
        return true
      })()`
    )
    await sleep(600)
    const doneInStore = JSON.parse(
      await cdp(
        wsUrl,
        `window.island.scheduleList().then((l) => JSON.stringify(l.find((it) => it.id === 'seed-today-1')))`
      )
    )
    assert(doneInStore.done === true, 'A5 勾选后数据里应为已完成: ' + JSON.stringify(doneInStore))
    const count1 = await cdp(wsUrl, `document.querySelector('.todo-stat .todo-count')?.textContent ?? ''`)
    assert(count1 === '1/3', 'A5 勾选后计数应为 1/3，实际 ' + JSON.stringify(count1))
    console.log('[5] A5 通过：勾选日程后数据为已完成，计数 =', count1)

    // ---------- A6：日程页同步显示已完成 ----------
    await gotoPage(wsUrl, 3)
    const schedTitle = await cdp(wsUrl, `document.querySelector('.panel-title')?.textContent`)
    assert(schedTitle === '日程', 'A6 没进到日程页，标题 = ' + schedTitle)
    const schedDone = await cdp(
      wsUrl,
      `(() => {
        const li = Array.from(document.querySelectorAll('.sched-list .todo-item')).find(
          (x) => x.querySelector('.todo-text')?.textContent === '今天-九点的会'
        )
        return JSON.stringify({ found: !!li, done: li?.classList.contains('done') ?? false })
      })()`
    )
    const sd = JSON.parse(schedDone)
    assert(sd.found && sd.done, 'A6 日程页应同步显示已完成: ' + JSON.stringify(sd))
    console.log('[6] A6 通过：日程页同步显示已完成')

    // ---------- A7：回待办页，用带时间的输入框新增一条 ----------
    await gotoPage(wsUrl, 0)
    await cdp(wsUrl, `document.querySelector('.todo-panel .sched-time-btn').click(); 1`)
    await sleep(250)
    // 先点小时 14，再点分钟 30
    await cdp(
      wsUrl,
      `(() => {
        const cols = document.querySelectorAll('.todo-panel .time-pop-col')
        const h = Array.from(cols[0].querySelectorAll('.time-pop-cell')).find((b) => b.textContent === '14')
        h.click()
        return true
      })()`
    )
    await sleep(200)
    await cdp(
      wsUrl,
      `(() => {
        const cols = document.querySelectorAll('.todo-panel .time-pop-col')
        const m = Array.from(cols[1].querySelectorAll('.time-pop-cell')).find((b) => b.textContent === '30')
        m.click()
        return true
      })()`
    )
    await sleep(200)
    await cdp(
      wsUrl,
      `(() => {
        const input = document.querySelector('.todo-panel .todo-input')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify('待办页新加的-下午茶')})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('.todo-panel .todo-add-btn').click()
        return true
      })()`
    )
    await sleep(700)
    const added = JSON.parse(
      await cdp(
        wsUrl,
        `window.island.scheduleList().then((l) => JSON.stringify(l.find((it) => it.text === '待办页新加的-下午茶') ?? null))`
      )
    )
    assert(added, 'A7 新加的条目没进日程: ' + JSON.stringify(added))
    assert(added.day === todayKey, `A7 新条目应落在今天(${todayKey})，实际 ${added.day}`)
    assert(added.time === '14:30', 'A7 时间应为 14:30，实际 ' + JSON.stringify(added.time))
    console.log('[7] A7 通过：待办页新增落到今天的日程，时间 =', added.time)

    // 不写进 todos.json（仍是原来那 1 条）
    const todosOnDisk = JSON.parse(readFileSync(TODOS_JSON, 'utf8'))
    assert(
      Array.isArray(todosOnDisk.todos) && todosOnDisk.todos.length === 1,
      'A7 待办数据不应被写入: ' + JSON.stringify(todosOnDisk.todos)
    )
    assert(
      !todosOnDisk.todos.some((t) => t.text === '待办页新加的-下午茶'),
      'A7 新条目不应写进 todos.json'
    )

    // ---------- A8：新条目出现在待办页列表里 ----------
    const texts2 = await cdp(wsUrl, listTexts)
    assert(texts2.includes('待办页新加的-下午茶'), 'A8 新条目没显示在待办页: ' + JSON.stringify(texts2))
    assert(texts2.length === 4, 'A8 列表应有 4 条，实际 ' + JSON.stringify(texts2))
    const count2 = await cdp(wsUrl, `document.querySelector('.todo-stat .todo-count')?.textContent ?? ''`)
    assert(count2 === '1/4', 'A8 计数应为 1/4，实际 ' + JSON.stringify(count2))
    console.log('[8] A8 通过：新条目显示在待办页，计数 =', count2)

    // ---------- A9：收起态数字按同一口径（4 件里 1 件做完 → 剩 3） ----------
    await collapse(wsUrl)
    const collapsed = JSON.parse(
      await cdp(
        wsUrl,
        `JSON.stringify({
          num: document.querySelector('.collapsed-todo-num')?.textContent ?? null,
          title: document.querySelector('.collapsed-todo')?.getAttribute('title') ?? null
        })`
      )
    )
    assert(collapsed.num === '3', 'A9 收起态剩余应为 3，实际 ' + JSON.stringify(collapsed))
    assert(
      collapsed.title === '今天还有 3 件没做完（共 4 件）',
      'A9 收起态文案不对: ' + JSON.stringify(collapsed.title)
    )
    console.log('[9] A9 通过：收起态数字 =', collapsed.num, '，文案 =', collapsed.title)

    // ---------- A10：把剩下的都勾完，收起标记消失 ----------
    await cdp(wsUrl, `document.querySelector('.island').click(); 1`)
    await sleep(500)
    await cdp(
      wsUrl,
      `(() => {
        for (const li of document.querySelectorAll('.todo-panel .todo-item')) {
          if (!li.classList.contains('done')) li.querySelector('.todo-check').click()
        }
        return true
      })()`
    )
    await sleep(900)
    const countAll = await cdp(wsUrl, `document.querySelector('.todo-stat .todo-count')?.textContent ?? ''`)
    assert(countAll === '4/4', 'A10 全部勾完后计数应为 4/4，实际 ' + JSON.stringify(countAll))
    await collapse(wsUrl)
    const gone = await cdp(wsUrl, `!!document.querySelector('.collapsed-todo')`)
    assert(gone === false, 'A10 全部完成后收起标记应消失')
    console.log('[10] A10 通过：全部完成后收起标记消失')

    console.log('E2E TODO-TODAY PASS')
  } finally {
    restore()
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
