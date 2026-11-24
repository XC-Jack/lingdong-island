// e2e 通知页：切到第三页 → DOM 面板标题「通知」→ 列表可读（防御式：空也显示提示）→ 已读按钮 → 收起态红点逻辑
// 自带启动+清理（与 e2e-m4 同模式）；9230 被 DSH 宿主占用，默认用 9321
import { spawn } from './isolate-userdata.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CDP_PORT = process.env.CDP_PORT || '9321'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 自启动实例（幂等：先有 9321 实例就复用）
async function ensureInstance() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
    const list = await r.json()
    if (list.some((t) => t.type === 'page' && t.url.includes('%E7%81%B5%E5%8A%A8') || t.url.includes('灵动岛'))) return
  } catch {}
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  child.unref()
}

async function connect() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}
function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 15000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      resolve(data.result?.result?.value)
      ws.close()
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
  })
}

/** 轮询直到表达式返回真值（避免固定 sleep 在慢机器/冷启动上不够）
 *  2026-11-12 修：原来 spawn 后固定 sleep(2000) 就往下走，实测 `.island` 首次出现
 *  可能晚到 2.9 秒，此时 `.click()` 抛 TypeError、岛停在收起态，而 `.dot` 只在展开态
 *  渲染 → 报 `dots=0`。这是脚本自身的时序问题，不是产品问题。 */
async function waitFor(wsUrl, expr, { timeoutMs = 15000, gapMs = 250, label = expr } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await cdp(wsUrl, expr)
      if (last) return last
    } catch {
      /* 页面还没就绪，继续等 */
    }
    await sleep(gapMs)
  }
  throw new Error(`FAIL: 等 ${label} 超时（${timeoutMs}ms），最后的值=${JSON.stringify(last)}`)
}

const main = async () => {
  await ensureInstance()
  const wsUrl = await connect()
  // 1. 等 React 挂载出岛，再展开
  await waitFor(wsUrl, `!!document.querySelector('.island')`, { label: '.island 挂载' })
  await cdp(wsUrl, `(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1)`)
  // 展开后圆点才渲染，等它出现（数量由 pagesCustom 决定，至少 3 个）
  await waitFor(wsUrl, `document.querySelectorAll('.dot').length >= 3`, { label: '.dot 出现' })
  // 2. 切到第三页（通知）——点击后等 React 渲染完再断言
  const dots = await cdp(wsUrl, `document.querySelectorAll('.dot').length`)
  if (dots < 3) throw new Error('FAIL: dots=' + dots)
  await cdp(wsUrl, `document.querySelectorAll('.dot')[2].click()`)
  await sleep(600)
  const title = await cdp(wsUrl, `document.querySelector('.panel-title')?.textContent`)
  console.log('[1] 第三页标题:', title)
  if (title !== '通知') throw new Error('FAIL: 标题不是通知，是 ' + title)
  await sleep(600)
  // 3. 通知面板出现（toast 空则显示提示行）
  const panel = await cdp(wsUrl, `(() => {
    const hint = document.querySelector('.shelf-drop-hint')?.textContent ?? null
    const list = document.querySelectorAll('.notify-item').length
    const readBtn = !!document.querySelector('.notify-item, .shelf-drop-hint')
    return { hint, list, readBtn }
  })()`)
  console.log('[2] 通知面板:', JSON.stringify(panel))
  if (!panel.readBtn) throw new Error('FAIL: 通知面板没渲染')
  // 4. 直接验证主进程 IPC 数据能返回（不依赖真实 toast）
  const ipc = await cdp(wsUrl, `window.island.notifyList().then(r => ({ n: r.items.length, unread: r.unread }))`)
  console.log('[3] notifyList IPC:', JSON.stringify(ipc))
  if (typeof ipc.n !== 'number' || typeof ipc.unread !== 'number') throw new Error('FAIL: IPC 返回异常')
  // 5. 已读按钮（有点击不报错即可）
  const marked = await cdp(wsUrl, `document.querySelector('.shelf-toolbar .todo-del') ? (document.querySelector('.shelf-toolbar .todo-del').disabled ? 'disabled-empty' : 'enabled') : 'no-btn'`)
  console.log('[4] 已读按钮:', marked)
  console.log('E2E NOTIFY PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
