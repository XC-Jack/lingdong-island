// e2e-m4-drop.mjs：复现用户场景——拖文件入岛（走真实 drop 广播链路），验证 UI 即时刷新且不白屏
// 用法：node scripts/e2e-m4-drop.mjs  （自动启动 electron，CDP 端口 9225；Node 22+ 自带全局 WebSocket）
import { spawn } from './isolate-userdata.mjs'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9225
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
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
      if (data.result?.exceptionDetails) {
        reject(new Error('页面异常: ' + (data.result.exceptionDetails.exception?.description ?? data.result.exceptionDetails.text)))
      } else {
        resolve(data.result?.result?.value)
      }
      ws.close()
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
  })
}

const main = async () => {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  const wsUrl = await connect()
  await sleep(1500)

  const dir = mkdtempSync(join(tmpdir(), 'island-drop-'))
  const f1 = join(dir, '测试文档.txt')
  const f2 = join(dir, 'photo.png')
  writeFileSync(f1, 'hello')
  writeFileSync(f2, 'png')

  // 展开岛并切到置物架页
  await cdp(wsUrl, `(async()=>{document.querySelector('.island').click(); await new Promise(r=>setTimeout(r,400)); document.querySelectorAll('.dot')[1].click(); await new Promise(r=>setTimeout(r,200)); return 'ok'})()`)

  // 走真实链路：shelfAdd（主进程落盘）→ emitShelfAdded 广播 → ShelfPanel 即时刷新
  const after = await cdp(wsUrl, `(async()=>{
    const list = await window.island.shelfAdd([${JSON.stringify(f1)}, ${JSON.stringify(f2)}]);
    window.island.emitShelfAdded(list);
    await new Promise(r=>setTimeout(r,300));
    const count = document.querySelector('.shelf-count')?.textContent ?? '(无 .shelf-count)';
    const cells = document.querySelectorAll('.shelf-cell').length;
    const names = [...document.querySelectorAll('.shelf-cell-name')].map(n=>n.textContent);
    return {count, cells, names, bodyAlive: !!document.querySelector('.island')};
  })()`)

  console.log('[1] 拖入2个文件后 UI 即时显示:', JSON.stringify(after))
  if (after.cells !== 2 || !String(after.count).includes('2 个文件')) throw new Error('FAIL: 拖入后 UI 未即时刷新')
  if (!after.names.some((n) => String(n).includes('测试文档'))) throw new Error('FAIL: 文件名未显示')
  if (!after.bodyAlive) throw new Error('FAIL: 页面白屏（.island 不存在）')

  // 清空走同一广播链路，确认不崩
  const cleared = await cdp(wsUrl, `(async()=>{
    const list = await window.island.shelfClear();
    window.island.emitShelfAdded(list);
    await new Promise(r=>setTimeout(r,200));
    return document.querySelector('.shelf-count')?.textContent;
  })()`)
  console.log('[2] 清空后:', cleared)
  console.log('E2E DROP PASS')
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
