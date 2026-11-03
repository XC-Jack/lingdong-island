// 临时 e2e：文件夹图标 + 连续两次网格内拖动换位
// 启动带 9225 调试端口的实例由外部脚本负责；本脚本只连 CDP。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const main = async () => {
  const r = await fetch('http://127.0.0.1:9225/json')
  const list = await r.json()
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

  // 展开岛切到置物架
  await evalJs("document.querySelector('.island').click();1")
  await sleep(500)
  await evalJs("document.querySelectorAll('.dot')[1]?.click();1")
  await sleep(400)

  // [2] 文件夹图标：_folder.png 应已生成且 IMG 加载成功
  await sleep(1500)
  const icons = JSON.parse(
    val(await evalJs("JSON.stringify([...document.querySelectorAll('.shelf-icon')].map(i=>({tag:i.tagName, ok:i.complete&&i.naturalWidth>0, src:(i.src||'').slice(-30)})))"))
  )
  console.log('[2] 图标状态:', JSON.stringify(icons))
  const folderIcon = icons.find((x) => x.src.includes('_folder'))
  if (!folderIcon || !folderIcon.ok) throw new Error('文件夹图标未生成/未加载')

  // [3] 连续两次拖动换位：模拟 reorderTo 的数据流（CDP 无法合成真实 HTML5 drag，直接驱动同一条代码路径）
  const names = () => evalJs("JSON.stringify([...document.querySelectorAll('.shelf-cell-name')].map(n=>n.textContent))")
  const doReorder = async (fromName, targetName) => {
    const res = val(
      await evalJs(
        `(async()=>{
          const cells=[...document.querySelectorAll('.shelf-cell')];
          const find=(nm)=>cells.find(c=>c.querySelector('.shelf-cell-name')?.textContent===nm);
          const src=find(${JSON.stringify(fromName)}), tgt=find(${JSON.stringify(targetName)});
          if(!src||!tgt) return 'cell missing';
          const dt=new DataTransfer();
          src.querySelector('[title]')&&null;
          // 触发与真实拖动一致的处理器链
          const mk=(type,el)=>{const ev=new DragEvent(type,{bubbles:true,cancelable:true});Object.defineProperty(ev,'dataTransfer',{value:dt});el.dispatchEvent(ev)};
          mk('dragstart',src);
          mk('dragover',tgt);
          mk('drop',tgt);
          mk('dragend',src);
          await new Promise(r=>setTimeout(r,600));
          return JSON.stringify([...document.querySelectorAll('.shelf-cell-name')].map(n=>n.textContent));
        })()`,
        true
      )
    )
    return res
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
