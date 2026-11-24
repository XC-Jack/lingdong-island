// e2e-schedule-day.mjs：验证 US-014「日程跨天」
// 覆盖：旧数据迁移（补 day 字段 + 生成 .bak 备份）→ 今天/明天各加一条 → 按天过滤
//      → 蓝点数量 → 待办只在今天混排 → 逾期徽标 → 数据层面每条都有合法 day
// 用法：node scripts/e2e-schedule-day.mjs（自动启动 electron，CDP 端口 9321；Node 22+ 自带全局 WebSocket）
// 注意：会临时改写用户的 schedule.json / todos.json，结束时原样恢复。
import { spawn } from './isolate-userdata.mjs'
import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const USER_DATA = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'lingdong-island')
const SCHEDULE_JSON = join(USER_DATA, 'schedule.json')
const TODOS_JSON = join(USER_DATA, 'todos.json')
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC） */
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const today = new Date()
const todayKey = localDay(today)
const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
const tomorrowKey = localDay(tomorrow)
const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
const yesterdayKey = localDay(yesterday)

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

/** 在日程页输入框里加一条（走真实输入事件路径） */
async function addSchedule(wsUrl, content) {
  await cdp(
    wsUrl,
    `(() => {
      const input = document.querySelector('.sched-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(content)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.todo-add-btn').click()
      return true
    })()`
  )
  await sleep(450)
}

/** 点日历上的某一天（跨月时先翻月） */
async function pickDay(wsUrl, targetKey) {
  const [y, m, d] = targetKey.split('-').map(Number)
  const clicked = await settle(
    wsUrl,
    `(() => {
      const want = ${JSON.stringify(`选择 ${m} 月 ${d} 日`)}
      const hit = Array.from(document.querySelectorAll('.cal-day')).find(
        (b) => b.getAttribute('aria-label') === want
      )
      if (hit) { hit.click(); return 'same-month' }
      return 'need-nav'
    })()`,
    250
  )
  if (clicked === 'need-nav') {
    // 目标月份在视图之外：按差月数翻页后再点
    const now = new Date()
    const diff = (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth())
    for (let i = 0; i < Math.abs(diff); i++) {
      await cdp(wsUrl, `document.querySelectorAll('.cal-nav')[${diff > 0 ? 1 : 0}].click(); 1`)
      await sleep(150)
    }
    await settle(
      wsUrl,
      `(() => {
        const want = ${JSON.stringify(`选择 ${m} 月 ${d} 日`)}
        const hit = Array.from(document.querySelectorAll('.cal-day')).find(
          (b) => b.getAttribute('aria-label') === want
        )
        if (!hit) throw new Error('找不到日历格子: ' + want)
        hit.click()
        return true
      })()`,
      350
    )
  }
  await sleep(250)
}

const listTexts = `Array.from(document.querySelectorAll('.sched-list .todo-text')).map(e => e.textContent)`

const main = async () => {
  // ---------- 备份用户真实数据 ----------
  const hadSchedule = existsSync(SCHEDULE_JSON)
  const scheduleBackup = hadSchedule ? readFileSync(SCHEDULE_JSON, 'utf8') : null
  const hadTodos = existsSync(TODOS_JSON)
  const todosBackup = hadTodos ? readFileSync(TODOS_JSON, 'utf8') : null
  const bakBefore = new Set(
    existsSync(USER_DATA) ? readdirSync(USER_DATA).filter((n) => n.startsWith('schedule.json.bak-')) : []
  )
  console.log('[准备] schedule.json / todos.json 已备份；已有 .bak 文件', bakBefore.size, '个')

  // ---------- 种植「旧格式」数据：没有 day 字段，用于测迁移 ----------
  writeFileSync(
    SCHEDULE_JSON,
    JSON.stringify(
      {
        items: [
          { id: 'legacy-1', text: '旧日程-无日期字段', time: null, done: false, reminded: false, createdAt: 1 }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
  console.log('[准备] 已写入旧格式 schedule.json（1 条，无 day 字段）')

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
      if (scheduleBackup !== null) writeFileSync(SCHEDULE_JSON, scheduleBackup, 'utf8')
      else if (existsSync(SCHEDULE_JSON)) unlinkSync(SCHEDULE_JSON)
      if (todosBackup !== null) writeFileSync(TODOS_JSON, todosBackup, 'utf8')
      else if (existsSync(TODOS_JSON)) unlinkSync(TODOS_JSON)
      // 删掉本次测试产生的 .bak 备份（用户原本没有的）
      for (const n of readdirSync(USER_DATA)) {
        if (n.startsWith('schedule.json.bak-') && !bakBefore.has(n)) unlinkSync(join(USER_DATA, n))
      }
      console.log('[收尾] schedule.json / todos.json 已恢复，测试产生的 .bak 已删除')
    } catch (e) {
      console.error('[收尾] 恢复失败:', e.message)
    }
  }

  try {
    const wsUrl = await connect()
    console.log('[0] 已连上 CDP')
    await sleep(900)

    // ---------- M1/M2：旧数据迁移 ----------
    const migrated = JSON.parse(
      await cdp(
        wsUrl,
        `(async () => {
          const l = await window.island.scheduleList()
          return JSON.stringify(l.map((it) => ({ text: it.text, day: it.day })))
        })()`
      )
    )
    assert(migrated.length === 1, 'M1 迁移后条目数应为 1，实际 ' + JSON.stringify(migrated))
    assert(migrated[0].text === '旧日程-无日期字段', 'M1 文本不对: ' + JSON.stringify(migrated[0]))
    assert(migrated[0].day === todayKey, `M1 旧条目应迁移到今天(${todayKey})，实际 ${migrated[0].day}`)
    console.log('[1] M1 通过：旧条目补上 day =', todayKey)

    const disk = JSON.parse(readFileSync(SCHEDULE_JSON, 'utf8'))
    assert(Array.isArray(disk.items) && disk.items.length === 1, 'M2 磁盘条目数不对')
    assert(disk.items[0].day === todayKey, 'M2 磁盘上没有写入 day 字段: ' + JSON.stringify(disk.items[0]))
    const bakNow = readdirSync(USER_DATA).filter((n) => n.startsWith('schedule.json.bak-'))
    assert(
      bakNow.some((n) => !bakBefore.has(n)),
      'M2 迁移前应生成 .bak 备份，实际 .bak = ' + JSON.stringify(bakNow)
    )
    console.log('[2] M2 通过：磁盘已落新格式，并生成', bakNow.filter((n) => !bakBefore.has(n)).join(', '))

    // ---------- 进入日程页 ----------
    await cdp(wsUrl, `(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1); 1`)
    await sleep(600)
    await cdp(wsUrl, `document.querySelectorAll('.dot')[3].click(); 1`)
    await sleep(700)
    const title = await cdp(wsUrl, `document.querySelector('.panel-title')?.textContent`)
    assert(title === '日程', '没进到日程页，标题 = ' + title)
    console.log('[3] 已进入日程页')

    // 幂等清理（老数据清掉，从干净状态开始）
    await cdp(
      wsUrl,
      `(async () => {
        let l = await window.island.scheduleList()
        for (const it of l) l = await window.island.scheduleRemove(it.id)
        return l.length
      })()`
    )
    // 面板的 items 只在挂载时拉一次，清完要重新进页面才刷新
    await cdp(wsUrl, `document.querySelectorAll('.dot')[0].click(); 1`)
    await sleep(300)
    await cdp(wsUrl, `document.querySelectorAll('.dot')[3].click(); 1`)
    await sleep(600)
    // 确保选中的是今天
    await pickDay(wsUrl, todayKey)

    // ---------- A1：今天加一条 ----------
    await addSchedule(wsUrl, 'e2e-今天的安排')
    let texts = await cdp(wsUrl, listTexts)
    assert(Array.isArray(texts) && texts.length === 1 && texts[0] === 'e2e-今天的安排', 'A1 今天列表不对: ' + JSON.stringify(texts))
    console.log('[4] A1 通过：今天列表 =', JSON.stringify(texts))

    // ---------- A2：切到明天，加一条，只显示明天的 ----------
    await pickDay(wsUrl, tomorrowKey)
    texts = await cdp(wsUrl, listTexts)
    assert(Array.isArray(texts) && texts.length === 0, 'A2 切到明天应看到空列表，实际 ' + JSON.stringify(texts))
    await addSchedule(wsUrl, 'e2e-明天的安排')
    texts = await cdp(wsUrl, listTexts)
    assert(
      Array.isArray(texts) && texts.length === 1 && texts[0] === 'e2e-明天的安排',
      'A2 明天列表不对: ' + JSON.stringify(texts)
    )
    console.log('[5] A2 通过：明天只显示明天的日程')

    // ---------- A3：明天的副标题说明待办只在今天 ----------
    const subTomorrow = await cdp(wsUrl, `document.querySelector('.sched-day-sub')?.textContent ?? ''`)
    assert(subTomorrow.includes('待办只在今天'), 'A3 明天副标题应写「待办只在今天」，实际 ' + subTomorrow)
    assert(subTomorrow.includes('1 条日程'), 'A3 明天副标题日程数不对: ' + subTomorrow)
    console.log('[6] A3 通过：明天副标题 =', subTomorrow.trim())

    // ---------- A4：明天不渲染待办条目 ----------
    const todoBadgesTomorrow = await cdp(
      wsUrl,
      `document.querySelectorAll('.sched-list .sched-badge-todo').length`
    )
    assert(todoBadgesTomorrow === 0, 'A4 明天不应显示待办，实际徽标数 ' + todoBadgesTomorrow)
    console.log('[7] A4 通过：明天没有混排待办')

    // ---------- A5：回到今天，待办照常混排 ----------
    await pickDay(wsUrl, todayKey)
    const subToday = await cdp(wsUrl, `document.querySelector('.sched-day-sub')?.textContent ?? ''`)
    assert(subToday.includes('条待办'), 'A5 今天副标题应含待办数，实际 ' + subToday)
    assert(!subToday.includes('待办只在今天'), 'A5 今天不应写「待办只在今天」: ' + subToday)
    console.log('[8] A5 通过：今天副标题 =', subToday.trim())

    // ---------- A6：蓝点数量 = 有日程的天数（2 天）----------
    const marks = await cdp(wsUrl, `document.querySelectorAll('.cal-day .cal-mark').length`)
    assert(marks === 2, 'A6 蓝点应有 2 个（今天+明天），实际 ' + marks)
    console.log('[9] A6 通过：日历蓝点 2 个')

    // ---------- A7：昨天加一条无时间未完成，应显示「逾期」----------
    await pickDay(wsUrl, yesterdayKey)
    await addSchedule(wsUrl, 'e2e-昨天没做完')
    const pastBadge = await cdp(
      wsUrl,
      `(() => {
        const b = document.querySelector('.sched-list .sched-badge.sched-past')
        return b ? b.textContent : null
      })()`
    )
    assert(pastBadge === '逾期', 'A7 昨天的无时间未完成条目应显示「逾期」徽标，实际 ' + JSON.stringify(pastBadge))
    console.log('[10] A7 通过：逾期徽标出现')

    // ---------- A8：数据层面每条都有合法 day，且分属 3 个不同日期 ----------
    const data = JSON.parse(
      await cdp(
        wsUrl,
        `(async () => {
          const l = await window.island.scheduleList()
          return JSON.stringify(l.map((it) => ({ text: it.text, day: it.day })))
        })()`
      )
    )
    assert(data.length === 3, 'A8 应有 3 条日程，实际 ' + data.length)
    for (const it of data) {
      assert(DAY_RE.test(it.day), 'A8 存在非法 day: ' + JSON.stringify(it))
    }
    const days = new Set(data.map((it) => it.day))
    assert(days.size === 3, 'A8 应有 3 个不同日期，实际 ' + JSON.stringify([...days]))
    console.log('[11] A8 通过：3 条日程分属 3 天，格式全部合法')

    // ---------- A9：安装版/开发版均存活的兜底（面板还在）----------
    const alive = await cdp(wsUrl, `!!document.querySelector('.island')`)
    assert(alive, 'A9 界面消失了')
    console.log('[12] A9 通过：界面存活')

    console.log('E2E SCHEDULE-DAY PASS')
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
