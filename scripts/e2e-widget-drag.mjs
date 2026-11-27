// e2e-widget-drag.mjs：组件网格拖动换位（SPEC-widget-drag）
// D1 网格五张卡等大、三行排满（没有横跨两列的宽卡）
// D2 网格不裁内容：岛高 ≥ 网格内容底 + 内边距（四套主题下都成立）
// D3 按下后移动即进入拖动（不等长按）：被拖卡加 .wg-dragging、其余卡让位
// D4 松手换位：顺序改变、写进 prefs.json、松手不误开页面
// D5 短按（按下即松手）仍是点击：打开对应组件页
// D6 按住不动（600ms）松手：不换位，按点击处理打开组件页
// D7 重启后顺序保持
// 用法：node scripts/e2e-widget-drag.mjs（自动启动 electron，CDP 端口 9321）
// 注意：会改写隔离目录（.tmp/e2e-userdata）里的 prefs.json，不碰真实用户数据。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREF_JSON = join(USER_DATA, 'prefs.json')
const ZOOM = 0.75

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const fail = (msg) => {
  console.error(`[FAIL] ${msg}`)
  process.exitCode = 1
}
const ok = (msg) => {
  console.log(`[PASS] ${msg}`)
  passed++
}

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

/** 长连接：拖动要连续派发多个鼠标事件，每次新建 WebSocket 太慢也不稳 */
async function openSession() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  const ws = new WebSocket(await connect())
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const call = (method, params = {}) => {
    const myId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 20000)
      const onMsg = (ev) => {
        const d = JSON.parse(ev.data)
        if (d.id !== myId) return
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result)
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  }
  const evalJs = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面异常')
    return r.result?.value
  }
  const mouse = (type, x, y) =>
    call('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1
    })
  const close = async () => {
    ws.close()
    child.kill()
    await sleep(1200) // 等进程退干净、端口释放
  }
  return { evalJs, mouse, close }
}

/** 展开岛并停在组件网格 */
async function expandGrid(s) {
  await sleep(2200)
  await s.evalJs(`document.querySelector('.island').click(); 1`)
  await sleep(1000)
}

const orderOf = (s) => s.evalJs(`JSON.stringify([...document.querySelectorAll('.widget[data-page]')].map(c=>c.dataset.page))`)
const readPages = () => {
  try {
    const raw = JSON.parse(readFileSync(PREF_JSON, 'utf8'))
    return raw?.pagesCustom?.pages ?? null
  } catch {
    return null
  }
}
const sameArr = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 某张卡的中心点（屏幕 px） */
const centerOf = (s, page) =>
  s
    .evalJs(
      `(() => { const r = document.querySelector('.widget[data-page="${page}"]').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }) })()`
    )
    .then(JSON.parse)

// 起点：一份确定的偏好（五页全开、顺序默认），避免上轮残留影响断言
const PREF_BASE = JSON.stringify(
  {
    musicIntro: true,
    pagesCustom: {
      pages: [0, 1, 2, 3, 4],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
      order: ['battery', 'pet', 'clock', 'net', 'todo', 'bell']
    }
  },
  null,
  2
)

let session = null
try {
  writeFileSync(PREF_JSON, PREF_BASE, 'utf8')

  // ---------- D1 / D2：布局 ----------
  session = await openSession()
  await expandGrid(session)
  const layout = JSON.parse(
    await session.evalJs(`(() => {
      const z = ${ZOOM}
      const cards = [...document.querySelectorAll('.widget[data-page]')]
      const rects = cards.map(c => c.getBoundingClientRect())
      const grid = document.querySelector('.widget-grid').getBoundingClientRect()
      const island = document.querySelector('.island').getBoundingClientRect()
      return JSON.stringify({
        count: cards.length,
        wide: cards.filter(c => c.classList.contains('wide')).length,
        rows: new Set(rects.map(r => Math.round(r.top))).size,
        cardW: [...new Set(rects.map(r => Math.round(r.width)))],
        cardH: [...new Set(rects.map(r => Math.round(r.height)))],
        gridBottom: Math.round((grid.bottom - island.top) / z),
        islandH: Math.round(island.height / z)
      })
    })()`)
  )
  if (layout.count === 5) ok(`D1a 网格 5 张卡`)
  else fail(`D1a 期望 5 张卡，got ${layout.count}`)
  if (layout.wide === 0) ok(`D1b 没有横跨两列的宽卡`)
  else fail(`D1b 仍有 ${layout.wide} 张宽卡`)
  if (layout.cardW.length === 1 && layout.cardH.length === 1) ok(`D1c 五张卡等大（${layout.cardW[0]}×${layout.cardH[0]} 视觉 px）`)
  else fail(`D1c 卡片尺寸不统一：w=${layout.cardW} h=${layout.cardH}`)
  if (layout.rows === 3) ok(`D1d 排成 3 行（2+2+1）`)
  else fail(`D1d 期望 3 行，got ${layout.rows}`)
  if (layout.islandH >= layout.gridBottom) ok(`D2a 网格没被岛裁掉（岛 ${layout.islandH} ≥ 内容底 ${layout.gridBottom} 布局 px）`)
  else fail(`D2a 网格被裁：岛 ${layout.islandH} < 内容底 ${layout.gridBottom}`)

  // ---------- D3 / D4：按住移动即拖动换位 ----------
  // 2026-11-27 用户要求「按着它的时候鼠标可以拖动」：按下后移动就起拖，不等 350ms。
  const before = JSON.parse(await orderOf(session))
  const a = await centerOf(session, 0)
  const b = await centerOf(session, 4)
  await session.mouse('mousePressed', a.x, a.y)
  // 按下后立刻小步移动（不等待）：这是「按下就能拖」的核心断言
  await session.mouse('mouseMoved', a.x + 12, a.y + 12)
  await sleep(120)
  const pressed = JSON.parse(
    await session.evalJs(
      `JSON.stringify({ dragging: document.querySelectorAll('.wg-dragging').length, dragPage: document.querySelector('.wg-dragging')?.dataset.page ?? null })`
    )
  )
  if (pressed.dragging === 1 && pressed.dragPage === '0') ok(`D3a 按下后移动 12px 即进入拖动（不用等长按）`)
  else fail(`D3a 按下移动后未进入拖动：${JSON.stringify(pressed)}`)

  for (let k = 1; k <= 6; k++) {
    await session.mouse('mouseMoved', a.x + ((b.x - a.x) * k) / 6, a.y + ((b.y - a.y) * k) / 6)
    await sleep(40)
  }
  const hovered = JSON.parse(
    await session.evalJs(
      `(() => {
        const cards = [...document.querySelectorAll('.widget[data-page]')]
        const others = cards.filter(c => !c.classList.contains('wg-dragging'))
        return JSON.stringify({
          reflow: !!document.querySelector('.wg-body.wg-reflow'),
          movedCount: others.filter(c => (c.style.transform || '').includes('translate')).length,
          moved: document.querySelector('.wg-dragging')?.style.transform ?? ''
        })
      })()`
    )
  )
  // 拖动时其余卡实时让位（iOS 主屏做法），所以没有「落点虚线框」这类标记
  if (hovered.reflow) ok(`D3b 拖动中网格进入让位模式（.wg-reflow）`)
  else fail(`D3b 没有进入让位模式：${JSON.stringify(hovered)}`)
  if (hovered.movedCount > 0) ok(`D3c 其余卡实时滑开让位（${hovered.movedCount} 张有位移）`)
  else fail(`D3c 其余卡没让位：${JSON.stringify(hovered)}`)
  if (hovered.moved.includes('translate')) ok(`D3d 被拖的卡跟手位移（${hovered.moved}）`)
  else fail(`D3d 被拖的卡没位移：${hovered.moved}`)

  await session.mouse('mouseReleased', b.x, b.y)
  await sleep(700)
  const after = JSON.parse(await orderOf(session))
  if (!sameArr(after, before)) ok(`D4a 松手后顺序变了：${before.join(',')} → ${after.join(',')}`)
  else fail(`D4a 顺序没变：${after.join(',')}`)
  if (after[after.length - 1] === '0') ok(`D4b 卡 0 落到卡 4 之后（拖到最后一格）`)
  else fail(`D4b 落点不对：${after.join(',')}`)
  const viewAfterDrop = await session.evalJs(
    `JSON.stringify({ grid: !!document.querySelector('.widget-grid'), page: !!document.querySelector('.page-fade') })`
  )
  if (viewAfterDrop.includes('"grid":true')) ok(`D4c 松手没有误开组件页（仍在网格）`)
  else fail(`D4c 松手误开了页面：${viewAfterDrop}`)
  const persisted = readPages()
  if (persisted && sameArr(persisted, after.map(Number))) ok(`D4d 顺序已写进 prefs.json：${persisted.join(',')}`)
  else fail(`D4d prefs.json 里的顺序不对：${JSON.stringify(persisted)}`)

  // ---------- D5：短按仍是点击 ----------
  // 用当前第一张卡（此时是卡 1）短按，应打开置物架页
  const first = Number(after[0])
  const c = await centerOf(session, first)
  await session.mouse('mousePressed', c.x, c.y)
  await sleep(120)
  await session.mouse('mouseReleased', c.x, c.y)
  await sleep(900)
  const opened = await session.evalJs(
    `JSON.stringify({ page: !!document.querySelector('.page-fade'), grid: !!document.querySelector('.widget-grid'), back: !!document.querySelector('.panel-back') })`
  )
  if (opened.includes('"page":true') && opened.includes('"grid":false')) ok(`D5 短按（120ms）照常打开组件页`)
  else fail(`D5 短按没打开页面：${opened}`)
  await session.evalJs(`document.querySelector('.panel-back')?.click(); 1`)
  await sleep(900)

  // ---------- D6：按住不动（哪怕按很久）松手仍是点击，不换位 ----------
  // 2026-11-27 起不再有「长按」概念：判据是「有没有移动」，不是「按了多久」。
  const beforeIdle = JSON.parse(await orderOf(session))
  const d = await centerOf(session, beforeIdle[0])
  await session.mouse('mousePressed', d.x, d.y)
  await sleep(600) // 按得够久，但完全不动
  await session.mouse('mouseReleased', d.x, d.y)
  await sleep(900)
  // 按住不动松手 = 一次点击 → 照常打开组件页（这正是「按着不动」该有的结果）
  const idleView = await session.evalJs(`JSON.stringify({ grid: !!document.querySelector('.widget-grid'), page: !!document.querySelector('.page-fade') })`)
  if (idleView.includes('"page":true')) ok(`D6a 按住不动松手按点击处理：打开了组件页`)
  else fail(`D6a 按住不动松手没打开页面：${idleView}`)
  // 回到网格再比顺序：此时网格才在 DOM 里（页面态下网格已卸载，读不到卡片）
  await session.evalJs(`document.querySelector('.panel-back')?.click(); 1`)
  await sleep(900)
  const afterIdle = JSON.parse(await orderOf(session))
  if (sameArr(afterIdle, beforeIdle)) ok(`D6b 按住不动 600ms 松手：顺序不变（没有误换位）`)
  else fail(`D6b 按住不动却换了位：${beforeIdle.join(',')} → ${afterIdle.join(',')}`)

  await session.close()
  session = null

  // ---------- D7：重启后顺序保持 ----------
  const expected = after
  const s2 = await openSession()
  session = s2
  await expandGrid(s2)
  const afterRestart = JSON.parse(await orderOf(s2))
  if (sameArr(afterRestart, expected)) ok(`D7 重启后顺序保持：${afterRestart.join(',')}`)
  else fail(`D7 重启后顺序变了：期望 ${expected.join(',')}，got ${afterRestart.join(',')}`)
} catch (e) {
  fail(e.message)
} finally {
  if (session) await session.close()
}

console.log(passed > 0 && process.exitCode !== 1 ? `E2E WIDGET-DRAG PASS（${passed} 项）` : 'E2E WIDGET-DRAG FAIL')
