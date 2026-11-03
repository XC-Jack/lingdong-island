import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, mkdirSync as mkDir } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ShelfItem } from '../shared/types'

export type { ShelfItem }

interface StoreShape {
  items: ShelfItem[]
}

const EMPTY: StoreShape = { items: [] }

let file: string
/** 系统图标 PNG 缓存目录（按扩展名缓存，一份图标全系统复用） */
let iconDir: string

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
 * 用 PowerShell 取系统图标，转成 PNG 缓存。
 * 优先对真实路径（文件或文件夹）用 SHGetFileInfo 取真实图标；
 * 文件不存在时按扩展名造一个空样本文件再取。
 * 返回 PNG 的绝对缓存路径，失败返回 null（渲染层退回 SVG 折角纸片）。
 */
const EXTRACT_ICON_PS1 = [
  'param([string]$Target)',
  "Add-Type -AssemblyName System.Drawing",
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class IslandIcon {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]',
  '  public struct SHFILEINFO {',
  '    public IntPtr hIcon; public int iIcon; public uint dwAttributes;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName;',
  '  }',
  '  [DllImport("shell32.dll", CharSet=CharSet.Auto)]',
  '  public static extern IntPtr SHGetFileInfo(string pszPath, uint fa, ref SHFILEINFO sfi, uint cb, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);',
  '}',
  '"@',
  '$i = New-Object IslandIcon+SHFILEINFO',
  '$cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][IslandIcon+SHFILEINFO])',
  '[void][IslandIcon]::SHGetFileInfo($Target, 0, [ref]$i, $cb, 0x100)',
  'if ($i.hIcon -eq [IntPtr]::Zero) { exit 1 }',
  '$b = [System.Drawing.Icon]::FromHandle($i.hIcon).ToBitmap()',
  '$m = New-Object System.IO.MemoryStream',
  '$b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png)',
  '[void][IslandIcon]::DestroyIcon($i.hIcon)',
  '[Convert]::ToBase64String($m.ToArray())'
].join('\n')

function systemIconPng(ext: string, realPath: string | null): string | null {
  // 目标真实存在（文件或文件夹）就直接用它的路径取图标；否则造样本文件
  let target: string | null = null
  if (realPath) {
    try {
      if (existsSync(realPath)) target = realPath
    } catch {
      // 忽略 stat 异常，走样本分支
    }
  }
  let isFolder = false
  if (target) {
    try {
      isFolder = statSync(target).isDirectory()
    } catch {
      isFolder = false
    }
  }
  const key = isFolder ? '_folder' : ext ? ext.toLowerCase() : '._none'
  const png = join(iconDir, `${key.replace(/[^a-z0-9._-]/gi, '_')}.png`)
  if (existsSync(png)) return png
  try {
    mkDir(iconDir, { recursive: true })
    const ps1 = join(iconDir, 'extract-icon.ps1')
    if (!existsSync(ps1)) writeFileSync(ps1, EXTRACT_ICON_PS1, 'utf8')
    let usePath = target
    if (!usePath) {
      // 样本文件：放临时目录，用扩展名让系统图标表命中
      const sampleDir = join(iconDir, 'samples')
      mkDir(sampleDir, { recursive: true })
      usePath = join(sampleDir, `sample${ext || '.unknownreax'}`)
      if (!existsSync(usePath)) writeFileSync(usePath, '', 'utf8')
    }
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', ps1, '-Target', usePath],
      {
        timeout: 8000,
        windowsHide: true,
        encoding: 'utf8'
      }
    )
    const b64 = (r.stdout ?? '').trim()
    if (r.status !== 0 || !b64 || b64.length < 100) return null
    writeFileSync(png, Buffer.from(b64, 'base64'))
    return png
  } catch {
    return null
  }
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
  iconDir = join(app.getPath('userData'), 'icon-cache')
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

  // 网格内拖动排序：渲染层传新的 id 顺序，主进程按它重排后持久化
  ipcMain.handle('shelf:reorder', (_e, ids: unknown): ShelfItem[] => {
    if (!Array.isArray(ids)) return load().items
    const order = ids.map(String)
    const data = load()
    data.items.sort((a, b) => {
      const ia = order.indexOf(a.id)
      const ib = order.indexOf(b.id)
      // 未知 id 的条目排最后，保持相对稳定
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })
    save(data)
    return data.items
  })

  // 按文件名取系统图标 PNG 的绝对路径；渲染层用 file:// 直接显示。
  // 文件/文件夹真实存在时用真实路径取真实图标（文件夹有黄色夹子图标），否则按扩展名退回
  ipcMain.handle('shelf:icon', (_e, name: unknown, path: unknown): string | null => {
    const n = String(name ?? '')
    const p = typeof path === 'string' && path ? path : null
    return systemIconPng(extname(n), p)
  })
}
