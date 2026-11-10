#!/usr/bin/env node
/**
 * e2e：点收起态铃铛 → 展开岛并直接跳到通知页（SPEC-bell-opens-notify-page）
 *
 * N3 点铃铛后：岛展开、当前页 = 通知（page 2）、标题「通知」、页点第 3 个 active
 * N3b 铃铛 title / aria-label 带「点击查看」语义，且 role=button、可聚焦
 * N3c 展开态头部也有铃铛（同一份 renderStatusItem，行为一致）
 * N4 **反证**：不点铃铛、只点胶囊空白处 → 展开后仍在第一页（待办），
 *    证明 N3 不是「展开后本来就到通知页」
 * N5 铃铛点击不会被岛根 onClick 吃掉（不会刚展开又被收起）
 *
 * 前提取舍：铃铛只在「有未读通知」时渲染，而未读来自真实 Windows 通知库
 * （%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db，只读，e2e 无法伪造）。
 * 本机通知库为空时 N3/N3b/N3c 无从断言 —— 脚本会打印「⚠ 跳过」并计入 skipped，
 * **不会**把它算成通过。
 *
 * 跑前请确认：无遗留 dev electron 占用 9321；本文件已 import isolate-userdata.mjs，
 * 真实 %APPDATA%\lingdong-island\ 不会被碰。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9321
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')

const DEFAULT_ORDER = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

let passed = 0
let failed = 0
let skipped = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`)
  }
}
const skip = (name, why) => {
  skipped++
  console.log(`  ⚠ 跳过 ${name}${why ? ' —— ' + why : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpEval(expr) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (!page) throw new Error('no page target')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('cdp timeout')), 15000)
        ws.onopen = () =>
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: expr, returnByValue: true, awaitPromise: true }
            })
          )
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id === 1) {
            clearTimeout(timer)
            ws.close()
            res(m.result)
          }
        }
        ws.onerror = rej
      })
      if (r?.exceptionDetails)
        throw new Error('eval 异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r?.result?.value
    } catch (e) {
      if (i === 39) throw e
    }
    await sleep(500)
  }
}

function killApp() {
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 无进程 */
  }
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 宿主注入会把 electron 跑成纯 Node，秒退
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  await sleep(3500)
  return child
}

/** 读当前页面状态：展开与否、标题、页点 active 序号、面板正文首个子元素 */
const READ_STATE = `(() => {
  const island = document.querySelector('.island')
  const dots = Array.from(document.querySelectorAll('.dots .dot'))
  const activeIdx = dots.findIndex((d) => d.classList.contains('active'))
  return {
    expanded: !!document.querySelector('.island.expanded'),
    collapsed: !!document.querySelector('.island.collapsed'),
    title: document.querySelector('.panel-title')?.textContent ?? null,
    activeIdx,
    headBell: document.querySelectorAll('.head-info .collapsed-bell').length,
    panelLabel: document.querySelector('.island')?.getAttribute('aria-label') ?? null
  }
})()`

/** 用原生 click() 点元素（bubbles=true → React 事件委托能收到，等价真实点击） */
const clickSel = (sel) => `(() => { const el = document.querySelector('${sel}'); if (!el) return 'no-el'; el.click(); return 'ok' })()`

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null

try {
  mkdirSync(USER_DATA, { recursive: true })
  // 收起态组件全开 + 默认顺序（只动隔离目录里的 prefs.json，不碰真实数据）
  writeFileSync(
    PREFS,
    JSON.stringify(
      {
        pagesCustom: {
          pages: [0, 1, 2, 3],
          collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
          order: DEFAULT_ORDER
        }
      },
      null,
      2
    ),
    'utf8'
  )

  killApp()
  await sleep(1200)
  child = await startApp()

  // ---------- 收起态 ----------
  const s0 = await cdpEval(READ_STATE)
  ok('N0 启动后是收起态', s0?.collapsed === true && s0?.expanded === false, JSON.stringify(s0))

  const bellHtml = await cdpEval(`document.querySelector('.collapsed-bell')?.outerHTML ?? null`)
  const hasBell = typeof bellHtml === 'string' && bellHtml.includes('collapsed-bell')
  ok('N0b 收起态有未读 → 铃铛存在', hasBell, '无铃铛则后续点击类断言无法执行')

  if (!hasBell) {
    skip('N3 点铃铛直达通知页', '本机通知库无未读，铃铛不渲染（未读来自只读的 wpndatabase，e2e 无法伪造）')
    skip('N3b 铃铛可点语义', '同上')
    skip('N5 点击不会被岛根收起', '同上')
  } else {
    // ---------- N4 反证：先点空白处，必须落在第一页 ----------
    await cdpEval(clickSel('.collapsed-clock'))
    await sleep(1200)
    const sBlank = await cdpEval(READ_STATE)
    ok(
      'N4 只点胶囊空白处 → 展开并在第一页（待办），不是通知页',
      sBlank?.expanded === true && sBlank?.title === '待办' && sBlank?.activeIdx === 0,
      JSON.stringify(sBlank)
    )

    // 收回去
    await cdpEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(1200)
    const sBack = await cdpEval(READ_STATE)
    ok('N4b Esc 收回收起态', sBack?.collapsed === true, JSON.stringify(sBack))

    // ---------- N3 / N3b / N5：点铃铛 ----------
    const bellMeta = await cdpEval(`(() => {
      const el = document.querySelector('.collapsed-bell')
      if (!el) return null
      return { role: el.getAttribute('role'), tab: el.getAttribute('tabindex'), title: el.getAttribute('title'), aria: el.getAttribute('aria-label') }
    })()`)
    ok('N3b-1 铃铛 role=button 且可聚焦', bellMeta?.role === 'button' && bellMeta?.tab === '0', JSON.stringify(bellMeta))
    ok(
      'N3b-2 铃铛 title 与 aria-label 带「点击查看」',
      String(bellMeta?.title ?? '').includes('点击查看') && String(bellMeta?.aria ?? '').includes('点击查看'),
      JSON.stringify(bellMeta)
    )

    const clicked = await cdpEval(clickSel('.collapsed-bell'))
    ok('N3a 点到了铃铛元素', clicked === 'ok', String(clicked))
    await sleep(1400)

    const s1 = await cdpEval(READ_STATE)
    ok('N3 点铃铛 → 岛展开', s1?.expanded === true, JSON.stringify(s1))
    ok('N3c 展开后标题是「通知」', s1?.title === '通知', JSON.stringify(s1))
    ok('N3d 页点第 3 个（index 2）active', s1?.activeIdx === 2, JSON.stringify(s1))
    ok('N5 没有被岛根 onClick 立刻收回去（仍是展开态）', s1?.expanded === true, JSON.stringify(s1))
    ok('N3e 展开态头部也有铃铛（共用一份实现）', s1?.headBell === 1, JSON.stringify(s1))

    // ---------- 已在通知页时再点头部铃铛：无副作用 ----------
    await cdpEval(clickSel('.head-info .collapsed-bell'))
    await sleep(800)
    const s2 = await cdpEval(READ_STATE)
    ok('N3f 已在通知页时再点头部铃铛，仍停在通知页且保持展开', s2?.expanded === true && s2?.activeIdx === 2, JSON.stringify(s2))

    // ---------- 收起后（非首次展开）再点铃铛也要直达 ----------
    await cdpEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(1200)
    const s3 = await cdpEval(READ_STATE)
    ok('N3g Esc 回到收起态', s3?.collapsed === true, JSON.stringify(s3))
    const click2 = await cdpEval(clickSel('.collapsed-bell'))
    await sleep(1400)
    const s4 = await cdpEval(READ_STATE)
    ok('N3h 从第一页展开过之后，再点铃铛仍直达通知页', click2 === 'ok' && s4?.activeIdx === 2 && s4?.title === '通知', JSON.stringify(s4))
  }
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.message ?? e))
} finally {
  killApp()
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
  else if (existsSync(PREFS)) {
    try {
      execSync(`del /q "${PREFS}"`, { stdio: 'ignore' })
    } catch {
      /* keep */
    }
  }
}

console.log(`== 结果：${passed} 过 / ${failed} 败 / ${skipped} 跳过 ==`)
process.exit(failed > 0 ? 1 : 0)
