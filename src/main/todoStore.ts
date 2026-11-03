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
