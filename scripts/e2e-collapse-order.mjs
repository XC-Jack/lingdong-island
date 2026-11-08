#!/usr/bin/env node
/**
 * e2e 美化-02：收起态组件排序与显隐（SPEC-beautify-02-collapse-order）
 *
 * R1 自定义 order 生效：离线写 order=[bell,clock,net,battery,pet,todo] → 收起态 DOM 顺序与之一致
 * R2 旧偏好兼容：只有 5 个 collapsed 键、无 order → prefs:get 回落默认顺序且 bell 视为开启
 * R3 铃铛可关：面板里取消勾选 → prefs.json bell=false → 收起态不渲染；再勾回 → 重新渲染（正反对照）
 * R4 面板：收起态组件区 6 行、含「通知铃铛」、行顺序与 order 一致
 * R5 面板拖动互换：拖 pet 到 bell 上 → prefs.json 两项交换，长度仍 6、无重复
 *
 * 面板打开方式：主进程 --inspect=9229 里执行 BrowserWindow.webContents.send('island:manage-pages')，
 * 这是唯一不经过真实右键菜单的入口（菜单是原生 popup，CDP 点不到）。
 * 主进程 Runtime.evaluate 必须带 includeCommandLineAPI:true，否则 require 不可见。
 * 注意：跑前先清 electron 进程；启动 env 必须 delete ELECTRON_RUN_AS_NODE。
 */
import { spawn, execSync } from 'node:child_process'
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
async function cdpEval(expr) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (!page) throw new Error('no page target')
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
        // includeCommandLineAPI 必须为 true：主进程 Inspector 里 require 只在命令行 API 上下文可见，
        // 否则 Runtime.evaluate 直接抛 ReferenceError: require is not defined（首次跑踩到）。
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

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 宿主注入会把 electron 跑成纯 Node，秒退
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  await sleep(3500) // 等窗口出现 + mount + prefsGet 回填 + 电量/网络快照
  return child
}

async function stopApp(child) {
  try { child.kill('SIGKILL') } catch { /* 已退 */ }
  killApp()
  await sleep(1200)
}

/** 写一份完整 pagesCustom 偏好（离线写，绕开 CDP 写偏好与 mount 回填的竞态） */
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

/** 收起态真正渲染出来的组件 key，按屏幕横向位置排序（不依赖 DOM 顺序，双重校验） */
const READ_ORDER = `(() => {
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

/** 打开「页面管理」面板（主进程发 IPC，等价于右键菜单点「页面管理…」） */
async function openPanel() {
  await mainEval(`(require('electron').BrowserWindow.getAllWindows()[0].webContents.send('island:manage-pages'), 'ok')`)
  await sleep(1000)
}

/** 点面板底部「完成并收起」：收岛退出面板，回到收起态 */
async function closePanel() {
  await cdpEval(`(() => { const b = document.querySelector('.pm-close'); if (!b) return 'no-button'; b.click(); return 'ok' })()`)
  await sleep(1200)
}

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null
const notifBackup = existsSync(NOTIF_READ) ? readFileSync(NOTIF_READ, 'utf8') : null

try {
  mkdirSync(USER_DATA, { recursive: true })

  // ========== R1：自定义顺序生效 ==========
  killApp(); await sleep(800)
  const ORDER_CUSTOM = ['bell', 'clock', 'net', 'battery', 'pet', 'todo']
  writePrefs(ORDER_CUSTOM)
  child = await startApp()
  {
    const rendered = await cdpEval(READ_ORDER)
    // 只比较真正渲染出来的组件之间的相对顺序（数据缺失的组件本来就不显示）
    const expect = ORDER_CUSTOM.filter((k) => rendered.includes(k))
    ok('R1 收起态组件按自定义 order 排列',
      rendered.length > 1 && JSON.stringify(rendered) === JSON.stringify(expect),
      `实际 ${JSON.stringify(rendered)} / 期望 ${JSON.stringify(expect)}`)
  }
  await stopApp(child); child = null

  // ========== R2：旧偏好兼容（无 order、无 bell 键） ==========
  writeFileSync(PREFS, JSON.stringify({
    pagesCustom: {
      pages: [0, 1, 2, 3],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true }
    }
  }, null, 2), 'utf8')
  child = await startApp()
  {
    const prefs = await cdpEval('window.island.prefsGet()')
    const pc = prefs?.pagesCustom
    ok('R2a 旧偏好不崩，仍读到 pagesCustom', !!pc)
    ok('R2b 缺 order 时补全为默认顺序',
      JSON.stringify(pc?.order) === JSON.stringify(DEFAULT_ORDER),
      `实际 ${JSON.stringify(pc?.order)}`)
    ok('R2c 缺 bell 键时视为开启', pc?.collapsed?.bell === true, `实际 ${JSON.stringify(pc?.collapsed)}`)
    const rendered = await cdpEval(READ_ORDER)
    ok('R2d 旧偏好下电量排在岛仔前（默认顺序生效）',
      rendered.indexOf('battery') !== -1 && rendered.indexOf('battery') < rendered.indexOf('pet'),
      `实际 ${JSON.stringify(rendered)}`)
  }
  await stopApp(child); child = null

  // ========== R3 + R4 + R5：面板交互（需要一条未读来让铃铛可观测） ==========
  // 造未读：lastOrder 与 hiddenUntil 同时清零（unread = order > lastOrder 且 order > hiddenUntil）
  if (notifBackup !== null) {
    const w = JSON.parse(notifBackup)
    w.lastOrder = 0
    w.hiddenUntil = 0
    writeFileSync(NOTIF_READ, JSON.stringify(w), 'utf8')
  }
  writePrefs(DEFAULT_ORDER)
  child = await startApp()
  {
    const bellOn = await cdpEval(`document.querySelector('.collapsed-bell') ? 1 : 0`)
    ok('R3a 铃铛开启 + 有未读 → 收起态渲染', bellOn === 1, '本机通知库为空时此项会失败')

    await openPanel()

    // ---- R4 面板结构 ----
    const rows = await cdpEval(`document.querySelectorAll('.pm-row[data-comp]').length`)
    ok('R4a 「收起态组件」区 6 行（原 5 行，铃铛新增）', rows === 6, `实际 ${rows}`)
    const labels = await cdpEval(`Array.from(document.querySelectorAll('.pm-row[data-comp] .pm-name')).map(e => e.textContent).join(',')`)
    ok('R4b 面板含「通知铃铛」一项', labels.includes('通知铃铛'), labels)
    const domOrder = await cdpEval(`Array.from(document.querySelectorAll('.pm-row[data-comp]')).map(e => e.dataset.comp)`)
    ok('R4c 面板行顺序与 order 一致', JSON.stringify(domOrder) === JSON.stringify(DEFAULT_ORDER), JSON.stringify(domOrder))

    // ---- R3b 取消勾选铃铛 ----
    await cdpEval(`(() => { const cb = document.querySelector('.pm-row[data-comp="bell"] input[type=checkbox]'); if (!cb) return 'no-cb'; cb.click(); return 'ok' })()`)
    await sleep(700)
    ok('R3b 取消勾选铃铛写进 prefs.json', readPrefs()?.pagesCustom?.collapsed?.bell === false,
      JSON.stringify(readPrefs()?.pagesCustom?.collapsed))

    // ---- R3c 收岛后铃铛消失 ----
    await closePanel()
    const bellOff = await cdpEval(`document.querySelector('.collapsed-bell') ? 1 : 0`)
    ok('R3c 铃铛关闭后收起态不再渲染', bellOff === 0, `实际 ${bellOff}`)

    // ---- R3d 再勾回，铃铛恢复（正反对照，排除「铃铛本来就不显示」的假通过） ----
    await openPanel()
    await cdpEval(`(() => { const cb = document.querySelector('.pm-row[data-comp="bell"] input[type=checkbox]'); if (!cb) return 'no-cb'; cb.click(); return 'ok' })()`)
    await sleep(700)
    ok('R3d 重新勾选写回 true', readPrefs()?.pagesCustom?.collapsed?.bell === true,
      JSON.stringify(readPrefs()?.pagesCustom?.collapsed))

    // ---- R5 拖动互换（pet ↔ bell） ----
    const dragResult = await cdpEval(`(() => {
      const from = document.querySelector('.pm-row[data-comp="pet"]')
      const to = document.querySelector('.pm-row[data-comp="bell"]')
      if (!from || !to) return 'missing-row'
      const dt = new DataTransfer()
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
      return 'done'
    })()`)
    ok('R5a 拖拽事件已派发', dragResult === 'done', dragResult)
    await sleep(900)
    const p = readPrefs()?.pagesCustom
    ok('R5b prefs.json 里 pet 与 bell 互换位置',
      JSON.stringify(p?.order) === JSON.stringify(['battery', 'bell', 'clock', 'net', 'todo', 'pet']),
      JSON.stringify(p?.order))
    ok('R5c order 长度仍为 6 且无重复',
      Array.isArray(p?.order) && p.order.length === 6 && new Set(p.order).size === 6,
      JSON.stringify(p?.order))

    // ---- R5d 收岛后视觉顺序跟着变（bell 紧跟 battery、pet 落到最后） ----
    await closePanel()
    const after = await cdpEval(READ_ORDER)
    // 同样只比较真正渲染出来的组件（本机待办为空时 todo 不渲染）
    const afterExpect = ['battery', 'bell', 'clock', 'net', 'todo', 'pet'].filter((k) => after.includes(k))
    ok('R5d 收起态视觉顺序随 order 改变', JSON.stringify(after) === JSON.stringify(afterExpect),
      `实际 ${JSON.stringify(after)} / 期望 ${JSON.stringify(afterExpect)}`)
  }
  await stopApp(child); child = null
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  killApp()
  // 还原用户真实数据（e2e 只借用偏好文件，不写用户数据）
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
  if (notifBackup !== null) writeFileSync(NOTIF_READ, notifBackup, 'utf8')
}

console.log(`\nE2E COLLAPSE-ORDER: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
