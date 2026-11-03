// e2e-m5.mjs —— 验证码收起态展示 + 开机自启开关
// 链路：注入文本走真实 extractCode 识别 → captcha:current → 收起态 DOM 显示「验证码 xxxxxx 已复制」→ 点掉恢复
// 用法：node scripts/e2e-m5.mjs （自动启动 electron，CDP 端口 9227；Node 22+ 自带全局 WebSocket）
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9227
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 15000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      if (data.result?.exceptionDetails) {
        reject(new Error('页面异常: ' + (data.result.exceptionDetails.exception?.description ?? data.result.exceptionDetails.text)))
      } else {
        resolve(data.result?.result?.value)
      }
      ws.close()
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
  })
}

const main = async () => {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  const wsUrl = await connect()
  await sleep(1500)

  // [1] 注入一条"短信"走真实识别链路
  const inj = await cdp(wsUrl, `window.island.captchaTestInject('【某平台】您的验证码 482913，10 分钟内有效，请勿泄露')`)
  if (!inj || inj.code !== '482913') throw new Error(`识别失败: ${JSON.stringify(inj)}`)
  console.log('[1] 短信识别出验证码:', inj.code)

  await sleep(5200) // 等渲染层 5 秒轮询拉到

  // [2] 收起态 DOM 应显示验证码
  const dom = await cdp(wsUrl, `(() => {
    const q = (s) => document.querySelector(s)?.textContent ?? null
    return { code: q('.captcha-code'), copied: q('.captcha-copied'), expanded: !!document.querySelector('.island.expanded') }
  })()`)
  if (dom.code !== '482913' || dom.copied !== '已复制') throw new Error(`DOM 未显示: ${JSON.stringify(dom)}`)
  console.log('[2] 收起态显示: 验证码', dom.code, dom.copied)

  // [3] 边界：普通文本不触发
  const neg = await cdp(wsUrl, `window.island.captchaTestInject('今天天气不错')`)
  if (neg.code !== null) throw new Error(`误报: ${JSON.stringify(neg)}`)
  console.log('[3] 普通文本不误报 ✓')

  // [4] 边界：6 位纯数字直接给
  const six = await cdp(wsUrl, `window.island.captchaTestInject('482913')`)
  if (six.code !== '482913') throw new Error(`纯数字未识别: ${JSON.stringify(six)}`)
  console.log('[4] 纯 6 位数字识别 ✓')

  // [5] 开机自启开关：读 → 关 → 读 → 恢复初始值
  const s0 = await cdp(wsUrl, `window.island.autostartGet()`)
  const s1 = await cdp(wsUrl, `window.island.autostartSet(false)`)
  const s2 = await cdp(wsUrl, `window.island.autostartGet()`)
  if (s1 !== false || s2 !== false) throw new Error(`autostart off 失败: ${s1},${s2}`)
  const s3 = await cdp(wsUrl, `window.island.autostartSet(${s0})`)
  const s4 = await cdp(wsUrl, `window.island.autostartGet()`)
  if (s4 !== s0) throw new Error(`autostart 恢复失败: 期望 ${s0} 实际 ${s4}`)
  console.log(`[5] 开机自启开关读写正常（初始=${s0}，已恢复）✓`)

  console.log('E2E M5 PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
