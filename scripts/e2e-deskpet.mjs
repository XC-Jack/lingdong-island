#!/usr/bin/env node
/**
 * e2e SPEC-deskpet-skin：桌宠皮肤包
 *
 * D1 老用户升级：prefs.json 里没有 petSkin → 岛仔仍是紫胶囊（不换脸），且不写死回文件
 * D2 prefs 里手改成不存在的皮肤 id → 岛仔回落默认胶囊，不渲染成空白
 * D3 设置窗口左导航有「桌宠」项，点进去有 160px 大预览 + 三套皮肤选项
 * D4 在设置页选「黄豆小怪兽」→ prefs.json 落盘 petSkin=bean → 岛仔立刻换脸（不重启）
 * D5 换肤后岛仔几何不变：.collapsed-pet 存在、仍是 22×22、.pet-eye 恰好 2 个
 *   （这三条是 e2e-m2 / e2e-head-order / e2e-collapse-order 的既有硬依赖，换肤不许弄坏）
 * D6 切回紫胶囊 → 落盘 petSkin=capsule → 岛仔换回来
 * D7 出现模式三档都在，只有「只在岛里」可选，另外两档 disabled 并带「还没做」
 * D8 选模式（island）落盘 petMode，且不影响皮肤
 *
 * 跑前：npm run build（e2e 加载 out/ 产物）。脚本自己启停 electron，结束恢复 prefs。
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

/** 打开设置窗口并等到它加载完 */
async function openSettings(section) {
  await islandEval(`(window.island.openSettings('${section}'), 'ok')`)
  await sleep(1800)
}
async function closeSettings() {
  await settingsEval(`(window.island.closeSettings(), 'ok')`)
  await sleep(1200)
}

/** 岛仔当前的皮肤 id（皮肤包装层上的 data-pet-skin） */
const islandPetSkin = () => islandEval(`document.querySelector('.pet-wrap')?.dataset.petSkin ?? ''`)

/**
 * 量岛仔的包围盒。
 *
 * 为什么要和「胶囊皮肤下的同一份测量」比、而不是硬写 22×22：
 * 窗口开 zoom=0.75（VERIFY-B/独立验收里固定下来的设置），Chromium 的 zoom 会缩放
 * getBoundingClientRect 的返回坐标，22 CSS px 量出来是 16.5→17。硬写 22 会假红。
 * 真正要锁的是「换肤不改变布局占位」，所以取同一次运行里胶囊态的量做基准。
 */
const islandPetBox = () => islandEval(
  `(()=>{const e=document.querySelector('.collapsed-pet'); if(!e) return '';
    const r=e.getBoundingClientRect();
    return [r.width.toFixed(2), r.height.toFixed(2)].join('x')})()`
)

/** 等岛仔的皮肤变成期望值（广播 + React 重渲染要几帧） */
async function waitPetSkin(want, timeoutMs = 4000) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    last = await islandPetSkin()
    if (last === want) return last
    await sleep(150)
  }
  return last
}

let child = null
const prefsBackup = existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null
/** D1 胶囊态下量的岛仔包围盒，作为 D5 换肤后的对照基准（见 islandPetBox 注释） */
let capsuleBox = ''

try {
  mkdirSync(USER_DATA, { recursive: true })

  killApp(); await sleep(800)

  // ========== D1 老用户升级：没有 petSkin 字段 ==========
  {
    writePrefs()
    child = await startApp()
    const skin = await waitPetSkin('capsule')
    ok('D1a 无 petSkin 字段时岛仔是紫胶囊（升级不换脸）', skin === 'capsule', `实际 ${skin}`)
    // 只在收起态渲染：确认岛仔真的挂载了，不是空 querySelector 造成的「碰巧相等」
    const mounted = await islandEval(`document.querySelectorAll('.collapsed-pet').length`)
    ok('D1b 岛仔确实渲染出来了（.collapsed-pet 计数 1）', mounted === 1, `实际 ${mounted}`)
    capsuleBox = await islandPetBox()
    await sleep(600)
    const onDisk = readPrefs()
    ok('D1c 读默认不该把 petSkin 写死进 prefs.json（否则以后改默认皮肤老用户跟不上）',
      onDisk.petSkin === undefined, `实际 ${JSON.stringify(onDisk.petSkin)}`)
  }

  // ========== D2 prefs 里是非法皮肤 id ==========
  {
    await stopApp(child)
    writePrefs({ petSkin: '不存在的皮肤' })
    child = await startApp()
    const skin = await waitPetSkin('capsule')
    ok('D2a 非法 petSkin 回落默认胶囊（不会渲染成空白）', skin === 'capsule', `实际 ${skin}`)
    const mounted = await islandEval(`document.querySelectorAll('.collapsed-pet').length`)
    ok('D2b 回落路径下岛仔仍有实体（不是空 svg）', mounted === 1, `实际 ${mounted}`)
    // 断言的是「渲染层拿不到非法值」，不是「文件被改写」：
    // prefsStore.load() 只在读出时过滤，不会主动回写文件——明文里残留一个查不到的 id
    // 无害（每次读都会被剔掉），主动回写反而多一次磁盘写。真正要保证的是别把它送到渲染层。
    const seen = await islandEval(`window.island.prefsGet().then(p => JSON.stringify(p.petSkin ?? null))`, true)
    ok('D2c 非法值没有漏给渲染层（prefsGet 拿到的是 null）', seen === 'null', `实际 ${seen}`)
  }

  // ========== D3 设置窗口「桌宠」分区 ==========
  {
    await openSettings('pet')
    const nav = await settingsEval(`Array.from(document.querySelectorAll('.set-nav-item')).map(e => e.textContent.trim())`)
    ok('D3a 左导航有「桌宠」项', Array.isArray(nav) && nav.some((s) => s.includes('桌宠')), JSON.stringify(nav))
    const skinCount = await settingsEval(`document.querySelectorAll('.pet-set-skin').length`)
    ok('D3b 桌宠分区列出三套皮肤（胶囊 / 矢量黄豆 / 原图）', skinCount === 3, `实际 ${skinCount}`)
    const previewSize = await settingsEval(
      `(()=>{const e=document.querySelector('.pet-set-preview .pet-full'); if(!e) return 'none'; const r=e.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height)})()`
    )
    ok('D3c 有大尺寸预览且真的按 132px 渲染（不是 0×0 的隐藏块）',
      previewSize === '132x132', `实际 ${previewSize}`)
    const checked = await settingsEval(
      `(()=>{const e=document.querySelector('.pet-set-skin.on'); return e?.dataset.skinId ?? ''})()`
    )
    ok('D3d 当前选中项是胶囊（与岛上一致）', checked === 'capsule', `实际 ${checked}`)
  }

  // ========== D4 在设置页换成黄豆 → 落盘 + 岛立刻换 ==========
  {
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="bean"]').click(), 'ok')`)
    await sleep(900)
    const onDisk = readPrefs()
    ok('D4a 选黄豆后 prefs.json 落盘 petSkin=bean', onDisk.petSkin === 'bean', `实际 ${JSON.stringify(onDisk.petSkin)}`)
    const skin = await waitPetSkin('bean')
    ok('D4b 岛仔立刻换成黄豆（不用重启、不用重开设置窗）', skin === 'bean', `实际 ${skin}`)
    const checked = await settingsEval(
      `(()=>{const e=document.querySelector('.pet-set-skin.on'); return e?.dataset.skinId ?? ''})()`
    )
    ok('D4c 设置页选中态同步到黄豆', checked === 'bean', `实际 ${checked}`)
  }

  // ========== D5 换肤后岛仔几何不变（既有 e2e 的硬依赖） ==========
  {
    const geo = JSON.parse(await islandEval(
      `(()=>{const e=document.querySelector('.collapsed-pet'); if(!e) return JSON.stringify({none:true});
        const r=e.getBoundingClientRect();
        return JSON.stringify({w:r.width.toFixed(2), h:r.height.toFixed(2),
          eyes:document.querySelectorAll('.pet-eye').length,
          paths:e.querySelectorAll('path').length})})()`
    ))
    ok('D5a 换肤后 .collapsed-pet 的占位与胶囊皮肤完全一致（换脸不动布局）',
      geo.w === capsuleBox?.split('x')[0] && geo.h === capsuleBox?.split('x')[1],
      `胶囊 ${capsuleBox} → 黄豆 ${geo.w}x${geo.h}`)
    ok('D5b 换肤后 .pet-eye 恰好 2 个（眨眼动画与 e2e-m2 都依赖这个数）',
      geo.eyes === 2, `实际 ${JSON.stringify(geo)}`)
    ok('D5c 黄豆皮肤用的是 path 画的身体（不是复用胶囊的 rect）', geo.paths >= 3, `path 数 ${geo.paths}`)
  }

  // ========== D6 切回胶囊 ==========
  {
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="capsule"]').click(), 'ok')`)
    await sleep(900)
    const onDisk = readPrefs()
    ok('D6a 切回胶囊后落盘 petSkin=capsule', onDisk.petSkin === 'capsule', `实际 ${JSON.stringify(onDisk.petSkin)}`)
    const skin = await waitPetSkin('capsule')
    ok('D6b 岛仔换回胶囊', skin === 'capsule', `实际 ${skin}`)
  }

  // ========== D7 三个出现模式 ==========
  {
    const modes = JSON.parse(await settingsEval(
      `JSON.stringify([...document.querySelectorAll('.pet-set-mode')].map(e => ({
        m: e.dataset.mode, disabled: e.disabled, on: e.classList.contains('on'),
        soon: !!e.querySelector('.pet-set-soon') })))`
    ))
    ok('D7a 三档模式都列出来了', Array.isArray(modes) && modes.length === 3, JSON.stringify(modes))
    const islandMode = modes.find((x) => x.m === 'island')
    ok('D7b「只在岛里」可选且当前选中', islandMode && islandMode.disabled === false && islandMode.on === true,
      JSON.stringify(islandMode))
    // SPEC-deskpet-out 之后「独立小窗口」也可用了，只剩「自由走动」是禁用档。
    // 这里改成「至少有一档仍是禁用 + 标了还没做」，并明确 free 必须是那一档——
    // 断言太宽会让「所有档都变成可用」这种回归溜过去。
    const freeMode = modes.find((x) => x.m === 'free')
    ok('D7c「自由走动」仍是禁用态且标了「还没做」',
      freeMode && freeMode.disabled === true && freeMode.soon === true, JSON.stringify(freeMode))
    const winMode = modes.find((x) => x.m === 'window')
    ok('D7d「独立小窗口」已可用（SPEC-deskpet-out 放开）',
      winMode && winMode.disabled === false && winMode.soon === false, JSON.stringify(winMode))
  }

  // ========== D8 切模式不影响皮肤 ==========
  {
    // 先切到「独立小窗口」的尝试应该无效（disabled），再确认 island 模式落盘
    await settingsEval(`(document.querySelector('.pet-set-mode[data-mode="island"]').click(), 'ok')`)
    await sleep(700)
    const onDisk = readPrefs()
    ok('D8a 选「只在岛里」后落盘 petMode=island', onDisk.petMode === 'island', `实际 ${JSON.stringify(onDisk.petMode)}`)
    ok('D8b 切模式没有把皮肤改掉（两份偏好互不干扰）', onDisk.petSkin === 'capsule', `实际 ${JSON.stringify(onDisk.petSkin)}`)
    const before = readPrefs().petSkin
    // 点禁用的「自由走动」：不该产生任何写入。
    // （原先是拿 window 档当禁用样例，SPEC-deskpet-out 把它放开了，换成 free。）
    const clickDisabled = await settingsEval(
      `(()=>{const e=document.querySelector('.pet-set-mode[data-mode="free"]'); e.click(); return 'clicked'})()`
    )
    await sleep(600)
    const after = readPrefs()
    ok('D8c 点禁用档位不产生任何写入', clickDisabled === 'clicked' && after.petMode === 'island' && after.petSkin === before,
      `petMode=${JSON.stringify(after.petMode)} petSkin=${JSON.stringify(after.petSkin)}`)
  }

  // ========== D9 原图皮肤：大尺寸用照片本人，22px 仍用矢量简版 ==========
  {
    await openSettings('pet')
    const chosen = await settingsEval(
      `(document.querySelector('.pet-set-skin[data-skin-id="photo"]').click(), 'ok')`
    )
    await sleep(900)
    ok('D9a 设置页能选中「我的原图」', chosen === 'ok')
    const onDisk = readPrefs()
    ok('D9b 选原图后落盘 petSkin=photo', onDisk.petSkin === 'photo', `实际 ${JSON.stringify(onDisk.petSkin)}`)
    const skin = await waitPetSkin('photo')
    ok('D9c 岛仔立刻换成原图皮肤的简版（不重启）', skin === 'photo', `实际 ${skin}`)

    // 照片本体在设置窗口里真的解码出来了：只查 DOM 存在会被「坏图占位」骗过去，
    // 所以量 <image> 的实际绘制尺寸，并确认它引用的地址能取到字节。
    const imgInfo = JSON.parse(await settingsEval(`(()=>{
      const el = document.querySelector('.pet-set-preview .pet-photo-img');
      if (!el) return JSON.stringify({none:true});
      const r = el.getBoundingClientRect();
      return JSON.stringify({href: el.getAttribute('href') || el.href?.baseVal || '',
        w: Math.round(r.width), h: Math.round(r.height)})
    })()`))
    ok('D9d 大预览里画的是照片（.pet-photo-img 存在且有实际尺寸）',
      !imgInfo.none && imgInfo.w > 40 && imgInfo.h > 40, JSON.stringify(imgInfo))
    ok('D9e 照片地址指向打包进来的资源（不是空串或外链）',
      typeof imgInfo.href === 'string' && /bean-photo[^/]*\.png/.test(imgInfo.href), String(imgInfo.href))

    // 岛里那 22px 仍必须是矢量简版：位图缩到 22px 只剩一团黄，
    // 且 .pet-eye 必须是 2 个（e2e-m2 的硬依赖）。
    const tiny = JSON.parse(await islandEval(`(()=>{
      const e = document.querySelector('.collapsed-pet');
      if (!e) return JSON.stringify({none:true});
      return JSON.stringify({tag: e.tagName.toLowerCase(),
        eyes: document.querySelectorAll('.pet-eye').length,
        hasImg: !!document.querySelector('.collapsed-pet image')})
    })()`))
    ok('D9f 岛里的 22px 仍是矢量画法（不是把照片缩到 22px）',
      tiny.tag === 'svg' && tiny.hasImg === false, JSON.stringify(tiny))
    ok('D9g 原图皮肤下 .pet-eye 仍是 2 个（眨眼动画与 e2e-m2 依赖）', tiny.eyes === 2, JSON.stringify(tiny))

    // 换回胶囊，别把用户的 prefs 留在测试值上
    await settingsEval(`(document.querySelector('.pet-set-skin[data-skin-id="capsule"]').click(), 'ok')`)
    await sleep(700)
    const back = await waitPetSkin('capsule')
    ok('D9h 换回胶囊正常', back === 'capsule', `实际 ${back}`)
  }

  await closeSettings()
} catch (e) {
  failed++
  console.log('  ✗ 异常：' + (e?.stack ?? e?.message ?? e))
} finally {
  killApp()
  if (prefsBackup !== null) writeFileSync(PREFS, prefsBackup, 'utf8')
}

console.log(`\nE2E DESKPET: ${failed > 0 ? 'FAIL' : 'PASS'}（${passed} 过 / ${failed} 败）`)
process.exit(failed > 0 ? 1 : 0)
