// e2e-schedule-crossmonth.mjs —— 补验证：跨月翻页的日历蓝点 + 跨月选日期（状态页未验证项）
// 流程：备份用户 schedule.json → 注入上月/下月/本月日程 → 启动 dev → 展开切日程页
// → 断言本月蓝点 → 翻下月断言蓝点+选日期显示对应日程 → 翻上月同理 → 还原数据。
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/Users/honor/Documents/Project/灵动岛'
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const SCHED = join(USER_DATA, 'schedule.json')
const BAK = ROOT + '/.tmp-e2e-schedule-backup.json'
const PORT = 9321

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

// ---- 数据备份与注入 ----
let hadSched = existsSync(SCHED)
let schedBak = hadSched ? readFileSync(SCHED, 'utf8') : null
if (hadSched) copyFileSync(SCHED, BAK)

const now = new Date()
const y = now.getFullYear(), m = now.getMonth() // 0-based
const mk = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
const prevMonth = mk(y, m - 1, 15)
const nextMonth = mk(y, m + 1, 10)
const today = mk(y, m, now.getDate())
const inject = {
  items: [
    { id: 'x-prevm-1', text: '上月跨月日程', day: prevMonth, time: '09:00', done: false, reminded: false, createdAt: Date.now() },
    { id: 'x-nextm-1', text: '下月跨月日程', day: nextMonth, time: '14:30', done: false, reminded: false, createdAt: Date.now() },
    { id: 'x-thism-1', text: '本月基线日程', day: today, time: '12:00', done: false, reminded: false, createdAt: Date.now() },
  ],
}
writeFileSync(SCHED, JSON.stringify(inject), 'utf8')

// ---- 启动 dev（CDP）----
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // DSH 宿主注入会把 electron 跑成纯 Node，秒退
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

  // 收起态先点 .island 展开
  await cdpEval(`(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1)`)
  await new Promise((r) => setTimeout(r, 800))

  // 直接点日程页 dot[3]（默认页序：待办/置物架/通知/日程），不要点「当前 active」——那等于没切
  await cdpEval(`(() => { const d = document.querySelectorAll('.dot')[3]; if (!d) return 'NO DOT'; d.dispatchEvent(new MouseEvent('click', {bubbles:true})); return 'ok' })()`)
  await new Promise((r) => setTimeout(r, 1500)) // 等日程页拉取 scheduleRefresh 完成

  const prevCount = await cdpEval(`document.querySelectorAll('.cal-mark').length`)

  // ---- 本月：应有 ≥1 蓝点（本月基线日程）----
  ok('B1 本月有蓝点(本月基线日程)', prevCount >= 1, `count=${prevCount}`)

  // ---- 翻下月：标题变化 + 下月 10 日蓝点 + 点选显示下月日程 ----
  await cdpEval(`document.querySelector('.cal-nav[title="下个月"]').click()`)
  await new Promise((r) => setTimeout(r, 500))
  const nextTitle = await cdpEval(`document.querySelector('.cal-title')?.textContent ?? 'MISSING'`)
  const nextDay10Mark = await cdpEval(`(Array.from(document.querySelectorAll('.cal-day')).find(b => b.textContent.trim().startsWith('10'))?.querySelector('.cal-mark') ?? null) !== null`)
  ok('B2 下月标题正确', nextTitle === `${m + 2 > 12 ? y + 1 : y}年${((m + 1) % 12) + 1}月`, nextTitle)
  ok('B3 下月10日有蓝点', nextDay10Mark === true)

  // 跨年边界：11 月点「下个月」应到 12 月，再点应到次年 1 月（12→1 是跨月特殊路径）
  if (m === 10) {
    await cdpEval(`document.querySelector('.cal-nav[title="上个月"]').click()`) // 先回到本月(11月)
    await new Promise((r) => setTimeout(r, 300))
    await cdpEval(`document.querySelector('.cal-nav[title="下个月"]').click()`)
    await new Promise((r) => setTimeout(r, 300))
    const decTitle = await cdpEval(`document.querySelector('.cal-title')?.textContent ?? 'MISSING'`)
    await cdpEval(`document.querySelector('.cal-nav[title="下个月"]').click()`)
    await new Promise((r) => setTimeout(r, 300))
    const janTitle = await cdpEval(`document.querySelector('.cal-title')?.textContent ?? 'MISSING'`)
    ok('B4 跨年翻月(11→12→次年1)', decTitle.includes('12月') && janTitle.includes('1月') && janTitle.includes(String(y + 1)), `${decTitle} → ${janTitle}`)
    // 回到下月（12 月）继续 B5
    await cdpEval(`document.querySelector('.cal-nav[title="上个月"]').click()`)
    await new Promise((r) => setTimeout(r, 300))
  }

  // 点选下月 10 日 → 右栏显示「下月跨月日程」
  await cdpEval(`Array.from(document.querySelectorAll('.cal-day')).find(b => b.textContent.trim().startsWith('10')).click()`)
  await new Promise((r) => setTimeout(r, 500))
  // 日期已并进月历标题（SPEC-calendar-date-in-title），右栏不再有 .sched-day-title
  const dayTitle = await cdpEval(`document.querySelector('.cal-title')?.textContent ?? 'MISSING'`)
  const hasNext = await cdpEval(`Array.from(document.querySelectorAll('.sched-list .todo-item')).some(el => el.textContent.includes('下月跨月日程'))`)
  ok(
    'B5 选中下月10日：月历标题带「10日」且右栏显示该日程',
    hasNext === true && dayTitle.includes('10日'),
    `dayTitle=${dayTitle}`
  )

  // ---- 翻上月：上月 15 日蓝点 + 选日期显示上月日程 ----
  await cdpEval(`document.querySelector('.cal-nav[title="上个月"]').click()`)
  await cdpEval(`document.querySelector('.cal-nav[title="上个月"]').click()`)
  await new Promise((r) => setTimeout(r, 400))
  const prevTitle = await cdpEval(`document.querySelector('.cal-title')?.textContent ?? 'MISSING'`)
  const prevDay15Mark = await cdpEval(`(Array.from(document.querySelectorAll('.cal-day')).find(b => b.textContent.trim().startsWith('15'))?.querySelector('.cal-mark') ?? null) !== null`)
  ok('B6 上月标题正确', prevTitle.includes(String(m === 0 ? 12 : m)), prevTitle)
  ok('B7 上月15日有蓝点', prevDay15Mark === true)
  await cdpEval(`Array.from(document.querySelectorAll('.cal-day')).find(b => b.textContent.trim().startsWith('15')).click()`)
  await new Promise((r) => setTimeout(r, 500))
  const hasPrev = await cdpEval(`Array.from(document.querySelectorAll('.sched-list .todo-item')).some(el => el.textContent.includes('上月跨月日程'))`)
  ok('B8 选中上月15日右栏显示该日程', hasPrev === true)
} catch (e) {
  fail++
  console.log('  ✗ 异常:', e.message)
} finally {
  child.kill()
  // 还原数据
  if (hadSched) copyFileSync(BAK, SCHED)
  else if (existsSync(SCHED)) { execSync(`del /q "${SCHED}"`, { shell: 'cmd.exe' }) }
  try { execSync(`del /q "${BAK}"`, { shell: 'cmd.exe' }) } catch {}
  console.log(`\n结果: ${pass} 过 / ${fail} 败`)
  process.exit(fail > 0 ? 1 : 0)
}
