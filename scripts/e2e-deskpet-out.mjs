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
 * P13 点「自由走动」（禁用档）不产生任何写入
 *
 * 跑前：npm run build（e2e 加载 out/ 产物）。脚本自己启停 electron，结束恢复 prefs。
 * CDP 9321 / 主进程 inspect 9229；spawn 时 delete ELECTRON_RUN_AS_NODE。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    ok('P2c「自由走动」仍是禁用 + 「还没做」（本轮不做）',
      free.disabled === true && free.soon === true, JSON.stringify(free))
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

  // ========== P13 点禁用档不写入 ==========
  {
    const before = readPrefs().petMode
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="free"]').click(), 'ok')`)
    await sleep(800)
    const after = readPrefs().petMode
    ok('P13 点「自由走动」（禁用档）不产生任何写入', after === before && after === 'island',
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    const hasPetWin = await hasTarget('pet')
    ok('P13b 点禁用档也不会误开宠物窗口', hasPetWin === false, `实际 ${hasPetWin}`)
  }

  // ========== P14 窗口属性：不进任务栏、置顶（验收条件 3） ==========
  {
    // 宠物窗口现在关着（P12 切回 island 了），先放出去
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="window"]').click(), 'ok')`)
    await waitForPrefs((p) => p.petMode === 'window', 8000, '落盘 petMode=window')
    await waitForTarget('pet', true, 15000, '宠物窗口出现')
    // CDP 的 target 在 loadURL 之前就存在了，此时 webContents.getURL() 还是空串，
    // 按 URL 找窗口会找不到（实测第一次就栽在这）。等到 bounds 能读到再说。
    {
      const t0 = Date.now()
      let got = null
      while (Date.now() - t0 < 10000) {
        got = await petBounds()
        if (!got.none) break
        await sleep(150)
      }
      if (!got || got.none) throw new Error('宠物窗口 target 有了但主进程仍找不到该窗口')
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
