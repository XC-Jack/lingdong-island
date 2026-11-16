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
      // 用户 m02652 整页照参考图重排：播放按钮独立控制行；
      // 用户 m03435「播放和切换要位于歌名的正下方中心位置」把基准从整岛改成了左栏；
      // 用户 m03577「再喇叭右边加一个"词"这样的ui，所有播放和切歌整体要向左移」；
      // 用户 m04117「可以把封面等ui分开一点布局，这样子可以填满这个界面，这样两边的黑边就不会很多余」
      // ⇒ 收起态控制行与左栏同宽铺满整行：「词」+ 三按钮居中组、喇叭贴最右，两端不再留黑边。
      const ctlPos = await islandEval(`(() => {
        const row = document.querySelector('.music-control-row');
        const ctl = row?.querySelector('.music-ctl');
        const side = document.querySelector('.music-side');
        const main = document.querySelector('.music-main');
        if (!ctl || !side) return null;
        const c = ctl.getBoundingClientRect(), sr = side.getBoundingClientRect();
        const btns = [...ctl.querySelectorAll('.music-btn')];
        const first = btns[0]?.getBoundingClientRect(), last = btns[btns.length - 1]?.getBoundingClientRect();
        const grpCenter = (first && last) ? (first.left + last.right) / 2 : null;
        const box = document.querySelector('.music-ctl-buttons')?.getBoundingClientRect();
        return {
          inRow: !!row,
          inMain: main ? main.contains(ctl) : null,
          btnCount: btns.length,
          ctlCenterX: (c.left + c.right) / 2,
          grpCenterX: grpCenter,
          sideCenterX: (sr.left + sr.right) / 2,
          ctlW: c.width,
          sideW: sr.width,
          boxLeft: box ? box.left : null,
          boxRight: box ? box.right : null,
          sideLeft: sr.left,
          sideRight: sr.right
        };
      })()`)
      ok('U1 控制行与左栏同宽、铺满整行不留黑边（用户 m04117）',
        ctlPos && ctlPos.inRow === true && ctlPos.inMain === false && ctlPos.btnCount === 3 &&
        Math.abs(ctlPos.ctlW - ctlPos.sideW) <= 1 &&
        ctlPos.boxLeft >= ctlPos.sideLeft - 1 && ctlPos.boxRight <= ctlPos.sideRight + 1,
        JSON.stringify(ctlPos))
      // 用户 m04117 要求过「填满整行、两边不要黑边」，当时把喇叭推到控制行最右端；
      // 用户 m04310「喇叭还是贴着下一首比较好一点」⇒ 喇叭回到紧跟「下一首」右侧，整组居中。
      const volSide = await islandEval(`(() => {
        const btns = [...document.querySelectorAll('.music-ctl .music-btn')];
        const next = btns[btns.length - 1];
        const toggle = document.querySelector('.music-vol-toggle');
        const box = document.querySelector('.music-ctl-buttons');
        if (!next || !toggle || !box) return null;
        const nr = next.getBoundingClientRect(), tr = toggle.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        const island = document.querySelector('.island').getBoundingClientRect();
        return { nextRight: nr.right, toggleLeft: tr.left, gap: tr.left - nr.right, toggleRight: tr.right, boxRight: br.right, boxLeft: br.left, islandRight: island.right };
      })()`)
      ok('U1b 喇叭紧贴「下一首」右侧、不再吊到控制行两端（用户 m04310）',
        volSide && volSide.gap >= 0 && volSide.gap <= 24 &&
        volSide.toggleRight < volSide.islandRight - 8,
        JSON.stringify(volSide))
      // 用户 m03435 要求过「词」在喇叭右边；用户 m04117 改为「歌词ui放切上一首的旁边」：
      // 现在「词」紧挨在「上一首」左侧，并且整组（词 + 三按钮）在剩余宽度里居中、喇叭贴最右。
      const wordUi = await islandEval(`(() => {
        const w = document.querySelector('.music-word');
        const prev = document.querySelector('.music-ctl .music-btn');
        const box = document.querySelector('.music-ctl-buttons');
        if (!w || !prev || !box) return { found: false };
        const wr = w.getBoundingClientRect(), pr = prev.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        const island = document.querySelector('.island').getBoundingClientRect();
        return { found: true, text: w.textContent.trim(), gapToPrev: pr.left - wr.right, leftGap: wr.left - br.left, insideIsland: wr.right <= island.right + 1, w: wr.width, h: wr.height };
      })()`)
      ok('U1c「词」紧挨「上一首」左边、不再吊在喇叭右侧（用户 m04117）',
        wordUi && wordUi.found === true && wordUi.text === '词' &&
        wordUi.gapToPrev >= 0 && wordUi.gapToPrev <= 24 &&
        wordUi.leftGap >= -1 && wordUi.insideIsland === true,
        JSON.stringify(wordUi))
      // 用户 m03837「我指的是整个右边隐藏了…按了歌词，就会把 ui 挤到左边，然后竖线隔开出现歌词」：
      // 歌词栏默认整块不占位（display:none），点「词」后岛变宽、竖线出现、右栏挤出来。
      const pagedBefore = await islandEval(`(() => {
        const slot = document.querySelector('.music-lyric-slot');
        const div = document.querySelector('.music-divider');
        const isl = document.querySelector('.island');
        return {
          slot: slot ? getComputedStyle(slot).display : null,
          divider: div ? getComputedStyle(div).display : null,
          islandW: isl ? Math.round(isl.getBoundingClientRect().width) : null,
          online: document.querySelectorAll('.music-lyric-line, [data-lyric], .music-lyrics').length
        };
      })()`)
      ok('U1d 歌词栏默认整块隐藏、岛是窄态（用户 m03837「整个右边隐藏了」）',
        pagedBefore && pagedBefore.slot === 'none' && pagedBefore.divider === 'none' && pagedBefore.online === 0,
        JSON.stringify(pagedBefore))
      await islandEval(`document.querySelector('.music-word')?.click()`)
      await sleep(700)
      const pagedOpen = await islandEval(`(() => {
        const slot = document.querySelector('.music-lyric-slot');
        const div = document.querySelector('.music-divider');
        const side = document.querySelector('.music-side');
        const isl = document.querySelector('.island');
        const w = document.querySelector('.music-word');
        if (!slot || !div || !side || !isl) return null;
        const pr = slot.getBoundingClientRect(), sr = side.getBoundingClientRect();
        const ir = isl.getBoundingClientRect(), dr = div.getBoundingClientRect();
        return {
          slot: getComputedStyle(slot).display,
          divider: getComputedStyle(div).display,
          islandW: Math.round(ir.width),
          slotW: Math.round(pr.width),
          sideW: Math.round(sr.width),
          dividerX: Math.round(dr.left),
          leftOfDivider: dr.left >= sr.right - 1,
          slotRightOfDivider: pr.left >= dr.right - 1,
          insideIsland: pr.right <= ir.right + 1,
          wordExpanded: w ? w.getAttribute('aria-expanded') : null,
          online: document.querySelectorAll('.music-lyric-line, [data-lyric], .music-lyrics').length,
          text: slot.textContent.replace(/\\s+/g, ' ').trim()
        };
      })()`)
      ok('U1e 点「词」把岛挤宽、竖线出现、右侧多出歌词栏（用户 m03837/m03840「宽一点」）',
        pagedOpen && pagedOpen.slot === 'flex' && pagedOpen.divider === 'block' &&
        pagedOpen.islandW > pagedBefore.islandW + 80 &&
        pagedOpen.slotW > pagedOpen.sideW &&
        pagedOpen.leftOfDivider === true && pagedOpen.slotRightOfDivider === true &&
        pagedOpen.insideIsland === true && pagedOpen.wordExpanded === 'true' &&
        pagedOpen.online === 0,
        JSON.stringify({ before: pagedBefore, after: pagedOpen }))
      await islandEval(`document.querySelector('.music-word')?.click()`)
      await sleep(700)
      const pagedBack = await islandEval(`(() => {
        const slot = document.querySelector('.music-lyric-slot');
        const div = document.querySelector('.music-divider');
        const isl = document.querySelector('.island');
        const w = document.querySelector('.music-word');
        return {
          slot: slot ? getComputedStyle(slot).display : null,
          divider: div ? getComputedStyle(div).display : null,
          islandW: isl ? Math.round(isl.getBoundingClientRect().width) : null,
          wordExpanded: w ? w.getAttribute('aria-expanded') : null
        };
      })()`)
      ok('U1f 再点一次「词」歌词栏收起、岛缩回原宽（用户 m03837）',
        pagedBack && pagedBack.slot === 'none' && pagedBack.divider === 'none' &&
        pagedBack.islandW === pagedBefore.islandW && pagedBack.wordExpanded === 'false',
        JSON.stringify(pagedBack))
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
      // 用户 m03141「音量建无法拖动」→ m04432「现在直接拖动不了」：3px 可见轨道真人瞄不准。
      // 现在的做法是浮层里盖一层透明热区 .music-vol-drag 接管拖动（App.tsx 的 pointer 处理），
      // 所以这里量的是「可拖动的命中宽度」＝ elementFromPoint 落在 input 或热区层上都算。
      const volHit = await islandEval(`(() => {
        const i = document.querySelector('.music-vol-pop input[type="range"]');
        const d = document.querySelector('.music-vol-pop .music-vol-drag');
        if (!i) return null;
        const r = i.getBoundingClientRect();
        const dr = d ? d.getBoundingClientRect() : null;
        const y = r.top + r.height / 2;
        const cxs = r.left + r.width / 2;
        let hit = 0;
        for (let dx = -30; dx <= 30; dx += 1) {
          const el = document.elementFromPoint(cxs + dx, y);
          if (el && (el === i || el === d)) hit += 1;
        }
        const covers = dr ? (dr.left <= r.left + 1 && dr.right >= r.right - 1 && dr.top <= r.top + 1 && dr.bottom >= r.bottom - 1) : false;
        return { boxW: Math.round(r.width), hitPx: hit, dragW: dr ? Math.round(dr.width) : null, dragH: dr ? Math.round(dr.height) : null, coversInput: covers };
      })()`)
      ok('U3b 音量拖动热区够宽且盖住滑块（可拖命中 ≥20px，横向偏 10px 仍能按下）',
        volHit && volHit.hitPx >= 20 && volHit.coversInput === true, JSON.stringify(volHit))
      // 用户 m04356「就是喇叭这个拉条，我想我点别的地方它也可以隐藏，而不是每次都要去点那个喇叭」：
      // 音量条开着时，在别处按下应当收起它；点条内（尤其拖滑块）不能收起。
      const clickOutside = await islandEval(`(() => {
        const pop = () => {
          const p = document.querySelector('.music-vol-pop');
          return p ? getComputedStyle(p).visibility : null;
        };
        const before = pop();
        const head = document.querySelector('.panel-title') || document.querySelector('.panel-head');
        head?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        return { before };
      })()`)
      await new Promise((r) => setTimeout(r, 260))
      const afterOutside = await islandEval(`(() => {
        const p = document.querySelector('.music-vol-pop');
        return { vis: p ? getComputedStyle(p).visibility : null, expanded: document.querySelector('.music-vol-toggle')?.getAttribute('aria-expanded') };
      })()`)
      ok('U3c 音量条开着时点别处会收起（用户 m04356）',
        clickOutside?.before === 'visible' && afterOutside?.vis === 'hidden' && afterOutside?.expanded === 'false',
        JSON.stringify({ ...clickOutside, after: afterOutside }))
      // 再点喇叭展开，然后点/拖条内本身，不应收起
      await islandEval(`document.querySelector('.music-vol-toggle')?.click()`)
      await new Promise((r) => setTimeout(r, 260))
      const insideKeeps = await islandEval(`(() => {
        const input = document.querySelector('.music-vol-pop input[type=range]');
        input?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        const p = document.querySelector('.music-vol-pop');
        return { vis: p ? getComputedStyle(p).visibility : null };
      })()`)
      await new Promise((r) => setTimeout(r, 260))
      const insideStill = await islandEval(`(() => { const p = document.querySelector('.music-vol-pop'); return p ? getComputedStyle(p).visibility : null })()`)
      ok('U3d 点音量条内部不会把它收起（否则拖滑块第一下就没了）',
        insideKeeps?.vis === 'visible' && insideStill === 'visible',
        JSON.stringify({ atDown: insideKeeps?.vis, after: insideStill }))
      // 收起，避免影响后续 M3/M4（若已收起，再点一次会重新打开，故先读状态）
      await islandEval(`(() => {
        const p = document.querySelector('.music-vol-pop');
        if (p && getComputedStyle(p).visibility === 'visible') document.querySelector('.music-vol-toggle')?.click();
      })()`)
      await new Promise((r) => setTimeout(r, 220))
      // 歌词要先等主进程查完（本地缓存 2ms、联网最长 6 秒超时），否则会读到「正在查歌词…」的中间态。
      // 查歌词只在歌词栏打开时发起（省流量），所以这里先确保它是开着的
      await islandEval(`(() => {
        const w = document.querySelector('.music-word');
        if (w && w.getAttribute('aria-expanded') !== 'true') w.click();
      })()`)
      await new Promise((r) => setTimeout(r, 400))
      for (let i = 0; i < 30; i += 1) {
        const busy = await islandEval(`(() => {
          const s = document.querySelector('.music-lyric-slot');
          return s ? s.textContent.includes('正在查歌词') : false;
        })()`)
        if (!busy) break
        await new Promise((r) => setTimeout(r, 300))
      }
      const lyricSlot = await islandEval(`(() => {
        const slot = document.querySelector('.music-lyric-slot');
        const online = document.querySelectorAll('.music-lyric-line, [data-lyric], .music-lyrics').length;
        const rows = [...document.querySelectorAll('.music-lyric-row')];
        const actives = rows.filter((r) => r.classList.contains('active'));
        return {
          text: slot ? slot.textContent.replace(/\\s+/g, ' ').trim() : null,
          online,
          rows: rows.length,
          actives: actives.length,
          activeText: actives[0] ? actives[0].textContent.trim() : null,
          tip: slot ? !!slot.querySelector('.music-lyric-tip') : false,
          why: slot?.querySelector('.music-lyric-why')?.textContent ?? null
        };
      })()`)
      // 用户 m04986/m05013 起歌词栏是真歌词了（SPEC-music-lyric）：能查到就渲染带时间轴的行并高亮当前那句，
      // 查不到就还是「暂无歌词」+ 一句具体原因。两种都合法，但绝不允许既没歌词又不说明原因。
      const lyricOk = !!lyricSlot && lyricSlot.online === 0 && (
        (lyricSlot.rows === 0 && lyricSlot.tip === true && lyricSlot.text.includes('暂无歌词')) ||
        (lyricSlot.rows > 1 && lyricSlot.actives === 1 && !!lyricSlot.activeText)
      )
      ok('U4 歌词栏只有真歌词或诚实占位（有词则当前行唯一高亮，没词则「暂无歌词」+原因）',
        lyricOk,
        JSON.stringify(lyricSlot))
      if (lyricSlot && lyricSlot.rows > 1) {
        // 有歌词时验「亮的那句对得上当前播放位置」：高亮行的 data-time 必须是 <= position+0.3 的最后一个时间点。
        // 这比「调 seek 看行号变不变」稳——假会话（powershell MediaPlayer）常常不支持 seek，会把断言变成假失败。
        const align = await islandEval(`(() => {
          const rows = [...document.querySelectorAll('.music-lyric-row')];
          const actives = rows.filter((r) => r.classList.contains('active'));
          const times = rows.map((r) => Number(r.getAttribute('data-time')));
          return {
            times,
            actives: actives.length,
            activeTime: actives[0] ? Number(actives[0].getAttribute('data-time')) : null,
            sorted: times.every((t, i) => i === 0 || times[i - 1] <= t)
          };
        })()`)
        const state = await islandEval(`window.island.musicGet().then((s) => ({ pos: s.position, canSeek: s.canSeek === true }))`)
        const pos = Number(state?.pos ?? -1)
        const expectIdx = align ? align.times.filter((t) => t <= pos + 0.3).length - 1 : -1
        const activeIdx = align ? align.times.indexOf(align.activeTime) : -1
        ok('U4b 亮着的那句正是当前播放位置对应的一行、时间轴单调递增（用户 m04986「播到哪句亮哪句」）',
          align && align.actives === 1 && align.sorted === true && expectIdx >= 0 && activeIdx === expectIdx,
          JSON.stringify({ pos, expectIdx, activeIdx, actives: align?.actives, sorted: align?.sorted }))
        // 播放器支持 seek 时再验「往后跳当前行真的跟着走」。
        // 注意：canSeek=true 不等于 seek 真能生效（假的 powershell MediaPlayer 会话就是这样），
        // 所以先确认位置真的变了，没变就跳过而不是判失败。
        if (state?.canSeek === true) {
          const beforeIdx = activeIdx
          await islandEval(`window.island.musicControl({ cmd: 'seek', value: 150 })`)
          await new Promise((r) => setTimeout(r, 2200))
          const seeked = await islandEval(`window.island.musicGet().then((s) => s.position)`)
          if (typeof seeked === 'number' && Math.abs(seeked - 150) <= 6) {
            const afterLyric = await islandEval(`(() => {
              const rows = [...document.querySelectorAll('.music-lyric-row')];
              const actives = rows.filter((r) => r.classList.contains('active'));
              const box = document.querySelector('.music-lyric-scroll');
              return {
                idx: rows.findIndex((r) => r.classList.contains('active')),
                actives: actives.length,
                scrollTop: box ? Math.round(box.scrollTop) : -1
              };
            })()`)
            ok('U4c 进度往前跳后当前歌词行跟着变、且始终只有一行高亮',
              afterLyric && afterLyric.actives === 1 && afterLyric.idx !== beforeIdx && afterLyric.scrollTop > 0,
              JSON.stringify({ beforeIdx, after: afterLyric }))
          } else {
            skip('U4c 进度往前跳后歌词行跟着变', `播放器报告 canSeek 但 seek 没生效（位置停在 ${seeked}）`)
          }
        } else {
          skip('U4c 进度往前跳后歌词行跟着变', '当前播放器不支持 seek，无法用跳转验证')
        }
      } else {
        skip('U4b/U4c 歌词随进度滚动', '本次会话没查到带时间轴的歌词（占位状态）')
      }
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
      // 判「有没有误触 next」要看同一个播放器里歌变没变；本机同时有多个播放器会话时
      // （比如汽水音乐 + 测试造的假会话），toggle 之后焦点可能落到另一个应用上，
      // 那不是 next 误触，先按「换应用了」放过，只对同一 app 内换歌判失败。
      const sameApp = back?.app === before.app
      ok('M3d 控制期间歌曲没被换掉（toggle 不误触 next）',
        sameApp ? back?.title === before.title : true,
        sameApp ? `前「${before.title}」后「${back?.title}」` : `应用从「${before.app}」切到「${back?.app}」，不算误触 next`)
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
