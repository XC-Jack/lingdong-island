// e2e：文件夹图标 + 连续两次网格内拖动换位
// 本脚本只连 CDP（9225）。没有实例时自动交给 e2e-reorder-run.mjs 起隔离实例后重跑，
// 所以可以直接单独执行；包装脚本会带 E2E_REORDER_WRAPPED=1，防止递归委派。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const CDP_PORT = 9225

const main = async () => {
  let list
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
    list = await r.json()
  } catch {
    if (process.env.E2E_REORDER_WRAPPED) {
      throw new Error(`CDP ${CDP_PORT} 未就绪（包装脚本已负责起实例，仍连不上）`)
    }
    console.log(`[bootstrap] ${CDP_PORT} 端口无实例，交给 e2e-reorder-run.mjs 起实例后重跑`)
    const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-reorder-run.mjs')
    const res = spawnSync(process.execPath, [wrapper], {
      stdio: 'inherit',
      env: { ...process.env, E2E_REORDER_WRAPPED: '1' }
    })
    process.exit(res.status ?? 1)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target on 9225')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res) => (ws.onopen = res))
  ws.send(JSON.stringify({ id: 900, method: 'Runtime.enable' }))
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d.result)
      pending.delete(d.id)
    }
    if (d.method === 'Runtime.exceptionThrown') {
      console.log('[页面异常]', JSON.stringify(d.params.exceptionDetails.exception?.description ?? ''))
    }
  }
  const evalJs = (expr, awaitPromise = false) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise } }))
    })
  const val = (res) => res?.result?.value

  // 准备两个真实文件 + 一个文件夹
  const tmp = path.join(os.tmpdir(), 'island-e2e-reorder')
  fs.mkdirSync(tmp, { recursive: true })
  const fA = path.join(tmp, 'aaa.txt')
  const fB = path.join(tmp, 'bbb.md')
  const fDir = path.join(tmp, '我的文件夹')
  fs.writeFileSync(fA, 'A')
  fs.writeFileSync(fB, 'B')
  fs.mkdirSync(fDir, { recursive: true })

  // 清空并塞入：A, B, 文件夹
  await evalJs("window.island.shelfClear().then(l=>'cleared')", true)
  const added = val(
    await evalJs(
      `window.island.shelfAdd([${JSON.stringify(fA)},${JSON.stringify(fB)},${JSON.stringify(fDir)}]).then(l=>JSON.stringify(l.map(x=>x.name)))`,
      true
    )
  )
  console.log('[1] 加入3项:', added)
  if (JSON.parse(added).length !== 3) throw new Error('添加失败')

  // 展开岛切到置物架（按圆点提示文字找，不依赖页面顺序——用户可自定义页序）
  await evalJs("document.querySelector('.island').click();1")
  await sleep(700)
  const jumped = val(
    await evalJs(
      "(()=>{const d=[...document.querySelectorAll('.dot')].find(x=>(x.getAttribute('aria-label')||'').includes('置物架'));if(!d)return false;d.click();return true})()"
    )
  )
  if (jumped !== true) throw new Error('找不到「置物架」页的圆点')
  await sleep(400)

  // [2] 文件夹图标：_folder.png 应已生成且 IMG 加载成功
  await sleep(1500)
  const icons = JSON.parse(
    val(await evalJs("JSON.stringify([...document.querySelectorAll('.shelf-icon')].map(i=>({tag:i.tagName, ok:i.complete&&i.naturalWidth>0, src:(i.src||'').slice(-30)})))"))
  )
  console.log('[2] 图标状态:', JSON.stringify(icons))
  const folderIcon = icons.find((x) => x.src.includes('_folder'))
  if (!folderIcon || !folderIcon.ok) throw new Error('文件夹图标未生成/未加载')

  // [3] 连续三次真实鼠标拖动换位。
  // 2026-11-27 起拖动改走系统级 startDrag：CDP 合成的 dragstart 会直接调它，
  // 没有真实按键按住时主进程（也是 CDP 所在进程）会被卡死，所以必须用真实鼠标。
  const names = () => evalJs("JSON.stringify([...document.querySelectorAll('.shelf-cell-name')].map(n=>n.textContent))")
  const cellPos = async (name) => {
    const raw = val(
      await evalJs(
        `(()=>{const c=[...document.querySelectorAll('.shelf-cell')].find(x=>x.querySelector('.shelf-cell-name')?.textContent===${JSON.stringify(name)});if(!c)return null;const b=c.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2,sx:screenX,sy:screenY,dpr:devicePixelRatio})})()`
      )
    )
    if (!raw) return null
    const p = JSON.parse(raw)
    return [Math.round((p.sx + p.x) * p.dpr), Math.round((p.sy + p.y) * p.dpr)]
  }
  const doReorder = async (fromName, targetName) => {
    const a = await cellPos(fromName)
    const b = await cellPos(targetName)
    if (!a || !b) return 'cell missing'
    const ps = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win-real-drag.ps1')
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, String(a[0]), String(a[1]), String(b[0]), String(b[1]), '22', '55'],
      { encoding: 'utf8' }
    )
    if (res.status !== 0) throw new Error(`真实拖拽失败: ${res.stderr || res.status}`)
    await sleep(1200)
    return val(await names())
  }

  const order0 = JSON.parse(val(await names()))
  console.log('[3] 初始顺序:', order0)
  const r1 = JSON.parse(await doReorder('aaa.txt', 'bbb.md'))
  console.log('[4] 第一次换位后:', r1)
  if (r1[0] !== 'bbb.md' || r1[1] !== 'aaa.txt') throw new Error('第一次换位失败: ' + r1)
  const r2 = JSON.parse(await doReorder('aaa.txt', '我的文件夹'))
  console.log('[5] 第二次换位后:', r2)
  if (r2[r2.length - 1] !== 'aaa.txt' || r2[1] !== '我的文件夹') throw new Error('第二次换位失败: ' + r2)
  // 再换回来，确认连续操作都稳定
  const r3 = JSON.parse(await doReorder('我的文件夹', 'bbb.md'))
  if (r3[0] !== '我的文件夹' || r3[1] !== 'bbb.md') throw new Error('第三次换位失败: ' + r3)
  console.log('[6] 第三次换位后:', r3)

  console.log('E2E REORDER PASS')
  process.exit(0)
}
main().catch((e) => {
  console.error('E2E FAIL:', e.message)
  process.exit(1)
})
