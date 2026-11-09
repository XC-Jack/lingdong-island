#!/usr/bin/env node
/**
 * e2e 美化-02：收起态组件排序与显隐（SPEC-beautify-02-collapse-order）
 *
 * R1 自定义 order 生效：离线写 order=[bell,clock,net,battery,pet,todo] → 收起态 DOM 顺序与之一致
 * R2 旧偏好兼容：只有 5 个 collapsed 键、无 order → prefs:get 回落默认顺序且 bell 视为开启
 * R3 铃铛可关：面板里取消勾选 → prefs.json bell=false → 收起态不渲染；再勾回 → 重新渲染（正反对照）
 * R4 面板：收起态组件区 6 行、含「通知铃铛」、行顺序与 order 一致
 * R5 面板拖动**插入**（不是互换）：落在目标行上半 → 插到它前面，下半 → 插到它后面；
 *    断言整条 order 数组（插入会让中间项顺移，互换不会），并反证结果不等于互换结果
 *
 * 面板打开方式：主进程 --inspect=9229 里执行 BrowserWindow.webContents.send('island:manage-pages')，
 * 这是唯一不经过真实右键菜单的入口（菜单是原生 popup，CDP 点不到）。
 * 主进程 Runtime.evaluate 必须带 includeCommandLineAPI:true，否则 require 不可见。
 * 注意：跑前先清 electron 进程；启动 env 必须 delete ELECTRON_RUN_AS_NODE。
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

    // ---- R5 拖动**插入**（不是互换）：用户 2026-11-08 验收反馈「我想要的是我拖动组件插空放」 ----
    // 落在目标行上半 → 插到它前面；落在下半 → 插到它后面；其余组件顺移，被拖项从原位置抽出。
    // 只要断言「整条 order 数组」，就能区分插入与互换（互换不会让第三者移动，插入会）。
    ok('R5a 拖动开始前 order 为默认顺序',
      JSON.stringify(readPrefs()?.pagesCustom?.order) === JSON.stringify(DEFAULT_ORDER),
      JSON.stringify(readPrefs()?.pagesCustom?.order))

    // 拖到上半 → 出现「插到我前面」的提示线
    const hint = await cdpEval(`(() => {
      const from = document.querySelector('.pm-row[data-comp="todo"]')
      const to = document.querySelector('.pm-row[data-comp="clock"]')
      if (!from || !to) return 'missing-row'
      const dt = new DataTransfer()
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const r = to.getBoundingClientRect()
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + r.height / 4 }))
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
      return 'ok'
    })()`)
    ok('R5b 拖动时可派发事件', hint === 'ok', hint)
    await sleep(400)

    /** 把 fromKey 拖到 targetKey 的上半(before)/下半(after)并松手；返回松手前目标行的 className。
     *  拆成三步：dragover → 等 React 提交一次 → 读 className → drop。
     *  dragover 是连续事件，React 18 对它的 setState 不一定同步落地，同一段 eval 里读 className 会读到旧值。 */
    const dragRow = async (fromKey, targetKey, half) => {
      const start = await cdpEval(`(() => {
        const from = document.querySelector('.pm-row[data-comp="${fromKey}"]')
        const to = document.querySelector('.pm-row[data-comp="${targetKey}"]')
        if (!from || !to) return 'missing-row'
        window.__e2eDt = new DataTransfer()
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt }))
        const b = to.getBoundingClientRect()
        window.__e2eY = b.top + b.height * ${half === 'before' ? 0.25 : 0.75}
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt, clientY: window.__e2eY }))
        return 'ok'
      })()`)
      if (start !== 'ok') return start
      await sleep(300)
      const hintCls = await cdpEval(
        `(document.querySelector('.pm-row[data-comp="${targetKey}"]')?.className ?? 'missing-row')`
      )
      await cdpEval(`(() => {
        const from = document.querySelector('.pm-row[data-comp="${fromKey}"]')
        const to = document.querySelector('.pm-row[data-comp="${targetKey}"]')
        if (!from || !to) return 'missing-row'
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt, clientY: window.__e2eY }))
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt }))
        return 'ok'
      })()`)
      await sleep(900)
      return hintCls
    }

    // ① todo 拖到 clock 上半 → 插到 clock **前面**；clock 与 todo 之间的 net 不会被换走
    const cls1 = await dragRow('todo', 'clock', 'before')
    ok('R5c 悬停在目标行上半时出现「插到前面」提示类',
      typeof cls1 === 'string' && cls1.includes('pm-drop-before'), cls1)
    let p = readPrefs()?.pagesCustom
    ok('R5d 插入到前面：order 变为 battery,pet,todo,clock,net,bell',
      JSON.stringify(p?.order) === JSON.stringify(['battery', 'pet', 'todo', 'clock', 'net', 'bell']),
      JSON.stringify(p?.order))
    // 反证不是互换：互换会得到 ['battery','pet','todo','net','clock','bell']（net 与 clock 换位）
    ok('R5e 不是互换语义（clock 没被顶到 todo 原位置）',
      JSON.stringify(p?.order) !== JSON.stringify(['battery', 'pet', 'todo', 'net', 'clock', 'bell']),
      JSON.stringify(p?.order))

    // ② bell 拖到 battery 下半 → 插到 battery **后面**
    const cls2 = await dragRow('bell', 'battery', 'after')
    ok('R5f 悬停在目标行下半时出现「插到后面」提示类',
      typeof cls2 === 'string' && cls2.includes('pm-drop-after'), cls2)
    p = readPrefs()?.pagesCustom
    ok('R5g 插入到后面：order 变为 battery,bell,pet,todo,clock,net',
      JSON.stringify(p?.order) === JSON.stringify(['battery', 'bell', 'pet', 'todo', 'clock', 'net']),
      JSON.stringify(p?.order))
    ok('R5h order 长度仍为 6 且无重复',
      Array.isArray(p?.order) && p.order.length === 6 && new Set(p.order).size === 6,
      JSON.stringify(p?.order))

    // ③ 拖到自己身上：不变化、不丢项
    await dragRow('bell', 'bell', 'before')
    ok('R5i 拖到自身不改变 order',
      JSON.stringify(readPrefs()?.pagesCustom?.order) === JSON.stringify(['battery', 'bell', 'pet', 'todo', 'clock', 'net']),
      JSON.stringify(readPrefs()?.pagesCustom?.order))

    // ---- R5j 收岛后视觉顺序跟着变 ----
    await closePanel()
    const after = await cdpEval(READ_ORDER)
    // 只比较真正渲染出来的组件（本机待办为空时 todo 不渲染）
    const afterExpect = ['battery', 'bell', 'pet', 'todo', 'clock', 'net'].filter((k) => after.includes(k))
    ok('R5j 收起态视觉顺序随 order 改变', JSON.stringify(after) === JSON.stringify(afterExpect),
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
