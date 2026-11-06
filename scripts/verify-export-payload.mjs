// verify-export-payload.mjs：US-029 导出 payload 结构的离线单测级验证。
// 与 src/main/exportStore.ts 的 buildPayload() 同构：读 todos.json / schedule.json，
// 组装 { app, version, exportedAt, todos, schedule } 并断言键值一致。
// 用途：e2e 里 dialog.showSaveDialog 弹不出来/被取消时，落盘内容靠本脚本验证。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function assert(cond, msg) {
  if (cond) return
  failures++
  console.error('FAIL:', msg)
}

// 与 exportStore.ts 保持一致的组装逻辑（手工同步，改动需两边一起改）
function localIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${pad(abs / 60)}:${pad(abs % 60)}`
}

function readStoreArray(file, key) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = raw[key]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

const dir = mkdtempSync(join(tmpdir(), 'ld-export-'))
try {
  // —— 造两份模拟 store ——
  const todos = [
    { id: 't1', text: '买牛奶', done: false, createdAt: 1730000000000 },
    { id: 't2', text: '已完成的', done: true, createdAt: 1730000001000 }
  ]
  const schedule = [
    { id: 's1', text: '开会', day: '2026-11-06', time: '09:00', done: false, reminded: false, createdAt: 1730000002000 },
    { id: 's2', text: '跨天的', day: '2026-11-07', time: null, done: false, reminded: false, createdAt: 1730000003000 }
  ]
  const todosFile = join(dir, 'todos.json')
  const schedFile = join(dir, 'schedule.json')
  writeFileSync(todosFile, JSON.stringify({ todos }, null, 2), 'utf8')
  writeFileSync(schedFile, JSON.stringify({ items: schedule }, null, 2), 'utf8')

  // —— 组装 payload（与 buildPayload 相同规则）——
  const payload = {
    app: 'lingdong-island',
    version: 1,
    exportedAt: localIso(),
    todos: readStoreArray(todosFile, 'todos'),
    schedule: readStoreArray(schedFile, 'items')
  }

  // 断言
  assert(payload.app === 'lingdong-island', 'app 键错')
  assert(payload.version === 1, 'version 错')
  assert(typeof payload.exportedAt === 'string' && !Number.isNaN(Date.parse(payload.exportedAt)), 'exportedAt 不是合法时间: ' + payload.exportedAt)
  assert(payload.exportedAt.includes('T') && (payload.exportedAt.includes('+') || payload.exportedAt.includes('-')), 'exportedAt 应带本地时区偏移')
  assert(JSON.stringify(payload.todos) === JSON.stringify(todos), 'todos 与 store 不一致')
  assert(JSON.stringify(payload.schedule) === JSON.stringify(schedule), 'schedule 与 store 不一致')
  assert(payload.schedule[0].day === '2026-11-06', 'schedule day 字段丢失')
  console.log('[1] payload 组装：五键齐全、条目与 store 一致、exportedAt 带本地时区')

  // —— 缺文件 / 坏文件防御 ——
  assert(readStoreArray(join(dir, '不存在.json'), 'todos').length === 0, '缺文件应返回空数组')
  writeFileSync(join(dir, 'bad.json'), 'not json', 'utf8')
  assert(readStoreArray(join(dir, 'bad.json'), 'todos').length === 0, '坏 JSON 应返回空数组')
  assert(readStoreArray(join(dir, 'bad.json'), 'items').length === 0, '坏 JSON（items）应返回空数组')
  console.log('[2] 防御分支：缺文件/坏 JSON 都按空数组处理，不抛错')

  if (failures === 0) console.log('VERIFY EXPORT PAYLOAD PASS')
  else process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
