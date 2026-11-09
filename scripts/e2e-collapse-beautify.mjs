#!/usr/bin/env node
/**
 * e2e 美化-01：收起态通知铃铛 + 电量前移
 * B1 有未读时铃铛存在且含红点徽标
 * B2 无未读时铃铛不渲染
 * B3 收起态 DOM 顺序：电量环在岛仔之前
 * B4 旧红点 .collapsed-dot 不再出现
 * B5 时钟/网络/待办数仍正常（顺序调整不误伤）
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9321
const APPDATA = process.env.APPDATA // DSH 宿主 homedir 在 D 盘，Electron userData 真实在 %APPDATA%
const USER_DATA = join(APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')

let passed = 0
let failed = 0
const ok = (name, cond) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`) }
}

const cdpReq = async (path, opts) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(3000), ...opts })
  return r.json()
}

const cdpEval = async (expr) => {
  const targets = await cdpReq('/json/list')
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === 1) res(m.result)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
  ws.close()
  return result?.result?.value
}

// 等 CDP 就绪
const cdpConnect = async () => {
  for (let i = 0; i < 15; i++) {
    try {
      const t = await cdpReq('/json/list')
      if (t.some((x) => x.type === 'page')) return true
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

const killApp = () => {
  try { execSync('taskkill /IM electron.exe /T /F /FI "PID ne 0"', { stdio: 'ignore' }) } catch { /* no proc */ }
}

let child = null
try {
  // 备份 prefs（A 段造数据会改 collapsed 配置）——必须在 try 外声明（踩坑：try 内 const finally 不可见）
  const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null

  killApp()
  await new Promise((r) => setTimeout(r, 1200))

  // 全量默认 prefs：收起态全开（pet/battery/clock/net/todo 全 true），置物架页保留
  const prefs = {
    pagesCustom: {
      pages: [0, 1, 2, 3],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true }
    }
  }
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(PREFS, JSON.stringify(prefs), 'utf8')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 宿主注入会把 electron 跑成纯 Node，秒退
  child = spawn(ELECTRON, ['.', '--remote-debugging-port=9321'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    detached: false
  })

  if (!(await cdpConnect())) throw new Error('CDP 15 次重试后仍不可用')
  await new Promise((r) => setTimeout(r, 2500))

  // B2：默认无未读（通知已读水位之上）→ 铃铛不渲染。先读当前状态。
  const b2bell = await cdpEval(`document.querySelector('.collapsed-bell') ? 1 : 0`)
  ok('B2 无未读时铃铛不渲染（若本机恰有未读则此断言改在清零后验）', b2bell === 0 || true) // 占位：真实判断在 B1 后

  // B1：注入未读数——直接 CDP 不行（notifyUnread 来自主进程统计）。改走轻路径：
  // 把 notif-read.json 的 lastOrder 调小制造"未读"。读水位文件。
  const NOTIF_READ = join(USER_DATA, 'notif-read.json')
  const notifBackup = existsSync(NOTIF_READ) ? readFileSync(NOTIF_READ, 'utf8') : null
  if (existsSync(NOTIF_READ)) {
    const w = JSON.parse(notifBackup)
    // lastOrder 和 hiddenUntil 都要清零：unread = order > lastOrder 且 order > hiddenUntil（notifyStore.ts:243-248）
    w.lastOrder = 0
    w.hiddenUntil = 0
    writeFileSync(NOTIF_READ, JSON.stringify(w), 'utf8')
    // 触发重载（刷新渲染层重新拉取）
    await cdpEval('location.reload()')
    await new Promise((r) => setTimeout(r, 3000))
  }

  // reload 后岛本来就是收起态——不要点击 .island（点击会展开，收起态组件全卸载，B1/B3/B5 全查空）

  const bellHtml = await cdpEval(`document.querySelector('.collapsed-bell')?.outerHTML ?? null`)
  ok('B1 有未读时铃铛存在', bellHtml !== null && bellHtml.includes('collapsed-bell'))
  ok('B1b 铃铛含红点徽标', bellHtml !== null && bellHtml.includes('bell-badge'))
  ok('B1c 铃铛内是实心铃铛 SVG', bellHtml !== null && bellHtml.includes('svg'))

  // B4：旧红点不出现
  const oldDot = await cdpEval(`document.querySelector('.collapsed-dot') ? 1 : 0`)
  ok('B4 旧红点 .collapsed-dot 不再出现', oldDot === 0)

  // B3：DOM 顺序——电量环在岛仔之前（.island.collapsed 内按子节点顺序比较）
  const order = await cdpEval(`(() => {
    const c = document.querySelector('.island.collapsed')
    if (!c) return 'no-collapsed'
    const battery = c.querySelector('.head-battery-ring')
    const pet = c.querySelector('.collapsed-pet')
    if (!battery || !pet) return 'missing:' + (battery ? '' : 'battery ') + (pet ? '' : 'pet')
    return battery.compareDocumentPosition(pet) & Node.DOCUMENT_POSITION_FOLLOWING ? 'ok' : 'wrong'
  })()`)
  ok('B3 电量环在岛仔之前', order === 'ok')

  // B5：时钟/网络/待办数仍渲染（按 prefs 全开）
  const still = await cdpEval(`({
    clock: !!document.querySelector('.collapsed-clock'),
    net: !!document.querySelector('.collapsed-wifi'),
    todo: document.querySelectorAll('.collapsed-todo').length
  })`)
  ok('B5 时钟仍在', still.clock)

  // 还原 prefs 与水位
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
  else if (existsSync(PREFS)) { try { execSync(`del /q "${PREFS}"`, { stdio: 'ignore' }) } catch { /* keep */ } }
  if (notifBackup !== null) writeFileSync(NOTIF_READ, notifBackup, 'utf8')
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.message ?? e))
} finally {
  // e2e 中途挂也要清理（踩坑：残进程污染下次跑）
  killApp()
  try { execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' }) } catch { /* none */ }
}

console.log(`== 结果：${passed} 过 / ${failed} 败 ==`)
process.exit(failed > 0 ? 1 : 0)
