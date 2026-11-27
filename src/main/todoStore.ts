import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Todo } from '../shared/types'

export type { Todo }

interface StoreShape {
  todos: Todo[]
}

const EMPTY: StoreShape = { todos: [] }

let file: string

function load(): StoreShape {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    if (!Array.isArray(parsed.todos)) return { ...EMPTY }
    return { todos: parsed.todos }
  } catch {
    return { ...EMPTY }
  }
}

function save(data: StoreShape): void {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 内容指纹：判断「本机是否已有同一条」用。
 * 只看文字——待办的语义就是一句要做的事，同文字即同一条；
 * id 只在同一次安装内稳定，换机器后 id 会变，所以不能只靠 id 去重。
 */
function fingerprint(t: Todo): string {
  return t.text
}

/**
 * 把导入的待办合并进本机列表（SPEC-data-import）。
 *
 * 两条去重规则，任一命中即跳过：
 * 1. 同 id（重复导入同一份备份）；
 * 2. 同文字指纹（换机器后 id 不同但内容相同）。
 * 其余追加到末尾，写盘后返回合并后的全量列表。
 *
 * 为什么放在 todoStore 而不是 importStore：写盘与「当前列表」的唯一事实在这个模块，
 * 外部直接写文件会绕开这里的 load/save 约定。
 */
export function mergeTodos(incoming: Todo[]): { list: Todo[]; added: number; skipped: number } {
  const data = load()
  const seenIds = new Set(data.todos.map((t) => t.id))
  const seenTexts = new Set(data.todos.map(fingerprint))
  let added = 0
  let skipped = 0
  for (const t of incoming) {
    if (seenIds.has(t.id) || seenTexts.has(fingerprint(t))) {
      skipped += 1
      continue
    }
    data.todos.push(t)
    seenIds.add(t.id)
    seenTexts.add(fingerprint(t))
    added += 1
  }
  if (added > 0) save(data)
  return { list: data.todos, added, skipped }
}

/** 待办数据存储：JSON 文件持久化在 userData 目录，通过 IPC 供渲染进程读写 */
export function setupTodoStore(): void {
  file = join(app.getPath('userData'), 'todos.json')
  mkdirSync(app.getPath('userData'), { recursive: true })

  ipcMain.handle('todos:list', (): Todo[] => load().todos)

  ipcMain.handle('todos:add', (_e, text: unknown): Todo[] => {
    const t = String(text ?? '').trim()
    if (!t) return load().todos
    const data = load()
    data.todos.push({ id: newId(), text: t, done: false, createdAt: Date.now() })
    save(data)
    return data.todos
  })

  ipcMain.handle('todos:toggle', (_e, id: unknown): Todo[] => {
    const data = load()
    const item = data.todos.find((t) => t.id === id)
    if (item) item.done = !item.done
    save(data)
    return data.todos
  })

  ipcMain.handle('todos:remove', (_e, id: unknown): Todo[] => {
    const data = load()
    data.todos = data.todos.filter((t) => t.id !== id)
    save(data)
    return data.todos
  })

  ipcMain.handle('todos:rename', (_e, payload: unknown): Todo[] => {
    const { id, text } = (payload ?? {}) as { id?: string; text?: string }
    const t = String(text ?? '').trim()
    if (id && t) {
      const data = load()
      const item = data.todos.find((x) => x.id === id)
      if (item) item.text = t
      save(data)
    }
    return load().todos
  })
}
