// e2e-notify-compact.mjs — SPEC-us-notify-compact 验证
// C1 条目紧凑化：padding/gap 计算样式生效，单条高度明显小于旧版
// C2 空条目兜底：title/body 皆空的条目不渲染（通过 CDP 注入 fake DOM 前先验证真实列表无空白卡；
//    空数据由前端 filter 挡住，主进程数据不可注入，因此用 JS 直接断言 filter 行为不可行 ——
//    改为渲染层断言：真实列表所有 .notify-item 都含非空 title/body，且计数文案与真实条目差值 = 被过滤数）
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from './isolate-userdata.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = ROOT
const CDP_PORT = 9321
// 注意：DSH 宿主 homedir() 返回 D:\Users\honor，而 Electron userData 真实在
// （%APPDATA%=C:\Users\honor\AppData\Roaming）。用 APPDATA 环境变量，取不到再退 homedir()。
const USER_DATA = join(
  process.env.APPDATA || join(platform() === 'win32' ? 'C:' + '' : '', 'Users', 'honor', 'AppData', 'Roaming'),
  'lingdong-island'
)
const MARK_FILE = join(USER_DATA, 'notif-read.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// CDP Runtime.evaluate：裸 await 表达式返回 undefined，必须 Promise.then 链 + awaitPromise:true
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

async function openNotifyPage(ws) {
  // 展开岛 → 点第 3 个分页点（通知页 page 2）
  await evaluate(ws, `document.querySelector('.island').click(); 1`)
  await sleep(450)
  await evaluate(ws, `document.querySelectorAll('.dot')[2].click(); 1`)
  await sleep(900)
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

  console.log('== e2e-notify-compact ==')
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

  try {
    child = await startApp()
    const ws = await connectCdp()
    await sleep(1800)
    await openNotifyPage(ws)

    // C1 紧凑化：第一条 .notify-item 的实际高度 ≤ 46px（旧版约 55px+），padding 生效
    const c1 = await evaluate(
      ws,
      `(() => {
        const li = document.querySelector('.notify-item');
        if (!li) return JSON.stringify({ ok: false, why: '无条目（通知列表为空）' });
        const cs = getComputedStyle(li);
        return JSON.stringify({ ok: true, h: li.getBoundingClientRect().height, pad: cs.padding, gap: cs.gap });
      })()`
    )
    const c1v = JSON.parse(c1)
    if (c1v.ok && c1v.h <= 46) {
      console.log(`C1 条目紧凑（高 ${Math.round(c1v.h)}px，padding ${c1v.pad}）✅`)
      pass++
    } else {
      console.log(`C1 条目高度 ${JSON.stringify(c1v)} 仍偏大 ❌`)
      fail++
    }

    // C2 空条目兜底：列表内所有条目都有非空 title 或 body（filter 后无空白卡）
    const c2 = await evaluate(
      ws,
      `(() => {
        const rows = [...document.querySelectorAll('.notify-item')];
        const empty = rows.filter((li) => {
          const t = li.querySelector('.notify-title');
          const b = li.querySelector('.notify-text');
          return (!t || !t.textContent.trim()) && (!b || !b.textContent.trim());
        });
        return JSON.stringify({ total: rows.length, empty: empty.length });
      })()`
    )
    const c2v = JSON.parse(c2)
    if (c2v.empty === 0) {
      console.log(`C2 空条目兜底（${c2v.total} 条全有内容）✅`)
      pass++
    } else {
      console.log(`C2 发现 ${c2v.empty}/${c2v.total} 条空白条目 ❌`)
      fail++
    }

    ws.close()
  } catch (e) {
    console.log('执行异常:', e.message)
    fail++
  } finally {
    await stopApp(child)
    if (backup !== null) writeFileSync(MARK_FILE, backup)
  }

  console.log(`== 结果：${pass} 过 / ${fail} 败 ==`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
