#!/usr/bin/env node
/**
 * e2e SPEC-deskpet-out：桌宠出岛（独立小窗口）
 *
 * P1  默认没有 petMode → 不出宠物窗口，岛里岛仔照常（.collapsed-pet 计数 1）
 * P2  设置页「独立小窗口」不再是禁用态，也没有「还没做」标签
 * P3  点它 → prefs.json 落盘 petMode=window
 * P4  → 出现一个 URL 含 pet.html 的渲染进程
 * P5  → 岛里 .collapsed-pet 计数变 0（它出门了，不能出现两只）
 * P6  → 宠物窗口里 .pet-wrap 的 data-pet-size=full，渲染宽度 > 100
 * P7  切皮肤 → 宠物窗口里的形象跟着换（它出门了也得换衣服）
 * P8  首次出现的默认位置在主屏右下（x 过了屏幕中线，y 过了中线）
 * P9  按住再松手 → prefs.json 的 petWindowPos 落盘，且等于窗口当前 bounds（±2）
 * P10 重启 → 宠物窗口出现在记录的位置（±2）
 * P11 prefs 里写一个屏幕外的坐标 → 重启后被 clamp 回工作区内（不会「丢了找不回来」）
 * P12 切回「只在岛里」→ 宠物窗口消失、岛里岛仔回来、petMode 落盘 island
 * P13 「自由走动」已放开：点它落盘 petMode=free、开宠物窗口、窗口自己横向移动、
 *      宽度不漂移、渲染层收到方向；随后切回 island 关窗（P14 的前提是窗口关着）
 *
 * 跑前：npm run build（e2e 加载 out/ 产物）。脚本自己启停 electron，结束恢复 prefs。
 * CDP 9321 / 主进程 inspect 9229；spawn 时 delete ELECTRON_RUN_AS_NODE。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9321
const INSPECT_PORT = 9229
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')

const DEFAULT_ORDER = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- CDP（渲染层） ----------
const IS_SETTINGS = (t) => (t.url ?? '').includes('settings.html')
const IS_PET = (t) => (t.url ?? '').includes('pet.html')

async function listTargets() {
  try {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === 'page')
  } catch {
    return [] // 端口还没起，等价于「没有」
  }
}

/**
 * 在指定窗口上求值。kind: 'island' | 'settings' | 'pet'
 *
 * 为什么不复用 e2e-head-order 那种「一个布尔 wantSettings」：现在有三个页面了，
 * 布尔表达不了，而且判断「某窗口是不是已经关掉」时不能用带重试的版本
 * （那是 40×500ms 的假等待），所以拆出裸查询 hasTarget。
 */
const MATCH = {
  island: (t) => !IS_SETTINGS(t) && !IS_PET(t),
  settings: IS_SETTINGS,
  pet: IS_PET
}

async function evalOn(expr, kind) {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await listTargets()
      const page = pages.find(MATCH[kind])
      if (!page) throw new Error(`no ${kind} target`)
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('cdp timeout')), 15000)
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }))
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); ws.close(); res(m.result) } }
        ws.onerror = rej
      })
      if (r?.exceptionDetails) throw new Error('eval 异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r?.result?.value
    } catch (e) {
      if (i === 39) throw e
    }
    await sleep(500)
  }
}
const islandEval = (expr) => evalOn(expr, 'island')
const settingsEval = (expr) => evalOn(expr, 'settings')
const petEval = (expr) => evalOn(expr, 'pet')

async function hasTarget(kind) {
  const pages = await listTargets()
  return pages.some(MATCH[kind])
}

/** 等某窗口出现/彻底消失 */
async function waitForTarget(kind, present, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if ((await hasTarget(kind)) === present) return
    await sleep(60)
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms）`)
}

/** 等宠物窗口里某个表达式为真 */
async function waitPetExpr(expr, { timeoutMs = 10000, gapMs = 100, label = expr } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    if (await hasTarget('pet')) {
      try {
        last = await petEval(expr)
        if (last) return last
      } catch (e) {
        last = '异常：' + (e?.message ?? e)
      }
    } else {
      last = '宠物窗口还没出现'
    }
    await sleep(gapMs)
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms），最后观察到：${JSON.stringify(last)}`)
}

/** 等 prefs.json 满足条件 */
async function waitForPrefs(pred, timeoutMs, label) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    try {
      const p = readPrefs()
      last = p
      if (pred(p)) return p
    } catch (e) {
      last = '读 prefs 失败：' + (e?.message ?? e)
    }
    await sleep(50)
  }
  throw new Error(`等「${label}」超时（${timeoutMs}ms），最后观察到：${JSON.stringify(last)}`)
}

// ---------- Inspector（主进程） ----------
/**
 * 主进程里求值。用 includeCommandLineAPI 让 `require` 可见（美化-02 踩过）。
 * 这里只用它读窗口几何和屏幕工作区——窗口位置只有主进程知道，CDP 拿不到。
 */
async function mainEval(expr) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()
      const t = list[0]
      if (!t) throw new Error('no main target')
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('main timeout')), 15000)
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }))
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); ws.close(); res(m.result) } }
        ws.onerror = rej
      })
      if (r?.exceptionDetails) throw new Error('main eval 异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
      return r?.result?.value
    } catch (e) {
      if (i === 39) throw e
    }
    await sleep(500)
  }
}

/** 宠物窗口的屏幕矩形（主进程视角；窗口没开时返回 {none:true}） */
async function petBounds() {
  return JSON.parse(await mainEval(`(()=>{
    const { BrowserWindow } = require('electron');
    const w = BrowserWindow.getAllWindows().find(x => (x.webContents.getURL() || '').includes('pet.html'));
    if (!w) return JSON.stringify({ none: true });
    const r = w.getBounds();
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height })
  })()`))
}

/** 主显示器工作区 */
async function workArea() {
  return JSON.parse(await mainEval(
    `JSON.stringify(require('electron').screen.getPrimaryDisplay().workArea)`
  ))
}

/**
 * 把真实光标挪动 (dx, dy) 像素。
 *
 * 为什么必须动真光标：拖动的位移是**主进程**每 16ms 读
 * `screen.getCursorScreenPoint()` 跟光标起点比出来的，不是渲染层算的。
 * 只派发 pointerdown 而不挪光标，主进程算出的位移恒为 0，窗口纹丝不动——
 * 那样测「能不能拖走」永远是一条假绿。
 *
 * 用 Windows 原生 `SetCursorPos`（user32），不引额外依赖。
 * 注意主进程读回的单位是物理像素（实测 125% 缩放下与 Windows
 * `Cursor.Position` 完全一致），所以这里的 dx/dy 也按物理像素给。
 */
async function moveCursorBy(dx, dy) {
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;` +
      `Add-Type -AssemblyName System.Drawing;` +
      `$p=[System.Windows.Forms.Cursor]::Position;` +
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(($p.X+${dx}),($p.Y+${dy}))"`,
    { stdio: 'ignore' }
  )
}

/**
 * 把真实光标挪到屏幕绝对坐标 (x, y)。
 *
 * 用途：验「把手平时看不见」时必须让光标**不在**宠物窗口上——
 * 只要光标悬在窗口上，`.petwin:hover` 就会让把手淡入成 opacity 1，
 * 那条断言会随用户当前鼠标位置随机红绿（假失败最难查）。
 */
async function setCursor(x, y) {
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;` +
      `Add-Type -AssemblyName System.Drawing;` +
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})"`,
    { stdio: 'ignore' }
  )
}

// ---------- 启停 ----------
function killApp() {
  try { execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' }) } catch { /* 无进程 */ }
}

/**
 * 等到 React 首帧真的把岛挂上再往下走。
 * 固定 sleep 会让第一条断言读到空 DOM（实测本机起进程到 .island.collapsed 出现要 4 秒以上）。
 */
async function waitReady() {
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      if (await islandEval(`!!document.querySelector('.island.collapsed')`)) return
    } catch { /* CDP 还没就绪 */ }
    await sleep(200)
  }
  throw new Error('等岛挂载超时')
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 宿主注入会把 electron 跑成纯 Node，秒退
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  await sleep(1200)
  await waitReady()
  return child
}

async function stopApp(child) {
  try { child.kill('SIGKILL') } catch { /* 已退 */ }
  killApp()
  await sleep(1200)
}

const readPrefs = () => JSON.parse(readFileSync(PREFS, 'utf8'))
function writePrefs(extra = {}) {
  writeFileSync(PREFS, JSON.stringify({
    musicIntro: true,
    pagesCustom: {
      pages: [0, 1, 2, 3, 4],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
      order: DEFAULT_ORDER
    },
    ...extra
  }, null, 2), 'utf8')
}

/** 打开设置窗口并等到目标分区渲染出来 */
async function openSettings(section, waitExpr) {
  await islandEval(`(window.island.openSettings('${section}'), 'ok')`)
  await waitForTarget('settings', true, 15000, '设置窗口出现')
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    try {
      if (await settingsEval(waitExpr)) return
    } catch { /* 还在加载 */ }
    await sleep(100)
  }
  throw new Error('等设置窗口内容超时：' + waitExpr)
}

/**
 * 关掉设置窗口（收尾用）。
 *
 * 为什么要 try/catch 兜一层：`hasTarget` 查到窗口在、到真正发 eval 之间有一个空档，
 * 窗口可能已经自己关了（用户在测、或上一轮的 close 正在生效）。这时候
 * `settingsEval` 会连重试 40 次都报 `no settings target`——明明已经达成目的（窗口没了），
 * 却算成失败。这里把「已经关了」当成成功，只等最终状态。
 */
async function closeSettings() {
  if (await hasTarget('settings')) {
    try {
      await settingsEval(`(window.island.closeSettings(), 'ok')`)
    } catch {
      /* 窗口在查询与求值之间自己关了——目的已达成，不当作失败 */
    }
  }
  await waitForTarget('settings', false, 10000, '设置窗口关闭')
}

/** 岛里岛仔的数量（window 模式下应当是 0） */
const islandPetCount = () => islandEval(`document.querySelectorAll('.collapsed-pet').length`)
const islandPetSkin = () => islandEval(`document.querySelector('.pet-wrap')?.dataset.petSkin ?? ''`)

/** 等岛仔数量变成期望值 */
async function waitIslandPetCount(want, timeoutMs = 6000) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await islandPetCount()
    if (last === want) return last
    await sleep(100)
  }
  return last
}

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null

try {
  mkdirSync(USER_DATA, { recursive: true })
  killApp(); await sleep(800)

  // ========== P1 默认没有 petMode ==========
  {
    writePrefs()
    child = await startApp()
    const count = await waitIslandPetCount(1)
    ok('P1a 默认（无 petMode）岛里岛仔照常渲染', count === 1, `实际 ${count}`)
    const hasPetWin = await hasTarget('pet')
    ok('P1b 默认不打开宠物窗口', hasPetWin === false, `实际 ${hasPetWin}`)
    const mode = readPrefs().petMode
    ok('P1c 读默认不该把 petMode 写死进 prefs.json', mode === undefined, `实际 ${JSON.stringify(mode)}`)
  }

  // ========== P2 设置页「独立小窗口」可点 ==========
  let area
  {
    await openSettings('pet', `!!document.querySelector('.pet-set-mode[data-mode="window"]')`)
    area = await workArea()
    const info = JSON.parse(await settingsEval(`(()=>{
      const e = document.querySelector('.pet-set-mode[data-mode="window"]');
      return JSON.stringify({disabled: e.disabled, soon: !!e.querySelector('.pet-set-soon'),
        on: e.classList.contains('on')})
    })()`))
    ok('P2a「独立小窗口」不再是禁用态', info.disabled === false, JSON.stringify(info))
    ok('P2b「独立小窗口」不再标「还没做」', info.soon === false, JSON.stringify(info))
    const free = JSON.parse(await settingsEval(`(()=>{
      const e = document.querySelector('.pet-set-mode[data-mode="free"]');
      return JSON.stringify({disabled: e.disabled, soon: !!e.querySelector('.pet-set-soon')})
    })()`))
    ok('P2c「自由走动」已可用且不再标「还没做」（SPEC-deskpet-walk 放开）',
      free.disabled === false && free.soon === false, JSON.stringify(free))
  }

  // ========== P3–P8 切到独立小窗口 ==========
  {
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="window"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petMode === 'window', 8000, '落盘 petMode=window')
    ok('P3 点「独立小窗口」后 prefs.json 落盘 petMode=window', true)

    await waitForTarget('pet', true, 15000, '宠物窗口出现')
    ok('P4 出现 URL 含 pet.html 的渲染进程', true)
    // 验收条件 2 的后半句：岛不能因为开了宠物窗口就没了
    ok('P4b 岛窗口仍在（两个窗口共存，不是替换）', await hasTarget('island'), '岛 target 不见了')

    const count = await waitIslandPetCount(0)
    ok('P5 岛里的岛仔消失了（它出门了，不能出现两只）', count === 0, `实际 ${count}`)

    const full = await waitPetExpr(`(()=>{
      const w = document.querySelector('.pet-wrap');
      if (!w) return '';
      const r = w.getBoundingClientRect();
      return JSON.stringify({size: w.dataset.petSize, w: Math.round(r.width), h: Math.round(r.height)})
    })()`, { label: '宠物窗口里画出大尺寸桌宠' })
    const f = JSON.parse(full)
    ok('P6a 宠物窗口用的是大尺寸画法（data-pet-size=full）', f.size === 'full', JSON.stringify(f))
    ok('P6b 桌宠在窗口里真的铺开了（渲染宽度 > 100）', f.w > 100, JSON.stringify(f))

    // 切皮肤 → 宠物窗口跟着换
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="bean"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petSkin === 'bean', 8000, '落盘 petSkin=bean')
    const skin = await waitPetExpr(
      `(document.querySelector('.pet-wrap')?.dataset.petSkin === 'bean') ? 'bean' : ''`,
      { label: '宠物窗口换皮肤' }
    )
    ok('P7 换皮肤后宠物窗口里的形象同步换（出门了也得换衣服）', skin === 'bean', `实际 ${skin}`)
    // 换回胶囊，别把测试值留在用户偏好里
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="capsule"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petSkin === 'capsule', 8000, '落盘 petSkin=capsule')

    const b = await petBounds()
    ok('P8 首次出现的默认位置在主屏右下（离贴顶居中的岛最远）',
      !b.none && b.x > area.x + area.width / 2 && b.y > area.y + area.height / 2,
      JSON.stringify({ bounds: b, workArea: area }))
  }

  // ========== P9 按住再松手 → 位置落盘 ==========
  {
    // 不真的移动鼠标（CDP 做不到），而是走一遍 pointerdown → pointerup 的真实路径：
    // 主进程在 drag-start 记下起点，drag-end 时把「当前 bounds」落盘。
    // 光标没动，所以落盘的应当就是当前 bounds——正好用来验「松手会存」这件事。
    const before = await petBounds()
    await petEval(`(()=>{
      const el = document.querySelector('.petwin');
      const opts = { bubbles: true, button: 0, pointerId: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      return 'ok'
    })()`)
    const p = await waitForPrefs((x) => !!x.petWindowPos, 8000, '落盘 petWindowPos')
    ok('P9a 松手后 prefs.json 记下了窗口位置', !!p.petWindowPos, JSON.stringify(p.petWindowPos))
    ok('P9b 记下的位置就是窗口当前所在（±2px）',
      Math.abs(p.petWindowPos.x - before.x) <= 2 && Math.abs(p.petWindowPos.y - before.y) <= 2,
      JSON.stringify({ recorded: p.petWindowPos, bounds: before }))
  }

  // ========== P9c 按住期间窗口不能变大（回归：2026-11-12 修的 setPosition 尺寸漂移） ==========
  {
    // 这条是用户报的「按住它就一直变大、还往下移动」bug 的回归测试。
    // 根因：拖动定时器每 16ms 调一次 w.setPosition(x, y)，而 setPosition 只给坐标，
    // 在 125% 缩放下 Electron 每次都要做 DIP↔物理像素换算，余数被并进窗口尺寸，
    // 于是每调一次长 1px。实测 200 次从 191×191 长到 391×391。
    // 修法：改用 setBounds 并显式带上 width/height。
    //
    // 判据只看「按住期间自己的波动」（max - min），不跟按住前的值比：
    // 本机 125% 缩放下，190×190 设进去读回来可能是 191 或 194，这个取整本身就不稳定。
    // 而漂移的特征是持续单调增长——按住 1.2 秒约 75 次调用，若没修就是 +75px，一眼可辨。
    await petEval(`(()=>{
      const el = document.querySelector('.petwin');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
      return 'ok'
    })()`)

    const samples = []
    for (let i = 0; i < 6; i++) {
      await sleep(200)
      const b = await petBounds()
      if (!b.none) samples.push([b.width, b.height])
    }

    await petEval(`(()=>{
      const el = document.querySelector('.petwin');
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
      return 'ok'
    })()`)
    await sleep(300)

    const ws = samples.map((s) => s[0])
    const hs = samples.map((s) => s[1])
    const growW = Math.max(...ws) - Math.min(...ws)
    const growH = Math.max(...hs) - Math.min(...hs)

    ok('P9c 按住 1.2 秒窗口尺寸没有持续变大（setPosition 尺寸漂移回归）',
      samples.length >= 4 && growW <= 1 && growH <= 1,
      JSON.stringify({ 按住期间采样: samples, '波动(宽,高)': [growW, growH], 说明: '未修时这里会是 +70 以上' }))
  }

  // ========== P9d 原图皮肤呼吸时头不能被画布裁掉（2026-11-12 用户反馈的回归） ==========
  {
    // 用户原话：「他呼吸的时候，头的上半部分就会被遮住」。
    // 根因：所有动画都以脚底为轴往上长（呼吸 scaleY 1.025、开心 translateY -6%、
    // 惊讶 scaleY 1.05），而图几乎顶满 160 的画布，一放大就冲出 viewBox 上边界被裁。
    // 修法见 src/renderer/src/pet/skinPhoto.tsx 的 PAD_TOP。
    //
    // 为什么不用截图判：裁切只发生在动画峰值，截图很容易抓在 0% 相位看不出来。
    // 这里把动画暂停后逐相位拨过去，直接量「图片顶边 vs 画布顶边」的几何关系。
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="photo"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petSkin === 'photo', 8000, '落盘 petSkin=photo')
    await waitPetExpr(
      `(document.querySelector('.pet-wrap')?.dataset.petSkin === 'photo') ? 'photo' : ''`,
      { label: '宠物窗口换成原图皮肤' }
    )

    const raw = await waitPetExpr(`(()=>{
      const svg = document.querySelector('.pet-full');
      const img = document.querySelector('.pet-photo-img');
      if (!svg || !img) return '';

      const anims = document.getAnimations();
      anims.forEach((a) => a.pause());

      const samples = [];
      const DUR = 3600;
      for (let i = 0; i <= 8; i++) {
        const t = (DUR / 8) * i;
        anims.forEach((a) => { a.currentTime = t });
        void svg.getBoundingClientRect();   // 强制同步布局，让 transform 落地
        const c = svg.getBoundingClientRect();
        const r = img.getBoundingClientRect();
        samples.push(+(c.top - r.top).toFixed(2));   // >0 表示图片顶边冲出画布
      }
      anims.forEach((a) => a.play());
      return JSON.stringify(samples);
    })()`, { label: '拨呼吸相位量裁切' })

    const overflows = JSON.parse(raw)
    const worst = Math.max(...overflows)
    // 阈值 0.5px：0 附近的小数来自亚像素取整，不是真的裁
    ok('P9d 原图皮肤呼吸全程头部没有被画布裁掉（图片顶边始终在 viewBox 内）',
      worst <= 0.5,
      JSON.stringify({ 各相位冲出量: overflows, 最大冲出: worst, 说明: '未修时峰值冲出约 4.6px' }))

    // ========== P9e 四视图转身（2026-11-12 新增：正面/侧左/背面/侧右） ==========
    {
      // 三张抠图（正面 310×515、侧面 230×521、背面 322×518）原始高度差很多，
      // 按「统一图片高度」摆位才对得上，否则转身时会一抽一抽地长高。
      // 这里量两件事：四层都在且等高；data-turn-view 真的会按顺序轮换。
      const layers = JSON.parse(await waitPetExpr(`(()=>{
        const ls = [...document.querySelectorAll('.pet-photo-layer')];
        if (ls.length !== 4) return '';
        return JSON.stringify(ls.map((l) => {
          const b = l.getBoundingClientRect();
          return { k: l.dataset.layer, h: +b.height.toFixed(1), y: +b.y.toFixed(1) };
        }))
      })()`, { label: '四视图层就位' }))

      ok('P9e-1 原图皮肤有四个视图层（正面/侧左/背面/侧右）',
        layers.map((l) => l.k).join(',') === 'front,side-l,back,side-r',
        JSON.stringify(layers.map((l) => l.k)))

      const hs = layers.map((l) => l.h)
      const ys = layers.map((l) => l.y)
      ok('P9e-2 四个视图等高（差 ≤ 1px，转身时不会忽高忽低）',
        Math.max(...hs) - Math.min(...hs) <= 1,
        JSON.stringify({ 各层高: hs, 差: +(Math.max(...hs) - Math.min(...hs)).toFixed(1) }))
      ok('P9e-3 四个视图脚底对齐（顶边 y 一致）',
        Math.max(...ys) - Math.min(...ys) <= 1,
        JSON.stringify({ 各层顶边: ys }))

      // 整圈转身（`pet:turn`）：留给 e2e 与以后的「点它一下」动作。
      // 自动转身已在 2026-11-12 第二轮删掉（用户嫌 22 秒转一次怪），
      // 所以这里必须显式触发，不能等。
      await petEval(`(window.dispatchEvent(new Event('pet:turn')), 'ok')`)
      const seq = []
      for (let i = 0; i < 34; i++) {
        const v = await petEval(`document.querySelector('.pet-full')?.dataset.turnView || ''`)
        if (v && seq[seq.length - 1] !== v) seq.push(v)
        await sleep(60)
      }
      ok('P9e-4 整圈转身按 正面→侧左→背面→侧右→正面 轮换',
        seq.join(',') === 'front,side-l,back,side-r,front',
        JSON.stringify({ 序列: seq, 说明: 'TURN_STEP_MS=260，四步约 1.05 秒' }))

      // ========== P9f 底部旋转把手转身（用户第三轮要求的功能） ==========
      //
      // 用户原话「我希望桌宠的下面有一个旋转的图标，按住它拖动鼠标可以旋转，
      // 平时碰到桌宠时图标才显现」。
      //
      // 2026-11-12 第三轮起：**移动和转身拆成两个把手**。
      // 按住身体 (.petwin) = 挪位置；按住底部图标 (.pet-rotor) = 原地转身。
      // 所以下面派发事件的元素从 `.petwin` 改成了 `.pet-rotor`。
      //
      // 这里不真移鼠标（CDP 做不到跨窗口的 screenX），而是派发带 screenX 的
      // PointerEvent 走真实处理路径——`onRotorMove` 读的就是 `e.screenX`。
      //
      // 注意：窗口会跟着光标走，`clientX` 全程不变，只有 `screenX` 在动。
      // 所以合成事件里必须给 screenX 赋值，给 clientX 是测不出来的。
      const viewNow = () => petEval(`document.querySelector('.pet-full')?.dataset.turnView || ''`)

      // 把手存在且默认不可见（opacity 0）——「平时碰到桌宠时图标才显现」
      //
      // 先把真实光标挪到屏幕左上角：只要光标悬在宠物窗口上，`.petwin:hover`
      // 就会让把手淡入成 opacity 1，这条断言会随用户当前鼠标位置随机红绿。
      await setCursor(2, 2)
      await sleep(300)
      const rotorInfo = await petEval(`(()=>{
        const r = document.querySelector('.pet-rotor');
        if (!r) return JSON.stringify({ 存在: false });
        const cs = getComputedStyle(r);
        const b = r.getBoundingClientRect();
        // 当前正在显示的那一张图（拿到它的矩形，用来判断图标有没有压到宠物身上）
        const on = document.querySelector('.pet-photo-layer.is-on') || document.querySelector('.pet-full');
        const ib = on ? on.getBoundingClientRect() : null;
        return JSON.stringify({
          存在: true,
          不透明度: cs.opacity,
          宽: Math.round(b.width),
          高: Math.round(b.height),
          底部: Math.round(b.bottom),
          左: Math.round(b.left),
          右: Math.round(b.right),
          顶: Math.round(b.top),
          宠物左: ib ? Math.round(ib.left) : null,
          宠物右: ib ? Math.round(ib.right) : null,
          宠物底: ib ? Math.round(ib.bottom) : null
        })
      })()`)
      const rotor = JSON.parse(rotorInfo)
      ok('P9f-1 底部有旋转图标，且鼠标不在宠物身上时不可见（opacity 0）',
        rotor.存在 === true && Number(rotor.不透明度) === 0,
        rotorInfo)

      // 2026-11-12 用户反馈两轮：「图标在往下移，有点遮住脚了」→「我希望在奶娃的下面」。
      // 第一版 `left:50%; bottom:4px` 居中贴底，190×190 的窗口里脚底到 187，
      // 那个位置必然盖住脚趾；改成右下角避开了，但用户要的是「正下方居中」。
      // 最终解法是把窗口加高（PET_WIN_H 190→250，加的是透明留白、宠物尺寸不变），
      // 多出来的下方空间正好放这个圆。
      //
      // 所以这条断言要测三件事：
      //   ① 把手完全在宠物下方（垂直方向不重叠）——遮脚就是垂直重叠
      //   ② 水平方向与宠物大致居中对齐——这是「在下面」而不是「歪在一边」
      //   ③ 不超出窗口底边
      // 注意别再只测「把手底部 >= 180」：那个值在居中贴底的旧版里是 187，
      // 比现在还大，旧版照样能过——那条断言测不出任何东西（本轮实测确认）。
      //
      // `overlapY` 是「宠物底边 − 把手顶边」：> 0 就是把手插进宠物身体里，
      // <= 0 才是把手整个落在宠物下方。窗口高度没加够时它会变成正数
      // （190 高的窗口里实测 +16），所以这条断言同时守着「窗口够不够高」。
      const overlapY = rotor.顶 !== null && rotor.宠物底 !== null
        ? rotor.宠物底 - rotor.顶
        : null
      const rotorCenterX = (rotor.左 + rotor.右) / 2
      const petCenterX = (rotor.宠物左 + rotor.宠物右) / 2
      const centerOff = Math.abs(rotorCenterX - petCenterX)
      ok('P9f-2 旋转图标在宠物正下方居中，且完全没压在宠物身上（不遮脚）',
        rotor.存在 === true && rotor.宽 > 0 && rotor.高 > 0 &&
          rotor.左 >= 0 && rotor.右 <= 194 &&
          overlapY !== null && overlapY <= 0 && centerOff <= 4,
        JSON.stringify({
          图标: { 左: rotor.左, 右: rotor.右, 顶: rotor.顶, 底部: rotor.底部 },
          宠物: { 左: rotor.宠物左, 右: rotor.宠物右, 底: rotor.宠物底 },
          压入量: overlapY,
          水平中心偏差: +centerOff.toFixed(1),
          说明: '压入量 = 宠物底 − 把手顶，> 0 就是压在身上；中心偏差 <= 4 表示正下方居中'
        }))

      // 「鼠标碰到桌宠时图标才显现」——hover 才淡入。
      //
      // 为什么用源码断言而不是运行时读样式：CDP 的合成事件不会真的移动系统光标，
      // 也就不会触发 `:hover`（`:hover` 由浏览器合成器按真实指针位置算）。
      // 这里只能确认规则在、且用的不是 `pointer-events: none` 那种会让把手
      // 永远碰不到的写法——那样「显现」永远不发生，是最容易写错的地方。
      const petwinCss = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'petwin', 'petwin.css'), 'utf8')
      const hoverRule = /\.petwin:hover \.pet-rotor\s*\{[^}]*opacity:\s*1/.test(petwinCss)
      const rotorBaseOpacity = /\.pet-rotor\s*\{[^}]*opacity:\s*0/.test(petwinCss)
      const noPointerEventsNone = /\.pet-rotor\s*\{[^}]*pointer-events:\s*none/.test(petwinCss)
      ok('P9f-3 把手只在 hover 时显现（平时 opacity 0，悬停变 1）',
        hoverRule && rotorBaseOpacity,
        JSON.stringify({ 悬停规则: hoverRule, 基础透明: rotorBaseOpacity }))
      ok('P9f-4 把手没有禁用指针事件（否则永远碰不到、也就永远不显现）',
        noPointerEventsNone === false,
        noPointerEventsNone ? '禁用了 pointer-events，hover 永远不会触发' : 'ok')

      const rotorTurn = async (dx) => {
        await petEval(`(()=>{
          const el = document.querySelector('.pet-rotor');
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, isPrimary: true, screenX: 500 }));
          el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 2, isPrimary: true, screenX: ${500 + dx} }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 2, isPrimary: true, screenX: ${500 + dx} }));
          return 'ok'
        })()`)
        await sleep(120)
        return viewNow()
      }

      // 往右拖 110px = 顺时针四分之一圈 = 露出右脸（side-r 在 VIEWS 里是下标 3）
      ok('P9f-5 按住旋转图标往右拖一格，露出右脸（顺时针）',
        (await rotorTurn(110)) === 'side-r',
        JSON.stringify({ 实际: await viewNow() }))

      // 再往右拖一格 = 转半圈 = 背面
      ok('P9f-6 再往右拖一格，转到背面',
        (await rotorTurn(110)) === 'back',
        JSON.stringify({ 实际: await viewNow() }))

      // 往左拖两格 = 从背面转回正面
      ok('P9f-7 往左拖两格，转回正面',
        (await rotorTurn(-220)) === 'front',
        JSON.stringify({ 实际: await viewNow() }))

      // 少拖一点（半格不到）不该换面——防止手抖就转
      await petEval(`(window.dispatchEvent(new CustomEvent('pet:turn-abs', { detail: 0 })), 'ok')`)
      await sleep(100)
      ok('P9f-8 拖不到半格不动（避免手抖就转）',
        (await rotorTurn(50)) === 'front',
        JSON.stringify({ 实际: await viewNow() }))

      // **关键回归**：按住把手时不能同时把窗口拖走。
      // 这是拆分两个把手的全部意义——转个身却把宠物拖着跑，是最容易写错的地方
      // （忘了 stopPropagation 就会这样，而且看起来像「窗口在乱跳」）。
      const posBefore = await petBounds()
      await petEval(`(()=>{
        const el = document.querySelector('.pet-rotor');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, isPrimary: true, screenX: 500 }));
        return 'ok'
      })()`)
      await sleep(700)
      await petEval(`(()=>{
        const el = document.querySelector('.pet-rotor');
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 2, isPrimary: true, screenX: 500 }));
        return 'ok'
      })()`)
      await sleep(300)
      const posAfter = await petBounds()
      ok('P9f-9 按住旋转图标不会把窗口拖走（两个把手互不干扰）',
        !posBefore.none && !posAfter.none &&
          Math.abs(posBefore.x - posAfter.x) <= 2 && Math.abs(posBefore.y - posAfter.y) <= 2,
        JSON.stringify({ 转之前: posBefore, 转之后: posAfter }))

      // 但按住**身体**仍然要能拖走窗口（别把原来的功能弄丢了）
      //
      // 先把光标钉到一个已知位置再按下：前面 P9f-1 为了验「把手平时看不见」
      // 把光标挪到过 (2,2)，中间几步又各自动过光标，起点不可预测。
      // 万一光标贴在屏幕右/下边缘，`moveCursorBy(60,40)` 会被 Windows
      // 自己的边界钳住而不动（实测就是这么撞上一次只走了 6px 的假红）。
      const areaDrag = await workArea()
      await setCursor(areaDrag.x + 200, areaDrag.y + 200)
      await sleep(150)
      const posDragBefore = await petBounds()
      await petEval(`(()=>{
        const el = document.querySelector('.petwin');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 3, isPrimary: true, screenX: 500 }));
        return 'ok'
      })()`)
      // 必须等主进程真正收到 pet:drag-start 再挪光标。
      // 主进程是在收到 IPC 的那一刻读 `screen.getCursorScreenPoint()` 当基准点的；
      // 如果光标先动、IPC 后到，基准点已经是移动后的位置，算出的位移恒为 0，
      // 窗口纹丝不动——这条断言就会随机红（2026-11-13 实测偶发一次）。
      await sleep(250)
      await moveCursorBy(60, 40)
      await sleep(600)
      await petEval(`(()=>{
        const el = document.querySelector('.petwin');
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 3, isPrimary: true, screenX: 560 }));
        return 'ok'
      })()`)
      await sleep(300)
      const posDragAfter = await petBounds()
      ok('P9f-10 按住身体仍然能把窗口拖走（原功能没被拆坏）',
        !posDragBefore.none && !posDragAfter.none &&
          (Math.abs(posDragAfter.x - posDragBefore.x) >= 10 || Math.abs(posDragAfter.y - posDragBefore.y) >= 10),
        JSON.stringify({ 拖之前: posDragBefore, 拖之后: posDragAfter }))

      // 双击转回正面：转歪了想让它重新面对你
      await petEval(`(window.dispatchEvent(new CustomEvent('pet:turn-abs', { detail: 2 })), 'ok')`)
      await sleep(100)
      await petEval(`(document.querySelector('.petwin').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 'ok')`)
      await sleep(150)
      ok('P9f-11 双击转回正面', (await viewNow()) === 'front', JSON.stringify({ 实际: await viewNow() }))

      // 自动转身真的没了：等 3 秒，视图不该自己变（旧版 3 秒时必定转身）
      const idleView = await viewNow()
      await sleep(3000)
      ok('P9f-12 没人碰它的时候不会自己转身（自动节拍已删）',
        (await viewNow()) === idleView,
        JSON.stringify({ 等待前: idleView, 等待后: await viewNow() }))

      // ========== P9g 右键菜单里的「出岛」入口 ==========
      //
      // 用户原话「还有就是给右键添加一个出岛，不然每次都要点设置」。
      // 菜单是系统原生的、点了就弹，e2e 没法真的去点它（popup 不在 CDP 视野里），
      // 所以这里分两层：
      //   1. 源码断言：两个标签都在，且分别把 petMode 写成 window / island
      //      （和 P14a 查 skipTaskbar 是同一个套路：Electron 没有运行时 getter）；
      //   2. 行为断言：直接走 patchPrefs 的同一路径，确认切过去窗口真的开/关
      //      （P5 / P12 已经在测，这里只补「菜单那一层没接错」）。
      const menuSrc = readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8')
      const hasOutItem = menuSrc.includes("label: '让桌宠出岛…'") && menuSrc.includes("patchPrefs({ petMode: 'window' })")
      const hasBackItem = menuSrc.includes("label: '让桌宠回到岛里'") && menuSrc.includes("patchPrefs({ petMode: 'island' })")
      ok('P9g-1 右键菜单有「让桌宠出岛…」且它把 petMode 写成 window', hasOutItem,
        '菜单项与 patchPrefs 调用必须成对出现，只加标签不接线等于没做')
      ok('P9g-2 右键菜单有「让桌宠回到岛里」且它把 petMode 写成 island', hasBackItem,
        '已经出去了就该显示收回，一个开关比两个入口省事')

      // ========== P9h 点一下播「大笑」动作（SPEC-deskpet-action，2026-11-12 第五轮）==========
      //
      // 用户原话「我们就先做动作出来，我先看看效果，先不去管什么怎么触发它」。
      // 触发方式只做最简单的一种：**在它身上点一下**（按下到松手之间没有拖动）。
      //
      // 动画素材是 108 帧两行 sprite sheet（8586×440，WebP 744 KB），
      // 靠改 `<image>` 的 x/y 平移 + clipPath 只露一格来播放，帧号写在
      // `data-action-frame` 上，所以 e2e 不靠截图也能判断「有没有在动」。
      const actionNow = () => petEval(`document.querySelector('.petwin')?.dataset.petAction || ''`)
      const frameNow = () => petEval(`document.querySelector('.pet-full')?.dataset.actionFrame || ''`)

      /** 在宠物身上点一下（按下和松开同一位置，没有拖动） */
      const clickPet = async () => {
        await petEval(`(()=>{
          const w = document.querySelector('.petwin');
          const b = w.getBoundingClientRect();
          const x = Math.round(b.left + b.width / 2);
          const y = Math.round(b.top + b.height / 2);
          const o = { bubbles: true, button: 0, buttons: 1, pointerId: 7, isPrimary: true,
                      clientX: x, clientY: y, screenX: x, screenY: y };
          w.dispatchEvent(new PointerEvent('pointerdown', o));
          w.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
          return 'ok'
        })()`)
        await sleep(220)
      }

      // 先等回 idle 再断言。
      //
      // 动作状态是渲染层的一个 useState，前面任何一段（拖动被判成点击、
      // 或者用户此刻正在真人试玩右键菜单「打个滚」）都可能让它还在播——
      // 那样这条会在「点之前」读到一个不是 idle 的值，看起来像代码坏了，
      // 其实只是上一件事还没播完（2026-11-13 连跑三轮撞到过一次）。
      // 等回 idle 之后仍然断言 idle：真要是卡在某个动作上不复位，这里照样红。
      for (let i = 0; i < 45 && (await actionNow()) !== 'idle'; i++) await sleep(200)
      ok('P9h-0 点之前是 idle（没有残留动作）', (await actionNow()) === 'idle',
        JSON.stringify({ 实际: await actionNow() }))

      await clickPet()
      ok('P9h-1 在它身上点一下会开始播「大笑」',
        (await actionNow()) === 'laugh',
        JSON.stringify({ 实际: await actionNow() }))

      // 帧号推进：采 6 次 × 200ms，至少要看到 3 个不同的帧号才算真在动。
      // 只断言「frame 变了」不够——推一帧就停也能过；这里要的是持续推进。
      const frames = []
      for (let i = 0; i < 6; i++) {
        const f = await frameNow()
        if (f !== '' && frames[frames.length - 1] !== f) frames.push(f)
        await sleep(200)
      }
      ok('P9h-2 动作帧在持续推进（不是卡在第一帧）',
        frames.length >= 4,
        JSON.stringify({ 采样到的帧号: frames }))

      // 构图：动作格与站姿层水平居中、底边对齐。
      //
      // 为什么读 SVG 属性而不是 getBoundingClientRect：`<clipPath>` 里的元素
      // **不参与渲染**，`getBoundingClientRect()` 一律返回 0（实测第一版就这么假红）。
      // 这里改成读 x / y / width / height 这几个用户坐标属性——它们才是真正
      // 决定「露出来哪一块」的值，而且和站姿 `<image>` 的属性在同一坐标系里，
      // 可以直接比，不用换算 DPI。
      const align = await petEval(`(()=>{
        const clip = document.querySelector('clipPath rect');
        const stand = document.querySelector('.pet-photo-layer.is-on');
        if (!clip || !stand) return '';
        const n = (el, a) => Number(el.getAttribute(a));
        const cx = n(clip, 'x'), cy = n(clip, 'y'), cw = n(clip, 'width'), ch = n(clip, 'height');
        const sx = n(stand, 'x'), sy = n(stand, 'y'), sw = n(stand, 'width'), sh = n(stand, 'height');
        return JSON.stringify({
          动作: { 中心: +(cx + cw / 2).toFixed(2), 底: +(cy + ch).toFixed(2), 宽: +cw.toFixed(2), 高: +ch.toFixed(2) },
          站姿: { 中心: +(sx + sw / 2).toFixed(2), 底: +(sy + sh).toFixed(2), 宽: +sw.toFixed(2), 高: +sh.toFixed(2) }
        })
      })()`)
      const a2 = JSON.parse(align)
      const dCenter = Math.abs(a2.动作.中心 - a2.站姿.中心)
      const dBottom = Math.abs(a2.动作.底 - a2.站姿.底)
      ok('P9h-3 动作格与站姿水平居中对齐、底边一致（不会跳位或站到半空）',
        dCenter <= 1 && dBottom <= 1 && a2.动作.高 > 0,
        JSON.stringify({ 动作: a2.动作, 站姿: a2.站姿, 中心偏差: +dCenter.toFixed(2), 底边差: +dBottom.toFixed(2) }))

      // 播完自己回到 idle：动作是一次性的，不该永远笑下去。
      //
      // 这条必须在「拖一把不算点击」之前跑：P9h-1 那次笑要 7.2 秒才结束，
      // 如果不先等它结束就去做拖动测试，读到的是还在播的 laugh，
      // 会把「拖动没触发」误判成失败（顺序写反过一次）。
      const startedAt = Date.now()
      let backToIdle = false
      for (let i = 0; i < 60; i++) {
        if ((await actionNow()) === 'idle') {
          backToIdle = true
          break
        }
        await sleep(200)
      }
      ok('P9h-4 播完自动回到 idle（约 7.2 秒），动作层从 DOM 移除',
        backToIdle && (await petEval(`document.querySelectorAll('.pet-photo-action').length`)) === 0,
        JSON.stringify({
          实际: await actionNow(),
          动作层数: await petEval(`document.querySelectorAll('.pet-photo-action').length`),
          等待毫秒: Date.now() - startedAt
        }))

      // 按住拖一把不算点击：否则每挪一次位置它都笑一场（很吵，而且明显不对）。
      // 用 pointermove 报 40px 位移，再在同一位置松手。
      await petEval(`(window.dispatchEvent(new CustomEvent('pet:turn-abs', { detail: 0 })), 'ok')`)
      await sleep(200)
      await petEval(`(()=>{
        const w = document.querySelector('.petwin');
        const b = w.getBoundingClientRect();
        const x = Math.round(b.left + b.width / 2);
        const y = Math.round(b.top + b.height / 2);
        const o = { bubbles: true, button: 0, buttons: 1, pointerId: 8, isPrimary: true,
                    clientX: x, clientY: y, screenX: x, screenY: y };
        w.dispatchEvent(new PointerEvent('pointerdown', o));
        w.dispatchEvent(new PointerEvent('pointermove', { ...o, screenX: x + 40, clientX: x + 40 }));
        w.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
        return 'ok'
      })()`)
      await sleep(300)
      ok('P9h-5 按住拖一把不会误触发动作（拖动 ≠ 点击）',
        (await actionNow()) === 'idle',
        JSON.stringify({ 实际: await actionNow(), 说明: '位移 > 4px 就不算点击' }))

      // 另两套皮肤（胶囊 / 黄豆）没有动作素材，点了不播也不该报错。
      // 这条是真回归：`PetSkin.Full` 的签名加了 `action`，如果哪套皮肤
      // 在解构时假定它一定存在，运行时就会抛异常、整个窗口白屏。
      const errs = []
      await petEval(`(()=>{ window.__laughErr = []; window.addEventListener('error', (e) => window.__laughErr.push(String(e.message))); return 'ok' })()`)
      await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="capsule"]').click(), 'ok')`)
      await waitForPrefs((p) => p.petSkin === 'capsule', 8000, '落盘 petSkin=capsule')
      await sleep(600)
      await clickPet()
      const errRaw = await petEval(`JSON.stringify(window.__laughErr || [])`)
      if (errRaw) errs.push(...JSON.parse(errRaw))
      const cAction = await actionNow()
      const cLayers = await petEval(`document.querySelectorAll('.pet-photo-action').length`)
      ok('P9h-6 换到胶囊皮肤后点它不报错（没有动作素材就不播，不是崩）',
        errs.length === 0 && Number(cLayers) === 0,
        JSON.stringify({ 页面错误: errs, 触发的动作: cAction, 动作层数: cLayers }))

      // 素材本身：108 帧折成 54 列 × 2 行。
      // 单行 108 格是 17172px 宽，超过 WebP 单边 16383 的上限会被编码器截断，
      // 所以「必须是两行」不是排版偏好而是硬限制，这里守住它。
      const photoSrc = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'pet', 'skinPhoto.tsx'), 'utf8')
      const cols = Number((photoSrc.match(/ACTION_COLS\s*=\s*(\d+)/) || [])[1])
      const frms = Number((photoSrc.match(/ACTION_FRAMES\s*=\s*(\d+)/) || [])[1])
      const laughFile = join(ROOT, 'src', 'renderer', 'src', 'assets', 'pet', 'bean-laugh.webp')
      const laughSize = existsSync(laughFile) ? statSync(laughFile).size : 0
      ok('P9h-7 大笑素材是两行 sprite sheet（单行会超 WebP 16383px 单边上限被截断）',
        frms === 108 && cols === 54 && Math.ceil(frms / cols) === 2 && laughSize > 500 * 1024,
        JSON.stringify({ 帧数: frms, 列数: cols, 行数: Math.ceil(frms / cols), 字节: laughSize }))

      // ========== P9i 第二支动作「打滚」（SPEC-deskpet-action，2026-11-12 第六轮）==========
      //
      // 用户原话「就做挥手打滚」。挥手那段素材里根本没有（视频只有站立/大笑/倒地打滚），
      // 所以这一轮只落了打滚：82 帧、24 列 × 4 行、每格 165×220。
      //
      // 触发入口放右键菜单，不做鼠标手势——「打滚」没有自然的手势能表达，
      // 硬塞成双击/长按会跟拖动、转身把手抢事件。
      const colsNow = () => petEval(`document.querySelector('.pet-photo-action')?.dataset.actionCols || ''`)
      const framesNow = () => petEval(`document.querySelector('.pet-photo-action')?.dataset.actionFrames || ''`)

      /** 让主进程往宠物窗口 send 一个动作（模拟右键菜单那一项被点击） */
      const pushAction = (a) =>
        mainEval(`(()=>{
          const { BrowserWindow } = require('electron');
          const w = BrowserWindow.getAllWindows().find(x => (x.webContents.getURL() || '').includes('pet.html'));
          if (!w) throw new Error('没有宠物窗口');
          w.webContents.send('pet:action', ${JSON.stringify(a)});
          return 'ok'
        })()`)

      // 先切回原图皮肤（P9h-6 把它换成了胶囊）
      await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="photo"]').click(), 'ok')`)
      await waitForPrefs((p) => p.petSkin === 'photo', 8000, '落盘 petSkin=photo')
      await sleep(600)

      // 等上一段（P9h-6 在胶囊皮肤上点的那一下）的笑播完再开始。
      // 注意：胶囊皮肤没有动作素材、不渲染动作层，但 `PetWindowApp` 的动作状态机
      // 照旧会把它设成 'laugh' 并挂 7.2 秒定时器——所以这里必须等，不能只看
      // 「DOM 里没有 .pet-photo-action」就认为没在播（第一次就是这么假红的）。
      for (let i = 0; i < 45 && (await actionNow()) !== 'idle'; i++) await sleep(200)

      ok('P9i-0 打滚之前是 idle', (await actionNow()) === 'idle',
        JSON.stringify({ 实际: await actionNow() }))

      // 计时：打滚 82 帧 / 15fps ≈ 5.47 秒，比大笑的 7.2 秒短。
      // 这条能抓住「复位定时器写成一个大笑专用的常量」这种错——
      // 那样打滚会播完 5.47 秒后还空站 1.7 秒才回 idle。
      const rollStart = Date.now()
      await pushAction('roll')
      await sleep(250)
      ok('P9i-1 右键菜单那条通道能把「打滚」推进窗口（data-pet-action 变 roll）',
        (await actionNow()) === 'roll',
        JSON.stringify({ 实际: await actionNow() }))

      ok('P9i-2 打滚用的是它自己的素材参数（24 列 / 82 帧，不是大笑的 54 列 / 108 帧）',
        (await colsNow()) === '24' && (await framesNow()) === '82',
        JSON.stringify({ 列数: await colsNow(), 帧数: await framesNow() }))

      const rollFrames = []
      for (let i = 0; i < 6; i++) {
        const f = await frameNow()
        if (f !== '' && rollFrames[rollFrames.length - 1] !== f) rollFrames.push(f)
        await sleep(200)
      }
      ok('P9i-3 打滚的帧在持续推进（不是卡在第一帧）',
        rollFrames.length >= 4,
        JSON.stringify({ 采样到的帧号: rollFrames }))

      // 构图：打滚的格子比大笑宽（167 vs 158 的格宽比），但两者都必须
      // 与站姿层水平居中、底边一致，否则播放时会「跳到半空」或者左右偏。
      //
      // 这条必须放在「等它回 idle」之前：动作层在 idle 时整个从 DOM 移除，
      // 等完了再来量只会读到 null（无意义的假红）。
      const rollAlign = await petEval(`(()=>{
        const stand = document.querySelector('.pet-photo-layer.is-on');
        const sheet = document.querySelector('.pet-photo-action-sheet');
        const grp = document.querySelector('.pet-photo-action');
        if (!stand || !sheet || !grp) return '';
        const n = (el, a) => Number(el.getAttribute(a));
        const sx = n(stand, 'x'), sy = n(stand, 'y'), sw = n(stand, 'width'), sh = n(stand, 'height');
        const cols = Number(grp.dataset.actionCols);
        const frames = Number(grp.dataset.actionFrames);
        const w = n(sheet, 'width') / cols;
        const h = n(sheet, 'height') / Math.ceil(frames / cols);
        return JSON.stringify({
          站姿中心: +(sx + sw / 2).toFixed(2), 站姿底: +(sy + sh).toFixed(2),
          动作格宽: +w.toFixed(2), 动作格高: +h.toFixed(2)
        })
      })()`)
      const rg = rollAlign ? JSON.parse(rollAlign) : null
      // 期望格宽比从源码常量算，不写死数字：
      // 2026-11-12 打滚素材重抠时格宽 165→167（裁框左界 30→24 补回左手），
      // 断言里写死 165 就会和源常量脱钩——那种「测试与实现各记一个数」的写法
      // 迟早变成假绿（改实现忘改测试）或假红（改测试忘改实现）。
      const rollRatioSrc = (photoSrc.match(/ROLL_CELL_RATIO\s*=\s*(\d+)\s*\/\s*(\d+)/) || [])
      const rollRatio = rollRatioSrc.length === 3 ? Number(rollRatioSrc[1]) / Number(rollRatioSrc[2]) : NaN
      ok('P9i-5 打滚的格宽按它自己的素材比例算（比大笑的 158/220 宽）',
        !!rg && Number.isFinite(rollRatio) && rollRatio > 158 / 220 &&
          Math.abs(rg.动作格宽 - rg.动作格高 * rollRatio) <= 0.5 && rg.动作格高 > 0,
        JSON.stringify({
          实测: rg,
          源码格宽比: Number.isFinite(rollRatio) ? +rollRatio.toFixed(4) : '没解析到',
          期望格宽: rg && Number.isFinite(rollRatio) ? +(rg.动作格高 * rollRatio).toFixed(2) : null
        }))

      // 等它自己回 idle，并核对耗时落在打滚的时长附近（4.5~6.8 秒），
      // 而不是大笑的 7.2 秒。
      let rollBack = false
      for (let i = 0; i < 40; i++) {
        if ((await actionNow()) === 'idle') {
          rollBack = true
          break
        }
        await sleep(200)
      }
      const rollElapsed = Date.now() - rollStart
      ok('P9i-4 打滚按自己的时长复位（约 5.5 秒，明显短于大笑的 7.2 秒）',
        rollBack && rollElapsed >= 4500 && rollElapsed <= 6800,
        JSON.stringify({ 回到idle: rollBack, 耗时毫秒: rollElapsed, 打滚应约: 5467, 大笑是: 7200 }))

      // 素材硬事实：82 帧排 24 列 4 行、3960×880，文件 > 300 KB。
      const rollFile = join(ROOT, 'src', 'renderer', 'src', 'assets', 'pet', 'bean-roll.webp')
      const rollSize = existsSync(rollFile) ? statSync(rollFile).size : 0
      const rollCols = Number((photoSrc.match(/ROLL_COLS\s*=\s*(\d+)/) || [])[1])
      const rollFrms = Number((photoSrc.match(/ROLL_FRAMES\s*=\s*(\d+)/) || [])[1])
      ok('P9i-6 打滚素材是 82 帧 24 列 4 行，且文件确实落盘了',
        rollCols === 24 && rollFrms === 82 && Math.ceil(rollFrms / rollCols) === 4 && rollSize > 300 * 1024,
        JSON.stringify({ 帧数: rollFrms, 列数: rollCols, 行数: Math.ceil(rollFrms / rollCols), 字节: rollSize }))

      // 菜单接线：两项都要既有标签、又有 send，不能只加标签。
      const petWinSrc = readFileSync(join(ROOT, 'src', 'main', 'petWindow.ts'), 'utf8')
      ok('P9i-7 右键菜单里有「打个滚」且它 send 的是 roll',
        /label:\s*'打个滚'/.test(petWinSrc) && /send\('pet:action',\s*'roll'\)/.test(petWinSrc),
        JSON.stringify({
          有标签: /label:\s*'打个滚'/.test(petWinSrc),
          有send: /send\('pet:action',\s*'roll'\)/.test(petWinSrc)
        }))
      // ========== P9l 第三支动作「挥手」（SPEC-deskpet-action，2026-11-13 第七轮）==========
      //
      // 用户 2026-11-13 另外给了一段可灵生成的视频，说「只要后半段」。
      // 实测那段视频是一次硬切的拼接：第 61 帧帧间运动量从每帧 3~5 突增到 34.33，
      // 61 帧之后才是正面居中真正挥手；再往后 95 帧起手就放下了、121 帧几乎不动。
      // 所以真正可用的是 61~94 共 34 帧。下面这几条守住三件事：
      // 素材参数是这支自己的、时长按它自己的 34 帧算、菜单那项真的接上了。
      {
        for (let i = 0; i < 45 && (await actionNow()) !== 'idle'; i++) await sleep(200)

        ok('P9l-0 挥手之前是 idle', (await actionNow()) === 'idle',
          JSON.stringify({ 实际: await actionNow() }))

        // 34 帧 / 15fps ≈ 2.27 秒，比打滚的 5.47 秒、大笑的 7.2 秒都短。
        // 这条抓的是「复位定时器沿用别的动作的帧数」——那样挥手播完会空站好几秒。
        const waveStart = Date.now()
        await pushAction('wave')
        await sleep(250)
        ok('P9l-1 右键菜单那条通道能把「挥手」推进窗口（data-pet-action 变 wave）',
          (await actionNow()) === 'wave',
          JSON.stringify({ 实际: await actionNow() }))

        ok('P9l-2 挥手用的是它自己的素材参数（17 列 / 34 帧，不是打滚的 24 列 / 82 帧）',
          (await colsNow()) === '17' && (await framesNow()) === '34',
          JSON.stringify({ 列数: await colsNow(), 帧数: await framesNow() }))

        const waveFrames = []
        for (let i = 0; i < 5; i++) {
          const f = await frameNow()
          if (f !== '' && waveFrames[waveFrames.length - 1] !== f) waveFrames.push(f)
          await sleep(150)
        }
        ok('P9l-3 挥手的帧在持续推进（不是卡在第一帧）',
          waveFrames.length >= 4,
          JSON.stringify({ 采样到的帧号: waveFrames }))

        // 格宽比同样从源码常量算，不写死 174——素材重抠时格宽会跟着变。
        // 这条必须排在「等它回 idle」之前：动作层在 idle 时整个从 DOM 移除。
        const waveAlign = await petEval(`(()=>{
          const sheet = document.querySelector('.pet-photo-action-sheet');
          const grp = document.querySelector('.pet-photo-action');
          if (!sheet || !grp) return '';
          const cols = Number(grp.dataset.actionCols);
          const frames = Number(grp.dataset.actionFrames);
          const w = Number(sheet.getAttribute('width')) / cols;
          const h = Number(sheet.getAttribute('height')) / Math.ceil(frames / cols);
          return JSON.stringify({ 动作格宽: +w.toFixed(2), 动作格高: +h.toFixed(2) })
        })()`)
        const wg = waveAlign ? JSON.parse(waveAlign) : null
        const waveRatioSrc = (photoSrc.match(/WAVE_CELL_RATIO\s*=\s*(\d+)\s*\/\s*(\d+)/) || [])
        const waveRatio = waveRatioSrc.length === 3
          ? Number(waveRatioSrc[1]) / Number(waveRatioSrc[2])
          : NaN
        ok('P9l-4 挥手的格宽按它自己的素材比例算（174/220）',
          !!wg && Number.isFinite(waveRatio) &&
            Math.abs(wg.动作格宽 - wg.动作格高 * waveRatio) <= 0.5 && wg.动作格高 > 0,
          JSON.stringify({
            实测: wg,
            源码格宽比: Number.isFinite(waveRatio) ? +waveRatio.toFixed(4) : '没解析到',
            期望格宽: wg && Number.isFinite(waveRatio) ? +(wg.动作格高 * waveRatio).toFixed(2) : null
          }))

        let waveBack = false
        for (let i = 0; i < 40; i++) {
          if ((await actionNow()) === 'idle') {
            waveBack = true
            break
          }
          await sleep(200)
        }
        const waveElapsed = Date.now() - waveStart
        ok('P9l-5 挥手按自己的时长复位（约 2.3 秒，明显短于打滚的 5.5 秒）',
          waveBack && waveElapsed >= 1800 && waveElapsed <= 3600,
          JSON.stringify({ 回到idle: waveBack, 耗时毫秒: waveElapsed, 挥手应约: 2267, 打滚是: 5467 }))

        const waveFile = join(ROOT, 'src', 'renderer', 'src', 'assets', 'pet', 'bean-wave.webp')
        const waveSize = existsSync(waveFile) ? statSync(waveFile).size : 0
        const waveCols = Number((photoSrc.match(/WAVE_COLS\s*=\s*(\d+)/) || [])[1])
        const waveFrms = Number((photoSrc.match(/WAVE_FRAMES\s*=\s*(\d+)/) || [])[1])
        ok('P9l-6 挥手素材是 34 帧 17 列 2 行，且文件确实落盘了',
          waveCols === 17 && waveFrms === 34 && Math.ceil(waveFrms / waveCols) === 2 &&
            waveSize > 200 * 1024,
          JSON.stringify({
            帧数: waveFrms, 列数: waveCols, 行数: Math.ceil(waveFrms / waveCols), 字节: waveSize
          }))

        ok('P9l-7 右键菜单里有「挥挥手」且它 send 的是 wave',
          /label:\s*'挥挥手'/.test(petWinSrc) && /send\('pet:action',\s*'wave'\)/.test(petWinSrc),
          JSON.stringify({
            有标签: /label:\s*'挥挥手'/.test(petWinSrc),
            有send: /send\('pet:action',\s*'wave'\)/.test(petWinSrc)
          }))
      }

    }


    // ========== P9j 右键不再多出一圈边框（焦点环）==========
    //
    // 用户原话（2026-11-12）：「我一右键就会多出来一个边框」。
    // 截图实测：那圈线是 238×313 物理像素的矩形，正好等于宠物窗口 190×250 DIP × DPR 1.25；
    // 线色 (229,151,0)，本机 DWM 强调色是 0xFFD47800 → RGB(212,120,0)。
    // 矩形贴合窗口 + 用系统强调色 = Chromium 的 :focus-visible 焦点环。
    //
    // 修法是 `.petwin:focus, .petwin:focus-visible { outline: none }`（petwin.css）。
    // 下面这三条里，P9j-3 是关键：它证明「删掉这条规则，焦点环就真的出现」，
    // 否则只断言「现在没有」属于假绿——把 CSS 整段删掉也能过。
    {
      // 让根节点进入 :focus-visible。脚本 focus() 不够（Chromium 认定那是鼠标交互），
      // 必须派发一次真实的 Tab 键。
      const tab = async () => {
        const pages = await listTargets()
        const page = pages.find(MATCH.pet)
        if (!page) throw new Error('no pet target')
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('cdp timeout')), 15000)
          ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(document.querySelector('.petwin').blur(), 'ok')`, returnByValue: true } }))
          }
          ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id === 1) {
              ws.send(JSON.stringify({ id: 2, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, text: '\t' } }))
            }
            if (m.id === 2) {
              ws.send(JSON.stringify({ id: 3, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 } }))
            }
            if (m.id === 3) { clearTimeout(timer); ws.close(); res() }
          }
          ws.onerror = rej
        })
      }

      const focusState = () => petEval(`(() => {
        const el = document.querySelector('.petwin')
        if (!el) return JSON.stringify({ err: 'no .petwin' })
        const cs = getComputedStyle(el)
        return JSON.stringify({
          focus: el.matches(':focus'),
          focusVisible: el.matches(':focus-visible'),
          outlineStyle: cs.outlineStyle,
          outlineColor: cs.outlineColor,
          outlineWidth: cs.outlineWidth,
        })
      })()`).then((s) => (typeof s === 'string' ? JSON.parse(s) : s))

      const cssSrc = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'petwin', 'petwin.css'), 'utf8')

      // P9j-1 源码层面：本意就是「这个窗口不要键盘焦点环」
      ok('P9j-1 petwin.css 里给 .petwin 关掉了 focus 焦点环',
        /\.petwin:focus[^{]*\{[^}]*outline:\s*none/.test(cssSrc),
        JSON.stringify({ 找到规则: /\.petwin:focus[^{]*\{[^}]*outline:\s*none/.test(cssSrc) }))

      // P9j-2 运行时层面：真的进到 :focus-visible 时，computed outline 必须是 none
      await tab()
      await sleep(400)
      const on = await focusState()
      ok('P9j-2 拿到键盘焦点时计算样式里 outline 是 none（真出现在界面上才是边框）',
        on.focusVisible === true && on.outlineStyle === 'none',
        JSON.stringify({ 拿到焦点: on.focus, 焦点可见: on.focusVisible, 描边样式: on.outlineStyle, 颜色: on.outlineColor }))

      // P9j-3 负对照：把那几条规则从文档里删掉，焦点环应该立刻回来。
      // 这一步是防止「CSS 写错了但恰好没触发」这种假绿。
      const del = await petEval(`(() => {
        let n = 0
        for (const sheet of Array.from(document.styleSheets)) {
          let rules
          try { rules = sheet.cssRules } catch { continue }
          for (let i = rules.length - 1; i >= 0; i--) {
            const sel = rules[i].selectorText || ''
            if (sel.includes('.petwin') && sel.includes(':focus')) {
              try { sheet.deleteRule(i); n++ } catch {}
            }
          }
        }
        return String(n)
      })()`)
      await tab()
      await sleep(400)
      const off = await focusState()
      ok('P9j-3 删掉那条规则后焦点环真的会出现（证明修复不是摆设）',
        Number(del) > 0 && off.outlineStyle !== 'none' && /229|212/.test(String(off.outlineColor)),
        JSON.stringify({
          删掉的规则数: del,
          描边样式: off.outlineStyle,
          描边颜色: off.outlineColor,
          说明: '本机强调色 0xFFD47800 → RGB(212,120,0)，Chromium 用强调色画焦点环'
        }))
    }

    // ========== P9k 桌宠出岛时，岛仍然能收到横幅事件 ==========
    //
    // 用户原话（2026-11-12）：「我刚刚截图，灵动岛没有信息提示弹出」。
    // 根因不在通知库，在推送目标：`notifyStore` / `clipboardStore` 用
    // `BrowserWindow.getAllWindows()[0]` 往渲染层推横幅，假设 [0] 是岛窗口。
    // 桌宠出岛后实测顺序是 `[pet.html, index.html]`，[0] 变成宠物窗口，
    // 横幅全发给了不监听 `island:notify-arrived` / `island:code-arrived` 的窗口。
    // 修法是新增 `src/main/islandWindowRef.ts` 显式登记岛窗口。
    //
    // 这里守两件事：①主进程里那个登记引用指向的是 index.html 而不是 pet.html
    // ②源码里不再有 `getAllWindows()[0]` 的横幅推送（防止以后改回去）。
    {
      const prevIdx = await mainEval(`(() => {
        const { BrowserWindow } = require('electron')
        const all = BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
        return JSON.stringify({
          count: all.length,
          第一个: all[0] || '',
          有岛: all.some((u) => u.includes('index.html')),
          有宠物: all.some((u) => u.includes('pet.html')),
        })
      })()`).then((s) => (typeof s === 'string' ? JSON.parse(s) : s))

      ok('P9k-1 前情：桌宠出岛时确实有宠物窗口，且它可能是 getAllWindows 的第一个',
        prevIdx.有宠物 === true,
        JSON.stringify(prevIdx))

      const refSrc = readFileSync(join(ROOT, 'src', 'main', 'islandWindowRef.ts'), 'utf8')
      const notifySrc = readFileSync(join(ROOT, 'src', 'main', 'notifyStore.ts'), 'utf8')
      const clipSrc = readFileSync(join(ROOT, 'src', 'main', 'clipboardStore.ts'), 'utf8')

      ok('P9k-2 岛窗口引用是显式登记的，靠 URL 猜会漏（开发版 loadURL / 打包版 loadFile）',
        /setIslandWindow/.test(refSrc) && /getIslandWindow/.test(refSrc),
        JSON.stringify({ 有set: /setIslandWindow/.test(refSrc), 有get: /getIslandWindow/.test(refSrc) }))

      ok('P9k-3 通知与验证码两条横幅都走登记引用，不再用 getAllWindows()[0]',
        /sendToIsland\('island:notify-arrived'/.test(notifySrc) &&
          /sendToIsland\('island:code-arrived'/.test(clipSrc) &&
          !/getAllWindows\(\)\[0\][\s\S]{0,40}island:(notify-arrived|code-arrived)/.test(notifySrc + clipSrc),
        JSON.stringify({
          通知走sendToIsland: /sendToIsland\('island:notify-arrived'/.test(notifySrc),
          验证码走sendToIsland: /sendToIsland\('island:code-arrived'/.test(clipSrc),
          还有getAllWindows写法: /getAllWindows\(\)\[0\][\s\S]{0,40}island:/.test(notifySrc + clipSrc)
        }))
    }

    // 换回胶囊，别把测试值留在偏好里
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="capsule"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petSkin === 'capsule', 8000, '落盘 petSkin=capsule')
  }

  // ========== P10 重启 → 回到记录的位置 ==========
  {
    const recorded = readPrefs().petWindowPos
    await stopApp(child)
    child = await startApp()
    await waitForTarget('pet', true, 15000, '重启后宠物窗口出现')
    const b = await petBounds()
    ok('P10 重启后宠物窗口出现在上次拖到的位置（±2px）',
      !b.none && Math.abs(b.x - recorded.x) <= 2 && Math.abs(b.y - recorded.y) <= 2,
      JSON.stringify({ recorded, bounds: b }))
    const count = await waitIslandPetCount(0)
    ok('P10b 重启后岛上仍然没有岛仔（模式记着了）', count === 0, `实际 ${count}`)
  }

  // ========== P11 屏幕外坐标被 clamp ==========
  {
    await stopApp(child)
    writePrefs({ petMode: 'window', petWindowPos: { x: -5000, y: -5000 } })
    child = await startApp()
    await waitForTarget('pet', true, 15000, '重启后宠物窗口出现')
    const b = await petBounds()
    area = await workArea()
    ok('P11a 屏幕外的坐标被拉回工作区内（x 不小于工作区左边）',
      !b.none && b.x >= area.x, JSON.stringify({ bounds: b, workArea: area }))
    ok('P11b 也不会跑到工作区右/下边界外（整窗可见）',
      !b.none && b.x + b.width <= area.x + area.width + 1 && b.y + b.height <= area.y + area.height + 1,
      JSON.stringify({ bounds: b, workArea: area }))
  }

  // ========== P12 切回「只在岛里」 ==========
  {
    await openSettings('pet', `!!document.querySelector('.pet-set-mode[data-mode="island"]')`)
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="island"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petMode === 'island', 8000, '落盘 petMode=island')
    ok('P12a 切回「只在岛里」后 petMode 落盘 island', true)

    await waitForTarget('pet', false, 10000, '宠物窗口关闭')
    ok('P12b 宠物窗口关掉了', true)

    const count = await waitIslandPetCount(1)
    ok('P12c 岛里的岛仔回来了', count === 1, `实际 ${count}`)
  }

  // ========== P13 自由走动（SPEC-deskpet-walk） ==========
  {
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="free"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petMode === 'free', 8000, '落盘 petMode=free')
    ok('P13a 点「自由走动」落盘 petMode=free', true)

    await waitForTarget('pet', true, 15000, '宠物窗口出现')
    ok('P13b free 模式开了独立宠物窗口', true)

    // 等窗口 bounds 能读到（target 存在 ≠ 页面加载完），再量走动前后的 x。
    let b0 = null
    {
      const t0 = Date.now()
      while (Date.now() - t0 < 10000) {
        b0 = await petBounds()
        if (!b0.none) break
        await sleep(150)
      }
    }
    if (!b0 || b0.none) throw new Error('free 模式宠物窗口 target 有了但主进程仍找不到该窗口')

    // 渲染层应收到走动方向：根 .petwin 带 .walking，且 data-pet-walk 是 left/right。
    // 走一段（60 帧≈3 秒）后会停一段（30 帧≈1.5 秒），停下时是 idle，所以用等待式断言
    // 抓住「曾经在走」的那一段，而不是固定 sleep 后碰运气。
    const walking = await waitPetExpr(`(()=>{
      const e = document.querySelector('.petwin');
      if (!e) return '';
      const cls = e.classList.contains('walking');
      const dir = e.dataset.petWalk;
      // 只在「真的在走」时返回：free 会走一段停一段，停下的那段是 idle，
      // 等的是走的那一段，否则会抓到 rest 相位造成假红。
      if (!cls || (dir !== 'left' && dir !== 'right')) return '';
      return JSON.stringify({cls, dir, facing: e.dataset.petFacing})
    })()`, { timeoutMs: 12000, gapMs: 120, label: '渲染层收到走动方向' })
      .then((s) => { try { return JSON.parse(s) } catch { return null } })
    ok('P13c 渲染层收到走动方向（.walking + data-pet-walk=left/right）',
      walking && walking.cls === true && (walking.dir === 'left' || walking.dir === 'right'),
      JSON.stringify(walking))
    ok('P13d 走动时朝向切到侧视（data-pet-facing=1 或 3）',
      walking && (Number(walking.facing) === 1 || Number(walking.facing) === 3),
      JSON.stringify(walking))

    await sleep(900)
    const b1 = await petBounds()
    ok('P13e 窗口确实在横向自己移动（x 变了）', b1.x !== b0.x,
      `x: ${b0.x} → ${b1.x}`)
    // 不硬写 190×250：125% 缩放下 getBounds() 返回物理像素（实测 191×251），
    // 和 P9c 一样用「走动前后不变」判漂移——setBounds 显式带尺寸锁的就是这个。
    ok('P13f 走动时窗口尺寸不漂移（走动前后 width/height 一致，setBounds 显式带尺寸）',
      b1.width === b0.width && b1.height === b0.height,
      `走动前 ${b0.width}×${b0.height} → 走动后 ${b1.width}×${b1.height}`)

    // 切回 island：关掉宠物窗口，保证 P14「窗口现在关着」的前提成立。
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="island"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petMode === 'island', 8000, '落盘 petMode=island')
    await waitForTarget('pet', false, 10000, '宠物窗口关闭')
    ok('P13g 切回「只在岛里」后宠物窗口关掉、走动停止', true)
  }

  // ========== P14 窗口属性：不进任务栏、置顶（验收条件 3） ==========
  {
    // 宠物窗口现在关着（P12 切回 island 了），先放出去
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="window"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petMode === 'window', 8000, '落盘 petMode=window')
    await waitForTarget('pet', true, 15000, '宠物窗口出现')
    // CDP 的 target 在 loadURL 之前就存在了，此时 webContents.getURL() 还是空串，
    // 按 URL 找窗口会找不到（实测第一次就栽在这）。等到窗口真的 show 出来再说：
    // showInactive() 挂在 ready-to-show 上，光能读到 bounds 时可能还没显示
    // （本轮 P13 多了一次开窗/关窗，撞进这个空档导致 visible=false 的假红）。
    {
      const t0 = Date.now()
      let got = null
      while (Date.now() - t0 < 10000) {
        got = JSON.parse(await mainEval(`(()=>{
          const { BrowserWindow } = require('electron');
          const w = BrowserWindow.getAllWindows().find(x => (x.webContents.getURL() || '').includes('pet.html'));
          if (!w) return JSON.stringify({ none: true });
          const r = w.getBounds();
          return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height, visible: w.isVisible() })
        })()`))
        if (!got.none && got.visible) break
        await sleep(150)
      }
      if (!got || got.none || !got.visible) throw new Error('宠物窗口 target 有了但主进程仍没看到可见窗口')
    }

    // skipTaskbar / alwaysOnTop 只有主进程能读（BrowserWindow 的 getter）
    const flags = JSON.parse(await mainEval(`(()=>{
      const { BrowserWindow } = require('electron');
      const w = BrowserWindow.getAllWindows().find(x => (x.webContents.getURL() || '').includes('pet.html'));
      if (!w) return JSON.stringify({ none: true });
      return JSON.stringify({
        alwaysOnTop: w.isAlwaysOnTop(),
        resizable: w.isResizable(),
        visible: w.isVisible(),
        focusable: w.isFocusable()
      })
    })()`))
    // Electron 没有 isSkipTaskbar() 这类读取接口（实测 typeof 为 undefined），
    // 运行时读不到这个属性，只能退回源码断言：createPetWindow 的构造参数里必须有它。
    // 这不是「运行时已验证」，是「配置确实写在那儿」——记在未验证清单里。
    const petWinSrc = readFileSync(join(ROOT, 'src', 'main', 'petWindow.ts'), 'utf8')
    const ctorBlock = petWinSrc.slice(petWinSrc.indexOf('new BrowserWindow('))
    const ctorEnd = ctorBlock.indexOf('})')
    const ctorOpts = ctorBlock.slice(0, ctorEnd === -1 ? 1200 : ctorEnd)
    ok('P14a 宠物窗口构造参数里带 skipTaskbar: true（Electron 无运行时 getter，只能查源码）',
      /skipTaskbar:\s*true/.test(ctorOpts), ctorOpts.slice(0, 300))
    ok('P14b 宠物窗口置顶', flags.alwaysOnTop === true, JSON.stringify(flags))
    ok('P14c 宠物窗口不可改尺寸（拖边不会变形）', flags.resizable === false, JSON.stringify(flags))
    ok('P14d 宠物窗口真的显示出来了（不是藏在 show:false 里）', flags.visible === true, JSON.stringify(flags))
  }

  // ========== P15 关掉岛窗口，应用不退出（验收条件 11） ==========
  {
    // 这条必须在最后：岛窗口一关，后面所有 islandEval 都不可用了。
    // 场景：用户把桌宠放出去后，岛上那条只想要桌宠——此时关掉岛，
    // 应用不该整个退出（宠物窗口还开着呢）。
    //
    // 判定用主进程的 BrowserWindow 数量，不用 CDP target：
    // 窗口关掉后 CDP target 有时会残留一小会儿，拿它当「窗口还在」会假红。
    const winCount = () => mainEval(`(()=>{
      const { BrowserWindow } = require('electron');
      const all = BrowserWindow.getAllWindows();
      return JSON.stringify({
        total: all.length,
        island: all.filter(x => {
          const u = x.webContents.getURL() || '';
          return !u.includes('pet.html') && !u.includes('settings.html');
        }).length
      })
    })()`).then(JSON.parse)

    const before = await winCount()
    if (before.island !== 1) throw new Error('前提不成立：岛窗口数应为 1，实际 ' + JSON.stringify(before))

    await mainEval(`(()=>{
      const { BrowserWindow } = require('electron');
      const w = BrowserWindow.getAllWindows().find(x => {
        const u = x.webContents.getURL() || '';
        return !u.includes('pet.html') && !u.includes('settings.html');
      });
      if (w) w.close();
      return 'ok'
    })()`)

    // 等主进程侧的窗口数真的降下来
    {
      const t0 = Date.now()
      let now = before
      while (Date.now() - t0 < 10000) {
        now = await winCount()
        if (now.island === 0) break
        await sleep(150)
      }
      ok('P15a 岛窗口确实关掉了（这条断言的前提）', now.island === 0, JSON.stringify(now))
    }

    // 给 window-all-closed 一点时间触发（如果会误触发的话）
    await sleep(2500)
    const after = await winCount()
    ok('P15b 应用没有因为关掉岛而退出（宠物窗口还在）', after.total > 0, JSON.stringify(after))
    ok('P15c 宠物窗口还在（只关了岛，没把桌宠一起带走）', after.total - after.island > 0, JSON.stringify(after))
    const b = await petBounds()
    ok('P15d 宠物窗口仍然可见可用', !b.none && b.width > 0, JSON.stringify(b))
  }

  await closeSettings()
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  killApp()
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
}

console.log(`\nE2E DESKPET-OUT: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
