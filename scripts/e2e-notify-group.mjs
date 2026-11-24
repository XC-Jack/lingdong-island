// e2e-notify-group.mjs —— SPEC-notify-icon-and-single-group 单级堆叠断言
// 前置：dev electron --remote-debugging-port=9321；通知库需要有多条同 app 的数据。
// 库里现有多条 lingdong-island toast + QQ 多条「我就是我」+ SecurityCenter 多条「启用病毒防护」。
// 口径：只按应用分一层，点开应用直接平铺该应用的全部通知，不再按 title 细分会话（旧 US-040 两级已推翻）。
// 断言：
//  G1 默认视图按 app 堆叠：组条目数 < 总条数（有堆叠发生）
//  G2 组条目带计数徽标（.notify-badge 显示 >1 的数字）
//  G3 点击最大组 → 直接平铺具体条目（.notify-leaf），条目数 = 该组计数
//  G3b 不再有会话子组（.notify-thread 恒为 0）—— 证明只剩一层
//  G4 平铺出的每个具体条目都有图标区（真图标或首字占位方块）
//  G5 再点该组 → 收起（leaf 消失）
//  G6 只有一条通知的 app 无数字徽标
//  G7 逐组展开后 .notify-leaf 总数 = 工具栏「n 条通知」
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
  await cdpEval(`(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1)`)
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

  // G2 计数徽标：找计数最大的组
  const g2 = await cdpEval(`(() => {
    const badge = document.querySelector('.notify-list > .notify-group .notify-badge')
    if (!badge) return { has: false }
    return { has: true, n: Number(badge.textContent) }
  })()`)
  ok('G2 堆叠组带计数徽标', g2.has && g2.n > 1, `badge=${g2.has ? g2.n : '无'}`)

  // G3 点击最大组展开 → 直接平铺具体条目（不再有会话子组）
  // 同时返回「最大组是第几个」，G5 要用同一个组收起。
  const g3pre = await cdpEval(`(() => {
    let best = -1, bestN = 0
    const groups = document.querySelectorAll('.notify-list > .notify-group')
    for (let i = 0; i < groups.length; i++) {
      const b = groups[i].querySelector(':scope > .notify-body .notify-badge')
      const n = b ? Number(b.textContent) : 1
      if (n > bestN) { bestN = n; best = i }
    }
    if (best < 0) return null
    groups[best].querySelector(':scope > .notify-body').dispatchEvent(new MouseEvent('click', {bubbles:true}))
    return { n: bestN, idx: best }
  })()`)
  const appOfMax = g3pre?.n ?? null
  const maxIdx = g3pre?.idx ?? 0
  await sleep(400)
  const g3 = await cdpEval(`(() => {
    const leaves = document.querySelectorAll('.notify-leaf').length
    return { leaves }
  })()`)
  ok('G3 点击组直接平铺具体条目', g3.leaves === appOfMax, `leaves=${g3.leaves} expect=${appOfMax}`)

  // G3b 只剩一层：任何地方都不应再出现 .notify-thread 会话子组
  const g3b = await cdpEval(`document.querySelectorAll('.notify-thread').length`)
  ok('G3b 不再有会话子组(单级)', g3b === 0, `threads=${g3b}`)

  // G4 平铺出的每个具体条目都有图标区（真图标或首字占位方块），不再退化成一片紫字
  const g4 = await cdpEval(`(() => {
    const leaves = [...document.querySelectorAll('.notify-leaf')]
    const withIcon = leaves.filter(l => l.querySelector('.notify-icon-wrap')).length
    return { total: leaves.length, withIcon }
  })()`)
  ok('G4 具体条目都有图标区', g4.total > 0 && g4.withIcon === g4.total, `leaves=${g4.total} withIcon=${g4.withIcon}`)

  // G5 再点同一个组 → 收起（leaf 消失）
  await cdpEval(`document.querySelectorAll('.notify-list > .notify-group')[${maxIdx}]?.querySelector(':scope > .notify-body')?.dispatchEvent(new MouseEvent('click', {bubbles:true})); 1`)
  await sleep(400)
  const g5 = await cdpEval(`document.querySelectorAll('.notify-leaf').length`)
  ok('G5 再点组收起条目', g5 === 0, `leaves=${g5}`)

  // G6 单条 app 无徽标
  const g6 = await cdpEval(`(() => {
    for (const li of document.querySelectorAll('.notify-list > .notify-group')) {
      const b = li.querySelector(':scope > .notify-body .notify-badge')
      if (!b) return { single: true }
    }
    return { single: false }
  })()`)
  ok('G6 单条app无徽标', g6.single === true)

  // G7 全部条目都在：逐组展开后 .notify-leaf 数量 = stated
  const nGroups = await cdpEval(`document.querySelectorAll('.notify-list > .notify-group').length`)
  for (let i = 0; i < nGroups; i++) {
    await cdpEval(`document.querySelectorAll('.notify-list > .notify-group')[${i}]?.querySelector(':scope > .notify-body')?.dispatchEvent(new MouseEvent('click', {bubbles:true})); 1`)
    await sleep(300)
  }
  const leafSum = await cdpEval(`document.querySelectorAll('.notify-leaf').length`)
  const stated2 = await cdpEval(`(() => {
    const m = (document.querySelector('.shelf-count')?.textContent || '').match(/(\\d+) 条通知/)
    return m ? Number(m[1]) : -1
  })()`)
  ok('G7 展开后具体条目数=计数', leafSum === stated2, `leaves=${leafSum} stated=${stated2}`)

  // G9 图标位补齐：每个 .notify-icon-wrap 恰好含一个方块（真 img 或首字占位），占位方块带 title 与首字
  const g9 = await cdpEval(`(() => {
    const wraps = [...document.querySelectorAll('.notify-icon-wrap')]
    const real = document.querySelectorAll('.notify-icon-wrap > .notify-icon').length
    const fb = [...document.querySelectorAll('.notify-icon-wrap > .notify-icon-fallback')]
    const fbOk = fb.every(f => (f.getAttribute('title') || '') && (f.textContent || '').trim().length >= 1)
    return { wraps: wraps.length, real, fb: fb.length, fbOk }
  })()`)
  ok('G9 每条通知都有图标位(真图标或占位方块)', g9.wraps > 0 && g9.real + g9.fb === g9.wraps && g9.fbOk,
    `wraps=${g9.wraps} 真图标=${g9.real} 占位=${g9.fb} 占位结构=${g9.fbOk}`)

  // G10 占位方块不复用 .notify-icon 类名（否则会污染 e2e-notify-icon 的 naturalWidth/ldapp 断言）
  const g10 = await cdpEval(`document.querySelectorAll('.notify-icon.notify-icon-fallback').length`)
  ok('G10 占位方块不冒充真图标', g10 === 0, `混用=${g10}`)

  // G11 Windows 安全中心（AUMID Windows.Defender.SecurityCenter，旧版退化成紫字 SecurityCenter）
  // 现在必须显示真图标：img.notify-icon 解码成功 + ldapp: 协议，而不是 .notify-icon-fallback 占位方块
  const g11 = await cdpEval(`(() => {
    const groups = [...document.querySelectorAll('.notify-list > .notify-group')]
    const sec = groups.find(g => (g.querySelector(':scope > .notify-body .notify-title')?.textContent || '').includes('启用病毒防护'))
    if (!sec) return { found: false }
    const img = sec.querySelector(':scope > .notify-body .notify-icon')
    const fb = sec.querySelector(':scope > .notify-body .notify-icon-fallback')
    return { found: true, hasImg: !!img, hasFb: !!fb, nw: img ? img.naturalWidth : 0, src: img ? (img.getAttribute('src') || '') : '' }
  })()`)
  ok('G11 Windows安全中心通知显示真图标(非占位方块/非紫字)',
    g11.found && g11.hasImg && !g11.hasFb && g11.nw > 0 && g11.src.startsWith('ldapp:'),
    g11.found ? `img=${g11.hasImg} 占位=${g11.hasFb} naturalWidth=${g11.nw} src=${g11.src.split(':')[0]}` : '(库里暂无该通知，跳过判定)')

  // G8 展开状态保留：重拉后展开的组仍展开（leaf > 0）
  await cdpEval(`window.island.notifyRefresh().then(()=>true)`)
  await sleep(800)
  const g8 = await cdpEval(`document.querySelectorAll('.notify-leaf').length`)
  ok('G8 重拉后展开状态保留', g8 > 0, `leaves=${g8}`)
} catch (e) {
  fail++
  console.log('  ✗ 异常:', e.message)
} finally {
  child.kill()
  console.log(`\n结果: ${pass} 过 / ${fail} 败`)
  process.exit(fail > 0 ? 1 : 0)
}
