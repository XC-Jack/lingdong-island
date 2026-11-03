// 通过 CDP 往真实窗口塞测试待办并截图，验证 M1 UI 视觉。
import { writeFileSync } from 'node:fs'

;(async () => {
  const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json())
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const call = (id, msg) => new Promise((res) => {
    ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id === id) res(d) }
    ws.send(JSON.stringify({ id, ...msg }))
  })
  const r = await call(1, {
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => {
        const l0 = await window.island.todosList()
        if (l0.length === 0) {
          await window.island.todosAdd('回复设计评审意见')
          await window.island.todosAdd('写周报')
          await window.island.todosAdd('整理会议资料')
          const l1 = await window.island.todosList()
          await window.island.todosToggle(l1[0].id)
          await window.island.todosToggle(l1[1].id)
        }
        const l = await window.island.todosList()
        return JSON.stringify(l.map(t => [t.text, t.done]))
      })()`,
      awaitPromise: true,
      returnByValue: true
    }
  })
  console.log('待办状态:', r.result.result.value)
  ws.close()
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
