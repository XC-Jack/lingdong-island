// 临时调试 v4：Runtime.enable + 逐步 evaluate，收集页面 console
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const main = async () => {
  const r = await fetch('http://127.0.0.1:9225/json')
  const list = await r.json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res) => (ws.onopen = res))
  ws.send(JSON.stringify({ id: 100, method: 'Runtime.enable' }))
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d.result)
      pending.delete(d.id)
    }
    if (d.method === 'Runtime.consoleAPICalled') {
      const text = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      console.log('[页面]', text)
    }
  }
  const evalJs = (expr, awaitPromise = false) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise } }))
    })

  await evalJs("document.querySelector('.island').click(); 'c1'")
  await sleep(600)
  await evalJs("document.querySelectorAll('.dot')[1]?.click(); 'c2'")
  await sleep(400)
  const st = await evalJs("'expanded=' + !!document.querySelector('.panel-head') + ' title=' + (document.querySelector('.panel-title')?.textContent ?? 'null')")
  console.log('[状态]', JSON.stringify(st?.result?.value ?? st))
  await evalJs("window.island.shelfAdd(['D:/Users/honor/Documents/Project/灵动岛/AGENTS.md']).then(l=>{window.island.emitShelfAdded(l);return 'x'})", true)
  await sleep(500)
  const fin = await evalJs("JSON.stringify({count:document.querySelector('.shelf-count')?.textContent, cells:document.querySelectorAll('.shelf-cell').length, names:[...document.querySelectorAll('.shelf-cell-name')].map(n=>n.textContent)})")
  console.log('[最终]', fin?.result?.value ?? JSON.stringify(fin))
  process.exit(0)
}
main().catch((e) => { console.error('脚本错:', e); process.exit(1) })
