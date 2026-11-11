// e2e-banner-fit.mjs — 横幅几何回归
// 背景：2026-11-11 独立验收（a54d9af）发现收起态横幅在长标题时左右各越出窗口约 30px、底部越出 1.7px，
// 而当时仓库里没有任何 e2e 断言横幅几何（`e2e-notify-compact` 只量条目高度、
// `e2e-notify-icon` 只断言横幅 DOM 不存在），完全靠肉眼，短标题下看不出来。
// 本脚本锁定：收起态来一条**很长标题**的真实 Windows toast 后，
// .collapsed-banner 必须完整落在窗口可视区内（左/右/下都不越界），且宽度大于旧版被压死的 98px。
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from './isolate-userdata.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9321
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ok = 0
let failed = 0
const assert = (name, cond, extra = '') => {
  if (cond) {
    ok++
    console.log(`  ✓ ${name} ${extra}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

async function connectCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && (t.url ?? '').includes('index.html'))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res2, rej) => {
          ws.addEventListener('open', res2, { once: true })
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
function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const onMsg = (ev) => {
      const d = JSON.parse(ev.data)
      if (d.id === id) {
        ws.removeEventListener('message', onMsg)
        if (d.error) reject(new Error(d.error.message))
        else resolve(d.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(ws, expr, awaitPromise = false) {
  const r = await cdpCall(ws, 'Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}

// 注入真实 Windows toast（与 probe-notify-collapsed2.mjs / e2e 里的做法一致）
function sendToast(title, body) {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$t.Item(0).AppendChild($xml.CreateTextNode('${title}')) | Out-Null
$t.Item(1).AppendChild($xml.CreateTextNode('${body}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.xcjack.lingdong-island').Show($toast)
`
  execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`, {
    stdio: 'ignore',
    timeout: 20000,
  })
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', detached: false, env })
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

async function main() {
  if (platform() !== 'win32') {
    console.log('SKIP：仅 Windows（依赖 Windows.UI.Notifications）')
    process.exit(0)
  }

  // 先清掉可能残留的开发版/预览版实例，避免端口与窗口互相干扰
  try {
    execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' })
  } catch {
    /* 没有残留 */
  }
  await sleep(1200)

  const child = await startApp()
  try {
    const ws = await connectCdp()
    // 等 React 挂载
    for (let i = 0; i < 40; i++) {
      if (await evaluate(ws, `!!document.querySelector('.island')`)) break
      await sleep(300)
    }
    assert('B0 岛已挂载', await evaluate(ws, `!!document.querySelector('.island')`))

    // 确保收起态
    await evaluate(ws, `window.island.setExpanded(false)`)
    await sleep(1600)
    const cls = await evaluate(ws, `document.querySelector('.island')?.className || ''`)
    assert('B1 处于收起态', String(cls).includes('collapsed'), `className=${cls}`)

    const win = await evaluate(ws, `JSON.stringify({ w: innerWidth, h: innerHeight })`)
    const winSize = JSON.parse(win)
    assert('B2 收起窗口尺寸合理（约 144~160 × 67）', winSize.h >= 60 && winSize.h <= 80 && winSize.w >= 130 && winSize.w <= 200, win)

    // 注入很长标题的 toast，专门压横幅宽度
    const uniq = `BANNER-${Date.now()}`
    sendToast('这是一个很长很长的通知标题用来测试横幅会不会越出窗口边界', uniq)

    let geo = null
    for (let i = 0; i < 16; i++) {
      await sleep(600)
      const raw = await evaluate(
        ws,
        `(() => {
          const b = document.querySelector('.collapsed-banner')
          if (!b) return 'null'
          const r = b.getBoundingClientRect()
          return JSON.stringify({
            outLeft: r.left < 0, outRight: r.right > innerWidth, outBottom: r.bottom > innerHeight,
            overLeft: Math.round((0 - r.left) * 100) / 100,
            overRight: Math.round((r.right - innerWidth) * 100) / 100,
            overBottom: Math.round((r.bottom - innerHeight) * 100) / 100,
            w: Math.round(r.width * 100) / 100,
            h: Math.round(r.height * 100) / 100,
            winW: innerWidth, winH: innerHeight
          })
        })()`
      )
      if (raw !== 'null') {
        geo = JSON.parse(raw)
        break
      }
    }

    assert('B3 长标题通知能弹出横幅', !!geo)
    if (geo) {
      console.log(`    横幅 ${geo.w}×${geo.h}，窗口 ${geo.winW}×${geo.winH}，越界 左${geo.overLeft} 右${geo.overRight} 下${geo.overBottom}`)
      // 允许 1px 亚像素误差
      assert('B4 横幅不越出窗口左边界', geo.overLeft <= 1, `overLeft=${geo.overLeft}`)
      assert('B5 横幅不越出窗口右边界', geo.overRight <= 1, `overRight=${geo.overRight}`)
      assert('B6 横幅不越出窗口下边界', geo.overBottom <= 1, `overBottom=${geo.overBottom}`)
      // 防「压得太窄」：修好前长标题时被压到 98.74px，修好后应接近窗口宽度
      assert('B7 横幅宽度跟得上窗口（> 窗口宽 60%）', geo.w > geo.winW * 0.6, `w=${geo.w} winW=${geo.winW}`)

      const s = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(ROOT, '.tmp', 'e2e-banner-fit.png'), Buffer.from(s.data, 'base64'))
    }

    ws.close()
  } finally {
    await stopApp(child)
  }

  console.log(`\nE2E BANNER-FIT: ${failed === 0 ? 'PASS' : 'FAIL'}（${ok} 过 / ${failed} 败）`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('异常:', e.message)
  process.exit(1)
})
