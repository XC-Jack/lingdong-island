// e2e-import.mjs — SPEC-data-import 验证
//
// 原生「打开」对话框无法在脚本里点，主进程留了 e2e 隔离口 ISLAND_IMPORT_PATH：
// 设了就直接用该路径，跳过对话框，其余链路（读文件 / 校验 / 规范化 / 合并 / 落盘）全走真实代码。
//
// 覆盖：
//   I1 空库导入合法备份 → 条数与内容一致（A3）
//   I2 同一份再导入一次 → added 全 0、skipped 等于上次 added（A4 幂等）
//   I3 四种坏输入被拒且数据零改动（A5）
//   I4 字段规范化：day 非法落今天、time 非法落 null、reminded 强制 false、空 text 丢弃（A6）
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execSync, USER_DATA } from './isolate-userdata.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9321
const TMP = join(ROOT, '.tmp')
const TODOS_FILE = join(USER_DATA, 'todos.json')
const SCHED_FILE = join(USER_DATA, 'schedule.json')
// 固定路径：ISLAND_IMPORT_PATH 是进程级环境变量，启动时定死，之后每次导入读的都是这个文件，
// 所以换用例要改写它的内容，而不是换路径。
const IMPORT_INPUT = join(TMP, 'e2e-import-input.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function connectCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res2, rej) => {
          ws.addEventListener('open', res2, { once: true })
          ws.addEventListener('error', rej, { once: true })
        })
        return ws
      }
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  throw new Error('CDP 连接失败')
}

let seq = 0
function evaluate(ws, expr, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const onMsg = (ev) => {
      const d = JSON.parse(ev.data)
      if (d.id === id) {
        ws.removeEventListener('message', onMsg)
        if (d.error) reject(new Error(d.error.message))
        else resolve(d.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise, returnByValue: true } }))
  })
}

function readTodos() {
  try {
    return JSON.parse(readFileSync(TODOS_FILE, 'utf8')).todos ?? []
  } catch {
    return []
  }
}
function readSchedule() {
  try {
    return JSON.parse(readFileSync(SCHED_FILE, 'utf8')).items ?? []
  } catch {
    return []
  }
}

/**
 * 把一个用例的备份内容写进固定输入文件，再走真实 IPC 导入。
 * 主进程读的是启动时定死的 ISLAND_IMPORT_PATH，这里改写它的内容即可。
 */
async function runImport(ws, content) {
  writeFileSync(IMPORT_INPUT, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
  const raw = await evaluate(
    ws,
    `window.island.importData().then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`,
    true
  )
  if (typeof raw !== 'string' || !raw.startsWith('{')) return { ok: false, detail: 'IPC 未返回 JSON: ' + raw }
  return JSON.parse(raw)
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.ISLAND_IMPORT_PATH = IMPORT_INPUT
  return spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', detached: false, env })
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  } catch {
    /* 进程已退出 */
  }
  await sleep(800)
}

async function main() {
  if (platform() !== 'win32') {
    console.log('SKIP：仅 Windows')
    process.exit(0)
  }
  if (!existsSync(electronExe)) {
    console.log('SKIP：找不到 electron.exe（先 npm i）')
    process.exit(0)
  }
  mkdirSync(TMP, { recursive: true })

  console.log('== e2e-import ==')

  // 先备份隔离库（其它 e2e 可能留了数据），跑完原样恢复，避免污染后续脚本
  const todosBackup = existsSync(TODOS_FILE) ? readFileSync(TODOS_FILE, 'utf8') : null
  const schedBackup = existsSync(SCHED_FILE) ? readFileSync(SCHED_FILE, 'utf8') : null
  // 清空隔离库，保证 I1「空库导入」成立
  rmSync(TODOS_FILE, { force: true })
  rmSync(SCHED_FILE, { force: true })

  // 合法备份：2 条待办 + 2 条日程（一条有 time、一条无）
  const validBackup = {
    app: 'lingdong-island',
    version: 1,
    exportedAt: '2026-11-27T10:00:00.000+08:00',
    todos: [
      { id: 'a1', text: '买牛奶', done: false, createdAt: 1730000000000 },
      { id: 'a2', text: '写报告', done: true, createdAt: 1730000001000 }
    ],
    schedule: [
      { id: 'b1', text: '开会', day: '2026-11-27', time: '09:00', done: false, reminded: false, createdAt: 1730000002000 },
      { id: 'b2', text: '健身', day: '2026-11-28', time: null, done: false, reminded: false, createdAt: 1730000003000 }
    ]
  }

  let child = null
  let ws = null
  try {
    // 先把合法备份写进输入文件，再起应用（起之前文件必须已存在）
    writeFileSync(IMPORT_INPUT, JSON.stringify(validBackup, null, 2), 'utf8')
    child = await startApp()
    ws = await connectCdp()
    await sleep(1800)

    // —— I1 空库导入 ——
    const r1 = await runImport(ws, validBackup)
    ok('I1 导入成功', r1.ok === true, JSON.stringify(r1))
    ok('I1 added 待办 2 / 日程 2', r1.added?.todos === 2 && r1.added?.schedule === 2, JSON.stringify(r1.added))
    const todos1 = readTodos()
    const sched1 = readSchedule()
    ok('I1 落盘待办 2 条', todos1.length === 2, JSON.stringify(todos1.map((t) => t.text)))
    ok('I1 落盘日程 2 条', sched1.length === 2, JSON.stringify(sched1.map((s) => s.text)))
    // 用集合比较，不用排序后拼串：默认 sort 按 UTF-16 码位，中文顺序不是直觉顺序
    ok(
      'I1 待办内容与备份一致',
      new Set(todos1.map((t) => t.text)).size === 2 &&
        todos1.every((t) => ['买牛奶', '写报告'].includes(t.text)),
      JSON.stringify(todos1.map((t) => t.text))
    )
    ok(
      'I1 日程字段完整（day/time 保留）',
      sched1.find((s) => s.text === '开会')?.time === '09:00' && sched1.find((s) => s.text === '健身')?.time === null,
      JSON.stringify(sched1)
    )

    // —— I2 幂等：同一份再导入 ——
    const r2 = await runImport(ws, validBackup)
    ok('I2 第二次 ok 但 added 全 0', r2.ok === true && r2.added?.todos === 0 && r2.added?.schedule === 0, JSON.stringify(r2))
    ok('I2 skipped 待办 2 / 日程 2', r2.skipped?.todos === 2 && r2.skipped?.schedule === 2, JSON.stringify(r2.skipped))
    ok('I2 落盘总数不变（待办 2）', readTodos().length === 2, String(readTodos().length))
    ok('I2 落盘总数不变（日程 2）', readSchedule().length === 2, String(readSchedule().length))

    // —— I3 四种坏输入被拒且数据零改动 ——
    const beforeT = readTodos().length
    const beforeS = readSchedule().length
    const bad = [
      ['非 JSON 文本', 'this is not json {'],
      ['app 不对', JSON.stringify({ app: 'other-app', version: 1, todos: [] })],
      ['version 不认', JSON.stringify({ app: 'lingdong-island', version: 2, todos: [] })],
      ['todos 不是数组', JSON.stringify({ app: 'lingdong-island', version: 1, todos: 'x' })]
    ]
    for (const [label, content] of bad) {
      const r = await runImport(ws, content)
      ok(`I3 ${label} 被拒（reason=invalid）`, r.ok === false && r.reason === 'invalid', JSON.stringify(r))
    }
    ok('I3 坏输入后待办数未变', readTodos().length === beforeT, `${readTodos().length} vs ${beforeT}`)
    ok('I3 坏输入后日程数未变', readSchedule().length === beforeS, `${readSchedule().length} vs ${beforeS}`)

    // —— I4 字段规范化 ——
    const normBackup = {
      app: 'lingdong-island',
      version: 1,
      todos: [
        { id: 'n1', text: '  合法待办  ', done: 1, createdAt: 'bad' }, // text 去空格、done 转布尔、createdAt 取当前
        { id: 'n2', text: '   ', done: false, createdAt: 1 } // 空 text → 丢弃
      ],
      schedule: [
        // day 非法 → 今天；time 非法 → null；reminded 强制 false
        { id: 'm1', text: '规范化日程', day: '2026/11/27', time: '9点', done: false, reminded: true, createdAt: 1 }
      ]
    }
    const r4 = await runImport(ws, normBackup)
    ok('I4 规范化导入 ok', r4.ok === true, JSON.stringify(r4))
    ok('I4 空 text 待办被丢弃（只加 1 条）', r4.added?.todos === 1, JSON.stringify(r4.added))
    const nt = readTodos().find((t) => t.text === '合法待办')
    ok('I4 待办 text 已 trim 且 done 转布尔', !!nt && nt.done === true, JSON.stringify(nt))
    ok('I4 待办 createdAt 非法时取数字', !!nt && typeof nt.createdAt === 'number' && nt.createdAt > 1730000000000, JSON.stringify(nt?.createdAt))
    const ns = readSchedule().find((s) => s.text === '规范化日程')
    const today = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    ok('I4 日程 day 非法落今天', !!ns && ns.day === today, `${ns?.day} vs ${today}`)
    ok('I4 日程 time 非法落 null', !!ns && ns.time === null, JSON.stringify(ns?.time))
    ok('I4 日程 reminded 强制 false', !!ns && ns.reminded === false, JSON.stringify(ns?.reminded))

    // —— I6 仅内容相同（id 不同）也要跳过：模拟换机器后 id 变了 ——
    // 用 I1 导入的「买牛奶」做靶子，换成全新 id 再导入一次
    const sameContent = {
      app: 'lingdong-island',
      version: 1,
      todos: [{ id: 'brand-new-id-xyz', text: '买牛奶', done: false, createdAt: 1730000099999 }],
      schedule: [{ id: 'brand-new-id-abc', text: '开会', day: '2026-11-27', time: '09:00', done: false, reminded: false, createdAt: 1730000099999 }]
    }
    const todoCountBefore = readTodos().length
    const schedCountBefore = readSchedule().length
    const r6 = await runImport(ws, sameContent)
    ok('I6 仅内容相同的待办被跳过（id 不同）', r6.ok === true && r6.added?.todos === 0 && r6.skipped?.todos === 1, JSON.stringify(r6))
    ok('I6 仅内容相同的日程被跳过（id 不同）', r6.added?.schedule === 0 && r6.skipped?.schedule === 1, JSON.stringify(r6))
    ok('I6 落盘总数未变', readTodos().length === todoCountBefore && readSchedule().length === schedCountBefore, `${readTodos().length}/${readSchedule().length}`)

    // —— I5 岛内即时刷新：停在待办页时导入，列表当场多出新条目（A7）——
    // 展开岛 → 点待办组件卡进待办页
    await evaluate(ws, `(document.querySelector('.island').click(), 1)`)
    await sleep(900)
    await evaluate(ws, `(document.querySelector('.widget[data-page="0"]')?.click(), 1)`)
    await sleep(900)
    const countBefore = await evaluate(ws, `document.querySelectorAll('.todo-item').length`)
    ok('I5 导入前待办页有条目（面板已挂载）', typeof countBefore === 'number' && countBefore > 0, String(countBefore))

    // 导入一条全新待办（内容唯一，不会撞指纹）
    const liveBackup = {
      app: 'lingdong-island',
      version: 1,
      todos: [{ id: 'live1', text: '即时刷新验证条目', done: false, createdAt: 1730000009999 }],
      schedule: []
    }
    const r5 = await runImport(ws, liveBackup)
    ok('I5 即时刷新导入 ok', r5.ok === true && r5.added?.todos === 1, JSON.stringify(r5))
    await sleep(700) // 等广播 → tick → 重拉 → 重渲染
    const countAfter = await evaluate(ws, `document.querySelectorAll('.todo-item').length`)
    ok(
      'I5 待办页条数当场 +1（无需重启/重开面板）',
      countAfter === countBefore + 1,
      `${countBefore} → ${countAfter}`
    )
    const hasNew = await evaluate(
      ws,
      `[...document.querySelectorAll('.todo-item .todo-text')].some(el => el.textContent.includes('即时刷新验证条目'))`
    )
    ok('I5 新条目已出现在列表 DOM', hasNew === true, String(hasNew))

    ws.close()
    ws = null
  } catch (e) {
    console.log('执行异常:', e.message)
    fail++
  } finally {
    await stopApp(child)
    rmSync(IMPORT_INPUT, { force: true })
    // 恢复隔离库原样（与 e2e-todo-today 同一约定）
    try {
      if (todosBackup !== null) writeFileSync(TODOS_FILE, todosBackup, 'utf8')
      else if (existsSync(TODOS_FILE)) unlinkSync(TODOS_FILE)
      if (schedBackup !== null) writeFileSync(SCHED_FILE, schedBackup, 'utf8')
      else if (existsSync(SCHED_FILE)) unlinkSync(SCHED_FILE)
      console.log('[收尾] todos.json / schedule.json 已恢复')
    } catch (e) {
      console.error('[收尾] 恢复失败:', e.message)
    }
  }

  console.log(`== 结果：${pass} 过 / ${fail} 败 ==`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
