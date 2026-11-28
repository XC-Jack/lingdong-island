#!/usr/bin/env node
/**
 * e2e SPEC-collapsed-lyric-bar：收起态歌词条
 *
 * L1 没放歌时一切照旧：没有歌词条，原来的状态组件（时钟）还在
 * L2 放歌且有歌词时整条胶囊换成歌词条：封面（无封面回落音符）、岛仔、当前句、节奏图标，
 *    岛变宽到 400 视觉 px，时钟等状态组件让位
 * L3 歌词跟着播放位置换句；长句单行省略号截断、不换行；title 里能看到歌名和当前句
 * L4 暂停时节奏图标停下，歌词条不消失
 * L5 设置里关掉「收起胶囊显示歌词」→ 歌词条立刻消失、岛缩回普通宽度；重启后仍然关闭
 *    （配置真的落盘）；再打开 → 歌词条恢复
 * L6 放歌但查不到歌词 → 不出现歌词条，状态组件照旧（不拿空歌词硬撑一条空条）
 * L7 进/出歌词条时宽度过渡被临时关掉，切换后窗口与岛同宽
 * L8 右侧播放/暂停按钮：有图标、带说明，点了只切播放状态、不展开岛
 * L9 歌词态点岛展开 / 收起：逐帧采样岛不超出窗口，且不走 island-entrance 入场动画
 *    （歌词条 400 视觉 px 比展开态 255 宽，旧插值只处理宽高都变大，会裁掉右边）
 *
 * 前提：npm run build（e2e 加载 out/ 产物）。
 * 用 ISLAND_FAKE_MUSIC 伪造播放会话、预置歌词缓存，不依赖本机真实播放器，也不碰真实用户数据
 * （路径由 scripts/isolate-userdata.mjs 隔离到 .tmp/e2e-userdata）。
 */
import { spawn, execSync, USER_DATA } from './isolate-userdata.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = process.cwd()
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9321)
const PREFS = join(USER_DATA, 'prefs.json')
const LYRIC_DIR = join(USER_DATA, 'lyrics')

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

async function evalOnTarget(expr, wantSettings) {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await listTargets()
      const page = pages.find((t) => IS_SETTINGS(t) === wantSettings)
      if (!page) throw new Error(wantSettings ? 'no settings target' : 'no page target')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('cdp timeout')), 15000)
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
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

/** 写 prefs（整份覆盖，保证不继承上一条 e2e 留下的开关） */
function writePrefs(extra = {}) {
  writeFileSync(PREFS, JSON.stringify({
    pagesCustom: {
      pages: [0, 1, 2, 3, 4],
      collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
      order: ['battery', 'pet', 'clock', 'net', 'todo', 'bell']
    },
    musicIntro: true,
    petMode: 'island',
    ...extra
  }, null, 2), 'utf8')
}
const readPrefs = () => JSON.parse(readFileSync(PREFS, 'utf8'))

/** 按主进程的规则算歌词缓存键，预置一份「查到了」的缓存，避免 e2e 联网 */
function seedLyric(song, lines) {
  const key = createHash('sha1')
    .update([song.title.trim(), song.artist.trim(), song.album.trim(), String(Math.round(song.duration))].join('\u0001').toLowerCase(), 'utf8')
    .digest('hex')
  mkdirSync(LYRIC_DIR, { recursive: true })
  writeFileSync(join(LYRIC_DIR, `${key}.json`), JSON.stringify({
    version: 5,
    savedAt: Date.now(),
    result: {
      ok: true,
      title: song.title,
      artist: song.artist,
      source: 'cache',
      lines,
      reason: '',
      duration: song.duration
    }
  }, null, 2), 'utf8')
}

/** 启一个隔离的 dev electron；music 为 null 时走真实桥接（本脚本不用） */
async function startApp(music) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (music) env.ISLAND_FAKE_MUSIC = JSON.stringify(music)
  else delete env.ISLAND_FAKE_MUSIC
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try {
      const list = await listTargets()
      if (list.length > 0) break
    } catch { /* CDP 还没起来 */ }
    await sleep(250)
  }
  // 等 React 首帧挂上 .island，不然第一个断言会读到 null
  const t1 = Date.now()
  while (Date.now() - t1 < 8000) {
    try {
      if (await islandEval(`!!document.querySelector('.island')`)) break
    } catch { /* 页面还没好 */ }
    await sleep(250)
  }
  await sleep(400)
  return child
}

async function waitFor(fn, maxMs = 8000, step = 250) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < maxMs) {
    last = await fn()
    if (last) return last
    await sleep(step)
  }
  return last
}

/** 收起态歌词条完整快照 */
const BAR_SNAP = `(() => {
  const isl = document.querySelector('.island')
  const bar = document.querySelector('.collapsed-lyric')
  const txt = document.querySelector('.cl-text')
  const cs = txt ? getComputedStyle(txt) : null
  return {
    islandW: isl ? Math.round(isl.getBoundingClientRect().width) : null,
    innerW: window.innerWidth,
    expanded: !!document.querySelector('.island.expanded'),
    lyricMode: isl ? isl.classList.contains('lyric-mode') : null,
    lyricSnap: isl ? isl.classList.contains('lyric-snap') : null,
    bar: !!bar,
    children: bar ? [...bar.children].map((c) => c.className.split(' ')[0]) : [],
    text: txt ? txt.textContent : null,
    prelude: txt ? txt.classList.contains('prelude') : null,
    playLabel: (() => { const e = document.querySelector('.cl-play'); return e ? e.getAttribute('aria-label') : null })(),
    playIcon: (() => { const e = document.querySelector('.cl-play'); return e ? !!e.querySelector('svg') : null })(),
    coverImg: !!document.querySelector('.cl-cover img'),
    coverPh: !!document.querySelector('.cl-cover-ph'),
    pet: !!document.querySelector('.cl-pet'),
    clock: !!document.querySelector('.collapsed-clock'),
    clipped: txt ? txt.scrollWidth > txt.clientWidth : null,
    textH: txt ? Math.round(txt.getBoundingClientRect().height) : null,
    lineH: cs ? Math.round(parseFloat(cs.lineHeight) || 0) : null,
    aria: bar ? bar.getAttribute('aria-label') : null,
    title: bar ? bar.getAttribute('title') : null
  }
})()`

const SONG = {
  active: true,
  title: 'E2E歌词条测试曲',
  artist: 'E2E歌手',
  album: 'E2E专辑',
  duration: 30,
  position: 0,
  playing: true,
  app: 'e2e.exe',
  canSeek: true
}
const LONG_LINE = '第二句很长很长的歌词用来验证省略号是否正常工作不会换行'
const LINES = [
  { time: 0, text: '第一句测试歌词' },
  { time: 5, text: LONG_LINE },
  { time: 10, text: '第三句' },
  { time: 15, text: '第四句' }
]
const SONG_NO_LYRIC = {
  ...SONG,
  title: 'zzz9f3a 无此歌曲 e2e 占位标题',
  artist: 'zzz',
  album: 'zzz'
}

let child = null

try {
  seedLyric(SONG, LINES)
  killApp(); await sleep(800)

  // ========== L1 没放歌：照旧 ==========
  {
    writePrefs()
    child = await startApp({ ...SONG, active: false, playing: false })
    const s = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v?.islandW ? v : null
    })
    ok('L1a 没放歌时不出现歌词条', s && s.bar === false, JSON.stringify(s && { bar: s.bar }))
    ok('L1b 没放歌时没有 lyric-mode 类名', s && s.lyricMode === false, String(s?.lyricMode))
    ok('L1c 原来的状态组件（时钟）照常显示', s && s.clock === true, JSON.stringify(s && { clock: s.clock }))
    ok('L1d 岛还是普通收起宽度（≤290）', s && s.islandW > 0 && s.islandW <= 290, String(s?.islandW))
    killApp(); await sleep(900)
  }

  // ========== L2 播放且有歌词：整条换成歌词条 ==========
  {
    writePrefs()
    child = await startApp(SONG)
    const s = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v?.bar ? v : null
    })
    ok('L2a 播放且有歌词时出现歌词条', !!s, JSON.stringify(s && { bar: s.bar }))
    ok('L2b 岛切换到 lyric-mode（窗口宽度上限随之放宽）', s && s.lyricMode === true, String(s?.lyricMode))
    ok('L2c 岛宽 400 视觉 px（±2）', s && s.islandW >= 398 && s.islandW <= 402, String(s?.islandW))
    ok('L2c2 窗口宽度跟岛同宽（右边不被窗口裁掉）',
      s && Math.abs((s.innerW ?? 0) - (s.islandW ?? 0)) <= 2,
      JSON.stringify(s && { innerW: s.innerW, islandW: s.islandW }))
    ok('L2d 条内顺序是 封面 / 岛仔 / 歌词 / 播放按钮',
      s && s.children.length === 4 && s.children[0] === 'cl-cover' && s.children[1] === 'cl-pet' &&
      s.children[2] === 'cl-text' && s.children[3] === 'cl-play',
      JSON.stringify(s?.children))
    ok('L2e 没有封面时回落音符占位', s && s.coverPh === true && s.coverImg === false,
      JSON.stringify(s && { ph: s.coverPh, img: s.coverImg }))
    ok('L2f 当前句是第一条歌词', s && s.text === LINES[0].text, JSON.stringify(s?.text))
    ok('L2g 播放中右侧是暂停图标（点它=暂停）',
      s && s.playLabel === '暂停' && s.playIcon === true,
      JSON.stringify(s && { label: s.playLabel, icon: s.playIcon }))
    ok('L2h 状态组件（时钟）让位、不跟歌词挤在一起', s && s.clock === false, String(s?.clock))
    ok('L2i 无障碍名里有歌名和当前句', s && typeof s.aria === 'string' && s.aria.includes(SONG.title) && s.aria.includes(LINES[0].text),
      JSON.stringify(s?.aria))
    ok('L2j title 提示里有「歌名 - 歌手」和当前句',
      s && typeof s.title === 'string' && s.title.includes(`${SONG.title} - ${SONG.artist}`) && s.title.includes(LINES[0].text),
      JSON.stringify(s?.title))
  }

  // ========== L3 换句与长句省略 ==========
  {
    // 假会话每秒前进 1 秒，第 5 秒切到第二句（长句）
    const s = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v?.text === LONG_LINE ? v : null
    }, 11000)
    ok('L3a 播到第 5 秒时切到第二句', !!s, JSON.stringify(s && { text: s.text }))
    ok('L3b 长句被省略号截断（scrollWidth > clientWidth）', s && s.clipped === true,
      JSON.stringify(s && { clipped: s.clipped }))
    ok('L3c 长句不换行（高度仍是一行）', s && s.lineH > 0 && s.textH <= s.lineH + 4,
      JSON.stringify(s && { textH: s.textH, lineH: s.lineH }))
    ok('L3d 换句后 title 里的歌词跟着换', s && typeof s.title === 'string' && s.title.includes(LONG_LINE),
      JSON.stringify(s?.title))
  }

  // ========== L4 暂停：节奏图标停、歌词条还在 ==========
  {
    const before = await islandEval(BAR_SNAP)
    await islandEval(`window.island.musicControl('toggle')`)
    const paused = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      const st = await islandEval(`window.island.musicGet().then((s) => s.playing)`)
      return st === false ? v : null
    }, 5000)
    ok('L4a 暂停后按钮变成播放图标（继续播放）',
      paused && paused.playLabel === '继续播放' && paused.playIcon === true,
      JSON.stringify(paused && { label: paused.playLabel, icon: paused.playIcon }))
    ok('L4b 暂停时歌词条仍然在（不是只有播放才显示）', paused && paused.bar === true && paused.text === before?.text,
      JSON.stringify(paused && { bar: paused.bar, text: paused.text, before: before?.text }))
    await islandEval(`window.island.musicControl('toggle')`)
    const resumed = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v?.playLabel === '暂停' ? v : null
    }, 5000)
    ok('L4c 恢复播放后按钮回到暂停图标', !!resumed, JSON.stringify(resumed && { label: resumed.playLabel }))
  }

  // ========== L8 右侧播放/暂停按钮 ==========
  {
    const eq = await islandEval(`(() => {
      const b = document.querySelector('.cl-play')
      return b ? { tag: b.tagName, label: b.getAttribute('aria-label'), svg: !!b.querySelector('svg') } : null
    })()`)
    ok('L8a 右侧是可点的播放/暂停按钮（带图标与暂停/继续播放说明）',
      eq && eq.tag === 'BUTTON' && eq.svg === true && (eq.label === '暂停' || eq.label === '继续播放'), JSON.stringify(eq))
    await islandEval(`document.querySelector('.cl-play')?.click()`)
    const paused = await waitFor(async () => {
      const st = await islandEval(`window.island.musicGet().then((s) => s.playing)`)
      return st === false ? true : null
    }, 4000)
    ok('L8b 点一下会暂停播放', paused === true)
    const afterPause = await islandEval(BAR_SNAP)
    ok('L8c 点它不会顺手把岛展开（stopPropagation），歌词条仍在',
      afterPause && afterPause.bar === true && afterPause.expanded !== true,
      JSON.stringify(afterPause && { bar: afterPause.bar }))
    await islandEval(`document.querySelector('.cl-play')?.click()`)
    const resumed = await waitFor(async () => {
      const st = await islandEval(`window.island.musicGet().then((s) => s.playing)`)
      return st === true ? true : null
    }, 4000)
    ok('L8d 再点一下恢复播放', resumed === true)
  }

  // ========== L9 歌词态点岛展开 / 收起：不裁切、不做入场动画 ==========
  // 歌词条 400 视觉 px 比展开态 255 宽，点开时宽度变窄；旧的入场插值只处理宽高都变大，
  // 会裁掉右边（2026-11-28 用户实测「抖动 / 显示不完整」）。这里在同一次 eval 里
  // 先点开、采样 400ms，再按 Esc 收起继续采样，避免两次 eval 之间被失焦自动收起干扰。
  {
    const SAMPLE_MS = 1000
    const ESC_AT = 400
    const frames = await islandEval(`new Promise((resolve) => {
      const t0 = performance.now()
      const out = []
      let escaped = false
      const tick = () => {
        const t = Math.round(performance.now() - t0)
        if (!escaped && t >= ${ESC_AT}) {
          escaped = true
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        }
        const isl = document.querySelector('.island')
        if (isl) {
          const r = isl.getBoundingClientRect()
          out.push({
            t,
            phase: escaped ? 'co' : 'ex',
            iw: Math.round(r.width),
            ih: Math.round(r.height),
            winW: window.innerWidth,
            winH: window.innerHeight,
            entrance: isl.classList.contains('island-entrance'),
            expanded: isl.classList.contains('expanded'),
            lyricMode: isl.classList.contains('lyric-mode'),
            snap: isl.classList.contains('lyric-snap')
          })
        }
        if (t < ${SAMPLE_MS}) requestAnimationFrame(tick)
        else resolve(out)
      }
      requestAnimationFrame(tick)
      const isl = document.querySelector('.island')
      if (isl) isl.click()
    })`)
    const summarize = (arr) => {
      let overW = -999
      let overH = -999
      let worst = null
      for (const f of arr) {
        if (f.iw - f.winW > overW) overW = f.iw - f.winW
        if (f.ih - f.winH > overH) overH = f.ih - f.winH
        const d = Math.max(f.iw - f.winW, f.ih - f.winH)
        if (!worst || d > worst.d) worst = { d, t: f.t, iw: f.iw, ih: f.ih, winW: f.winW, winH: f.winH, lyricMode: f.lyricMode, expanded: f.expanded }
      }
      return {
        n: arr.length,
        overW,
        overH,
        worst,
        entrance: arr.some((f) => f.entrance),
        last: arr[arr.length - 1] || null
      }
    }
    const ex = summarize((frames || []).filter((f) => f.phase === 'ex'))
    const co = summarize((frames || []).filter((f) => f.phase === 'co'))

    ok('L9a 歌词态点岛展开：过程中岛不超出窗口（宽/高）',
      ex.n > 0 && ex.overW <= 1 && ex.overH <= 1, JSON.stringify(ex))
    ok('L9b 歌词态展开不走入场动画（island-entrance 未出现）',
      ex.n > 0 && ex.entrance === false, JSON.stringify(ex))
    ok('L9c 展开后窗口与岛同尺寸',
      ex.last && ex.last.expanded === true && ex.last.winW === ex.last.iw && Math.abs(ex.last.winH - ex.last.ih) <= 2,
      JSON.stringify(ex.last))
    ok('L9d 歌词态收起：过程中岛不超出窗口（宽/高）',
      co.n > 0 && co.overW <= 1 && co.overH <= 1, JSON.stringify(co))
    ok('L9e 歌词态收起不走入场动画（island-entrance 未出现）',
      co.n > 0 && co.entrance === false, JSON.stringify(co))
    const back = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v && v.bar && !v.expanded ? v : null
    }, 5000)
    ok('L9f 收起后回到歌词条，且窗口与岛同宽',
      back && Math.abs(back.innerW - back.islandW) <= 2,
      JSON.stringify(back && { innerW: back.innerW, islandW: back.islandW, bar: back.bar }))
  }

  // ========== L5 设置开关：关掉即恢复普通收起态，重启后保持 ==========
  {
    await islandEval(`window.island.openSettings('general')`)
    const sw = await waitFor(async () => {
      const v = await settingsEval(`(() => {
        const b = document.querySelector('button[aria-label="收起胶囊显示歌词"]')
        return b ? { checked: b.getAttribute('aria-checked') } : null
      })()`)
      return v || null
    }, 8000)
    ok('L5a 设置页有「收起胶囊显示歌词」开关且默认开着', sw && sw.checked === 'true', JSON.stringify(sw))
    await settingsEval(`document.querySelector('button[aria-label="收起胶囊显示歌词"]')?.click()`)
    // 宽度过渡必须在切换瞬间关掉：否则窗口按 RO 量到的中间宽度一截一截追（用户 2026-11-28 卡顿/不完整）
    const sawSnap = await waitFor(async () => {
      const v = await islandEval(`document.querySelector('.island')?.classList.contains('lyric-snap') ?? false`)
      return v === true ? true : null
    }, 2500, 60)
    ok('L7 切出歌词条时临时关掉宽度过渡（lyric-snap）', sawSnap === true)
    const off = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v && v.bar === false ? v : null
    }, 6000)
    ok('L5b 关掉开关后歌词条立刻消失、时钟回来', off && off.bar === false && off.clock === true,
      JSON.stringify(off && { bar: off.bar, clock: off.clock }))
    ok('L5c 关掉后岛缩回普通收起宽度（≤290）', off && off.islandW <= 290, String(off?.islandW))
    // 刚切回来的第一两帧还在等 rAF 里的宽度上报，允许它追上；稳定后必须同宽
    const synced = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v && v.bar === false && Math.abs((v.innerW ?? 0) - (v.islandW ?? 0)) <= 2 ? v : null
    }, 3000)
    ok('L7b 切换后窗口宽度与岛同宽（没有被中间态甩下）', !!synced,
      JSON.stringify(synced ? { innerW: synced.innerW, islandW: synced.islandW } : off && { innerW: off.innerW, islandW: off.islandW }))
    const persisted = await waitFor(async () => {
      try { return readPrefs()?.collapsedLyric === false } catch { return false }
    }, 4000)
    ok('L5d 关闭状态落盘到 prefs.collapsedLyric = false', persisted === true, String(readPrefs()?.collapsedLyric))

    // 重启：不重写 prefs，验证真的持久化
    killApp(); await sleep(900)
    child = await startApp(SONG)
    await sleep(2500)
    const afterRestart = await islandEval(BAR_SNAP)
    ok('L5e 重启后开关保持关闭（不重写 prefs）', afterRestart && afterRestart.bar === false && afterRestart.clock === true,
      JSON.stringify(afterRestart && { bar: afterRestart.bar, clock: afterRestart.clock }))

    // 再打开
    await islandEval(`window.island.openSettings('general')`)
    await waitFor(async () => {
      const v = await settingsEval(`(() => {
        const b = document.querySelector('button[aria-label="收起胶囊显示歌词"]')
        return b ? b.getAttribute('aria-checked') : null
      })()`)
      return v === 'false' ? v : null
    }, 8000)
    await settingsEval(`document.querySelector('button[aria-label="收起胶囊显示歌词"]')?.click()`)
    const on = await waitFor(async () => {
      const v = await islandEval(BAR_SNAP)
      return v && v.bar === true ? v : null
    }, 6000)
    ok('L5f 再打开开关后歌词条恢复（歌词走缓存，无需重新联网）',
      on && on.bar === true && on.islandW >= 398, JSON.stringify(on && { bar: on.bar, islandW: on.islandW }))
    killApp(); await sleep(900)
  }

  // ========== L6 放歌但查不到歌词：不硬撑空条 ==========
  {
    writePrefs()
    child = await startApp(SONG_NO_LYRIC)
    // 联网查歌词最长 6 秒超时，给足时间；期间任何时刻出现歌词条都算失败
    const t0 = Date.now()
    let appeared = false
    let snap = null
    while (Date.now() - t0 < 15000) {
      snap = await islandEval(BAR_SNAP)
      if (snap?.bar) { appeared = true; break }
      await sleep(500)
    }
    ok('L6a 查不到歌词时不出现歌词条', appeared === false, JSON.stringify(snap && { bar: snap.bar }))
    ok('L6b 查不到歌词时状态组件（时钟）照旧', snap && snap.clock === true, JSON.stringify(snap && { clock: snap.clock }))
    ok('L6c 查不到歌词时岛保持普通收起宽度', snap && snap.islandW <= 290, String(snap?.islandW))
  }
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  killApp()
}

console.log(`\nE2E COLLAPSED LYRIC: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
