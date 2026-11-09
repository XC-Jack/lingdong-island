/**
 * e2e：通知页「清空」水位 + 已读边界 + 打开来源兜底。
 *
 * 场景：
 *  N1 初始列表非空（本机系统通知库有历史 toast）
 *  N2 notify:clear-all → 列表变空 + unread=0（渲染层同步）
 *  N3 清空后 notify:refresh 旧通知不回来（水位过滤）
 *  N4 重启应用后列表仍空（hiddenUntil 持久化）
 *  N5 notify:open-source 映射不到的 app 返回 true（兜底开 Windows 通知设置）
 *
 * 运行方式：node scripts/e2e-notify-clear.mjs（自带启动与清理，CDP 端口 9321）
 */
import { spawn, execSync, USER_DATA } from './isolate-userdata.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'

const CDP_PORT = 9321
const MARK_FILE = join(USER_DATA, 'notif-read.json')

const electronExe = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = process.cwd()

let pass = 0
const fails = []
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fails.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

let msgId = 0
function evaluate(ws, expr, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg)
      reject(new Error(`evaluate 超时（15s）: ${expr.slice(0, 60)}`))
    }, 15_000)
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data.toString())
      if (m.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        if (m.error) reject(new Error(m.error.message))
        else resolve(m.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise, returnByValue: true },
    }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connectCdp() {
  // 等端口起来。Node 22+ 自带全局 WebSocket，无需 node:ws
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true })
          ws.addEventListener('error', rej, { once: true })
        })
        return { ws, page }
      }
    } catch (e) {
      if (i % 10 === 9) console.log(`  (cdp 等待中 ${i + 1}/40: ${e.message})`)
    }
    await sleep(250)
  }
  throw new Error('CDP 连接失败')
}

async function startApp() {
  // 宿主可能注入 ELECTRON_RUN_AS_NODE（把 electron 跑成纯 Node 导致秒退），spawn 时剥掉
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExe, [appDir, `--remote-debugging-port=${CDP_PORT}`], {
    stdio: 'ignore',
    detached: false,
    env,
  })
  return child
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return
  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  await sleep(800)
}

async function main() {
  if (platform() !== 'win32') {
    console.log('SKIP：仅 Windows（依赖本机 wpndatabase）')
    process.exit(0)
  }
  if (!existsSync(electronExe)) {
    console.log('SKIP：找不到 electron.exe（先 npm i）')
    process.exit(0)
  }

  console.log('== e2e-notify-clear ==')
  const backup = existsSync(MARK_FILE) ? readFileSync(MARK_FILE, 'utf8') : null
  let child = null

  try {
    // N1 启动 → 初始列表非空
    child = await startApp()
    let { ws } = await connectCdp()
    await sleep(1500)
    const n1raw = await evaluate(
      ws,
      `window.island.notifyRefresh().then(r => JSON.stringify({n: r.items.length, u: r.unread}))`,
      true
    )
    const n1 = JSON.parse(n1raw)
    ok('N1 初始列表非空', n1.n > 0, `${n1.n} 条 unread=${n1.u}`)
    ws.close()
    await stopApp(child)

    // N2/N3 清空 + 刷新不回来（重启保证全新 cached）
    child = await startApp()
    ;({ ws } = await connectCdp())
    await sleep(1500)
    const n2raw = await evaluate(
      ws,
      `window.island.notifyClearAll().then(r => JSON.stringify({n: r.items.length, u: r.unread}))`,
      true
    )
    const n2 = JSON.parse(n2raw)
    ok('N2 清空后列表空+未读0', n2.n === 0 && n2.u === 0, `n=${n2.n} u=${n2.u}`)
    const n3raw = await evaluate(
      ws,
      `window.island.notifyRefresh().then(r => JSON.stringify({n: r.items.length}))`,
      true
    )
    const n3 = JSON.parse(n3raw)
    ok('N3 刷新后旧通知不回来', n3.n === 0, `n=${n3.n}`)
    // 渲染层红点：collapsed-dot 不存在
    await sleep(500)
    const dot = await evaluate(ws, `!!document.querySelector('.collapsed-dot')`)
    ok('N2b 收起态红点消失', !dot)
    ws.close()
    await stopApp(child)

    // N4 重启后仍空（hiddenUntil 持久化）
    child = await startApp()
    ;({ ws } = await connectCdp())
    await sleep(1500)
    const n4raw = await evaluate(
      ws,
      `window.island.notifyList().then(r => JSON.stringify({n: r.items.length}))`,
      true
    )
    const n4 = JSON.parse(n4raw)
    ok('N4 重启后列表仍空', n4.n === 0, `n=${n4.n}`)
    const markRaw = readFileSync(MARK_FILE, 'utf8')
    const mark = JSON.parse(markRaw)
    ok('N4b hiddenUntil 已写入', typeof mark.hiddenUntil === 'number' && mark.hiddenUntil > 0, markRaw.slice(0, 60))

    // N5 打开来源兜底（映射不到的 app → 仍返回 true）
    const n5 = await evaluate(ws, `window.island.notifyOpenSource('Unknown.App.XYZ')`, true)
    ok('N5 兜底打开返回 true', n5 === true, `got ${n5}`)
    // 还原 notif-read.json，清掉 e2e 留下的水位
    if (backup !== null) writeFileSync(MARK_FILE, backup)
    else execSync(`cmd /c del "${MARK_FILE}"`, { stdio: 'ignore' })

    ws.close()
  } finally {
    await stopApp(child)
  }

  console.log(`\n== E2E NOTIFY CLEAR: ${fails.length === 0 ? 'PASS' : 'FAIL'} (${pass} 过 / ${fails.length} 败) ==`)
  if (fails.length) {
    console.log('失败项：', fails.join(' / '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('E2E ERROR', e)
  process.exit(1)
})
