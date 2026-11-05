// e2e-exit-and-shelf-view.mjs：验证 US-034「退出入口 + 记住置物架视图」
// 覆盖：①默认视图是「大图标」②选「列表」后视图生效且写进 localStorage
//      ③重载页面（模拟重启）后仍是「列表」④偏好值被改坏时回落到「大图标」不报错
//      ⑤window.island.quitApp() 能让 electron 进程真正退出（不是隐藏窗口）
// 用法：node scripts/e2e-exit-and-shelf-view.mjs（自动启动 electron，CDP 端口 9321；Node 22+ 自带全局 WebSocket）
// 注意：只动渲染层 localStorage，不碰 shelf.json / todos.json / schedule.json 任何用户数据。
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const VIEW_KEY = 'island.shelfView'

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

const storedView = `localStorage.getItem(${JSON.stringify(VIEW_KEY)})`

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

  try {
    const wsUrl = await connect()
    await sleep(1500)

    // ---------- A1：无偏好记录时默认「大图标」 ----------
    // 先记下用户原本的选择，脚本结束要还原（这是用户点出来的偏好，不该被测试清掉）
    const viewBackup = await cdp(wsUrl, `localStorage.getItem(${JSON.stringify(VIEW_KEY)})`)
    await cdp(wsUrl, `localStorage.removeItem(${JSON.stringify(VIEW_KEY)}); 1`)
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a1 = await settle(wsUrl, `({ view: ${currentViewClass}, stored: ${storedView} })`)
    console.log('[A1] 首次进入:', JSON.stringify(a1))
    assert(a1.view === 'lg', `无偏好时默认应为 lg，实际 ${a1.view}`)
    assert(a1.stored === null, '还没选过就不该写 localStorage')

    // ---------- A2：选「列表」立即生效并落盘 ----------
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][3].click(); 1`)
    const a2 = await settle(wsUrl, `({ view: ${currentViewClass}, stored: ${storedView} })`)
    console.log('[A2] 选「列表」后:', JSON.stringify(a2))
    assert(a2.view === 'list', `选完应立刻变成 list，实际 ${a2.view}`)
    assert(a2.stored === 'list', `选择应写进 localStorage，实际 ${a2.stored}`)

    // ---------- A3：重载（等价于重启）后仍是「列表」 ----------
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a3 = await settle(wsUrl, `({ view: ${currentViewClass}, stored: ${storedView} })`)
    console.log('[A3] 重载后:', JSON.stringify(a3))
    assert(a3.view === 'list', `重载后应记得 list，实际 ${a3.view}`)

    // ---------- A4：换成「小图标」重载也记得 ----------
    await cdp(wsUrl, `document.querySelector('.shelf-view-btn').click(); 1`)
    await sleep(200)
    await cdp(wsUrl, `[...document.querySelectorAll('.shelf-view-item')][2].click(); 1`)
    await sleep(300)
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a4 = await settle(wsUrl, `({ view: ${currentViewClass}, stored: ${storedView} })`)
    console.log('[A4] 改选「小图标」后重载:', JSON.stringify(a4))
    assert(a4.view === 'sm', `重载后应记得 sm，实际 ${a4.view}`)
    assert(a4.stored === 'sm', `localStorage 应更新为 sm，实际 ${a4.stored}`)

    // ---------- A5：偏好值被改坏时回落「大图标」，不白屏 ----------
    await cdp(wsUrl, `localStorage.setItem(${JSON.stringify(VIEW_KEY)}, 'xxx'); 1`)
    await reload(wsUrl)
    await openShelf(wsUrl)
    const a5 = await settle(wsUrl, `({ view: ${currentViewClass}, alive: !!document.querySelector('.island'), count: document.querySelectorAll('.shelf-cell,.shelf-item').length })`)
    console.log('[A5] 值被改坏后:', JSON.stringify(a5))
    assert(a5.view === 'lg', `非法值应回落到 lg，实际 ${a5.view}`)
    assert(a5.alive === true, '值非法也不该白屏')

    // ---------- 恢复用户原本的偏好，别把测试值留在机器上 ----------
    await cdp(
      wsUrl,
      `(() => {
        const old = ${JSON.stringify(viewBackup)};
        if (old === null || old === undefined) localStorage.removeItem(${JSON.stringify(VIEW_KEY)});
        else localStorage.setItem(${JSON.stringify(VIEW_KEY)}, old);
        return localStorage.getItem(${JSON.stringify(VIEW_KEY)});
      })()`
    )
    console.log('[清理] 已还原用户原本的视图偏好:', JSON.stringify(viewBackup))

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
