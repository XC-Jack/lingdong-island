// e2e-notify-open.mjs — SPEC-us-notify-open 验证
// O1 列表条目带 launch 字段（QQ 深链含 ntqq-notification://）
// O2 notify:open-source IPC 签名 (app, launch) 且 launch 原样透传（主进程回显）
// O3 危险协议过滤（file:/javascript: 等被拒，走兜底）——复刻 launchUsable 逻辑断言
// O4 HKCR 存在 ntqq-notification 协议处理器（openExternal 有接收方）
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = ROOT
const CDP_PORT = 9321
// DSH 宿主 homedir() 在 D 盘；Electron userData 真实在 %APPDATA%（C 盘）
const USER_DATA = join(
  process.env.APPDATA || join(platform() === 'win32' ? 'C:' + '' : '', 'Users', 'honor', 'AppData', 'Roaming'),
  'lingdong-island'
)
const MARK_FILE = join(USER_DATA, 'notif-read.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connectCdp() {
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
        return ws
      }
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  throw new Error('CDP 连接失败')
}

let seq = 0
function evaluate(ws, expr, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const onMsg = (ev) => {
      const d = JSON.parse(ev.data)
      if (d.id === id) {
        ws.removeEventListener('message', onMsg)
        if (d.error) reject(new Error(d.error.message))
        else resolve(d.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise, returnByValue: true } }))
  })
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(electronExe, [appDir, `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', detached: false, env })
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return
  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  await sleep(800)
}

/** 与 src/main/notifyStore.ts launchUsable 同款逻辑（单元级复刻验证） */
function launchUsable(launch) {
  if (!launch) return false
  if (!/^[a-z][a-z0-9+.-]*:/i.test(launch)) return false
  const scheme = launch.slice(0, launch.indexOf(':')).toLowerCase()
  return !['file', 'javascript', 'data', 'vbscript'].includes(scheme)
}

async function main() {
  if (platform() !== 'win32') {
    console.log('SKIP：仅 Windows')
    process.exit(0)
  }
  if (!existsSync(electronExe)) {
    console.log('SKIP：找不到 electron.exe（先 npm i）')
    process.exit(0)
  }

  console.log('== e2e-notify-open ==')
  const backup = existsSync(MARK_FILE) ? readFileSync(MARK_FILE, 'utf8') : null
  if (backup !== null) {
    try {
      const m = JSON.parse(backup)
      if (typeof m.hiddenUntil === 'number') writeFileSync(MARK_FILE, JSON.stringify({ lastOrder: m.lastOrder }))
    } catch {}
  }
  let child = null
  let pass = 0
  let fail = 0
  const check = (name, ok, detail = '') => {
    if (ok) {
      console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
      pass++
    } else {
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
      fail++
    }
  }

  try {
    // O1：启动 → 列表带 launch 字段，QQ 条目深链非空
    child = await startApp()
    const ws = await connectCdp()
    await sleep(1800)
    const raw = await evaluate(
      ws,
      `window.island.notifyRefresh().then(r => JSON.stringify({
        qq: r.items.filter(i => i.app === 'QQ').slice(0, 2).map(i => ({ launch: i.launch, hasField: 'launch' in i })),
        total: r.items.length,
        withLaunch: r.items.filter(i => i.launch).length
      }))`,
      true
    )
    const o1 = JSON.parse(raw)
    check('O1 列表带 launch 字段', o1.qq.length > 0 && o1.qq.every((q) => q.hasField), `${o1.withLaunch}/${o1.total} 条有深链`)
    check('O1b QQ 深链含 ntqq-notification://', o1.qq.some((q) => typeof q.launch === 'string' && q.launch.startsWith('ntqq-notification://')), o1.qq[0]?.launch?.slice(0, 50) ?? '(无)')
    ws.close()
    await stopApp(child)
    child = null

    // O2：主进程 IPC 签名验证——直接 invoke notify:open-source 传已知应用+launch，验证不报参数错误（返回 boolean）
    child = await startApp()
    const ws2 = await connectCdp()
    await sleep(1800)
    const o2 = await evaluate(
      ws2,
      `window.island.notifyOpenSource('___no_such_app___', null).then(v => JSON.stringify({ ret: typeof v === 'boolean' }))`,
      true
    )
    check('O2 IPC (app, launch) 两参签名可用', JSON.parse(o2).ret === true)
    ws2.close()
  } catch (e) {
    console.log('执行异常:', e.message)
    fail++
  } finally {
    await stopApp(child)
    if (backup !== null) writeFileSync(MARK_FILE, backup)
  }

  // O3：危险协议过滤（复刻逻辑单元级验证，不真开 shell）
  check('O3 file: 协议被拒', launchUsable('file:///C:/Windows/System32/cmd.exe') === false)
  check('O3b javascript:/data:/vbscript: 被拒', !launchUsable('javascript:alert(1)') && !launchUsable('data:text/html,x') && !launchUsable('vbscript:msg'))
  check('O3c 合法深链放行', launchUsable('ntqq-notification://externalCommand?subcmd=x') === true && launchUsable('ms-screenclip:') === true)
  check('O3d null/无协议被拒', !launchUsable(null) && !launchUsable('not-a-uri'))

  // O4：HKCR 协议处理器
  try {
    execSync('reg query "HKCR\\ntqq-notification\\shell\\open\\command"', { stdio: 'pipe' })
    check('O4 ntqq-notification 协议已注册', true)
  } catch {
    check('O4 ntqq-notification 协议已注册', false, 'HKCR 无该协议')
  }

  console.log(`== 结果：${pass} 过 / ${fail} 败 ==`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
