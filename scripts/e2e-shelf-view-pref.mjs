// e2e-shelf-view-pref.mjs：验证 US-037「置物架视图记忆迁移 prefs.json」
// 背景：localStorage 版（US-034）跨重启会丢（file:// 源 localStorage 本机实测重启即 null），
//      视图记忆改走主进程 prefs.json（prefs:get/prefs:set IPC）。
// 覆盖：①无偏好记录时默认「大图标」且 prefs.json 无 shelfView ②选「列表」立即生效且写进 prefs.json
//      ③重载页面（模拟重启）后仍是「列表」④改选「小图标」重载也记得
//      ⑤prefs.json 里 shelfView 被改坏时回落「大图标」不白屏
//      ⑥写 shelfView 不破坏 pagesCustom（页面管理偏好互不干扰）
// 用法：node scripts/e2e-shelf-view-pref.mjs（自动启动 electron，CDP 端口 9331；Node 22+ 自带全局 WebSocket）
// 注意：只动 userData/prefs.json 的 shelfView 字段（测试值跑完还原），不碰 shelf.json / todos.json / schedule.json。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9331
// Electron userData 真实路径：%APPDATA%\lingdong-island（DSH 宿主 homedir() 在 D 盘，不能用）
const USER_DATA = pathJoin(process.env.APPDATA, 'lingdong-island')
const PREFS_FILE = pathJoin(USER_DATA, 'prefs.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起 */
    }
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl, expression, method = 'Runtime.evaluate') {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000)
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method,
          params:
            method === 'Runtime.evaluate'
              ? { expression, awaitPromise: true, returnByValue: true }
              : {}
        })
      )
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      if (data.result?.exceptionDetails) {
        reject(
          new Error(
            '页面异常: ' +
              (data.result.exceptionDetails.exception?.description ?? data.result.exceptionDetails.text)
          )
        )
      } else if (method === 'Runtime.evaluate') {
        resolve(data.result?.result?.value)
      } else {
        resolve(data.result)
      }
      ws.close()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('ws error'))
    }
  })
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

/** 等 React 状态落定再求值 */
async function settle(wsUrl, expression, ms = 400) {
  await cdp(wsUrl, `new Promise(r=>setTimeout(r,${ms})).then(()=>true)`)
  return cdp(wsUrl, expression)
}

/** 页面重载：模拟「关掉再打开」，看重启后是否还记得选择 */
async function reload(wsUrl) {
  await cdp(wsUrl, 'void 0', 'Page.reload')
  await sleep(1600)
}

/** 展开岛并切到置物架页（第 2 页，索引 1） */
async function openShelf(wsUrl) {
  await cdp(wsUrl, `document.querySelector('.island').click(); 1`)
  await sleep(450)
  await cdp(wsUrl, `document.querySelectorAll('.dot')[1].click(); 1`)
  await sleep(500)
}

const currentViewClass = `(() => {
  const drop = document.querySelector('.shelf-drop');
  if (!drop) return null;
  return ['lg','md','sm','list'].find(c => drop.classList.contains(c)) ?? null;
})()`

/** 直接读磁盘上的 prefs.json（主进程文件，跨重载都真实持久） */
function readPrefs() {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

const main = async () => {
  // 备份用户原本的 prefs.json（测试值跑完要还原）
  const prefsBackup = readPrefs()

  const child = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: ROOT,
      env: (() => {
        const e = { ...process.env }
        delete e.ELECTRON_RUN_AS_NODE
        return e
      })(),
      stdio: 'ignore'
    }
  )
  let exited = false
  child.on('exit', () => {
    exited = true
  })

  try {
    const wsUrl = await connect()
    await sleep(1500)

    // ---------- A1：无 shelfView 时默认「大图标」，且不写 prefs.json ----------
    // A1 从全量默认状态开始（pagesCustom 清掉——可能被上次失败运行污染），
    // 页面裁剪偏好由 e2e-pages-custom.mjs 自己覆盖测试，这里不掺和。
    writeFileSync(PREFS_FILE, '{}\n', 'utf8')
    await reload(wsUrl)
    await openShelf(wsUrl)
    await settle(wsUrl, `new Promise(r=>setTimeout(r,600)).then(()=>1)`) // 等 prefsGet 回填窗口过去
    const a1 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    console.log('[A1] 无偏好时:', JSON.stringify(a1), 'prefs:', JSON.stringify(readPrefs()))
    assert(a1.view === 'lg', `无偏好时默认应为 lg，实际 ${a1.view}`)

    // ---------- A2：选「列表」立即生效且写进 prefs.json ----------
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][3].click(); 1`)
    await settle(wsUrl, `new Promise(r=>setTimeout(r,600)).then(()=>1)`) // 等 IPC 写盘
    const a2 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    const prefs2 = readPrefs()
    console.log('[A2] 选「列表」后:', JSON.stringify(a2), 'prefs.shelfView:', prefs2.shelfView)
    assert(a2.view === 'list', `选完应立刻变成 list，实际 ${a2.view}`)
    assert(prefs2.shelfView === 'list', `prefs.json 应记 shelfView=list，实际 ${JSON.stringify(prefs2.shelfView)}`)

    // ---------- A3：重载（等价于重启）后仍是「列表」 ----------
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a3 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    console.log('[A3] 重载后:', JSON.stringify(a3))
    assert(a3.view === 'list', `重载后应记得 list，实际 ${a3.view}`)

    // ---------- A4：改选「小图标」重载也记得 ----------
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][2].click(); 1`)
    await settle(wsUrl, `new Promise(r=>setTimeout(r,600)).then(()=>1)`)
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a4 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    const prefs4 = readPrefs()
    console.log('[A4] 改选「小图标」后重载:', JSON.stringify(a4), 'prefs.shelfView:', prefs4.shelfView)
    assert(a4.view === 'sm', `重载后应记得 sm，实际 ${a4.view}`)
    assert(prefs4.shelfView === 'sm', `prefs.json 应更新为 sm，实际 ${JSON.stringify(prefs4.shelfView)}`)

    // ---------- A5：prefs.json 里 shelfView 被改坏 → 回落「大图标」，不白屏 ----------
    const prefs5 = readPrefs()
    prefs5.shelfView = 'xxx'
    writeFileSync(PREFS_FILE, JSON.stringify(prefs5, null, 2), 'utf8')
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a5 = await settle(
      wsUrl,
      `({ view: ${currentViewClass}, alive: !!document.querySelector('.island'), count: document.querySelectorAll('.shelf-cell,.shelf-item').length })`
    )
    console.log('[A5] 值被改坏后:', JSON.stringify(a5))
    assert(a5.view === 'lg', `非法值应回落到 lg，实际 ${a5.view}`)
    assert(a5.alive === true, '值非法也不该白屏')

    // ---------- A6：写 shelfView 不破坏 pagesCustom（互不干扰） ----------
    // 先造一份带 pagesCustom 的 prefs，再走 UI 切视图，断言 pagesCustom 原样保留。
    // 注意：pages 必须包含置物架页（索引 1），否则置物架被裁掉、后面的选择器点不到。
    writeFileSync(
      PREFS_FILE,
      JSON.stringify({ pagesCustom: { pages: [0, 1, 2], collapsed: { pet: true, clock: true, battery: true, net: true, todo: false } } }, null, 2),
      'utf8'
    )
    await reload(wsUrl)
    await openShelf(wsUrl)
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][0].click(); 1`)
    await settle(wsUrl, `new Promise(r=>setTimeout(r,600)).then(()=>1)`)
    const prefs6 = readPrefs()
    console.log('[A6] 切视图后 pagesCustom:', JSON.stringify(prefs6.pagesCustom))
    assert(
      prefs6.pagesCustom &&
        JSON.stringify(prefs6.pagesCustom.pages) === JSON.stringify([0, 1, 2]) &&
        prefs6.pagesCustom.collapsed.todo === false,
      '切视图不应动 pagesCustom'
    )
    assert(prefs6.shelfView === 'lg', `A6 切回大图标应落盘 lg，实际 ${JSON.stringify(prefs6.shelfView)}`)

    // ---------- 恢复已由 finally 统一处理（prefsBackup） ----------
    console.log('[清理] prefs.json 已在 finally 还原')

    console.log('E2E SHELF-VIEW-PREF PASS')
  } finally {
    // 还原用户原本的 prefs.json——不管跑到哪一步挂掉都不能把测试值留在机器上
    writeFileSync(PREFS_FILE, JSON.stringify(prefsBackup, null, 2), 'utf8')
    if (!exited) {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.message ?? e)
    process.exit(1)
  })
