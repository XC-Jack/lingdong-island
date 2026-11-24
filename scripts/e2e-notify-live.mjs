// e2e-notify-live.mjs — 验证「停在通知页时新消息实时出现」（2026-11-07 用户反馈 bug）
// L1 停在通知页，注入新 toast（自家 AUMID，即时入库）→ 不重进页面，列表顶部自动出现新条目
// 注意：wpndatabase 系统侧容量恒定（本机实测恒 32 条 toast，新条入库自动挤掉最旧），
// 所以断言「新条出现在首位」（文本/顺序变化）而不是「条数 +1」。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from './isolate-userdata.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = ROOT
const CDP_PORT = 9321
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

/** 发一条真实 Windows toast（自家 AUMID；PowerShell 5.1 WinRT EncodedCommand——多行脚本换行不能压扁） */
function sendToast(text) {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$t.Item(0).AppendChild($xml.CreateTextNode('e2e-live')) | Out-Null
$t.Item(1).AppendChild($xml.CreateTextNode('${text}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.xcjack.lingdong-island').Show($toast)
`
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  execSync(`powershell -NoProfile -EncodedCommand ${b64}`, { stdio: 'ignore', timeout: 20000 })
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

  console.log('== e2e-notify-live ==')
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

    // 展开岛 → 切到通知页
    await evaluate(ws, `(document.querySelector('.island').click(), setTimeout(()=>document.querySelector('.widget[data-page="0"]')?.click(), 150), 1); 1`)
    await sleep(450)
    await evaluate(ws, `document.querySelectorAll('.dot')[2].click(); 1`)
    await sleep(900)

    const readFirst = `(() => {
      const item = document.querySelector('.notify-item')
      return item ? item.textContent : ''
    })()`
    // 停留在通知页，发新 toast —— 修复后列表顶部应自动出现新条目（不用退出重进）
    // text2 用时间戳做唯一标识：残留条目绝不含它，避免同名假过/假败
    const uniq = `live-${Date.now()}`
    sendToast(uniq)
    let appeared = false
    for (let i = 0; i < 20; i++) {
      await sleep(500) // 主进程 watch 即时刷新+120ms 补读；渲染层 tick 直拉
      const t = await evaluate(ws, readFirst)
      if (t.includes(uniq)) {
        appeared = true
        console.log(`  L1 列表顶部出现新条目（…${t.slice(-24)}，停留页面自动更新）`)
        break
      }
    }
    if (appeared) {
      console.log('  PASS L1 停留通知页时新消息实时出现')
      pass++
    } else {
      console.log('  FAIL L1 停留通知页 10s 内列表顶部未出现新条目')
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
