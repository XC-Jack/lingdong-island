// M3 e2e：验证 statusSnapshot IPC 返回电量数据（CDP 驱动真实窗口）。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PORT = 9223

async function main() {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

  try {
    let page = null
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
        page = targets.find((t) => t.type === 'page')
        if (page) break
      } catch { /* 未就绪 */ }
    }
    if (!page) throw new Error('CDP 未就绪')
    console.log('已连上:', page.title)

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const call = (id, expression) => new Promise((res) => {
      ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id === id) res(d) }
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })

    // 1) IPC 快照
    const snap = await call(1, `window.island.statusSnapshot().then(s => JSON.stringify(s))`)
    console.log('[1] statusSnapshot:', snap.result.result.value)

    // 2) 收起态 DOM 里有电量文本
    const dom = await call(2, `document.querySelector('.collapsed-battery')?.textContent ?? '(无)'`)
    console.log('[2] 收起态电量 DOM:', dom.result.result.value)

    // 3) 时钟存在
    const clock = await call(3, `document.querySelector('.collapsed-clock')?.textContent`)
    console.log('[3] 时钟 DOM:', clock.result.result.value)

    ws.close()
    const s = JSON.parse(snap.result.result.value)
    const ok = (s.battery === null || (typeof s.battery === 'number' && s.battery >= 0 && s.battery <= 100))
    console.log(ok ? 'E2E PASS' : 'E2E FAIL: battery 越界')
    if (!ok) process.exitCode = 1
  } finally {
    child.kill()
  }
}

main().catch((e) => { console.error('E2E FAIL:', e.message); process.exit(1) })
