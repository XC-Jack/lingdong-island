import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ShelfItem } from '../shared/types'

export type { ShelfItem }

interface StoreShape {
  items: ShelfItem[]
}

const EMPTY: StoreShape = { items: [] }

let file: string

function load(): StoreShape {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    if (!Array.isArray(parsed.items)) return { ...EMPTY }
    return { items: parsed.items }
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
 * 把拖进来的文件路径转成置物架条目。
 * 只记录路径不复制文件（首版策略：暂存 = 快速找回，不是备份）。
 * 文件可以不存在（比如 U 盘拔了），列表里仍显示，打开失败由 shell.openPath 报错。
 */
function addPaths(paths: string[]): ShelfItem[] {
  const data = load()
  for (const p of paths) {
    const path = String(p ?? '').trim()
    if (!path) continue
    // 去重：同一路径已在架上就跳过
    if (data.items.some((x) => x.path === path)) continue
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      // 拖入瞬间拿不到大小（极少见），先记 0
    }
    data.items.push({
      id: newId(),
      path,
      name: basename(path),
      size,
      addedAt: Date.now()
    })
  }
  save(data)
  return data.items
}

/** 置物架数据存储：JSON 持久化在 userData，IPC 供渲染层增/删/列 */
export function setupShelfStore(): void {
  file = join(app.getPath('userData'), 'shelf.json')
  mkdirSync(app.getPath('userData'), { recursive: true })

  ipcMain.handle('shelf:list', (): ShelfItem[] => load().items)

  ipcMain.handle('shelf:add', (_e, paths: unknown): ShelfItem[] => {
    const list = Array.isArray(paths) ? paths : [paths]
    return addPaths(list.map(String))
  })

  ipcMain.handle('shelf:remove', (_e, id: unknown): ShelfItem[] => {
    const data = load()
    data.items = data.items.filter((x) => x.id !== id)
    save(data)
    return data.items
  })

  ipcMain.handle('shelf:clear', (): ShelfItem[] => {
    save({ items: [] })
    return []
  })
}
