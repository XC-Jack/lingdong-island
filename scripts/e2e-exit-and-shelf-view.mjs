// e2e-exit-and-shelf-view.mjs：验证 US-034「退出入口 + 记住置物架视图」
// 覆盖：①默认视图是「大图标」②选「列表」后视图生效（US-037 起落盘走 prefs.json，不再断言 localStorage）
//      ③重载页面（模拟重启）后仍是「列表」④偏好值被改坏时回落到「大图标」不报错
//      ⑤window.island.quitApp() 能让 electron 进程真正退出（不是隐藏窗口）
// 用法：node scripts/e2e-exit-and-shelf-view.mjs（自动启动 electron，CDP 端口 9321；Node 22+ 自带全局 WebSocket）
// 注意：只动 userData/prefs.json 的 shelfView 字段（跑完还原），不碰 shelf.json / todos.json / schedule.json 任何用户数据。
//      视图记忆的完整断言（含 pagesCustom 互不干扰）在 e2e-shelf-view-pref.mjs。
import { spawn } from './isolate-userdata.mjs'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
// Electron userData 真实路径：%APPDATA%\lingdong-island（DSH 宿主 homedir() 在 D 盘，不能用）
const PREFS_FILE = join(process.env.APPDATA, 'lingdong-island', 'prefs.json')

/** 直接读磁盘上的 prefs.json（US-037 起视图记忆存这里） */
function readPrefs() {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

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

const main = async () => {
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

  // 备份在 try 外声明：finally 是独立块级作用域，看不到 try 内的 const（A5 残留踩过）
  const prefsBackup = readPrefs()
  try {
    const wsUrl = await connect()
    await sleep(1500)

    // ---------- A1：无偏好记录时默认「大图标」 ----------
    // US-037 起视图记忆存 prefs.json；从全量默认状态开始，跑完由 finally 还原备份
    writeFileSync(PREFS_FILE, '{}\n', 'utf8')
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a1 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    console.log('[A1] 首次进入:', JSON.stringify(a1))
    assert(a1.view === 'lg', `无偏好时默认应为 lg，实际 ${a1.view}`)
    assert(readPrefs().shelfView === undefined, '还没选过就不该写 prefs.json')

    // ---------- A2：选「列表」立即生效并落盘 ----------
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][3].click(); 1`)
    await settle(wsUrl, `new Promise(r=>setTimeout(r,600)).then(()=>1)`) // 等 IPC 写盘
    const a2 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    console.log('[A2] 选「列表」后:', JSON.stringify(a2), 'prefs.shelfView:', readPrefs().shelfView)
    assert(a2.view === 'list', `选完应立刻变成 list，实际 ${a2.view}`)
    assert(readPrefs().shelfView === 'list', `选择应写进 prefs.json，实际 ${JSON.stringify(readPrefs().shelfView)}`)

    // ---------- A3：重载（等价于重启）后仍是「列表」 ----------
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a3 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    console.log('[A3] 重载后:', JSON.stringify(a3))
    assert(a3.view === 'list', `重载后应记得 list，实际 ${a3.view}`)

    // ---------- A4：换成「小图标」重载也记得 ----------
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][2].click(); 1`)
    await settle(wsUrl, `new Promise(r=>setTimeout(r,600)).then(()=>1)`)
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a4 = await settle(wsUrl, `({ view: ${currentViewClass} })`)
    console.log('[A4] 改选「小图标」后重载:', JSON.stringify(a4), 'prefs.shelfView:', readPrefs().shelfView)
    assert(a4.view === 'sm', `重载后应记得 sm，实际 ${a4.view}`)
    assert(readPrefs().shelfView === 'sm', `prefs.json 应更新为 sm，实际 ${JSON.stringify(readPrefs().shelfView)}`)

    // ---------- A5：偏好值被改坏时回落「大图标」，不白屏 ----------
    const prefs5 = readPrefs()
    prefs5.shelfView = 'xxx'
    writeFileSync(PREFS_FILE, JSON.stringify(prefs5, null, 2), 'utf8')
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a5 = await settle(wsUrl, `({ view: ${currentViewClass}, alive: !!document.querySelector('.island'), count: document.querySelectorAll('.shelf-cell,.shelf-item').length })`)
    console.log('[A5] 值被改坏后:', JSON.stringify(a5))
    assert(a5.view === 'lg', `非法值应回落到 lg，实际 ${a5.view}`)
    assert(a5.alive === true, '值非法也不该白屏')

    console.log('[清理] prefs.json 在 finally 还原')

    // ---------- A6：退出接口能让进程真正结束 ----------
    console.log('[A6] 调用 quitApp() …')
    // 这一句会让进程退出，回复可能来不及返回，所以不 await 结果
    cdp(wsUrl, `window.island.quitApp(); 1`).catch(() => {})
    const deadline = Date.now() + 8000
    while (!exited && Date.now() < deadline) await sleep(200)
    assert(exited === true, 'quitApp() 后 electron 进程应在 8 秒内退出（说明是真退出，不是隐藏窗口）')
    console.log('[A6] 进程已退出: true')

    console.log('E2E EXIT-AND-VIEW PASS')
  } finally {
    // 还原用户原本的 prefs.json——不管跑到哪一步挂掉都不能把测试值留在机器上
    try {
      writeFileSync(PREFS_FILE, JSON.stringify(prefsBackup, null, 2), 'utf8')
    } catch (err) {
      console.error('[清理] 还原失败:', err?.message)
    }
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
