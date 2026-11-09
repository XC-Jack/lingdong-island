// e2e-code-hint.mjs —— US-039 验证码提示自动化断言
// 流程：启动 dev（收起态）→
//   C1 Set-Clipboard '482913' → 3s 内 .code-banner 出现且内容正确
//   C2 写普通网址 → 5s 内不弹新横幅（C1 横幅自然过期后验证）
//   C4 长文本无关键词含数字 → 不弹
//   C5 横幅 8s 自动消失、窗口高度还原
//   C3 同码 30s 抑制 → 用快路径验证：弹过 482913 消失后（>8s）立即再写 482913 → 不弹
//   C6 短文本带关键词 '验证码 7731' → 弹且内容 7731
import { spawn, execFileSync } from './isolate-userdata.mjs'
import { join } from 'node:path'

const ROOT = 'D:/Users/honor/Documents/Project/灵动岛'
const PORT = 9321

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

function setClip(text) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-EncodedCommand', Buffer.from(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`, 'utf16le').toString('base64')],
    { timeout: 10_000 }
  )
}

function readClip() {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-EncodedCommand', Buffer.from('Get-Clipboard -Raw', 'utf16le').toString('base64')],
    { timeout: 10_000, encoding: 'utf8' }
  ).trim()
}

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

const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronExe, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await sleep(6000)
  // dev 启动默认收起态——不要点岛（点了会切展开态，展开态验证码不弹）。清剪贴板起始状态：
  setClip('placeholder-long-text-without-code-1234567890')
  await sleep(1500) // 让轮询吃掉占位文本（不匹配不弹）

  // C1 纯数字码
  setClip('482913')
  let found = false
  let text = ''
  for (let i = 0; i < 12; i++) {
    await sleep(250)
    const r = await cdpEval(`(() => { const el = document.querySelector('.code-banner'); return el ? el.querySelector('.banner-code-text').textContent : null })()`)
    if (r === '482913') { found = true; break }
    if (typeof r === 'string' && r !== '') text = r
  }
  ok('C1 复制 482913 → 3s 内弹验证码横幅', found, text ? `实际=${text}` : '')

  // C5a 等横幅自动消失（8s）+ 还原
  await sleep(8500)
  const gone = await cdpEval(`document.querySelector('.code-banner') === null`)
  ok('C5a 8s 后横幅消失', gone === true)

  // C4 长文本无关键词含数字 → 不弹
  setClip('订单号 202411073355 已发货请查收附件')
  await sleep(2500)
  const noFalse = await cdpEval(`document.querySelector('.code-banner') === null`)
  ok('C4 长文本无关键词不弹', noFalse === true)

  // C2 普通网址 → 不弹
  setClip('https://example.com/some/page')
  await sleep(2500)
  const noUrl = await cdpEval(`document.querySelector('.code-banner') === null`)
  ok('C2 普通网址不弹', noUrl === true)

  // C3 同码 30s 抑制：C1 的 482913 在 ~13s 前弹过 → 再写同码应被抑制
  setClip('482913')
  await sleep(2500)
  const suppressed = await cdpEval(`document.querySelector('.code-banner') === null`)
  ok('C3 同码 30s 内不重弹', suppressed === true)

  // C6 短文本带关键词
  setClip('验证码 7731')
  found = false
  for (let i = 0; i < 12; i++) {
    await sleep(250)
    const r = await cdpEval(`(() => { const el = document.querySelector('.code-banner'); return el ? el.querySelector('.banner-code-text').textContent : null })()`)
    if (r === '7731') { found = true; break }
  }
  ok('C6 「验证码 7731」→ 弹且显示 7731', found)

  // C5b 点击横幅 → 复制验证码到剪贴板（不关闭，显示「已复制」，照常 8s 计时）
  await sleep(500)
  // 先用无关文本占位剪贴板，验证点击复制真的写入了
  setClip('placeholder-before-copy')
  await sleep(1300) // 让轮询吃掉占位文本
  await cdpEval(`(() => { const el = document.querySelector('.code-banner'); if (el) el.dispatchEvent(new MouseEvent('click', {bubbles:true})); return true })()`)
  await sleep(800)
  const copiedText = readClip()
  const copiedBadge = await cdpEval(`document.querySelector('.code-banner .banner-code-copied')?.textContent ?? null`)
  const stillOpen = await cdpEval(`document.querySelector('.code-banner') !== null`)
  ok('C8 点击横幅复制验证码到剪贴板', copiedText === '7731', `clip=${copiedText}`)
  ok('C8b 点击后显示「已复制」且横幅不关闭', copiedBadge === '已复制' && stillOpen === true, `badge=${copiedBadge} open=${stillOpen}`)
  // 点击后等 8s 计时结束，横幅应自动收回
  await sleep(8300)
  const closedAfterCopy = await cdpEval(`document.querySelector('.code-banner') === null`)
  ok('C8c 复制后 8s 计时照常收回', closedAfterCopy === true)

  // C7 收起窗口高度：横幅系列改版后收起窗口常驻 COLLAPSED_WIN_HEIGHT=88（胶囊+横幅预留区，
  // set-banner-visible 已是空操作），验证码横幅不需要主进程加高
  const h = await cdpEval(`window.innerHeight`)
  ok('C7 收起窗口常驻高度(≤90)', typeof h === 'number' && h <= 90, `innerHeight=${h}`)
} catch (e) {
  fail++
  console.log('  ✗ 异常:', e.message)
} finally {
  child.kill()
  console.log(`\n结果: ${pass} 过 / ${fail} 败`)
  process.exit(fail > 0 ? 1 : 0)
}
