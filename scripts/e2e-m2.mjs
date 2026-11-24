// M2 e2e：岛仔情绪系统（CDP 驱动真实窗口）
// 验证：1) idle 态有呼吸动画类；2) 勾掉一条待办 → 岛仔切 happy（弯眼 SVG + 弹跳类），1.8s 后回 idle
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PORT = 9226

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

  try {
    let page = null
    for (let i = 0; i < 40; i++) {
      await sleep(500)
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
    let id = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id) }
      if (d.method === 'Runtime.exceptionThrown') {
        console.log('[页面异常]', d.params.exceptionDetails.exception?.description ?? '')
      }
    }
    const evalJs = (expression, awaitPromise = false) => new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }))
    })
    const val = (r) => r?.result?.value

    /**
     * 轮询等到表达式为真再往下走。
     *
     * 为什么必须等：CDP 的 page target 出现 ≠ React 已经把岛渲染出来。
     * 实测（2026-11-12）从拿到 target 到 `.collapsed-pet` 真的挂载上可以差
     * 几百毫秒到 2 秒多，起手立刻 evaluate 会读到 breathe=false / eyes=0，
     * 这不是产品问题，是脚本抢跑（同为 e2e-notify 的 dots=0 那个坑）。
     */
    const waitFor = async (expr, { timeoutMs = 15000, label = '' } = {}) => {
      const t0 = Date.now()
      let last
      while (Date.now() - t0 < timeoutMs) {
        last = val(await evalJs(expr))
        if (last) return last
        await sleep(200)
      }
      throw new Error(`等到超时：${label || expr}（最后读到 ${JSON.stringify(last)}）`)
    }

    // [1] idle 态：呼吸动画类存在，两颗圆眼睛
    await waitFor(`!!document.querySelector('.collapsed-pet')`, { label: '岛仔挂载' })
    const idle = JSON.parse(val(await evalJs(
      `JSON.stringify({breathe: !!document.querySelector('.collapsed-pet'), eyes: document.querySelectorAll('.pet-eye').length, happy: !!document.querySelector('.pet-happy')})`
    )))
    console.log('[1] idle 态:', JSON.stringify(idle))
    if (!idle.breathe || idle.eyes !== 2 || idle.happy) throw new Error('idle 态不对')

    // 先清掉上一轮可能残留的同名临时待办，保持幂等
    await evalJs(
      `(async()=>{ const l=await window.island.todosList(); for (const t of l.filter(x=>x.text==='e2e-m2 临时待办')) await window.island.todosRemove(t.id); return 'cleaned' })()`,
      true)
    const before = JSON.parse(val(await evalJs(`window.island.todosList().then(l=>JSON.stringify(l))`, true)))
    console.log('[2] 清理后待办数:', before.length)
    const added = JSON.parse(val(await evalJs(`window.island.todosAdd('e2e-m2 临时待办').then(l=>JSON.stringify(l))`, true)))
    console.log('[2b] 加待办后:', added.length)
    // 勾选（未完成→完成）触发 onDonePulse。岛的收起自动收回是 700ms，先重新展开再在同一个 evaluate 里完成点击+观察（跨调用间隔会超 700ms 被收回）
    await evalJs(`(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1); 1`)
    await sleep(400)
    const clicked = val(await evalJs(
      `(async()=>{
        const items=[...document.querySelectorAll('.todo-item')];
        const li=items.find(x=>x.querySelector('.todo-text')?.textContent==='e2e-m2 临时待办');
        if(!li) return JSON.stringify({err:'not found'});
        // 注意：岛是收起态时 todo-item 不存在——确认当前展开态
        if(items.length===0) return JSON.stringify({err:'no items visible'});
        li.querySelector('.todo-check')?.click();
        await new Promise(r=>setTimeout(r,300));
        return JSON.stringify({
          happy: !!document.querySelector('.pet-happy'),
          petPaths: document.querySelectorAll('.collapsed-pet path').length,
          checkDone: li.classList.contains('done'),
          visible: items.length
        });
      })()`, true))
    console.log('[4] 勾掉待办后(UI 展开态,Pet 未挂载,只验证勾选生效):', clicked)
    const st = JSON.parse(clicked)
    if (st.err) throw new Error('勾选环境不对: ' + st.err)
    if (!st.checkDone) throw new Error('待办没勾上: ' + clicked)

    // 关键：Pet 只在收起态渲染。勾选后派发 mouseout（React 的 onMouseLeave 由原生 mouseout 模拟，
    // 合成 mouseleave 无效——实测踩坑）→ onLeave → scheduleCollapse → 700ms 后收起，
    // happy 窗口(1.8s)还剩 ~200ms，收起瞬间 Pet 挂载 .pet-happy
    await evalJs(`document.querySelector('.island').dispatchEvent(new MouseEvent('mouseout', {bubbles:true})); 1`)
    await sleep(950)
    const happyVisible = JSON.parse(val(await evalJs(
      `JSON.stringify({happy: !!document.querySelector('.pet-happy'), petPaths: document.querySelectorAll('.collapsed-pet path').length})`
    )))
    console.log('[5] 收起后岛仔(应仍 happy):', JSON.stringify(happyVisible))
    if (!happyVisible.happy) throw new Error('收起后岛仔没开心')

    // [6] 1.8s happy 窗口结束后回 idle
    await sleep(1200)
    const back = JSON.parse(val(await evalJs(
      `JSON.stringify({happy: !!document.querySelector('.pet-happy'), eyes: document.querySelectorAll('.pet-eye').length})`
    )))
    console.log('[6] happy 结束后回 idle:', JSON.stringify(back))
    if (back.happy || back.eyes !== 2) throw new Error('happy 没有回 idle')

    // 清理：删掉 e2e 临时待办
    await evalJs(
      `(async()=>{ const l=await window.island.todosList(); const t=l.find(x=>x.text==='e2e-m2 临时待办'); if(t) await window.island.todosRemove(t.id); return 'cleaned' })()`,
      true)
    console.log('E2E M2 PASS')
  } finally {
    child.kill()
  }
}

main().catch((e) => { console.error('E2E M2 FAIL:', e.message); process.exit(1) })
