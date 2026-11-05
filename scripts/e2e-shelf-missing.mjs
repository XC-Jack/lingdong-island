// e2e-shelf-missing.mjs：验证 US-019「置物架文件失效提示」
// 覆盖：失效识别（主进程算 missing，不落盘）→ 图标/列表视图的失效标识与中文 title
//      → 点击失效条目出中文提示条 → 一键「从架子上移除」→ 失效条目定位按钮禁用
// 用法：node scripts/e2e-shelf-missing.mjs（自动启动 electron，CDP 端口 9321；Node 22+ 自带全局 WebSocket）
// 注意：会临时改写用户的 shelf.json，结束时原样恢复。
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CDP_PORT = 9321
const SHELF_JSON = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'lingdong-island', 'shelf.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP 连不上')
}

function cdp(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout')), 20000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id !== 1) return
      clearTimeout(timer)
      if (data.result?.exceptionDetails) {
        reject(new Error('页面异常: ' + (data.result.exceptionDetails.exception?.description ?? data.result.exceptionDetails.text)))
      } else {
        resolve(data.result?.result?.value)
      }
      ws.close()
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
  })
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

/** 等到文件末尾断言通过（UI 更新是异步的，给一点余量） */
async function settle(wsUrl, expression, ms = 400) {
  await cdp(wsUrl, `new Promise(r=>setTimeout(r,${ms})).then(()=>true)`)
  return cdp(wsUrl, expression)
}

const main = async () => {
  // 备份用户真实数据，测试结束原样恢复
  const backup = existsSync(SHELF_JSON) ? readFileSync(SHELF_JSON, 'utf8') : null

  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: ROOT, env, stdio: 'ignore' })

  const dir = mkdtempSync(join(tmpdir(), 'island-missing-'))
  try {
    const wsUrl = await connect()
    await sleep(1500)

    const alive = join(dir, '还在的文件.txt')
    const gone = join(dir, '会被删掉的文件.txt')
    writeFileSync(alive, 'alive')
    writeFileSync(gone, 'gone')

    // 准备：清空 → 加入两个文件 → 删掉其中一个 → 重新拉列表
    const prepared = await cdp(wsUrl, `(async()=>{
      await window.island.shelfClear();
      await window.island.shelfAdd([${JSON.stringify(alive)}, ${JSON.stringify(gone)}]);
      return (await window.island.shelfList()).length;
    })()`)
    assert(prepared === 2, '准备阶段应有 2 条')

    unlinkSync(gone)

    // A1/A2：主进程按文件系统算出 missing，且只有掉的那个是 true
    const flags = await cdp(wsUrl, `(async()=>{
      const l = await window.island.shelfList();
      return l.map(x=>({name:x.name, missing:x.missing}));
    })()`)
    console.log('[A1] 列表 missing 标记:', JSON.stringify(flags))
    const goneItem = flags.find((x) => x.name.includes('会被删掉'))
    const aliveItem = flags.find((x) => x.name.includes('还在'))
    assert(goneItem && goneItem.missing === true, '被删的文件应为 missing:true')
    assert(aliveItem && aliveItem.missing !== true, '还在的文件不应标记失效')

    // 失效状态不落盘
    const onDisk = JSON.parse(readFileSync(SHELF_JSON, 'utf8'))
    const hasMissingField = onDisk.items.some((x) => 'missing' in x)
    console.log('[A2] shelf.json 是否落了 missing 字段:', hasMissingField)
    assert(!hasMissingField, 'missing 状态不应写进 shelf.json')

    // 展开岛、切到置物架页，并用广播让面板拿到带 missing 的列表
    await cdp(wsUrl, `(async()=>{
      document.querySelector('.island').click();
      await new Promise(r=>setTimeout(r,400));
      document.querySelectorAll('.dot')[1].click();
      await new Promise(r=>setTimeout(r,200));
      const l = await window.island.shelfList();
      window.island.emitShelfAdded(l);
      return 'ok';
    })()`)

    // US-034 起置物架视图会被记住，用户上次若选了「列表」，这里的图标视图断言就不成立。
    // 所以先在界面上显式切回「大图标」——顺带也验证了视图菜单本身能用。
    // 切视图会写 localStorage，先把用户原来的选择记下来，脚本末尾还原。
    await cdp(wsUrl, `(async()=>{
      window.__shelfViewBackup = localStorage.getItem('island.shelfView');
      document.querySelector('.shelf-view-btn').click();
      await new Promise(r=>setTimeout(r,150));
      document.querySelectorAll('.shelf-view-item')[0].click();
      return 'ok';
    })()`)

    // A3：图标视图里失效格子有 missing 类 + 「失效」徽标 + 中文 title
    const iconView = await settle(wsUrl, `(()=>{
      const miss = document.querySelector('.shelf-cell.missing');
      const badge = miss?.querySelector('.shelf-badge-missing');
      const all = [...document.querySelectorAll('.shelf-cell')];
      const normal = all.find(c=>!c.classList.contains('missing'));
      return {
        missingCells: document.querySelectorAll('.shelf-cell.missing').length,
        totalCells: all.length,
        badgeText: badge?.textContent ?? null,
        missTitle: miss?.getAttribute('title') ?? null,
        normalTitle: normal?.getAttribute('title') ?? null,
        folderDisabled: miss?.querySelector('.shelf-cell-folder')?.disabled ?? null
      };
    })()`)
    console.log('[A3] 图标视图:', JSON.stringify(iconView))
    assert(iconView.missingCells === 1 && iconView.totalCells === 2, '图标视图应恰有 1 个失效格子')
    assert(String(iconView.badgeText).includes('失效'), '失效格子应有「失效」徽标')
    assert(String(iconView.missTitle).startsWith('文件已不在：'), '失效格子 title 应为「文件已不在：…」')
    assert(!String(iconView.normalTitle).startsWith('文件已不在'), '正常格子 title 不应是失效文案')
    assert(iconView.folderDisabled === true, '失效格子的「在文件夹中显示」应禁用')

    // A4：点失效格子 → 底部中文提示条 + 「从架子上移除」
    await cdp(wsUrl, `(()=>{ document.querySelector('.shelf-cell.missing .shelf-cell-body').click(); return true })()`)
    const notice = await settle(wsUrl, `(()=>{
      const n = document.querySelector('.shelf-notice');
      return {
        exists: !!n,
        kind: n?.className ?? null,
        text: n?.querySelector('.shelf-notice-text')?.textContent ?? null,
        btn: n?.querySelector('.shelf-notice-btn')?.textContent ?? null,
        errorBox: document.querySelector('.shelf-error')?.textContent ?? null
      };
    })()`)
    console.log('[A4] 点击失效条目后的提示:', JSON.stringify(notice))
    assert(notice.exists, '点击失效条目应出现提示条')
    assert(String(notice.text).includes('已经不在了'), '提示应为中文「已经不在了」')
    assert(!/Failed|Error|ENOENT|no such file/i.test(String(notice.text)), '提示里不应出现英文系统报错')
    assert(String(notice.btn).includes('从架子上移除'), '提示条应带「从架子上移除」按钮')
    assert(notice.errorBox === null, '旧的英文报错框不应再出现')

    // A5：一键移除 → 条目消失、提示条消失、落盘只剩 1 条
    await cdp(wsUrl, `(()=>{ document.querySelector('.shelf-notice-btn').click(); return true })()`)
    const afterRemove = await settle(wsUrl, `(()=>{
      return {
        cells: document.querySelectorAll('.shelf-cell').length,
        notice: !!document.querySelector('.shelf-notice'),
        count: document.querySelector('.shelf-count')?.textContent ?? null
      };
    })()`, 600)
    console.log('[A5] 一键移除后:', JSON.stringify(afterRemove))
    assert(afterRemove.cells === 1, '移除后应只剩 1 个格子')
    assert(afterRemove.notice === false, '移除后提示条应收起')
    const diskAfter = JSON.parse(readFileSync(SHELF_JSON, 'utf8'))
    assert(diskAfter.items.length === 1, 'shelf.json 应只剩 1 条')
    assert(!diskAfter.items.some((x) => String(x.name).includes('会被删掉')), 'shelf.json 里失效条目应被删除')

    // A6：列表视图同样有失效文案（重新放一个失效条目再切列表）
    writeFileSync(gone, 'gone again')
    await cdp(wsUrl, `(async()=>{
      const l = await window.island.shelfAdd([${JSON.stringify(gone)}]);
      window.island.emitShelfAdded(l);
      return l.length;
    })()`)
    unlinkSync(gone)
    await cdp(wsUrl, `(async()=>{
      const l = await window.island.shelfList();
      window.island.emitShelfAdded(l);
      document.querySelector('.shelf-view-btn').click();
      await new Promise(r=>setTimeout(r,150));
      const items = [...document.querySelectorAll('.shelf-view-item')];
      items[3].click();
      return 'ok';
    })()`)
    const listView = await settle(wsUrl, `(()=>{
      const miss = document.querySelector('.shelf-item.missing');
      const nameEl = miss?.querySelector('.shelf-name');
      return {
        missingRows: document.querySelectorAll('.shelf-item.missing').length,
        totalRows: document.querySelectorAll('.shelf-item').length,
        badge: miss?.querySelector('.shelf-badge-missing')?.textContent ?? null,
        rowTitle: miss?.getAttribute('title') ?? null,
        strikeName: nameEl ? getComputedStyle(nameEl).textDecorationLine : null,
        folderDisabled: miss?.querySelector('.shelf-row-folder')?.disabled ?? null
      };
    })()`)
    console.log('[A6] 列表视图:', JSON.stringify(listView))
    assert(listView.missingRows === 1 && listView.totalRows === 2, '列表视图应恰有 1 行失效')
    assert(String(listView.badge).includes('失效'), '列表失效行应有「失效」标记')
    assert(String(listView.rowTitle).startsWith('文件已不在：'), '列表失效行 title 应为「文件已不在：…」')
    assert(String(listView.strikeName).includes('line-through'), '列表失效行文件名应有删除线')
    assert(listView.folderDisabled === true, '列表失效行的定位按钮应禁用')

    // A7：定位接口对失效路径如实回报（不再静默）——这也证明 preload 的 invoke 接线通了
    const reveal = await cdp(wsUrl, `(async()=>{
      const l = await window.island.shelfList();
      const m = l.find(x=>x.missing);
      const r = await window.island.shelfShowInFolder(m.path);
      return r;
    })()`)
    console.log('[A7] 失效条目定位结果:', JSON.stringify(reveal))
    assert(reveal && reveal.ok === false && reveal.reason === 'missing', '失效条目的定位应返回 reason=missing')

    // A8：打开失效文件 → 结构化 missing，不返回英文报错
    const openRes = await cdp(wsUrl, `(async()=>{
      const l = await window.island.shelfList();
      const m = l.find(x=>x.missing);
      return await window.island.shelfOpen(m.path);
    })()`)
    console.log('[A8] 打开失效文件结果:', JSON.stringify(openRes))
    assert(openRes && openRes.ok === false && openRes.reason === 'missing', '打开失效文件应返回 reason=missing')

    // 还原用户原本的视图偏好（本脚本为了断言切过视图，会顺带写 localStorage）
    await cdp(wsUrl, `(()=>{
      if (window.__shelfViewBackup === null || window.__shelfViewBackup === undefined) {
        localStorage.removeItem('island.shelfView');
      } else {
        localStorage.setItem('island.shelfView', window.__shelfViewBackup);
      }
      return 'ok';
    })()`)

    console.log('E2E SHELF-MISSING PASS')
  } finally {
    try { child.kill() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    // 恢复用户原数据
    try {
      if (backup === null) {
        if (existsSync(SHELF_JSON)) rmSync(SHELF_JSON, { force: true })
      } else {
        writeFileSync(SHELF_JSON, backup, 'utf8')
      }
    } catch {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
