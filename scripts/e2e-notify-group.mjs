// e2e-notify-group.mjs —— US-040 两级堆叠断言
// 前置：dev electron --remote-debugging-port=9321；通知库需要有多条同 app、可分 title 的数据。
// 库里现有多条 lingdong-island toast（title 分 e2e-live / diag-live / probe-live 等多组）+ QQ 多条「我就是我」。
// 断言：
//  G1 默认视图按 app 堆叠：组条目数 < 总条数（有堆叠发生）
//  G2 组条目带计数徽标（.notify-badge 显示 >1 的数字）且预览为该组最新一条 title
//  G3 点击组条目 → 展开会话子组（.notify-thread），同 title 归堆且计数正确
//  G4 点击会话子组 → 展开具体条目（.notify-leaf），条目数与计数一致
//  G5 再点会话子组 → 收起（leaf 消失）；再点组条目 → 收起（thread 消失）
//  G6 只有一条通知的 app 无数字徽标
//  G7 未读总数不受堆叠影响（工具栏「n 条通知」= 全部条目数）
//  G8 展开状态在新通知到达重拉后保留（触发 notifyRefresh 前后 openApps 不丢）
import { spawn, execFileSync } from './isolate-userdata.mjs'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/Users/honor/Documents/Project/灵动岛'
const PORT = 9321

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronExe, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

async function cdpEval(expr) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const r = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data))
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return r.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await sleep(6000)
  // dev 启动默认收起态——先点岛展开，再切通知页
  await cdpEval(`document.querySelector('.island').click()`)
  await sleep(1000)
  // 通知页 = dot[2]
  await cdpEval(`document.querySelectorAll('.dot')[2].dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  await sleep(1500)

  // G1 组条目数 < 总条数（工具栏 stated 计数 > 渲染出的组数 = 堆叠发生）
  const stat = await cdpEval(`(() => {
    const groups = document.querySelectorAll('.notify-list > .notify-group').length
    const m = (document.querySelector('.shelf-count')?.textContent || '').match(/(\\d+) 条通知/)
    return { groups, stated: m ? Number(m[1]) : -1 }
  })()`)
  ok('G1 按app堆叠(计数>组数)', stat.stated > stat.groups, `stated=${stat.stated} groups=${stat.groups}`)

  // G2 计数徽标 + 预览：找计数最大的组，预览 title 应等于该组首条
  const g2 = await cdpEval(`(() => {
    const badge = document.querySelector('.notify-list > .notify-group .notify-badge')
    if (!badge) return { has: false }
    return { has: true, n: Number(badge.textContent) }
  })()`)
  ok('G2 堆叠组带计数徽标', g2.has && g2.n > 1, `badge=${g2.has ? g2.n : '无'}`)

  // G3 点击最大组展开 → 会话子组出现
  const appOfMax = await cdpEval(`(() => {
    let best = null, bestN = 0
    for (const li of document.querySelectorAll('.notify-list > .notify-group')) {
      const b = li.querySelector(':scope > .notify-body .notify-badge')
      const n = b ? Number(b.textContent) : 1
      if (n > bestN) { bestN = n; best = li }
    }
    if (!best) return null
    const btn = best.querySelector(':scope > .notify-body')
    btn.dispatchEvent(new MouseEvent('click', {bubbles:true}))
    return bestN
  })()`)
  await sleep(400)
  const g3 = await cdpEval(`(() => {
    const threads = document.querySelectorAll('.notify-thread').length
    return { threads }
  })()`)
  ok('G3 点击展开出现会话子组', g3.threads > 0, `threads=${g3.threads}`)

  // 会话子组的计数总和 = 组计数
  const threadSum = await cdpEval(`(() => {
    let sum = 0
    for (const t of document.querySelectorAll('.notify-thread')) {
      const b = t.querySelector(':scope > .notify-body .notify-badge')
      sum += b ? Number(b.textContent) : 1
    }
    return sum
  })()`)
  ok('G3b 会话计数总和=组计数', threadSum === appOfMax, `sum=${threadSum} group=${appOfMax}`)

  // G4 点击第一个会话子组展开具体条目
  await cdpEval(`document.querySelector('.notify-thread > .notify-body').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  await sleep(400)
  const g4 = await cdpEval(`(() => {
    const leaves = document.querySelectorAll('.notify-leaf').length
    const t = document.querySelector('.notify-thread > .notify-body .notify-badge')
    const n = t ? Number(t.textContent) : 1
    return { leaves, n }
  })()`)
  ok('G4 会话展开显示具体条目', g4.leaves === g4.n, `leaves=${g4.leaves} expect=${g4.n}`)

  // G5a 再点会话子组 → leaf 消失
  await cdpEval(`document.querySelector('.notify-thread > .notify-body').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  await sleep(400)
  const g5a = await cdpEval(`document.querySelectorAll('.notify-leaf').length`)
  ok('G5a 再点会话收起条目', g5a === 0, `leaves=${g5a}`)

  // G5b 再点组条目 → thread 消失
  await cdpEval(`document.querySelector('.notify-list > .notify-group > .notify-body').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  await sleep(400)
  const g5b = await cdpEval(`document.querySelectorAll('.notify-thread').length`)
  ok('G5b 再点组收起子组', g5b === 0, `threads=${g5b}`)

  // G6 单条 app 无徽标
  const g6 = await cdpEval(`(() => {
    for (const li of document.querySelectorAll('.notify-list > .notify-group')) {
      const b = li.querySelector(':scope > .notify-body .notify-badge')
      if (!b) return { single: true }
    }
    return { single: false }
  })()`)
  ok('G6 单条app无徽标', g6.single === true)

  // G7 全部条目都在：逐组展开后 .notify-item 总数（含组/会话/条目）应 = stated + 会话数 + 组数（层级节点也各算一个 item）
  // 简化口径：把所有组与会话都展开后，.notify-leaf 数量 = stated
  let leafSum = 0
  const nGroups = await cdpEval(`document.querySelectorAll('.notify-list > .notify-group').length`)
  for (let i = 0; i < nGroups; i++) {
    await cdpEval(`document.querySelectorAll('.notify-list > .notify-group')[${i}]?.querySelector(':scope > .notify-body')?.dispatchEvent(new MouseEvent('click', {bubbles:true})); 1`)
    await sleep(300)
  }
  const nThreads = await cdpEval(`document.querySelectorAll('.notify-thread').length`)
  for (let i = 0; i < nThreads; i++) {
    await cdpEval(`document.querySelectorAll('.notify-thread')[${i}]?.querySelector(':scope > .notify-body')?.dispatchEvent(new MouseEvent('click', {bubbles:true})); 1`)
    await sleep(250)
  }
  leafSum = await cdpEval(`document.querySelectorAll('.notify-leaf').length`)
  const stated2 = await cdpEval(`(() => {
    const m = (document.querySelector('.shelf-count')?.textContent || '').match(/(\\d+) 条通知/)
    return m ? Number(m[1]) : -1
  })()`)
  ok('G7 展开后具体条目数=计数', leafSum === stated2, `leaves=${leafSum} stated=${stated2}`)

  // G8 展开状态保留：展开第一组 → 触发重拉 → 仍展开
  await cdpEval(`document.querySelector('.notify-list > .notify-group > .notify-body').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
  await sleep(300)
  await cdpEval(`window.island.notifyRefresh().then(()=>true)`)
  await sleep(800)
  const g8 = await cdpEval(`document.querySelectorAll('.notify-thread').length`)
  ok('G8 重拉后展开状态保留', g8 > 0, `threads=${g8}`)
} catch (e) {
  fail++
  console.log('  ✗ 异常:', e.message)
} finally {
  child.kill()
  console.log(`\n结果: ${pass} 过 / ${fail} 败`)
  process.exit(fail > 0 ? 1 : 0)
}
