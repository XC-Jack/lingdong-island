#!/usr/bin/env node
/**
 * e2e SPEC-music-page：音乐页（US-031，控制 + 信息，不做歌词/封面）
 *
 * M1 岛里出现第 5 个翻页圆点，点它能进音乐页
 * M2 音乐页结构：有歌名行/进度条/三个控制按钮；没有会话时是空态文案
 * M3 播放/暂停：点主按钮 → 主进程回来 playing 真的翻转 → 岛上的按钮 aria-pressed 跟着变 → 再点回原状
 * M4 进度条：transform: scaleX(...) 随 position/duration 变化，且 0..1 之间
 * M5 prefs 迁移：只有旧 pages（[0,1,2,3]）、没有 musicIntro → 补上音乐页并落音乐页标记；
 *    已有 musicIntro: true 且用户关掉音乐页 → 不复活（补一次就够了）
 * M6 页面管理里能勾掉音乐页 → 岛圆点少一个；勾回 → 恢复
 *
 * 前提：本机要有注册了 SMTC 的播放器（PotPlayer / 网易云 / 系统「电影和电视」等）。
 * 没有会话时不判失败，但**有会话却读不到会话**（桥接坏了）判失败（M2a0）——这两件事以前被
 * 同一条 skip() 混在一起，导致功能已坏时 e2e 仍报 PASS（独立验收 B2）。
 *
 * 跑前：npm run build（e2e 加载 out/ 产物）。脚本自己启停 electron，结束恢复 prefs。
 * 有失败时以非 0 退出码结束。
 */
import { spawn, execSync } from './isolate-userdata.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9321
const USER_DATA = join(process.env.APPDATA, 'lingdong-island')
const PREFS = join(USER_DATA, 'prefs.json')

const DEFAULT_ORDER = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

let passed = 0
let failed = 0
let skipped = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}
const skip = (name, why) => { skipped++; console.log(`  ~ ${name}（跳过：${why}）`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IS_SETTINGS = (t) => (t.url ?? '').includes('settings.html')

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === 'page')
}

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
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id === 1) { clearTimeout(timer); ws.close(); res(m.result) }
        }
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
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  // 轮询 CDP 就绪，不再固定 sleep(3500)：迁移实测需要 2524ms，固定等 3500ms 只剩 1 秒余量，
  // 慢一点就会让 M5a/M5b 读 prefs 时迁移还没落盘。迁移在 app.whenReady 里、窗口创建之前完成，
  // 所以「能看到页面 target」就等于「迁移已经跑完」。
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try {
      const list = await listTargets()
      if (list.length > 0) break
    } catch { /* CDP 还没起来 */ }
    await sleep(250)
  }
  await sleep(400)
  return child
}

/**
 * 独立查询本机真实 SMTC 会话数 —— 故意不复用 src/main/smtcScript.ts 那条链路。
 * 目的：区分「本机真的没有播放器」和「有播放器但桥接读不到」。
 * 后者以前会被 skip() 吞掉，导致功能坏了 e2e 仍报 PASS（独立验收 B2）。
 * 返回 -1 表示查询本身失败（未知），调用方应退回旧的跳过行为。
 */
const SESSION_COUNT_PS1 = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" -and
  $_.GetGenericArguments().Count -eq 1
})[0]
$task = $asTask.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]).Invoke($null, @([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()))
$task.Wait(-1) | Out-Null
$mgr = $task.Result
[Console]::Out.WriteLine((@($mgr.GetSessions())).Count)
`

function countSessions() {
  try {
    mkdirSync(join(ROOT, '.tmp'), { recursive: true })
    const file = join(ROOT, '.tmp', 'e2e-session-count.ps1')
    // 必须带 UTF-8 BOM，否则 PS 5.1 按 ANSI 解码会把类型名解坏
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SESSION_COUNT_PS1, 'utf8')]))
    const out = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`, { encoding: 'utf8', timeout: 30000 })
    const n = Number(String(out).trim().split(/\r?\n/).pop())
    return Number.isFinite(n) ? n : -1
  } catch {
    return -1
  }
}

function writePrefs(pages, extra = {}) {
  writeFileSync(PREFS, JSON.stringify({
    ...extra,
    pagesCustom: {
      pages,
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
      order: DEFAULT_ORDER
    }
  }, null, 2), 'utf8')
}
const readPrefs = () => JSON.parse(readFileSync(PREFS, 'utf8'))

/**
 * 等岛渲染出来并确保处于展开态。
 * 重启后 React 首帧可能还没挂载，此时 `.island` 为 null——旧写法用可选链吞掉了这种情况，
 * 表面上返回 'ok' 其实一次都没点，圆点数自然是 0（M5e/M5g 偶发失败的真正原因）。
 */
async function ensureExpanded(maxMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const cls = String(await islandEval(`document.querySelector('.island')?.className ?? ''`))
    if (cls.includes('expanded')) return true
    if (cls.includes('collapsed')) {
      await islandEval(`(() => { const el = document.querySelector('.island'); if (el && !el.className.includes('expanded')) el.click(); return el ? 'clicked' : 'no-el' })()`)
      await sleep(700)
      continue
    }
    await sleep(400) // 还没挂载，再等
  }
  return false
}

/** 展开岛并跳到第 idx 个圆点（0 基） */
async function gotoDot(idx) {
  await ensureExpanded()
  const r = await islandEval(`(() => { const d = document.querySelectorAll('.dots .dot')[${idx}]; if (!d) return 'no-dot'; d.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok' })()`)
  await sleep(700)
  return r
}

/** 等桥接进程起来并采到第一条状态：首次 music:get 只负责懒启动，缓存可能是空的 */
async function waitForMusicState(maxMs = 8000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < maxMs) {
    last = await islandEval(`window.island.musicGet()`)
    if (last && typeof last === 'object' && (last.active === true || last.title || last.app)) return last
    await sleep(500)
  }
  return last
}

/** 勾/取消勾页面区名为 label 的那一行（页面行没有 data-comp，只能按 .pm-name 文案找） */
function clickPageRow(label) {
  return settingsEval(`(() => {
    const rows = Array.from(document.querySelectorAll('.pm-row')).filter(r => !r.hasAttribute('data-comp'))
    const row = rows.find(r => (r.querySelector('.pm-name')?.textContent ?? '').trim() === ${JSON.stringify(label)})
    if (!row) return 'no-row'
    const cb = row.querySelector('input[type=checkbox]')
    if (!cb) return 'no-cb'
    cb.click()
    return 'ok'
  })()`)
}

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null

try {
  mkdirSync(USER_DATA, { recursive: true })
  killApp(); await sleep(800)
  // 基线：5 页全开，且带上音乐页已补标记（不测迁移时就该是这样）
  writePrefs([0, 1, 2, 3, 4], { musicIntro: true })
  child = await startApp()

  // ========== M1 第 5 个圆点 ==========
  {
    await ensureExpanded()
    const dots = await islandEval(`document.querySelectorAll('.dots .dot').length`)
    ok('M1a 岛里 5 个翻页圆点（待办/置物架/通知/日程/音乐）', dots === 5, `实际 ${dots}`)
    const label = await islandEval(`(document.querySelectorAll('.dots .dot')[4]?.getAttribute('aria-label')) || ''`)
    ok('M1b 第 5 个圆点的无障碍名是音乐页', String(label).includes('音乐'), String(label))
    const r = await gotoDot(4)
    ok('M1c 点第 5 个圆点能进音乐页', r === 'ok', String(r))
    const atMusic = await islandEval(`(() => { const d = Array.from(document.querySelectorAll('.dots .dot')).findIndex(x => x.classList.contains('active')); return d })()`)
    ok('M1d 音乐页成为当前页（active 圆点下标 4）', atMusic === 4, `实际 ${atMusic}`)
  }

  // ========== M2 页面结构（有会话 / 无会话两条分支） ==========
  {
    const state = await waitForMusicState()
    const active = state?.active === true
    // 本机真实会话数（不复用被测链路）：用来区分「真没播放器」和「有播放器但读不到」
    const realSessions = countSessions()
    console.log(`  · 当前会话：${active ? `${state.title} / ${state.app} / ${state.playing ? '播放中' : '暂停'}` : '（无）'}；本机真实 SMTC 会话数 ${realSessions}`)
    // 有会话却读不到 = 功能坏了，必须判失败；以前这里会静默 skip，功能坏了 e2e 仍报 PASS
    const readable = realSessions <= 0 || active
    ok('M2a0 本机有 SMTC 会话时桥接必须能读到（读不到＝功能坏了，不算跳过）',
      readable, `真实会话 ${realSessions} 个，但 musicGet().active = ${active}`)
    const canCheckSession = active

    // 第 1 批 + 第 2 批新增字段：无论有会话还是空态，musicGet() 都必须带齐，不能出现 undefined
    ok('M2a1 新字段齐全（shuffle 布尔 / repeat 0..2 / volume 0..1 / 四个 can* 布尔 / cover 字符串）',
      state && typeof state.shuffle === 'boolean' &&
      typeof state.repeat === 'number' && state.repeat >= 0 && state.repeat <= 2 &&
      typeof state.volume === 'number' && state.volume >= 0 && state.volume <= 1 &&
      typeof state.canSeek === 'boolean' && typeof state.canShuffle === 'boolean' &&
      typeof state.canRepeat === 'boolean' && typeof state.canVolume === 'boolean' &&
      typeof state.cover === 'string',
      JSON.stringify(state))
    // 第 2 批：封面 data URL 格式必须合法（要么是空串，要么是合法 data:image）
    ok('M2a2 cover 是空串或合法 data:image（png/jpeg）',
      state && (state.cover === '' || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(state.cover)),
      `cover 长度=${String(state?.cover ?? '').length}`)

    const hasBar = await islandEval(`document.querySelectorAll('.music-bar-fill').length`)
    const btns = await islandEval(`document.querySelectorAll('.music-ctl .music-btn').length`)
    if (canCheckSession) {
      ok('M2a 有会话时渲染进度条', hasBar === 1, `实际 ${hasBar}`)
      ok('M2b 有会话时渲染三个控制按钮（上一首/播放暂停/下一首）', btns === 3, `实际 ${btns}`)
      const title = await islandEval(`document.querySelector('.music-title')?.textContent?.trim() ?? ''`)
      ok('M2c 歌名行非空', typeof title === 'string' && title.length > 0, `实际「${title}」`)
      const times = await islandEval(`Array.from(document.querySelectorAll('.music-time')).map(e => e.textContent.trim())`)
      ok('M2d 两个时间文本都在（当前 / 负数剩余）',
        Array.isArray(times) && times.length === 2 && times.every((t) => /^-?\d+:\d{2}(:\d{2})?$/.test(t)),
        JSON.stringify(times))
      // preflight：这些只是结构，不证明数据接得上
      ok('M2e musicGet 返回八字段齐全',
        state && typeof state.title === 'string' && typeof state.position === 'number' &&
        typeof state.duration === 'number' && typeof state.playing === 'boolean' && typeof state.app === 'string',
        JSON.stringify(state))
      // 三次修复（用户 m01006）：随机/循环在真实播放器上无法真执行也读不到状态，
      // 已直接删掉这两个假按钮。护栏：绝不允许它们再加回来。
      const chips = await islandEval(`document.querySelectorAll('.music-extra .music-chip').length`)
      ok('M2h 不再渲染随机 / 循环假按钮', chips === 0, `实际 ${chips}`)
      const volRange = await islandEval(`document.querySelectorAll('.music-volume input[type="range"]').length`)
      ok('M2i 有会话时渲染音量滑块', volRange === 1, `实际 ${volRange}`)
      const seekBox = await islandEval(`document.querySelectorAll('.music-seek').length`)
      ok('M2j 有会话时渲染进度条拖拽热区', seekBox === 1, `实际 ${seekBox}`)
      // 音量：只对得上当前播放应用的音频会话才允许拖，对不上号必须置灰且显示 --
      const volUi = await islandEval(`(() => { const i = document.querySelector('.music-volume input[type="range"]'); const n = document.querySelector('.music-volume-num'); return { disabled: i ? i.disabled : null, text: n ? n.textContent.trim() : null } })()`)
      ok('M2l 音量滑块按 canVolume 置灰、对不上号显示 --',
        volUi && volUi.disabled === (state.canVolume !== true) &&
        (state.canVolume === true ? /^\d+%$/.test(volUi.text ?? '') : volUi.text === '--'),
        `禁用=${volUi?.disabled} / canVolume=${state.canVolume} / 显示=${volUi?.text}`)
      // 第 2 批：有封面时 .music-cover 里是 <img>，没封面时回落音符 svg，二者必居其一
      const coverUi = await islandEval(`(() => { const c = document.querySelector('.music-cover'); const i = c?.querySelector('img.music-cover-img'); const s = c?.querySelector('svg'); return { hasImg: !!i, hasSvg: !!s, imgPrefix: i ? (i.getAttribute('src') || '').slice(0, 24) : '' } })()`)
      ok('M2m 封面容器渲染（有封面用 img / 无封面回落音符 svg）',
        coverUi && (state.cover !== '' ? (coverUi.hasImg === true && coverUi.hasSvg === false) : (coverUi.hasImg === false && coverUi.hasSvg === true)),
        `cover=${state.cover ? '有' : '无'} / hasImg=${coverUi?.hasImg} / hasSvg=${coverUi?.hasSvg}`)
      if (state.cover !== '') {
        ok('M2n 封面 img 的 src 是合法 data:image 前缀',
          /^data:image\/(png|jpeg);base64,/.test(coverUi?.imgPrefix ?? ''),
          `src 前缀=${coverUi?.imgPrefix}`)
      }
      // 用户 m02652 整页照参考图重排：播放按钮回到进度条下方独立控制行、相对整岛居中；
      // 音量保持竖直弹出（m02917 纠正回竖线）；封面行右侧只留诚实「暂无歌词」占位；进度右端用负数剩余时间
      const ctlPos = await islandEval(`(() => {
        const row = document.querySelector('.music-control-row');
        const ctl = row?.querySelector('.music-ctl');
        const island = document.querySelector('.island');
        const main = document.querySelector('.music-main');
        if (!ctl || !island) return null;
        const c = ctl.getBoundingClientRect(), ir = island.getBoundingClientRect();
        return {
          inRow: !!row,
          inMain: main ? main.contains(ctl) : null,
          ctlCenterX: (c.left + c.right) / 2,
          islandCenterX: (ir.left + ir.right) / 2
        };
      })()`)
      ok('U1 播放按钮回到进度条下方控制行、相对整岛居中（不再嵌在封面行）',
        ctlPos && ctlPos.inRow === true && ctlPos.inMain === false &&
        Math.abs(ctlPos.ctlCenterX - ctlPos.islandCenterX) <= 6,
        JSON.stringify(ctlPos))
      const popHidden = await islandEval(`(() => { const p = document.querySelector('.music-vol-pop'); return p ? getComputedStyle(p).visibility : null })()`)
      ok('U2 音量竖条平时隐形（点喇叭前不可见）', popHidden === 'hidden', `visibility=${popHidden}`)
      await islandEval(`document.querySelector('.music-vol-toggle')?.click()`)
      await sleep(250)
      const popShown = await islandEval(`(() => {
        const p = document.querySelector('.music-vol-pop');
        const island = document.querySelector('.island');
        if (!p || !island) return null;
        const pr = p.getBoundingClientRect(), ir = island.getBoundingClientRect();
        return { visibility: getComputedStyle(p).visibility, inside: pr.left >= ir.left - 1 && pr.right <= ir.right + 1 && pr.top >= ir.top - 1 && pr.bottom <= ir.bottom + 1, w: pr.width, h: pr.height };
      })()`)
      ok('U3 点喇叭后竖条显现且完整落在岛内（不被 overflow 裁）',
        popShown && popShown.visibility === 'visible' && popShown.inside === true && popShown.h > 60 && popShown.w < 60,
        JSON.stringify(popShown))
      // 收起，避免影响后续 M3/M4
      await islandEval(`document.querySelector('.music-vol-toggle')?.click()`)
      const lyricSlot = await islandEval(`(() => {
        const slot = document.querySelector('.music-lyric-slot');
        const online = document.querySelectorAll('.music-lyric-line, [data-lyric], .music-lyrics').length;
        return { text: slot ? slot.textContent.trim() : null, online };
      })()`)
      ok('U4 封面行右侧只有诚实占位「暂无歌词」、不引入联网歌词',
        lyricSlot && lyricSlot.text === '暂无歌词' && lyricSlot.online === 0,
        JSON.stringify(lyricSlot))
      const remainTime = await islandEval(`(() => { const t = document.querySelectorAll('.music-time'); return t.length === 2 ? t[1].textContent.trim() : null })()`)
      ok('U5 进度行右端显示负数剩余时间（-mm:ss）',
        typeof remainTime === 'string' && /^-\d+:\d{2}(:\d{2})?$/.test(remainTime),
        `实际「${remainTime}」`)
    } else if (realSessions > 0) {
      // 已有 M2a0 判失败，这里不重复计败，也不假装通过
      skip('M2a–M2e 有会话时的结构断言', `本机有 ${realSessions} 个会话但桥接读不到，已在 M2a0 判失败`)
    } else {
      skip('M2a–M2e 有会话时的结构断言', '本机确实没有注册 SMTC 的播放器会话')
      const empty = await islandEval(`document.body.innerText.includes('现在没有在放歌')`)
      ok('M2f 无会话时显示空态文案', empty === true)
      const noCtl = await islandEval(`document.querySelectorAll('.music-ctl .music-btn').length`)
      ok('M2g 无会话时不渲染控制按钮', noCtl === 0, `实际 ${noCtl}`)
    }
  }

  // ========== M3 播放/暂停真的打通到播放器 ==========
  {
    const before = await waitForMusicState()
    if (before?.active !== true) {
      // 有会话却读不到已在 M2a0 判失败；这里只区分「真没会话」与「已知坏了」
      const n = countSessions()
      skip('M3a–M3d 播放/暂停控制', n > 0 ? `本机有 ${n} 个会话但桥接读不到（已由 M2a0 判失败）` : '本机确实没有活动播放会话')
    } else {
      // 点主按钮
      await islandEval(`(() => { const b = document.querySelector('.music-btn-main'); if (!b) return 'no-btn'; b.click(); return 'ok' })()`)
      await sleep(1800)
      const after = await islandEval(`window.island.musicGet()`)
      ok(`M3a 点主按钮后播放状态翻转（${before.playing ? '播放' : '暂停'} → ${!before.playing ? '播放' : '暂停'}）`,
        after?.playing === !before.playing, `前 ${before.playing} / 后 ${after?.playing}`)
      const pressed = await islandEval(`document.querySelector('.music-btn-main')?.getAttribute('aria-pressed') ?? 'missing'`)
      ok('M3b 岛上的按钮 aria-pressed 跟着新状态变',
        pressed === String(after?.playing === true), `实际 ${pressed}，状态 ${after?.playing}`)
      // 还原用户原来的播放状态（测试不该把用户的播放器留在动）
      await islandEval(`window.island.musicControl('toggle')`)
      await sleep(1500)
      const back = await islandEval(`window.island.musicGet()`)
      ok('M3c 再切一次回到原来的播放状态（没把用户播放器留在动）',
        back?.playing === before.playing, `原始 ${before.playing} / 现在 ${back?.playing}`)
      ok('M3d 控制期间歌曲没被换掉（toggle 不误触 next）',
        back?.title === before.title, `前「${before.title}」后「${back?.title}」`)
    }
  }

  // ========== M4 进度条比例正确 ==========
  {
    const s = await waitForMusicState()
    if (s?.active !== true || !(s.duration > 0)) {
      const n = countSessions()
      skip('M4a–M4c 进度条比例', s?.active === true ? '总时长未知' : (n > 0 ? `本机有 ${n} 个会话但桥接读不到（已由 M2a0 判失败）` : '没有会话'))
    } else {
      const scale = await islandEval(`(() => {
        const el = document.querySelector('.music-bar-fill')
        if (!el) return null
        const m = /scaleX\\(([\\d.]+)\\)/.exec(el.style.transform || '')
        return m ? Number(m[1]) : null
      })()`)
      ok('M4a 进度条用 transform: scaleX(...) 表达比例', typeof scale === 'number', String(scale))
      ok('M4b 比例在 0..1 之内', typeof scale === 'number' && scale >= 0 && scale <= 1, String(scale))
      // 采样点的真实比例（允许 1 秒本地插值误差）
      const expect = Math.min(1, Math.max(0, s.position / s.duration))
      ok('M4c 比例与 position/duration 相符（±0.03）',
        typeof scale === 'number' && Math.abs(scale - expect) <= 0.03,
        `实际 ${scale} / 期望约 ${expect.toFixed(3)}`)
    }
  }

  // ========== M5 prefs 迁移：老用户补一次音乐页 ==========
  {
    // 5a 只有旧 4 页、没有 musicIntro → 启动后应该被补上音乐页
    await islandEval(`(() => { const el = document.querySelector('.island'); if (el && el.className.includes('expanded')) el.click(); return 'ok' })()`)
    await sleep(400)
    killApp(); await sleep(900)
    writePrefs([0, 1, 2, 3]) // 故意不写 musicIntro
    child = await startApp()
    const migrated = readPrefs()
    ok('M5a 老数据（pages 只有 4 页、无 musicIntro）启动后被补上音乐页',
      Array.isArray(migrated?.pagesCustom?.pages) && migrated.pagesCustom.pages.includes(4),
      JSON.stringify(migrated?.pagesCustom?.pages))
    ok('M5b 补完落了 musicIntro 标记（只补一次）', migrated?.musicIntro === true, String(migrated?.musicIntro))

    // 5c 用户补完后自己关掉音乐页 → 重启不能复活
    await islandEval(`window.island.openSettings('pages')`)
    await sleep(1800)
    const offRow = await clickPageRow('音乐')
    ok('M5c 设置窗口能勾掉音乐页（页面区有音乐这一行）', offRow === 'ok', String(offRow))
    await sleep(900)
    const off = readPrefs()
    ok('M5c2 取消勾选后 prefs 里 pages 不再含 4',
      Array.isArray(off?.pagesCustom?.pages) && !off.pagesCustom.pages.includes(4),
      JSON.stringify(off?.pagesCustom?.pages))

    killApp(); await sleep(900)
    child = await startApp()
    const after = readPrefs()
    ok('M5d 用户关掉后重启不复活（musicIntro 挡住了重复补入）',
      Array.isArray(after?.pagesCustom?.pages) && !after.pagesCustom.pages.includes(4),
      JSON.stringify(after?.pagesCustom?.pages))
    await ensureExpanded()
    const n = await islandEval(`document.querySelectorAll('.dots .dot').length`)
    ok('M5e 关掉后岛里只剩 4 个圆点', n === 4, `实际 ${n}`)

    // 勾回来
    await islandEval(`window.island.openSettings('pages')`)
    await sleep(1800)
    const backRow = await clickPageRow('音乐')
    ok('M5f 设置窗口能重新勾上音乐页', backRow === 'ok', String(backRow))
    await sleep(1200)
    // 设置窗口在前台时岛通常是收起态；先关掉设置窗口再展开岛看圆点（也是真实用户看到的顺序）
    await islandEval(`window.island.closeSettings()`)
    await sleep(900)
    await ensureExpanded()
    const back2 = await islandEval(`document.querySelectorAll('.dots .dot').length`)
    ok('M5g 勾回音乐页后岛当场恢复 5 个圆点（prefs:changed 广播）', back2 === 5, `实际 ${back2}`)
  }
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  killApp()
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
}

console.log(`\nE2E MUSIC: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败${skipped > 0 ? ` / ${skipped} 跳过` : ''}）`)
// 有失败必须以非 0 退出，否则 CI/验收方只能靠人眼看日志（其余 e2e 脚本都是这个口径）
process.exit(failed > 0 ? 1 : 0)
