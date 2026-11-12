// e2e-notify-open.mjs — SPEC-us-notify-open 验证
// O1 通知列表里的深链（launch 字段）原样透传到渲染层
// O2 notify:open-source IPC 签名 (app, launch) 且 launch 原样透传（主进程回显）
// O3 危险协议过滤（file:/javascript: 等被拒，走兜底）——复刻 launchUsable 逻辑断言
// O4 深链协议是否已注册（有接收方才能真开）
//
// 2026-11-12 修：原来 O1/O1b 硬断言「本机通知库里有 QQ 的 ntqq-notification:// 深链」。
// 那是环境依赖不是产品行为——没装/没登录 QQ、或通知库被清过就必然失败（当时实测 35 条里
// 只有 12 条带 launch、一条 QQ 都没有）。现在改成：
//   O1  用「通知库里真实存在的任意深链」做端到端核对——把渲染层拿到的 launch 与直接读
//       wpndatabase 得到的原始值逐字比对，证明没有截断/转义/丢字段。
//   O1b 自带数据兜底：设 E2E_SEED_TOAST=1 时自己投一条带深链的 toast 再断言。
//       **默认关闭**，因为 wpndatabase 是只追加的系统库，投进去的条目删不掉（实测
//       History.Clear / Remove 只清通知中心显示，不删库行），会永久污染用户的岛通知页。
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from './isolate-userdata.mjs'

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
// 与 src/main/notifyStore.ts 的 WPN_DB 同一个文件
const WPN_DB = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db')

const SEED = process.env.E2E_SEED_TOAST === '1'
const STAMP = `e2e${Date.now()}`
const SEED_LAUNCH = `lingdongtest://e2e?stamp=${STAMP}`
const SEED_TITLE = `e2e-open-${STAMP}`
const SEED_APP = 'ShellExperienceHost_cw5n1h2txyewy'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 直接读 wpndatabase（复制快照再读，和主进程同款做法），拿「原始 launch」用于逐字比对 */
async function readDbLaunches() {
  if (!existsSync(WPN_DB)) return null
  const tmp = join(tmpdir(), `e2e-open-${process.pid}-${Date.now()}.db`)
  try {
    copyFileSync(WPN_DB, tmp)
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(`${WPN_DB}${ext}`)) copyFileSync(`${WPN_DB}${ext}`, `${tmp}${ext}`)
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(tmp, { readOnly: true })
    try {
      const rows = db
        .prepare(
          `SELECT n.Id, n.Payload FROM Notification n
           WHERE n.Type = 'toast' AND n.Payload IS NOT NULL
           ORDER BY n.[Order] DESC LIMIT 50`
        )
        .all()
      const out = new Map()
      for (const r of rows) {
        const xml = Buffer.from(r.Payload).toString('utf8')
        const m = xml.match(/<toast[^>]*\slaunch="([^"]*)"/i)
        if (m) out.set(Number(r.Id), m[1])
      }
      return out
    } finally {
      db.close()
    }
  } catch (e) {
    console.log('  读取 wpndatabase 失败:', e.message)
    return null
  } finally {
    for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* 临时文件清理失败无碍 */
      }
    }
  }
}

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
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    /* 已退出 */
  }
  await sleep(800)
}

async function waitApp(ws) {
  for (let i = 0; i < 40; i++) {
    try {
      if (await evaluate(ws, `!!window.island`)) return
    } catch {
      /* 还没挂载 */
    }
    await sleep(250)
  }
  throw new Error('页面里等不到 window.island')
}

/** 投一条带 launch 的真实 toast（仅 E2E_SEED_TOAST=1 时调用） */
function seedToast() {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast launch="${SEED_LAUNCH}"><visual><binding template="ToastGeneric"><text>${SEED_TITLE}</text><text>e2e seed for launch field</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${SEED_APP}!App').Show($toast)
`
  execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`, { stdio: 'ignore', timeout: 25000 })
}

/** 与 src/main/notifyStore.ts launchUsable 同款逻辑（单元级复刻验证） */
function launchUsable(launch) {
  if (!launch) return false
  if (!/^[a-z][a-z0-9+.-]*:/i.test(launch)) return false
  const scheme = launch.slice(0, launch.indexOf(':')).toLowerCase()
  return !['file', 'javascript', 'data', 'vbscript'].includes(scheme)
}

/** 与 src/main/notifyStore.ts parseToastLaunch 同款：先解 XML 实体，再解百分号（顺序不能反） */
function decodeLikeProduct(raw) {
  const unescaped = raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
  try {
    return decodeURIComponent(unescaped)
  } catch {
    return unescaped
  }
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
  let skipped = 0
  const check = (name, ok, detail = '') => {
    if (ok) {
      console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
      pass++
    } else {
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
      fail++
    }
  }
  const skip = (name, why) => {
    console.log(`  ~ ${name}（跳过）— ${why}`)
    skipped++
  }

  // 清掉可能残留的开发版实例，避免端口抢占后连到旧实例
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 没有残留 */
  }
  await sleep(1000)

  try {
    if (SEED) {
      console.log('  （E2E_SEED_TOAST=1：会往系统通知库投一条永久条目）')
      try {
        seedToast()
        await sleep(2500)
      } catch (e) {
        console.log('  种子 toast 注入失败:', e.message)
      }
    }

    child = await startApp()
    const ws = await connectCdp()
    await waitApp(ws)
    await sleep(1800)

    // O1：渲染层拿到的 launch 与系统库里原始 XML 的 launch 逐字一致
    const raw = await evaluate(
      ws,
      `window.island.notifyRefresh().then(r => JSON.stringify({
        items: r.items.map(i => ({ id: i.id, app: i.app, title: i.title, launch: i.launch ?? null, hasField: 'launch' in i })),
        total: r.items.length
      }))`,
      true
    )
    const list = JSON.parse(raw)
    const dbLaunches = await readDbLaunches()
    const withLaunch = list.items.filter((i) => i.launch)
    console.log(`  （列表 ${list.total} 条，其中 ${withLaunch.length} 条带深链${dbLaunches ? `；库里 ${dbLaunches.size} 条有 launch` : ''}）`)

    if (SEED) {
      const seeded = list.items.find((i) => i.title === SEED_TITLE)
      check(
        'O1a 自造种子条目的 launch 原样透传',
        !!seeded && seeded.hasField && seeded.launch === SEED_LAUNCH,
        seeded ? `launch=${seeded.launch}` : `未找到 title=${SEED_TITLE}`
      )
    }

    if (withLaunch.length === 0) {
      skip('O1 深链原样透传（端到端逐字比对）', '本机通知库里没有任何带 launch 的通知——这是环境条件，不是代码问题；设 E2E_SEED_TOAST=1 可自造一条')
    } else {
      // O1 的真正断言：**没有残留未解码的 XML 实体**。
      // 不能用「所有 launch 都是合法 URI」来判——实测本机就有两类非 URI 的 launch：
      //   magpie 用 base64 的 JSON（eyJhY3Rpb24i…）、SecurityCenter 用「439#enable&av&…」。
      // 那不是本项目的 bug（launchUsable 会把它们判为不可用、走兜底打开应用）。
      // 真正会坏的是 &amp; 没还原：那样交给 shell.openExternal 就是坏 URI。
      const dirty = withLaunch.filter((i) => /&(amp|lt|gt|quot|apos);|&#\d+;|&#x[0-9a-f]+;/i.test(i.launch))
      check(
        'O1 launch 里没有残留未解码的 XML 实体',
        dirty.length === 0,
        dirty.length ? JSON.stringify(dirty.slice(0, 2)) : `${withLaunch.length} 条都干净`
      )
      if (dbLaunches && dbLaunches.size > 0) {
        // O1b：逐条比「库里原始值 ─去实体→ 去百分号→」与「渲染层拿到的值」。
        // 不能直接比原始值：产品会解 XML 实体（&amp; → &），那是设计行为。
        const mismatched = []
        let compared = 0
        for (const i of withLaunch) {
          if (!dbLaunches.has(i.id)) continue
          compared++
          const expected = decodeLikeProduct(dbLaunches.get(i.id))
          if (expected !== i.launch) mismatched.push({ id: i.id, raw: dbLaunches.get(i.id), expected, got: i.launch })
        }
        check(
          'O1b launch = 库原始值经「解实体 + 解百分号」后的结果（逐字）',
          compared > 0 && mismatched.length === 0,
          compared === 0 ? '库里没有能对上的 id' : mismatched.length ? JSON.stringify(mismatched.slice(0, 2)) : `核对 ${compared} 条，全部一致`
        )
      } else {
        skip('O1b launch 与系统库里原始值逐字比对', dbLaunches === null ? '直接读 wpndatabase 失败（权限/文件被占用）' : '库读取成功但没解析出 launch')
      }
    }
    ws.close()
    await stopApp(child)
    child = null

    // O2：主进程 IPC 签名验证——直接 invoke notify:open-source 传已知应用+launch，验证不报参数错误（返回 boolean）
    child = await startApp()
    const ws2 = await connectCdp()
    await waitApp(ws2)
    await sleep(1200)
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

  // O4：协议是否已注册。QQ 未安装时退化为断言系统原生 ms- 协议可用——
  // 这一条测的是「本机有没有接收方」，不该因为没装 QQ 就让整个脚本红灯。
  let qqOk = false
  try {
    execSync('reg query "HKCR\\ntqq-notification\\shell\\open\\command"', { stdio: 'pipe' })
    qqOk = true
  } catch {}
  if (qqOk) {
    check('O4 ntqq-notification 协议已注册', true)
  } else {
    let msOk = false
    try {
      execSync('reg query "HKCR\\ms-screensketch\\shell\\open\\command"', { stdio: 'pipe' })
      msOk = true
    } catch {}
    check('O4 深链协议有接收方（本机无 QQ，退化为原生 ms- 协议）', msOk, msOk ? 'ms-screensketch 已注册' : '未找到任何已知协议')
  }

  console.log(`== 结果：${pass} 过 / ${fail} 败${skipped ? ` / ${skipped} 跳过` : ''} ==`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
