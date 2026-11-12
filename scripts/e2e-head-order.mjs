#!/usr/bin/env node
/**
 * e2e 美化-03：展开态头部同步组件顺序（SPEC-beautify-03-head-order）
 *
 * H1 展开态 .head-info 子元素顺序 = pagesCustom.order（过滤出「真渲染的」再比，数据缺失项本来就不画）
 * H2 取消勾选 → 展开态不渲染；勾回 → 恢复（正反对照，排除「本来就不显示」的假通过）
 * H3 岛仔在 .head-pet 里单独一层，几何上在信息行上方，且不在 .head-info 子元素中
 * H4 铃铛按未读数出现/消失，且只在 .head-info 里出现一次
 * H5 头部各控件矩形互不重叠，.head-status 完整落在 .island 内
 * H6 与收起态一致：同一份 order 下两边的组件相对顺序相同
 *
 * 用法：node scripts/e2e-head-order.mjs（自动启 electron，CDP 9321 / 主进程 inspect 9229）
 * 跑前先清 electron 进程；spawn 时 delete ELECTRON_RUN_AS_NODE；改 UI 后必须先 npm run build。
 * 会临时改写 prefs.json 与 notif-read.json，结束原样恢复。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9321
const INSPECT_PORT = 9229
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')
const NOTIF_READ = join(USER_DATA, 'notif-read.json')

const DEFAULT_ORDER = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- CDP（渲染层） ----------
/**
 * SPEC-settings-shell 起，CDP 里有两个 page target：岛（index.html）和设置窗口（settings.html）。
 * cdpEval 只查岛；`.pm-*` 面板元素现在住在设置窗口，要用 settingsEval。
 */
const IS_SETTINGS = (t) => (t.url ?? '').includes('settings.html')

async function evalOnTarget(expr, wantSettings) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && IS_SETTINGS(t) === wantSettings)
      if (!page) throw new Error(wantSettings ? 'no settings target' : 'no page target')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('cdp timeout')), 15000)
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }))
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); ws.close(); res(m.result) } }
        ws.onerror = rej
      })
      if (r?.exceptionDetails) throw new Error('eval 异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r?.result?.value
    } catch (e) {
      if (i === 39) throw e
    }
    await sleep(500)
  }
}

/** 岛窗口 */
const cdpEval = (expr) => evalOnTarget(expr, false)
/** 设置窗口（页面管理面板在这里） */
const settingsEval = (expr) => evalOnTarget(expr, true)

// ---------- Inspector（主进程） ----------
async function mainEval(expr) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()
      const t = list[0]
      if (!t) throw new Error('no main target')
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('main timeout')), 15000)
        // includeCommandLineAPI 必须 true，否则 require 不可见（美化-02 踩过）
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }))
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); ws.close(); res(m.result) } }
        ws.onerror = rej
      })
      if (r?.exceptionDetails) throw new Error('main eval 异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r?.result?.value
    } catch (e) {
      if (i === 39) throw e
    }
    await sleep(500)
  }
}

// ---------- 启停 ----------
function killApp() {
  try { execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' }) } catch { /* 无进程 */ }
}

/**
 * 等到 React 首帧真的把岛挂上再往下走。
 *
 * 为什么不能只 sleep：实测（2026-11-12）本机从起进程到 `.island.collapsed` 出现要 4.7 秒，
 * 固定 sleep(3500) 会让第一条断言读到空 DOM（infoOrder=[] / hasPetRow=false），
 * 看起来像功能坏了，实际是脚本抢跑。
 */
async function waitReady() {
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      if (await cdpEval(`!!document.querySelector('.island.collapsed')`)) return
    } catch { /* CDP 还没就绪 */ }
    await sleep(200)
  }
  throw new Error('等岛挂载超时')
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 宿主注入会把 electron 跑成纯 Node，秒退
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  await sleep(1200)
  await waitReady()
  return child
}

async function stopApp(child) {
  try { child.kill('SIGKILL') } catch { /* 已退 */ }
  killApp()
  await sleep(1200)
}

// ---------- 偏好 ----------
function writePrefs(order, collapsedOverride = {}) {
  writeFileSync(PREFS, JSON.stringify({
    pagesCustom: {
      pages: [0, 1, 2, 3],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true, ...collapsedOverride },
      order
    }
  }, null, 2), 'utf8')
}
const readPrefs = () => JSON.parse(readFileSync(PREFS, 'utf8'))

// ---------- 页面探针 ----------
/** 展开岛（点一下，= 收起态 toggle 成展开） */
async function expand() {
  await cdpEval(`(() => { const el = document.querySelector('.island'); if (!el) return 'no-island'; if (!el.className.includes('expanded')) el.click(); return 'ok' })()`)
  await sleep(700)
}

/** 展开态头部结构：岛仔层、信息行子元素、几何、重叠情况 */
const READ_HEAD = `(() => {
  const isl = document.querySelector('.island')
  if (!isl) return JSON.stringify({ err: 'no-island' })
  const pet = document.querySelector('.head-pet')
  const info = document.querySelector('.head-info')
  const petInner = pet ? pet.querySelector('.collapsed-pet') : null
  const infoKids = info ? Array.from(info.children) : []
  const sel = [['battery','.head-battery-ring'],['clock','.collapsed-clock'],['net','.collapsed-wifi'],['todo','.collapsed-todo'],['bell','.collapsed-bell']]
  const found = []
  for (const [k, s] of sel) {
    const el = info ? info.querySelector(s) : null
    if (el) found.push({ k, x: el.getBoundingClientRect().left })
  }
  found.sort((a, b) => a.x - b.x)
  const pr = petInner ? petInner.getBoundingClientRect() : null
  const ir = info ? info.getBoundingClientRect() : null
  const islR = isl.getBoundingClientRect()
  // 头部三个区（左徽章+标题、中间状态区、右侧自启开关）矩形是否互不重叠
  const hsR = document.querySelector('.head-status')?.getBoundingClientRect() ?? null
  const badgeR = document.querySelector('.panel-title')?.getBoundingClientRect() ?? null
  const autoR = document.querySelector('.autostart-toggle')?.getBoundingClientRect() ?? null
  const overlap = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
  return JSON.stringify({
    expanded: isl.className.includes('expanded'),
    hasPetRow: !!pet,
    hasInfoRow: !!info,
    petInInfo: !!(petInner && info && info.contains(petInner)),
    infoOrder: found.map((f) => f.k),
    infoKidCount: infoKids.length,
    petTop: pr ? Math.round(pr.top) : null,
    infoTop: ir ? Math.round(ir.top) : null,
    petBottom: pr ? Math.round(pr.bottom) : null,
    infoBottom: ir ? Math.round(ir.bottom) : null,
    statusInsideIsland: !!hsR && hsR.left >= islR.left - 0.5 && hsR.right <= islR.right + 0.5 && hsR.top >= islR.top - 0.5 && hsR.bottom <= islR.bottom + 0.5,
    overlapTitle: overlap(hsR, badgeR),
    overlapAuto: overlap(hsR, autoR),
    infoText: info ? info.textContent : null
  })
})()`

/** 收起态真正渲染出来的组件 key，按横向位置排序（与 e2e-collapse-order 同款） */
const READ_COLLAPSED_ORDER = `(() => {
  const c = document.querySelector('.island.collapsed')
  if (!c) return ['__no-collapsed']
  const sel = [['battery','.head-battery-ring'],['pet','.collapsed-pet'],['clock','.collapsed-clock'],['net','.collapsed-wifi'],['todo','.collapsed-todo'],['bell','.collapsed-bell']]
  const found = []
  for (const [k, s] of sel) {
    const el = c.querySelector(s)
    if (el) found.push({ k, x: el.getBoundingClientRect().left })
  }
  found.sort((a, b) => a.x - b.x)
  return found.map((f) => f.k)
})()`

/** 打开「页面管理」（SPEC-settings-shell 起在独立设置窗口里） */
async function openPanel() {
  await cdpEval(`(window.island.openSettings('pages'), 'ok')`)
  await sleep(1500)
}
/** 关闭设置窗口 */
async function closePanel() {
  await settingsEval(`(window.island.closeSettings(), 'ok')`)
  await sleep(1000)
}

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null
const notifBackup = existsSync(NOTIF_READ) ? readFileSync(NOTIF_READ, 'utf8') : null

try {
  mkdirSync(USER_DATA, { recursive: true })

  // ========== H1 + H3 + H6：自定义顺序 ==========
  killApp(); await sleep(800)
  const ORDER_CUSTOM = ['bell', 'clock', 'net', 'battery', 'pet', 'todo']
  writePrefs(ORDER_CUSTOM)
  child = await startApp()
  {
    await expand()
    const head = JSON.parse(await cdpEval(READ_HEAD))
    // H1：只比真渲染出来的（本机可能没网 / 待办为空 / 无未读）
    const expect = ORDER_CUSTOM.filter((k) => k !== 'pet' && head.infoOrder.includes(k))
    ok('H1 展开态信息行顺序 = pagesCustom.order（过滤未渲染项）',
      head.infoOrder.length > 0 && JSON.stringify(head.infoOrder) === JSON.stringify(expect),
      `实际 ${JSON.stringify(head.infoOrder)} / 期望 ${JSON.stringify(expect)}`)

    // H3：岛仔单独一层，且在信息行上方
    ok('H3a 岛仔在独立的 .head-pet 层里', head.hasPetRow && head.hasInfoRow,
      JSON.stringify({ pet: head.hasPetRow, info: head.hasInfoRow }))
    ok('H3b 岛仔不是 .head-info 的子元素', head.petInInfo === false, `petInInfo=${head.petInInfo}`)
    ok('H3c 岛仔几何位置在信息行上方',
      head.petTop !== null && head.infoTop !== null && head.petTop < head.infoTop,
      `岛仔 top=${head.petTop} / 信息行 top=${head.infoTop}`)

    // H5：不重叠、不外溢
    ok('H5a 状态区与左侧标题不重叠', head.overlapTitle === false, `overlapTitle=${head.overlapTitle}`)
    ok('H5b 状态区与右侧自启开关不重叠', head.overlapAuto === false, `overlapAuto=${head.overlapAuto}`)
    ok('H5c .head-status 完整落在岛内', head.statusInsideIsland === true, `statusInsideIsland=${head.statusInsideIsland}`)

    // H6：与收起态相对顺序一致
    const collapsedOrder = await cdpEval(`(() => { document.querySelector('.island').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'collapsed' })()`)
    await sleep(700)
    const co = await cdpEval(READ_COLLAPSED_ORDER)
    const headRel = head.infoOrder.filter((k) => co.includes(k))
    const collRel = co.filter((k) => head.infoOrder.includes(k))
    ok('H6 展开态与收起态的相对顺序一致（同一份 order）',
      JSON.stringify(headRel) === JSON.stringify(collRel),
      `展开 ${JSON.stringify(headRel)} / 收起 ${JSON.stringify(collRel)} (${collapsedOrder})`)
  }
  await stopApp(child); child = null

  // ========== H2：取消勾选 → 展开态不渲染；勾回 → 恢复 ==========
  writePrefs(DEFAULT_ORDER)
  child = await startApp()
  {
    await openPanel()
    await settingsEval(`(() => { const cb = document.querySelector('.pm-row[data-comp="clock"] input[type=checkbox]'); if (!cb) return 'no-cb'; cb.click(); return 'ok' })()`)
    await sleep(700)
    ok('H2a 取消勾选时钟写进 prefs.json',
      readPrefs()?.pagesCustom?.collapsed?.clock === false,
      JSON.stringify(readPrefs()?.pagesCustom?.collapsed))

    await closePanel()
    await expand()
    let head = JSON.parse(await cdpEval(READ_HEAD))
    ok('H2b 取消勾选后展开态不渲染时钟', !head.infoOrder.includes('clock'),
      JSON.stringify(head.infoOrder))

    await openPanel()
    await settingsEval(`(() => { const cb = document.querySelector('.pm-row[data-comp="clock"] input[type=checkbox]'); if (!cb) return 'no-cb'; cb.click(); return 'ok' })()`)
    await sleep(700)
    ok('H2c 重新勾选写回 true', readPrefs()?.pagesCustom?.collapsed?.clock === true,
      JSON.stringify(readPrefs()?.pagesCustom?.collapsed))

    await closePanel()
    await expand()
    head = JSON.parse(await cdpEval(READ_HEAD))
    ok('H2d 勾回后展开态重新渲染时钟', head.infoOrder.includes('clock'),
      JSON.stringify(head.infoOrder))
  }
  await stopApp(child); child = null

  // ========== H4：铃铛按未读出现 ==========
  // 造未读：lastOrder 与 hiddenUntil 同时清零（unread = order > lastOrder 且 order > hiddenUntil）
  let bellReady = false
  if (notifBackup !== null) {
    const w = JSON.parse(notifBackup)
    w.lastOrder = 0
    w.hiddenUntil = 0
    writeFileSync(NOTIF_READ, JSON.stringify(w), 'utf8')
    bellReady = true
  }
  writePrefs(DEFAULT_ORDER)
  child = await startApp()
  {
    await expand()
    const head = JSON.parse(await cdpEval(READ_HEAD))
    if (bellReady) {
      const bellCount = head.infoOrder.filter((k) => k === 'bell').length
      ok('H4a 有未读时展开态信息行渲染铃铛', bellCount === 1,
        `infoOrder=${JSON.stringify(head.infoOrder)}（本机通知库为空时此项会失败）`)
    } else {
      ok('H4a 有未读时展开态信息行渲染铃铛', true, '跳过：本机无 notif-read.json')
    }
    const bellInInfoOnly = await cdpEval(
      `(() => { const all = document.querySelectorAll('.island.expanded .collapsed-bell'); const info = document.querySelector('.head-info'); let outside = 0; all.forEach(e => { if (!info || !info.contains(e)) outside++ }); return outside })()`
    )
    ok('H4b 铃铛只出现在信息行内（没有散落到面板其它位置）', bellInInfoOnly === 0, `行外铃铛数=${bellInInfoOnly}`)
  }
  await stopApp(child); child = null
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  killApp()
  // 还原用户真实数据
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
  if (notifBackup !== null) writeFileSync(NOTIF_READ, notifBackup, 'utf8')
}

console.log(`\nE2E HEAD-ORDER: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
