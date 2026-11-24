// e2e-collapsed-todo.mjs：验证 US-004「收起态看待办剩余」（US-033 起口径 = 待办 + 今天的日程）
// 覆盖：收起态标记出现/数字正确/悬停文案 → 全部完成后标记消失 → 新增后收回数字刷新
//      → 标记位置在时钟右边（不挤压时钟）→ 待办页完成度不受影响
// 用法：node scripts/e2e-collapsed-todo.mjs（自动启动 electron，CDP 端口 9321；Node 22+ 自带全局 WebSocket）
// 注意：会临时清空并改写用户的 todos.json 与 schedule.json，结束时原样恢复。
import { spawn } from './isolate-userdata.mjs'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const USER_DATA = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'lingdong-island')
const TODOS_JSON = join(USER_DATA, 'todos.json')
// US-033 起收起态数字 = 待办 + 今天的日程，所以必须把用户的真实日程也清掉，否则数字被污染
const SCHEDULE_JSON = join(USER_DATA, 'schedule.json')
const AUTO_COLLAPSE_MS = 700

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
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

/** 等一会儿再求值（React 状态更新是异步的） */
async function settle(wsUrl, expression, ms = 400) {
  await cdp(wsUrl, `new Promise(r=>setTimeout(r,${ms})).then(()=>true)`)
  return cdp(wsUrl, expression)
}

/** 通过真实鼠标事件路径收起：派发原生 mouseout 触发 React 的 onMouseLeave（合成 mouseleave 无效，实测踩坑） */
async function collapse(wsUrl) {
  await cdp(wsUrl, `document.querySelector('.island').dispatchEvent(new MouseEvent('mouseout', {bubbles:true})); 1`)
  await sleep(AUTO_COLLAPSE_MS + 250)
}

/** 点击岛展开（收起态点一下会 toggle 成展开） */
async function expand(wsUrl) {
  await cdp(wsUrl, `(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1); 1`)
  await sleep(350)
}

const main = async () => {
  // 备份用户真实待办与日程，测试结束原样恢复
  const hadFile = existsSync(TODOS_JSON)
  const backup = hadFile ? readFileSync(TODOS_JSON, 'utf8') : null
  const hadSchedule = existsSync(SCHEDULE_JSON)
  const scheduleBackup = hadSchedule ? readFileSync(SCHEDULE_JSON, 'utf8') : null
  console.log('[准备] todos.json 备份:', hadFile ? `${backup.length} 字节` : '(原本不存在)')
  // 清空今天的日程来源：本次断言只关心待办，日程留空才能算出确定数字
  writeFileSync(SCHEDULE_JSON, JSON.stringify({ items: [] }, null, 2), 'utf8')
  console.log('[准备] schedule.json 已清空（US-033 起该页数字含今天的日程）')

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
      if (backup !== null) writeFileSync(TODOS_JSON, backup, 'utf8')
      else if (existsSync(TODOS_JSON)) unlinkSync(TODOS_JSON)
      if (scheduleBackup !== null) writeFileSync(SCHEDULE_JSON, scheduleBackup, 'utf8')
      console.log('[收尾] todos.json 已恢复，schedule.json 已恢复')
    } catch (e) {
      console.error('[收尾] 恢复失败:', e.message)
    }
  }

  try {
    const wsUrl = await connect()
    console.log('[0] 已连上 CDP')
    await sleep(600)

    // —— 准备数据：清空 → 建 3 条、勾掉 1 条（未完成 2 / 共 3）——
    const seed = await cdp(
      wsUrl,
      `(async () => {
        let l = await window.island.todosList()
        for (const t of l) l = await window.island.todosRemove(t.id)
        await window.island.todosAdd('e2e-收起态甲')
        await window.island.todosAdd('e2e-收起态乙')
        l = await window.island.todosAdd('e2e-收起态丙')
        l = await window.island.todosToggle(l[0].id)
        return JSON.stringify({ total: l.length, undone: l.filter(t => !t.done).length })
      })()`
    )
    const seedObj = JSON.parse(seed)
    assert(seedObj.total === 3 && seedObj.undone === 2, '种子数据不对: ' + seed)
    console.log('[1] 种子数据: 共 3 条，未完成 2 条')

    // —— A1：收起态标记出现，数字 = 未完成数 ——
    await expand(wsUrl)
    await collapse(wsUrl)
    const a1 = JSON.parse(
      await settle(
        wsUrl,
        `JSON.stringify({
          has: !!document.querySelector('.collapsed-todo'),
          num: document.querySelector('.collapsed-todo-num')?.textContent ?? null,
          title: document.querySelector('.collapsed-todo')?.getAttribute('title') ?? null,
          aria: document.querySelector('.collapsed-todo')?.getAttribute('aria-label') ?? null,
          inner: document.querySelector('.collapsed-todo')?.textContent ?? null,
          svgCount: document.querySelectorAll('.collapsed-todo svg').length,
          expanded: !!document.querySelector('.island.expanded')
        })`
      )
    )
    assert(!a1.expanded, 'A1 没收回成收起态: ' + JSON.stringify(a1))
    assert(a1.has, 'A1 收起态没有待办标记')
    assert(a1.num === '2', 'A1 数字应为 2，实际 ' + a1.num)
    assert(a1.svgCount === 0, 'A1 只应显示数字，不应带图标，实际 svg 数 ' + a1.svgCount)
    assert(a1.inner.trim() === '2', 'A1 标记内文字应只有数字，实际 ' + JSON.stringify(a1.inner))
    assert(a1.title === '今天还有 2 件没做完（共 3 件）', 'A1 悬停文案不对: ' + a1.title)
    assert(a1.aria === '今天还有 2 件没做完', 'A1 无障碍文案不对: ' + a1.aria)
    console.log('[2] A1 通过：标记出现、数字 2、文案正确')

    // —— A2：位置在时钟右边、电量环左边，且不挤压时钟 ——
    const a2 = JSON.parse(
      await cdp(
        wsUrl,
        `(() => {
          const kid = document.querySelector('.island').children
          const names = Array.from(kid).map(el => el.className)
          const c = document.querySelector('.collapsed-clock')
          const t = document.querySelector('.collapsed-todo')
          const cr = c.getBoundingClientRect(), tr = t.getBoundingClientRect()
          return JSON.stringify({
            order: names,
            clockText: c.textContent,
            clockRight: Math.round(cr.right), todoLeft: Math.round(tr.left),
            sameRow: Math.abs((cr.top + cr.bottom) / 2 - (tr.top + tr.bottom) / 2) < 6,
            clockWidth: Math.round(cr.width)
          })
        })()`
      )
    )
    assert(a2.order.indexOf('collapsed-clock') < a2.order.indexOf('collapsed-todo'), 'A2 标记不在时钟右边: ' + JSON.stringify(a2.order))
    assert(a2.todoLeft >= a2.clockRight, 'A2 标记与时钟重叠了')
    assert(a2.sameRow, 'A2 标记与时钟不在同一行')
    assert(/^\d{2}:\d{2}$/.test(a2.clockText), 'A2 时钟被挤压/串行了: ' + a2.clockText)
    console.log('[3] A2 通过：DOM 顺序与几何位置正确，时钟完整:', a2.clockText, '宽', a2.clockWidth, 'px')

    // —— A3：全部完成后标记消失（展开态勾完剩下 2 条 → 收回）——
    const finish = await cdp(
      wsUrl,
      `(async () => {
        let l = await window.island.todosList()
        for (const t of l.filter(x => !x.done)) l = await window.island.todosToggle(t.id)
        return JSON.stringify({ total: l.length, undone: l.filter(x => !x.done).length })
      })()`
    )
    assert(JSON.parse(finish).undone === 0, 'A3 勾选没生效: ' + finish)
    await expand(wsUrl)
    await collapse(wsUrl)
    const a3 = JSON.parse(
      await settle(
        wsUrl,
        `JSON.stringify({ has: !!document.querySelector('.collapsed-todo'), expanded: !!document.querySelector('.island.expanded') })`
      )
    )
    assert(!a3.expanded, 'A3 没收回成收起态')
    assert(!a3.has, 'A3 全部完成后标记本该消失')
    console.log('[4] A3 通过：待办全部完成时标记不出现')

    // —— A4：一条待办都没有时也不出现 ——
    await cdp(
      wsUrl,
      `(async () => { let l = await window.island.todosList(); for (const t of l) l = await window.island.todosRemove(t.id); return l.length })()`
    )
    await expand(wsUrl)
    await collapse(wsUrl)
    const a4 = JSON.parse(
      await settle(wsUrl, `JSON.stringify({ has: !!document.querySelector('.collapsed-todo') })`)
    )
    assert(!a4.has, 'A4 没有待办时不该有标记')
    console.log('[5] A4 通过：没有任何待办时标记不出现')

    // —— A5：新增一条后收回，数字刷新为 1（证明「收回即刷新」有效）——
    await cdp(wsUrl, `window.island.todosAdd('e2e-新的一条').then(l => l.length)`)
    await expand(wsUrl)
    await collapse(wsUrl)
    const a5 = JSON.parse(
      await settle(
        wsUrl,
        `JSON.stringify({
          num: document.querySelector('.collapsed-todo-num')?.textContent ?? null,
          title: document.querySelector('.collapsed-todo')?.getAttribute('title') ?? null
        })`
      )
    )
    assert(a5.num === '1', 'A5 收回后数字应为 1，实际 ' + a5.num)
    assert(a5.title === '今天还有 1 件没做完（共 1 件）', 'A5 文案不对: ' + a5.title)
    console.log('[6] A5 通过：收到 1 件未办，收回后数字立即刷新')

    // —— A6：展开态头部完成度仍在（0/1），本次改动没碰它 ——
    await expand(wsUrl)
    const a6 = JSON.parse(
      await settle(
        wsUrl,
        `JSON.stringify({
          expanded: !!document.querySelector('.island.expanded'),
          headCount: document.querySelector('.todo-stat .todo-count')?.textContent ?? null
        })`,
        600
      )
    )
    assert(a6.expanded, 'A6 没展开')
    assert(a6.headCount === '0/1', 'A6 展开态完成度应仍为 0/1，实际 ' + a6.headCount)
    console.log('[7] A6 通过：展开态头部完成度仍为', a6.headCount)

    console.log('E2E COLLAPSED-TODO PASS')
  } finally {
    restore()
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    await sleep(300)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e)
    process.exit(1)
  })
