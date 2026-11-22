import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, mkdirSync as mkDir } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { runPowerShellArgs } from './runPs'
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

/**
 * 给条目补上「原文件是否还在」这个运行时状态。
 * 只加在传出去的副本上，不写盘（shelf.json 里永远没有 missing 字段）；
 * 每次返回列表都重新查一次文件系统，文件放回原处后标识会自动消失。
 */
function withMissing(items: ShelfItem[]): ShelfItem[] {
  return items.map((it) => {
    let missing = false
    try {
      missing = !existsSync(it.path)
    } catch {
      missing = true
    }
    return missing ? { ...it, missing: true } : { ...it, missing: false }
  })
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

/** 同一 cacheKey 正在解析时共用同一个 Promise：一页 10 个 .exe 不会同时起 10 个 PowerShell */
const iconPending = new Map<string, Promise<string | null>>()

/**
 * 提图标串行化：一页可能有 10 种不同扩展名，并行就是 10 个 PowerShell 同时在跑
 * （每个约 40–60 MB 的 CLR）。串行只是让后面的图标晚几百毫秒出现，界面先有 SVG 占位。
 */
let queueTail: Promise<unknown> = Promise.resolve()
function runSerial<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job)
  queueTail = run.catch(() => {})
  return run
}

/**
 * 取系统图标并转 PNG 缓存（**异步**）。
 *
 * 2026-11-22 改异步（SPEC-perf-no-sync-ps）：旧实现是 `spawnSync`，一次 280–600 ms，
 * 期间主进程整个冻结。它挂在「切到置物架页 → 每个条目请求图标」这条路上，
 * 每种新扩展名第一次都要卡一下，且会让同期的窗口尺寸动画停住。
 * 现在改成异步：界面先显示 SVG 折角纸片，PNG 就绪后自然替换（FileIcon 本来就按状态渲染）。
 */
function systemIconPng(ext: string, realPath: string | null): Promise<string | null> {
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
  if (existsSync(png)) return Promise.resolve(png)
  const running = iconPending.get(key)
  if (running) return running

  const task = runSerial(async (): Promise<string | null> => {
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
      const r = await runPowerShellArgs(['-File', ps1, '-Target', usePath], 8000)
      const b64 = (r.stdout ?? '').trim()
      if (r.code !== 0 || !b64 || b64.length < 100) return null
      writeFileSync(png, Buffer.from(b64, 'base64'))
      return png
    } catch {
      return null
    }
  }).finally(() => {
    iconPending.delete(key)
  })

  iconPending.set(key, task)
  return task
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

  // 返回给渲染层的列表一律带 missing 运行时状态（不落盘）
  ipcMain.handle('shelf:list', (): ShelfItem[] => withMissing(load().items))

  ipcMain.handle('shelf:add', (_e, paths: unknown): ShelfItem[] => {
    const list = Array.isArray(paths) ? paths : [paths]
    return withMissing(addPaths(list.map(String)))
  })

  ipcMain.handle('shelf:remove', (_e, id: unknown): ShelfItem[] => {
    const data = load()
    data.items = data.items.filter((x) => x.id !== id)
    save(data)
    return withMissing(data.items)
  })

  ipcMain.handle('shelf:clear', (): ShelfItem[] => {
    save({ items: [] })
    return []
  })

  // 网格内拖动排序：渲染层传新的 id 顺序，主进程按它重排后持久化
  ipcMain.handle('shelf:reorder', (_e, ids: unknown): ShelfItem[] => {
    if (!Array.isArray(ids)) return withMissing(load().items)
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
    return withMissing(data.items)
  })

  // 按文件名取系统图标 PNG 的绝对路径；渲染层用 file:// 直接显示。
  // 文件/文件夹真实存在时用真实路径取真实图标（文件夹有黄色夹子图标），否则按扩展名退回
  ipcMain.handle('shelf:icon', (_e, name: unknown, path: unknown): Promise<string | null> => {
    const n = String(name ?? '')
    const p = typeof path === 'string' && path ? path : null
    return systemIconPng(extname(n), p)
  })
}
