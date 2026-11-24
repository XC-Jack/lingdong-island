// M4 e2e：验证置物架 IPC 链路（加/列/删/清）+ 第二页切换。
import { spawn } from './isolate-userdata.mjs'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(import.meta.dirname, '..')
const PORT = 9224

async function main() {
  // 造两个真实测试文件，模拟从资源管理器拖入
  const tmp = mkdtempSync(join(tmpdir(), 'e2e-m4-'))
  const f1 = join(tmp, 'e2e-测试文件甲.txt')
  const f2 = join(tmp, 'e2e-测试文件乙.txt')
  writeFileSync(f1, 'hello 甲')
  writeFileSync(f2, 'hello 乙')

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

    // 0) 清场
    await call(0, `window.island.shelfClear()`)

    // 1) 加两个文件
    const add = await call(1, `window.island.shelfAdd([${JSON.stringify(f1)},${JSON.stringify(f2)}]).then(l => JSON.stringify(l.map(x => x.name)))`)
    console.log('[1] 添加后:', add.result.result.value)

    // 2) 去重：重复加同一个
    const dup = await call(2, `window.island.shelfAdd([${JSON.stringify(f1)}]).then(l => l.length)`)
    console.log('[2] 重复添加后数量(应仍为2):', dup.result.result.value)

    // 3) 删除第一条
    const del = await call(3, `(async () => {
      const l = await window.island.shelfList()
      const after = await window.island.shelfRemove(l[0].id)
      return after.length
    })()`)
    console.log('[3] 删一条后数量(应为1):', del.result.result.value)

    // 4) 切到第二页，检查置物架 DOM
    const dom = await call(4, `(async () => {
      // 先展开（岛是收起态，点一下展开）
      (document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1)
      await new Promise(r => setTimeout(r, 400))
      const dots = document.querySelectorAll('.dot')
      if (dots.length < 2) return JSON.stringify({ err: 'dots=' + dots.length })
      dots[1].click()
      await new Promise(r => setTimeout(r, 100))
      const title = document.querySelector('.panel-title')?.textContent
      const hint = document.querySelector('.shelf-drop-hint')?.textContent
      const count = document.querySelector('.shelf-count')?.textContent
      return JSON.stringify({ title, hint, count })
    })()`)
    console.log('[4] 第二页 DOM:', dom.result.result.value)

    // 5) 清空
    const clr = await call(5, `window.island.shelfClear().then(l => l.length)`)
    console.log('[5] 清空后数量(应为0):', clr.result.result.value)

    ws.close()
    console.log('E2E PASS')
  } finally {
    child.kill()
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

main().catch((e) => { console.error('E2E FAIL:', e.message); process.exit(1) })
