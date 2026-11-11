#!/usr/bin/env node
/**
 * e2e SPEC-settings-shell：带左导航的独立设置窗口
 *
 * S1 设置窗口能打开：调 window.island.openSettings('pages') 后 CDP 里出现 url 含 settings.html 的 target
 * S2 左导航三项齐全（常规/页面管理/专注·喝水），openSettings('pages') 落在「页面管理」
 * S3 常规页：版本号非空、数据目录路径是 userData、自启开关在场
 * S4 页面管理页：页面区 5 行（含音乐）+ 收起态组件区 6 行
 * S5 设置窗口改偏好 → 岛立刻同步（取消铃铛勾选后收起态不再渲染，勾回恢复）
 * S6 关闭设置窗口不影响岛（岛 target 仍在，收起态仍有胶囊）
 * S7 岛里没有页面管理页：翻页圆点只有业务页（2026-11-11 起 5 个，含音乐）
 * S8 重复 openSettings 不会叠出多个设置窗口
 * S9 自启状态双向同步（设置窗口 ↔ 岛，不重启）
 * S10 页面区拖拽是「插入」不是「互换」（2026-11-11 用户修正）
 * S11 导出数据入口在设置窗口「常规」分区，IPC 通道存活
 * S12 跨区拖拽护栏：页面行拖到组件行不能弄坏 order（独立验收 5.1 回归）；
 *     提示线在 dragover→drop 之间采样、行数用 rAF 帧序列取峰值（复验指出单点采样恒真）
 *
 * 跑前：npm run build（e2e 加载 out/ 产物）。脚本自己启停 electron，结束恢复 prefs/notif-read。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9321
const INSPECT_PORT = 9229
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')
const NOTIF_READ = join(USER_DATA, 'notif-read.json')

const DEFAULT_ORDER = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IS_SETTINGS = (t) => (t.url ?? '').includes('settings.html')

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === 'page')
}

/** 在岛（wantSettings=false）或设置窗口（true）上求值 */
async function evalOnTarget(expr, wantSettings) {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await listTargets()
      const page = pages.find((t) => IS_SETTINGS(t) === wantSettings)
      if (!page) throw new Error(wantSettings ? 'no settings target' : 'no page target')
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
const islandEval = (expr) => evalOnTarget(expr, false)
const settingsEval = (expr) => evalOnTarget(expr, true)

function killApp() {
  try { execSync('taskkill /IM electron.exe /T /F', { stdio: 'ignore' }) } catch { /* 无进程 */ }
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--inspect=${INSPECT_PORT}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore'
  })
  await sleep(3500)
  return child
}

async function stopApp(child) {
  try { child.kill('SIGKILL') } catch { /* 已退 */ }
  killApp()
  await sleep(1200)
}

function writePrefs(order, collapsedOverride = {}) {
  // musicIntro: true —— 让「老用户补音乐页」的迁移不再介入，测试基线固定为 5 页
  writeFileSync(PREFS, JSON.stringify({
    musicIntro: true,
    pagesCustom: {
      pages: [0, 1, 2, 3, 4],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true, ...collapsedOverride },
      order
    }
  }, null, 2), 'utf8')
}
const readPrefs = () => JSON.parse(readFileSync(PREFS, 'utf8'))

/** 打开设置窗口并等到它加载完 */
async function openSettings(section) {
  await islandEval(`(window.island.openSettings('${section}'), 'ok')`)
  await sleep(1800)
}
async function closeSettings() {
  await settingsEval(`(window.island.closeSettings(), 'ok')`)
  await sleep(1200)
}

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null
const notifBackup = existsSync(NOTIF_READ) ? readFileSync(NOTIF_READ, 'utf8') : null
/**
 * S9 会真的开关机自启（改注册表）。原值必须在模块级记录、且恢复动作放 finally：
 * 只要恢复写在 S9 块内部，中间任一 await 抛异常或进程被强杀就漏恢复，用户的开机自启
 * 会停在测试翻转后的状态。恢复要在 killApp() 之前做——应用已被杀掉就没法调 IPC 了。
 */
let autostartOrig = null
async function restoreAutostart() {
  if (autostartOrig === null) return
  try {
    await islandEval(`window.island.autostartSet(${autostartOrig})`)
    await sleep(500)
    const now = await islandEval(`window.island.autostartGet()`)
    if (now !== autostartOrig) console.log(`  ! 自启恢复失败：期望 ${autostartOrig}，实际 ${now}`)
  } catch (e) {
    console.log('  ! 自启恢复异常（应用可能已退出）：' + (e?.message ?? e))
  }
}

try {
  mkdirSync(USER_DATA, { recursive: true })

  killApp(); await sleep(800)
  writePrefs(DEFAULT_ORDER)
  // 造未读：lastOrder 与 hiddenUntil 同时清零，铃铛才可观测
  if (notifBackup !== null) {
    const w = JSON.parse(notifBackup)
    w.lastOrder = 0
    w.hiddenUntil = 0
    writeFileSync(NOTIF_READ, JSON.stringify(w), 'utf8')
  }
  child = await startApp()

  // ========== S1 设置窗口能打开 ==========
  {
    const before = await listTargets()
    ok('S1a 启动时只有岛一个 page target', before.length === 1 && !before.some(IS_SETTINGS),
      JSON.stringify(before.map((t) => t.url)))

    await openSettings('pages')
    const after = await listTargets()
    ok('S1b 打开后出现 settings.html target',
      after.some((t) => IS_SETTINGS(t)),
      JSON.stringify(after.map((t) => t.url)))
  }

  // ========== S2 左导航 ==========
  {
    const nav = await settingsEval(`Array.from(document.querySelectorAll('.set-nav-item')).map(e => e.textContent.trim())`)
    ok('S2a 左导航三项齐全', Array.isArray(nav) && nav.length === 3 &&
      nav.some((s) => s.includes('常规')) && nav.some((s) => s.includes('页面管理')) && nav.some((s) => s.includes('专注')),
      JSON.stringify(nav))

    // openSettings('pages') 落点：页面管理分区可见（5 行页面 + 6 行组件）
    const rows = await settingsEval(`document.querySelectorAll('.pm-row').length`)
    ok('S2b openSettings("pages") 直接落在页面管理分区', rows === 11, `实际 .pm-row 共 ${rows} 行`)
  }

  // ========== S3 常规页 ==========
  {
    // 点左导航「常规」
    await settingsEval(`(() => { const b = Array.from(document.querySelectorAll('.set-nav-item')).find(e => e.textContent.includes('常规')); if (!b) return 'no-nav'; b.click(); return 'ok' })()`)
    await sleep(600)
    const general = await settingsEval(`(() => {
      const txt = document.body.innerText
      return JSON.stringify({
        hasAuto: !!document.querySelector('.set-switch'),
        hasVerRow: txt.includes('版本'),
        ver: (txt.match(/\\d+\\.\\d+\\.\\d+/) ?? [null])[0],
        hasDataRow: txt.includes('数据文件夹') || txt.includes('数据目录'),
        pmRows: document.querySelectorAll('.pm-row').length
      })
    })()`)
    const g = JSON.parse(general)
    ok('S3a 常规页有自启开关', g.hasAuto === true, general)
    ok('S3b 常规页显示版本号（x.y.z）', typeof g.ver === 'string' && /^\d+\.\d+\.\d+$/.test(g.ver), general)
    ok('S3c 常规页有数据文件夹入口', g.hasDataRow === true, general)
    ok('S3d 切到常规后页面管理行不在 DOM 里', g.pmRows === 0, `实际 ${g.pmRows}`)
  }

  // ========== S4 页面管理分区结构 ==========
  {
    await settingsEval(`(() => { const b = Array.from(document.querySelectorAll('.set-nav-item')).find(e => e.textContent.includes('页面管理')); if (!b) return 'no-nav'; b.click(); return 'ok' })()`)
    await sleep(600)
    const pageRows = await settingsEval(`document.querySelectorAll('.pm-panel > .pm-row, .pm-panel div.pm-row').length`)
    const compRows = await settingsEval(`document.querySelectorAll('.pm-row[data-comp]').length`)
    ok('S4a 页面区 5 行', pageRows - compRows === 5, `总行 ${pageRows} 组件行 ${compRows}`)
    ok('S4b 收起态组件区 6 行', compRows === 6, `实际 ${compRows}`)
    const labels = await settingsEval(`Array.from(document.querySelectorAll('.pm-row[data-comp] .pm-name')).map(e => e.textContent).join(',')`)
    ok('S4c 组件行文案含「通知铃铛」', labels.includes('通知铃铛'), labels)
    const hasReset = await settingsEval(`!!document.querySelector('.pm-reset')`)
    ok('S4d 有「重置为默认」按钮', hasReset === true)
    const hasNoClose = await settingsEval(`document.querySelectorAll('.pm-close').length`)
    ok('S4e 页面管理里不再有「完成并收起」', hasNoClose === 0, `实际 ${hasNoClose}`)
  }

  // ========== S5 设置窗口改偏好 → 岛同步 ==========
  {
    const bellBefore = await islandEval(`document.querySelector('.collapsed-bell') ? 1 : 0`)
    ok('S5a 初始未读在，收起态有铃铛', bellBefore === 1, '本机通知库为空时此项会失败')

    await settingsEval(`(() => { const cb = document.querySelector('.pm-row[data-comp="bell"] input[type=checkbox]'); if (!cb) return 'no-cb'; cb.click(); return 'ok' })()`)
    await sleep(900)
    ok('S5b 取消勾选铃铛写进 prefs.json', readPrefs()?.pagesCustom?.collapsed?.bell === false,
      JSON.stringify(readPrefs()?.pagesCustom?.collapsed))
    const bellOff = await islandEval(`document.querySelector('.collapsed-bell') ? 1 : 0`)
    ok('S5c 岛当场跟着变（prefs:changed 广播生效，未重启）', bellOff === 0, `实际 ${bellOff}`)

    await settingsEval(`(() => { const cb = document.querySelector('.pm-row[data-comp="bell"] input[type=checkbox]'); if (!cb) return 'no-cb'; cb.click(); return 'ok' })()`)
    await sleep(900)
    const bellBack = await islandEval(`document.querySelector('.collapsed-bell') ? 1 : 0`)
    ok('S5d 勾回后岛当场恢复', bellBack === 1, `实际 ${bellBack}`)
  }

  // ========== S7 岛里没有页面管理页 ==========
  {
    await islandEval(`(() => { const el = document.querySelector('.island'); if (el && !el.className.includes('expanded')) el.click(); return 'ok' })()`)
    await sleep(900)
    const dots = await islandEval(`document.querySelectorAll('.dots .dot').length`)
    ok('S7 翻页圆点只有业务页 5 个（页面管理页已摘除，音乐页已加入）', dots === 5, `实际 ${dots}`)
    const hasPm = await islandEval(`document.querySelectorAll('.pm-row').length`)
    ok('S7b 岛 DOM 里没有 .pm-row（面板已搬走）', hasPm === 0, `实际 ${hasPm}`)
    await islandEval(`(() => { const el = document.querySelector('.island'); if (el && el.className.includes('expanded')) el.click(); return 'ok' })()`)
    await sleep(700)
  }

  // ========== S9 自启状态双向同步（独立验收阻断项 B2 的回归） ==========
  {
    // 自启会真的改注册表，先记原值（模块级变量，finally 里兜底恢复）
    const orig = await islandEval(`window.island.autostartGet()`)
    autostartOrig = orig
    // 展开岛，头部那枚胶囊才在 DOM 里
    await islandEval(`(() => { const el = document.querySelector('.island'); if (el && !el.className.includes('expanded')) el.click(); return 'ok' })()`)
    await sleep(900)
    const islandAuto = () => islandEval(`(() => { const e = document.querySelector('.autostart-toggle'); return e ? (e.className.includes('on') ? 1 : 0) : -1 })()`)
    ok('S9a 展开态头部有自启胶囊且状态与主进程一致',
      (await islandAuto()) === (orig ? 1 : 0),
      `主进程 ${orig}，胶囊 ${await islandAuto()}`)

    // 在设置窗口「常规」点开关
    await settingsEval(`(() => { const b = Array.from(document.querySelectorAll('.set-nav-item')).find(e => e.textContent.includes('常规')); if (b) b.click(); return 'ok' })()`)
    await sleep(600)
    await settingsEval(`(() => { const s = document.querySelector('.set-switch'); if (!s) return 'no-switch'; s.click(); return 'ok' })()`)
    await sleep(1200)

    const flipped = await islandEval(`window.island.autostartGet()`)
    ok('S9b 设置窗口改自启后主进程状态已翻转', flipped === !orig, `原 ${orig}，现 ${flipped}`)
    const islandAfter = await islandAuto()
    ok('S9c 岛头部胶囊当场跟着变（autostart:changed 广播生效，未重启）',
      islandAfter === (flipped ? 1 : 0),
      `主进程 ${flipped}，胶囊 ${islandAfter}`)

    // 反向：设置窗口的开关也要跟随岛那边的改动
    await islandEval(`(() => { const e = document.querySelector('.autostart-toggle'); if (e) e.click(); return 'ok' })()`)
    await sleep(1200)
    const backAgain = await islandEval(`window.island.autostartGet()`)
    ok('S9d 从岛侧改回后主进程恢复原值', backAgain === orig, `原 ${orig}，现 ${backAgain}`)
    const switchState = await settingsEval(`(() => { const s = document.querySelector('.set-switch'); return s ? (s.getAttribute('aria-checked') === 'true' ? 1 : 0) : -1 })()`)
    ok('S9e 设置窗口开关反向跟随岛侧改动', switchState === (orig ? 1 : 0), `主进程 ${orig}，开关 ${switchState}`)

    // 正常路径先恢复（finally 里还有一道兜底，见 restoreAutostart）
    await restoreAutostart()
    autostartOrig = null
    await islandEval(`(() => { const el = document.querySelector('.island'); if (el && el.className.includes('expanded')) el.click(); return 'ok' })()`)
    await sleep(700)
  }

  // ========== S10 页面区拖拽是「插入」不是「互换」（2026-11-11 用户修正） ==========
  {
    await settingsEval(`(() => { const b = Array.from(document.querySelectorAll('.set-nav-item')).find(e => e.textContent.includes('页面管理')); if (b) b.click(); return 'ok' })()`)
    await sleep(600)
    await settingsEval(`(() => { const r = document.querySelector('.pm-reset'); if (r) r.click(); return 'ok' })()`)
    await sleep(700)
    const basePages = readPrefs()?.pagesCustom?.pages
    ok('S10a 重置后页面恢复默认顺序 [0,1,2,3,4]',
      JSON.stringify(basePages) === JSON.stringify([0, 1, 2, 3, 4]), JSON.stringify(basePages))

    /** 把页面区第 fromIdx 行拖到第 toIdx 行的上半/下半。
     *  页面行没有 data-comp，用「不带 data-comp 的 .pm-row」按 DOM 顺序取。 */
    const dragPageRow = async (fromIdx, toIdx, half) => {
      const start = await settingsEval(`(() => {
        const rows = Array.from(document.querySelectorAll('.pm-row')).filter(r => !r.hasAttribute('data-comp'))
        const from = rows[${fromIdx}]
        const to = rows[${toIdx}]
        if (!from || !to) return 'missing-row'
        window.__e2eDt2 = new DataTransfer()
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt2 }))
        const b = to.getBoundingClientRect()
        window.__e2eY2 = b.top + b.height * ${half === 'before' ? 0.25 : 0.75}
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt2, clientY: window.__e2eY2 }))
        return 'ok'
      })()`)
      if (start !== 'ok') return start
      await sleep(300)
      const hintCls = await settingsEval(`(() => {
        const rows = Array.from(document.querySelectorAll('.pm-row')).filter(r => !r.hasAttribute('data-comp'))
        return rows[${toIdx}]?.className ?? 'missing-row'
      })()`)
      await settingsEval(`(() => {
        const rows = Array.from(document.querySelectorAll('.pm-row')).filter(r => !r.hasAttribute('data-comp'))
        const from = rows[${fromIdx}]
        const to = rows[${toIdx}]
        if (!from || !to) return 'missing-row'
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt2, clientY: window.__e2eY2 }))
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt2 }))
        return 'ok'
      })()`)
      await sleep(900)
      return hintCls
    }

    // ① 通知(页2) 拖到 待办(页0) 上半 → 插到最前：[2,0,1,3,4]
    const c1 = await dragPageRow(2, 0, 'before')
    ok('S10b 悬停目标行上半出现「插到前面」提示类',
      typeof c1 === 'string' && c1.includes('pm-drop-before'), c1)
    let pg = readPrefs()?.pagesCustom?.pages
    ok('S10c 插入到前面：pages 变为 [2,0,1,3,4]',
      JSON.stringify(pg) === JSON.stringify([2, 0, 1, 3, 4]), JSON.stringify(pg))
    // 反证不是互换：互换会得到 [2,1,0,3,4]（1 与 0 换位）
    ok('S10d 不是互换语义（待办没被顶到通知原位）',
      JSON.stringify(pg) !== JSON.stringify([2, 1, 0, 3, 4]), JSON.stringify(pg))

    // ② 音乐(页4) 拖到 待办(页0) 上半 → [2,0,1,3,4] 里 0 在下标 1，插到它前面 → [2,4,0,1,3]
    //    选跨 3 位的组合：相邻两行调换时插入和互换结果相同，没有判别力
    await dragPageRow(4, 1, 'before')
    pg = readPrefs()?.pagesCustom?.pages
    ok('S10e 再拖一次仍是插入：pages 变为 [2,4,0,1,3]',
      JSON.stringify(pg) === JSON.stringify([2, 4, 0, 1, 3]), JSON.stringify(pg))
    // 反证：互换会得到 [2,4,1,3,0]
    ok('S10f 第二次也不是互换（1 与 0 位置未对调）',
      JSON.stringify(pg) !== JSON.stringify([2, 4, 1, 3, 0]), JSON.stringify(pg))

    // ③ 第一行(页2) 拖到 最后一行(页3) 下半 → [4,0,1,3,2]
    const c2 = await dragPageRow(0, 4, 'after')
    ok('S10g 悬停目标行下半出现「插到后面」提示类',
      typeof c2 === 'string' && c2.includes('pm-drop-after'), c2)
    pg = readPrefs()?.pagesCustom?.pages
    ok('S10h 插入到后面：pages 变为 [4,0,1,3,2]',
      JSON.stringify(pg) === JSON.stringify([4, 0, 1, 3, 2]), JSON.stringify(pg))
    // 反证：互换会得到 [3,4,0,1,2]
    ok('S10i 第三次也不是互换（首尾对调）',
      JSON.stringify(pg) !== JSON.stringify([3, 4, 0, 1, 2]), JSON.stringify(pg))
    ok('S10j pages 长度仍为 5 且无重复',
      Array.isArray(pg) && pg.length === 5 && new Set(pg).size === 5, JSON.stringify(pg))

    // ④ 拖到自己身上不变化
    await dragPageRow(1, 1, 'before')
    ok('S10k 拖到自身不改变 pages',
      JSON.stringify(readPrefs()?.pagesCustom?.pages) === JSON.stringify([4, 0, 1, 3, 2]),
      JSON.stringify(readPrefs()?.pagesCustom?.pages))

    // 收尾：重置回默认，别把用户的页面顺序留在测试态
    await settingsEval(`(() => { const r = document.querySelector('.pm-reset'); if (r) r.click(); return 'ok' })()`)
    await sleep(700)
    ok('S10l 重置回默认 [0,1,2,3,4]',
      JSON.stringify(readPrefs()?.pagesCustom?.pages) === JSON.stringify([0, 1, 2, 3, 4]),
      JSON.stringify(readPrefs()?.pagesCustom?.pages))
  }

  // ========== S11 导出数据搬进设置窗口（2026-11-11 用户要求） ==========
  {
    await settingsEval(`(() => { const b = Array.from(document.querySelectorAll('.set-nav-item')).find(e => e.textContent.includes('常规')); if (b) b.click(); return 'ok' })()`)
    await sleep(600)
    const hasRow = await settingsEval(`document.body.innerText.includes('导出数据')`)
    ok('S11a 常规分区有「导出数据」行', hasRow === true)
    const btnText = await settingsEval(`(() => {
      const b = Array.from(document.querySelectorAll('.set-btn')).find(e => e.textContent.includes('导出'))
      return b ? b.textContent.trim() : 'no-btn'
    })()`)
    ok('S11b 有「导出…」按钮', typeof btnText === 'string' && btnText.includes('导出'), btnText)

    // 真点一次，主进程会弹原生另存为；用 WM_CLOSE 按标题关掉，断言走的是取消分支
    // （证明 IPC 通道存活且模态确实挂在设置窗口上，不会卡死）。手法同 e2e-export.mjs。
    const closeDialog = () => {
      const script = [
        'Add-Type -TypeDefinition @\'',
        'using System;',
        'using System.Runtime.InteropServices;',
        'using System.Text;',
        'public class WClose2 {',
        '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);',
        '  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);',
        '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
        '}',
        '\'@',
        '$cb = [WClose2+EnumWindowsProc]{ param($h,$l)',
        '  if ([WClose2]::IsWindowVisible($h)) {',
        '    $sb = New-Object System.Text.StringBuilder 256',
        '    [void][WClose2]::GetWindowText($h,$sb,256)',
        '    if ($sb.ToString() -match \'导出灵动岛数据|另存为\') { [void][WClose2]::SendMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }',
        '  }',
        '  $true',
        '}',
        '[void][WClose2]::EnumWindows($cb,[IntPtr]::Zero)'
      ].join('\n')
      try { spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' }) } catch { /* 关不掉就靠超时 */ }
    }
    setTimeout(closeDialog, 1200)
    const raw = await settingsEval(`window.island.exportData().then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`)
    let res = null
    if (typeof raw === 'string' && raw.startsWith('{')) {
      try { res = JSON.parse(raw) } catch { /* 非 JSON 就按失败处理 */ }
    }
    ok('S11c 导出 IPC 通道存活（返回结构合法）',
      res !== null && typeof res.ok === 'boolean', String(raw))
    ok('S11d 对话框取消后返回 canceled 分支（不落盘）',
      res !== null && (res.ok === true || (res.canceled === true && res.reason === 'canceled')),
      String(raw))
    if (res && res.ok && typeof res.path === 'string' && existsSync(res.path)) {
      // 万一对话框没关掉、用户点了保存，清理掉这份测试产物
      try { rmSync(res.path, { force: true }) } catch { /* ignore */ }
      console.log('  ! 注意：另存为对话框被误确认，已删除测试文件 ' + res.path)
    }
  }

  // ========== S12 跨区拖拽护栏：页面行拖到组件行不能弄坏 order（独立验收 5.1 回归）==========
  // 采样要点（复验指出第一版 S12 恒真，已按此改写）：
  // ① 提示线必须在 dragover 之后、drop 之前采样 —— onDragEnd 会立刻清掉它，事后再查必然为 0；
  // ② 第 7 行只活约 3ms，单点采样必然读到 6，必须用 MutationObserver + rAF 取整段帧序列的最大值。
  {
    await settingsEval(`(() => { const b = Array.from(document.querySelectorAll('.set-nav-item')).find(e => e.textContent.includes('页面管理')); if (b) b.click(); return 'ok' })()`)
    await sleep(600)
    await settingsEval(`(() => { const r = document.querySelector('.pm-reset'); if (r) r.click(); return 'ok' })()`)
    await sleep(700)
    const before = readPrefs()
    const cmpBefore = await settingsEval(`document.querySelectorAll('.pm-row[data-comp]').length`)
    ok('S12a 前置：组件行 6 行、order 6 个键',
      cmpBefore === 6 && Array.isArray(before?.pagesCustom?.order) && before.pagesCustom.order.length === 6,
      `行 ${cmpBefore} / order ${JSON.stringify(before?.pagesCustom?.order)}`)

    // 装观测器 + 派发 dragstart → dragover，返回「dragover 之后」的提示线数量（此刻还没 drop）
    // 行数用 MutationObserver 的同步回调记录 —— 第 7 行只活约 3ms，纯 rAF 采样（约 16.7ms 一帧）会漏。
    const hintAtHover = await settingsEval(`(() => {
      const snap = () => {
        const comp = document.querySelectorAll('.pm-row[data-comp]').length
        const all = document.querySelectorAll('.pm-row').length
        if (comp > window.__s12.maxComp) window.__s12.maxComp = comp
        if (all > window.__s12.maxAll) window.__s12.maxAll = all
        window.__s12.frames++
      }
      window.__s12 = { maxComp: 0, maxAll: 0, frames: 0, running: true }
      window.__s12.mo = new MutationObserver(() => { if (window.__s12.running) snap() })
      window.__s12.mo.observe(document.querySelector('.pm-panel'), { childList: true, subtree: true, attributes: true, characterData: true })
      const tick = () => { if (!window.__s12.running) return; snap(); requestAnimationFrame(tick) }
      requestAnimationFrame(tick)

      const pageRows = Array.from(document.querySelectorAll('.pm-row')).filter(r => !r.hasAttribute('data-comp'))
      const compRows = Array.from(document.querySelectorAll('.pm-row[data-comp]'))
      const from = pageRows[0]
      const to = compRows[0]
      if (!from || !to) return 'missing-row'
      window.__e2eDt3 = new DataTransfer()
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt3 }))
      const b = to.getBoundingClientRect()
      window.__e2eY3 = b.top + b.height * 0.25
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt3, clientY: window.__e2eY3 }))
      return 'ok'
    })()`)
    await sleep(350) // 让 React 提交 dragover 引起的状态更新，同时观测器持续采样
    const hoverHints = await settingsEval(`document.querySelectorAll('.pm-drop-before,.pm-drop-after').length`)
    ok('S12b 跨区悬停时不亮落点提示线（dragover→drop 之间采样）',
      hintAtHover === 'ok' && hoverHints === 0, `dragover ${hintAtHover} / 提示线 ${hoverHints}`)

    // 继续 drop + dragend，然后收观测器
    await settingsEval(`(() => {
      const pageRows = Array.from(document.querySelectorAll('.pm-row')).filter(r => !r.hasAttribute('data-comp'))
      const compRows = Array.from(document.querySelectorAll('.pm-row[data-comp]'))
      const from = pageRows[0]
      const to = compRows[0]
      if (!from || !to) return 'missing-row'
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt3, clientY: window.__e2eY3 }))
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDt3 }))
      return 'ok'
    })()`)
    await sleep(700)
    const frames = await settingsEval(`(() => {
      window.__s12.running = false
      if (window.__s12.mo) window.__s12.mo.disconnect()
      return { maxComp: window.__s12.maxComp, maxAll: window.__s12.maxAll, frames: window.__s12.frames }
    })()`)

    const after = readPrefs()
    ok('S12c 全过程组件行峰值仍是 6（观测器覆盖 ' + (frames?.frames ?? '?') + ' 帧，没冒第 7 行）',
      frames?.maxComp === 6, `峰值 ${frames?.maxComp}`)
    ok('S12d 全过程总行峰值仍是 11（5 页 + 6 组件）', frames?.maxAll === 11, `峰值 ${frames?.maxAll}`)
    ok('S12e order 仍是 6 个合法键，没有混进数字',
      Array.isArray(after?.pagesCustom?.order) &&
        after.pagesCustom.order.length === 6 &&
        after.pagesCustom.order.every((k) => typeof k === 'string'),
      JSON.stringify(after?.pagesCustom?.order))
    ok('S12f 页面顺序未被跨区拖拽改动',
      JSON.stringify(after?.pagesCustom?.pages) === JSON.stringify(before?.pagesCustom?.pages),
      `前 ${JSON.stringify(before?.pagesCustom?.pages)} → 后 ${JSON.stringify(after?.pagesCustom?.pages)}`)
    ok('S12g 观测器确实在采样（帧数 > 0，防「观测器没跑导致恒真」）',
      typeof frames?.frames === 'number' && frames.frames > 0, `帧数 ${frames?.frames}`)
  }

  // ========== S6 关闭设置窗口不影响岛 ==========
  {
    await closeSettings()
    const after = await listTargets()
    ok('S6a 关闭后 settings.html target 消失', !after.some(IS_SETTINGS), JSON.stringify(after.map((t) => t.url)))
    const alive = await islandEval(`document.querySelector('.island') ? 1 : 0`)
    ok('S6b 岛仍然存活（关设置窗 ≠ 退出应用）', alive === 1, `实际 ${alive}`)
  }

  // ========== S8 重复打开不叠窗口 ==========
  {
    await openSettings('general')
    await openSettings('pages')
    const all = await listTargets()
    const settingsCount = all.filter(IS_SETTINGS).length
    ok('S8a 连续打开两次只有一个设置窗口', settingsCount === 1, `实际 ${settingsCount}`)
    const rows = await settingsEval(`document.querySelectorAll('.pm-row[data-comp]').length`)
    ok('S8b 第二次打开把分区切到页面管理', rows === 6, `实际组件行 ${rows}`)
  }
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  // 恢复顺序有讲究：注册表要赶在 killApp() 之前（靠应用 IPC 写回去），
  // 文件备份在应用杀掉后写更安全（不会被运行中的应用覆写）。
  await restoreAutostart()
  killApp()
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
  if (notifBackup !== null) writeFileSync(NOTIF_READ, notifBackup, 'utf8')
}

console.log(`\nE2E SETTINGS-SHELL: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
