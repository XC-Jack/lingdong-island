// e2e-beautify-04.mjs —— 界面美化 4 项（SPEC-beautify-04-batch）断言
//
// 覆盖：
//   N1-N4  通知页：未读蓝点按已读水位出现 / 点「已读」后消失 / 组条与会话条有「打开」按钮
//   T1-T6  待办页：头部完成度圆环存在、周长达标、dashoffset 随完成比例变化、.todo-count 文本仍是 n/m、
//          底部进度条 fill 的 scaleX 随比例变化、0% 时宽度为 0
//   C1-C5  日程页：今天实心高亮（与选中日不同）、格内最多 2 条标签、超出显示 +N 且数字正确、
//          标签文本含时间、aria-label 仍是「选择 M 月 D 日」
//
// 前置：data 在 .tmp/e2e-userdata（isolate-userdata 重定向 APPDATA）；
//       通知来自真实系统通知库，若库里没有任何通知，N1-N4 会 skip 并写明原因（不算失败）。
// 用法：node scripts/e2e-beautify-04.mjs
import { spawn, execSync } from './isolate-userdata.mjs'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')
const NOTIF_READ = join(USER_DATA, 'notif-read.json')
const TODOS_JSON = join(USER_DATA, 'todos.json')
const SCHEDULE_JSON = join(USER_DATA, 'schedule.json')

const DEFAULT_ORDER = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
let skip = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}
function skipped(name, why) {
  skip++
  console.log(`  ~ ${name}（跳过：${why}）`)
}

// ---------- 时间与种子 ----------
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const day0 = new Date()
const todayKey = localDay(day0)
const m = day0.getMonth() + 1
const d = day0.getDate()

// ---------- 备份 ----------
const backups = new Map()
for (const f of [PREFS, NOTIF_READ, TODOS_JSON, SCHEDULE_JSON]) {
  backups.set(f, existsSync(f) ? readFileSync(f, 'utf8') : null)
}

function writePrefs() {
  writeFileSync(
    PREFS,
    JSON.stringify(
      {
        musicIntro: true,
        pagesCustom: {
          pages: [0, 1, 2, 3, 4],
          collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
          order: [...DEFAULT_ORDER]
        }
      },
      null,
      2
    ),
    'utf8'
  )
}

// 今天 3 条日程（其中 2 条带时间）+ 1 条待办：完成度 0/4，日历格内应 2 标签 + 「+1 更多」
writeFileSync(
  SCHEDULE_JSON,
  JSON.stringify(
    {
      items: [
        { id: 'b4-s1', text: 'b4-九点的会', day: todayKey, time: '09:00', done: false, reminded: true, createdAt: 1 },
        { id: 'b4-s2', text: 'b4-下午评审', day: todayKey, time: '14:30', done: false, reminded: true, createdAt: 2 },
        { id: 'b4-s3', text: 'b4-晚上复盘', day: todayKey, time: null, done: false, reminded: true, createdAt: 3 }
      ]
    },
    null,
    2
  ),
  'utf8'
)
writeFileSync(
  TODOS_JSON,
  JSON.stringify({ todos: [{ id: 'b4-t1', text: 'b4-待办一条', done: false, createdAt: 4 }] }, null, 2),
  'utf8'
)

// ---------- CDP ----------
async function targets() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return r.json()
}
const IS_SETTINGS = (t) => (t.url ?? '').includes('settings.html')

async function evalOnTarget(expr, wantSettings = false) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets()
      const page = list.find((t) => t.type === 'page' && IS_SETTINGS(t) === wantSettings)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.onopen = res
          ws.onerror = rej
        })
        const r = await new Promise((res) => {
          ws.onmessage = (e) => res(JSON.parse(e.data))
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: expr, awaitPromise: true, returnByValue: true }
            })
          )
        })
        ws.close()
        if (r.result?.exceptionDetails) {
          throw new Error('页面异常: ' + (r.result.exceptionDetails.exception?.description ?? ''))
        }
        return r.result?.result?.value
      }
    } catch (e) {
      if (String(e.message).startsWith('页面异常')) throw e
    }
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}
const islandEval = (e) => evalOnTarget(e, false)

/** 等岛挂载 + 展开（重启后第一帧可能还没渲染 .island） */
async function ensureExpanded(maxMs = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const cls = await islandEval(`document.querySelector('.island')?.className ?? ''`)
    if (cls.includes('expanded')) return true
    if (cls.includes('collapsed')) {
      await islandEval(`(() => { const el = document.querySelector('.island'); if (el) el.click(); return 'ok' })()`)
      await sleep(700)
    } else {
      await sleep(400)
    }
  }
  return false
}

async function gotoPage(idx) {
  await islandEval(`(() => { const d = document.querySelectorAll('.dots .dot')[${idx}]; if (!d) return 'NO'; d.click(); return 'ok' })()`)
  await sleep(700)
}

/** 在设置窗口里打开页面管理（不需要，本脚本直接写 prefs） */

function killApp() {
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 没有在跑 */
  }
}
async function startApp() {
  killApp()
  await sleep(600)
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  // 轮询 CDP 就绪（迁移 + 首帧渲染都要时间，固定 sleep 不可靠）
  const t0 = Date.now()
  while (Date.now() - t0 < 25000) {
    try {
      const list = await targets()
      if (list.some((t) => t.type === 'page')) break
    } catch {
      /* 还没起 */
    }
    await sleep(250)
  }
  await sleep(900)
}

const main = async () => {
  writePrefs()
  // 已读水位清零 → 库里所有通知都算未读，用来验蓝点
  writeFileSync(NOTIF_READ, JSON.stringify({ lastOrder: 0, hiddenUntil: 0 }, null, 2), 'utf8')

  try {
    await startApp()
    await ensureExpanded()
    console.log('[0] 岛已展开')

    // ================= 通知页（美化-04 第 1 项）=================
    await gotoPage(2)
    const title2 = await islandEval(`document.querySelector('.panel-title')?.textContent ?? ''`)
    ok('N0 已进入通知页', title2 === '通知', `title=${title2}`)

    const nstat = await islandEval(`(() => {
      const groups = [...document.querySelectorAll('.notify-list > .notify-group')]
      return JSON.stringify({
        groups: groups.length,
        unread: document.querySelectorAll('.notify-unread').length,
        opens: document.querySelectorAll('.notify-open').length,
        empty: !!document.querySelector('.notify-empty')
      })
    })()`)
    const ns = JSON.parse(nstat)
    if (ns.groups === 0) {
      skipped('N1 未读蓝点数量 = 未读条数', '系统通知库当前为空')
      skipped('N2 点「已读」后蓝点清零', '系统通知库当前为空')
      skipped('N3 组条与会话条有「打开」按钮', '系统通知库当前为空')
    } else {
      ok('N1 未读蓝点数量 = 未读组数（水位 0 时全部未读）', ns.unread === ns.groups, `unread=${ns.unread} groups=${ns.groups}`)
      ok('N3 每个组条一个「打开」按钮', ns.opens >= ns.groups, `opens=${ns.opens} groups=${ns.groups}`)

      await islandEval(`(() => { const b = document.querySelector('.shelf-toolbar [aria-label="全部标为已读"]'); if (b) b.click(); return 'ok' })()`)
      await sleep(1200)
      const after = await islandEval(`document.querySelectorAll('.notify-unread').length`)
      ok('N2 点「已读」后蓝点清零', after === 0, `unread=${after}`)
    }

    // ================= 待办页（第 2 项圆环 + 第 4 项进度条）=================
    await gotoPage(0)
    const title0 = await islandEval(`document.querySelector('.panel-title')?.textContent ?? ''`)
    ok('T0 已进入待办页', title0 === '待办', `title=${title0}`)

    const t0stat = await islandEval(`(() => {
      const ring = document.querySelector('.todo-stat .todo-ring')
      const fg = document.querySelector('.todo-stat .todo-ring-fg')
      const count = document.querySelector('.todo-stat .todo-count')?.textContent ?? ''
      const fill = document.querySelector('.todo-progress-fill')
      const cs = fill ? getComputedStyle(fill) : null
      const bar = document.querySelector('.todo-progress-bar')
      return JSON.stringify({
        hasRing: !!ring,
        hasBg: !!document.querySelector('.todo-stat .todo-ring-bg'),
        dasharray: fg ? Number(fg.getAttribute('stroke-dasharray')) : -1,
        dashoffset0: fg ? Number(fg.getAttribute('stroke-dashoffset')) : -1,
        count,
        hasBar: !!bar,
        barW: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
        fillTransform: cs ? cs.transform : '',
        fillW: fill ? Math.round(fill.getBoundingClientRect().width) : -1,
        barRadius: bar ? getComputedStyle(bar).borderRadius : ''
      })
    })()`)
    const t0v = JSON.parse(t0stat)
    ok('T1 头部有完成度圆环（底环 + 前景环）', t0v.hasRing && t0v.hasBg)
    ok('T2 圆环周长 ≈ 2πr（r=9，约 56.5）', Math.abs(t0v.dasharray - 56.55) < 0.5, `dasharray=${t0v.dasharray}`)
    ok('T3 完成度 0 时圆环完全未填充', Math.abs(t0v.dashoffset0 - t0v.dasharray) < 0.5, `offset=${t0v.dashoffset0}`)
    ok('T4 .todo-count 文本仍是 n/m（0/4）', t0v.count === '0/4', `count=${t0v.count}`)
    ok('T5 列表下方有进度条（圆角轨道 + 可见宽度）', t0v.hasBar && t0v.barW > 60 && t0v.barRadius !== '0px', `barW=${t0v.barW}`)
    ok('T6 完成度 0 时进度条填充宽度为 0（scaleX(0)）', /matrix\(0,\s*0,\s*0,\s*1,\s*0,\s*0\)/.test(t0v.fillTransform), `transform=${t0v.fillTransform}`)

    // 勾一条日程 → 完成度 1/4 → 两个指标都要动
    await islandEval(`(() => {
      const li = Array.from(document.querySelectorAll('.todo-panel .todo-item')).find((x) => (x.querySelector('.todo-text')?.textContent ?? '').includes('b4-九点的会'))
      if (!li) return 'no-item'
      li.querySelector('.todo-check').click()
      return 'ok'
    })()`)
    await sleep(1200)
    const t1stat = await islandEval(`(() => {
      const fg = document.querySelector('.todo-stat .todo-ring-fg')
      const count = document.querySelector('.todo-stat .todo-count')?.textContent ?? ''
      const fill = document.querySelector('.todo-progress-fill')
      const m = fill ? getComputedStyle(fill).transform.match(/matrix\\(([^,]+),/) : null
      return JSON.stringify({
        dashoffset: fg ? Number(fg.getAttribute('stroke-dashoffset')) : -1,
        dasharray: fg ? Number(fg.getAttribute('stroke-dasharray')) : -1,
        count,
        scaleX: m ? Number(m[1]) : -1,
        pctText: document.querySelector('.todo-progress-text b')?.textContent ?? ''
      })
    })()`)
    const t1v = JSON.parse(t1stat)
    ok('T7 勾一条后计数变成 1/4', t1v.count === '1/4', `count=${t1v.count}`)
    ok(
      'T8 圆环填到 1/4（dashoffset ≈ 周长 × 0.75）',
      Math.abs(t1v.dashoffset - t1v.dasharray * 0.75) < 1,
      `offset=${t1v.dashoffset.toFixed(2)} expect≈${(t1v.dasharray * 0.75).toFixed(2)}`
    )
    ok('T9 进度条填到 25%（scaleX≈0.25）', Math.abs(t1v.scaleX - 0.25) < 0.02, `scaleX=${t1v.scaleX}`)
    ok('T10 进度条右侧百分比文本 25%', t1v.pctText === '25%', `pct=${t1v.pctText}`)

    // ================= 日程页（第 3 项日历）=================
    await gotoPage(3)
    const title3 = await islandEval(`document.querySelector('.panel-title')?.textContent ?? ''`)
    ok('C0 已进入日程页', title3 === '日程', `title=${title3}`)

    const cstat = await islandEval(`(() => {
      const label = '选择 ${m} 月 ${d} 日'
      const cells = [...document.querySelectorAll('.cal-day')]
      const cell = cells.find((b) => b.getAttribute('aria-label') === label)
      if (!cell) return JSON.stringify({ found: false })
      const cs = getComputedStyle(cell)
      const tags = [...cell.querySelectorAll('.cal-tag')]
      const more = cell.querySelector('.cal-more')
      const num = cell.querySelector('.cal-num')
      // 找一个「选中但非今天」的格子作对比
      const sel = cells.find((b) => b.classList.contains('selected') && !b.classList.contains('today'))
      return JSON.stringify({
        found: true,
        today: cell.classList.contains('today'),
        selected: cell.classList.contains('selected'),
        bg: cs.backgroundColor,
        tagCount: tags.length,
        tagTexts: tags.map((t) => t.textContent.trim()),
        hasBoldTime: tags.some((t) => !!t.querySelector('b')),
        more: more ? more.textContent.trim() : null,
        numText: num ? num.textContent.trim() : null,
        firstText: cell.textContent.trim().slice(0, 3),
        ariaOk: cell.getAttribute('aria-label') === label
      })
    })()`)
    const cv = JSON.parse(cstat)
    ok('C1 今天的格子能找到且带 .today', cv.found && cv.today === true, `found=${cv.found}`)
    ok('C2 今天实心高亮（背景不透明度 ≥ 0.8，不再是 0.22 淡蓝）', (() => {
      if (!cv.found) return false
      const mm = cv.bg.match(/rgba?\(([^)]+)\)/)
      if (!mm) return false
      const parts = mm[1].split(',').map((s) => Number(s.trim()))
      const a = parts.length > 3 ? parts[3] : 1
      return a >= 0.8
    })(), `bg=${cv.bg}`)
    ok('C3 格内最多 2 条标签（3 条日程 → 2 个标签）', cv.tagCount === 2, `tags=${cv.tagCount}`)
    ok('C4 超出的折成「+1」', cv.more === '+1', `more=${cv.more}`)
    ok('C5 标签里带时间（09:00 / 14:30 有 <b>）', cv.hasBoldTime === true, JSON.stringify(cv.tagTexts))
    ok('C6 日期数字仍在该格文本最前面（e2e 靠 startsWith 找格子）', cv.numText === String(d), `num=${cv.numText} first=${cv.firstText}`)
    ok('C7 aria-label 保持「选择 M 月 D 日」', cv.ariaOk === true)

    console.log(`\nE2E BEAUTIFY-04: ${fail === 0 ? 'PASS' : 'FAIL'}（${pass} 过 / ${fail} 败 / ${skip} 跳过）`)
  } finally {
    killApp()
    for (const [f, content] of backups) {
      try {
        if (content !== null) writeFileSync(f, content, 'utf8')
        else if (existsSync(f)) unlinkSync(f)
      } catch {
        /* 恢复失败不掩盖主结论 */
      }
    }
    console.log('[收尾] 数据已恢复、应用已关闭')
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  killApp()
  process.exit(1)
})
