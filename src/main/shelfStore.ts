import { app, ipcMain, nativeImage } from 'electron'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  readdirSync,
  unlinkSync,
  mkdirSync as mkDir
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, extname } from 'node:path'
import { runPowerShellArgs } from './runPs'
import type { ShelfItem } from '../shared/types'

export type { ShelfItem }

interface StoreShape {
  items: ShelfItem[]
}

const EMPTY: StoreShape = { items: [] }

let file: string
/**
 * 系统图标 PNG 缓存目录。
 * 真实文件按「扩展名 + 路径哈希」缓存（一个文件一份图标）；失效条目按扩展名共用占位图。
 * 2026-11-27 修：旧实现只按扩展名，全系统所有 `.lnk` 共用第一张图标
 * （用户截图里置物架显示的是别人家快捷方式的图标）。
 */
let iconDir: string

/** 路径 → 8 位十六进制指纹。Windows 路径不区分大小写，先归一化再算，避免大小写不同生成两份缓存 */
function pathHash(p: string): string {
  return createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 8)
}

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
 * 拖拽光标图的兜底 PNG（32×32 圆角方块）。
 * `startDrag` 的 `icon` 传空 NativeImage 时，Windows 上整个拖拽会**静默失败**
 * （探针实测：`iconEmpty=true` 时目标端连 dragenter 都收不到；换成真实图标后
 * `types=[Files]` 正常到达）。所以图标取不到时必须有一张兜底图，不能传空。
 */
const FALLBACK_DRAG_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAATElEQVR4nO3XoQ0AIAwF0Q7MKAzLBuAQJcHRQ1yT6nv2R6RrfcyXn3tl4SukOn4gUAAV3wgBAgQIECBAgAABAgTgAHyYfAHAxyk5zxc6Ij/GppmdbgAAAABJRU5ErkJggg=='

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
/**
 * 算某个条目的图标缓存信息（**同步、不生成**）。
 * 抽出来是为了让「拖出」路径能在 `dragstart` 里同步拿到图标 PNG 路径——
 * 那时来不及等 PowerShell 跑完，只能用已经缓存好的。
 */
function iconCacheInfo(ext: string, realPath: string | null): { key: string; png: string; target: string | null } {
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
  // 缓存 key：真实文件存在 → 「扩展名 + 路径哈希」（一个文件一份，`.lnk` 不再互相串）；
  // 文件已不在 → 只按扩展名（失效条目共用一张占位图，不必为每个失效路径生成一份）。
  const base = isFolder ? '_folder' : ext ? ext.toLowerCase() : '._none'
  const safe = base.replace(/[^a-z0-9._-]/gi, '_')
  const key = target ? `${safe}.${pathHash(target)}` : safe
  return { key, png: join(iconDir, `${key}.png`), target }
}

function systemIconPng(ext: string, realPath: string | null): Promise<string | null> {
  const { key, png, target } = iconCacheInfo(ext, realPath)
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

/**
 * 清掉 2026-11-27 之前按「仅扩展名」生成的旧图标缓存（`<ext>.png` / `_folder.png`）。
 *
 * 那些文件是**错误**的：旧实现让全系统所有 `.lnk` 共用第一张图标，用户截图里
 * 置物架显示的就是别人家快捷方式的图标（实测 `%APPDATA%\lingdong-island\icon-cache\.lnk.png`，
 * 1179 B，生成于 2025-11-07）。新 key 是「扩展名 + 路径哈希」，不会命中旧文件，
 * 但旧文件留着没有意义、还会占地方，顺手清掉。
 *
 * 只删本目录下「扩展名形态」的 PNG（`.<ext>.png` / `_folder.png` / `._none.png`），
 * 不动带哈希的新缓存，也不递归、不碰用户文件。
 */
function purgeLegacyIconCache(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 目录还不存在，没什么可清的
  }
  for (const n of names) {
    // 新格式一定以「.<8 位十六进制>.png」结尾（`pathHash` 的输出），旧格式只有「<base>.png」
    if (!n.endsWith('.png') || /\.[0-9a-f]{8}\.png$/i.test(n)) continue
    // 图标缓存名都以 `.`（`.lnk` / `._none`）或 `_`（`_folder`）开头；
    // 不是这个形态的一律不动，避免误删以后加进来的其它文件
    if (!n.startsWith('.') && !n.startsWith('_')) continue
    try {
      unlinkSync(join(dir, n))
    } catch {
      // 删不掉（被占用/权限）就算了：下次启动再试，不影响正确性——新 key 不会命中它
    }
  }
}

/** 置物架数据存储：JSON 持久化在 userData，IPC 供渲染层增/删/列 */
export function setupShelfStore(): void {
  file = join(app.getPath('userData'), 'shelf.json')
  iconDir = join(app.getPath('userData'), 'icon-cache')
  mkdirSync(app.getPath('userData'), { recursive: true })
  purgeLegacyIconCache(iconDir)

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

  // 拖出到别的应用（2026-11-27 新增）：HTML5 拖放只在同一渲染进程内传数据，
  // 拖到剪映/资源管理器时对端收到的是空拖拽（光标变禁止）。要让系统级拖拽接管，
  // 唯一途径是 webContents.startDrag——由主进程向操作系统发起一次真实文件拖拽。
  //
  // 三个实测约束（`.tmp/dragtest` 探针，Electron 45.2.1 / Windows 11）：
  // 1. 渲染层 `dragstart` 里必须先 `e.preventDefault()` 掐掉 HTML5 拖拽，否则 startDrag 不接管；
  // 2. `icon` 不能是空 NativeImage，否则拖拽静默失败（目标端连 dragenter 都收不到）；
  // 3. `startDrag` 会**阻塞到拖拽结束**才返回（实测 1288–1559ms），所以不能用 invoke 等它。
  ipcMain.on('shelf:start-drag', (event, path: unknown) => {
    const p = typeof path === 'string' ? path : ''
    if (!p || !existsSync(p)) return
    // 图标只用**已缓存**的那张（dragstart 里没时间等 PowerShell）。
    // 没缓存过（用户还没看到过这张图标就拖）就用兜底图，不影响拖拽本身。
    let img = nativeImage.createEmpty()
    const cached = iconCacheInfo(extname(p), p).png
    if (existsSync(cached)) img = nativeImage.createFromPath(cached)
    if (img.isEmpty()) img = nativeImage.createFromBuffer(Buffer.from(FALLBACK_DRAG_ICON_B64, 'base64'))
    try {
      event.sender.startDrag({ file: p, icon: img })
    } catch {
      // 拖拽发起失败（极少数：拖拽会话已被占用）不影响架内换位，静默即可
    }
    // startDrag 是同步的：它在**拖拽结束时**才返回（实测 1.3–1.6 秒）。
    // 渲染层靠这个事件复位「正在拖置物架条目」标记，否则拖到岛外松手后
    // 这个标记会一直挂着，下一次拖外部文件进来会被格子误当成架内拖动吞掉。
    if (!event.sender.isDestroyed()) event.sender.send('shelf:drag-ended')
  })
}
