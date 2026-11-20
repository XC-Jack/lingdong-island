import { app, ipcMain, session } from 'electron'
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CleanupItem,
  CleanupRunResult,
  CleanupScanResult,
  CleanupTargetId
} from '../shared/types'
import { getUpdateStage } from './updater'

/**
 * 设置「空间」页的扫描与清理（SPEC-space-cleanup）。
 *
 * 设计原则：
 * - **白名单写死在这里**，渲染层只传 id；任何路径都不从页面传进来。
 * - 只清本应用自己产生的、删了能再生的东西，用户数据（待办/日程/置物架/偏好）一概不碰。
 * - 扫描与删除分开：先算清楚多大，再让用户点。
 * - `freedBytes` 用「清理前后重新扫描的差值」算，不拿勾选时的旧数字冒充结果。
 */

/** 用户数据目录（%APPDATA%\lingdong-island） */
function userDataDir(): string {
  return app.getPath('userData')
}

/**
 * electron-updater 的缓存目录。
 * 路径规则与 `updater.ts` 的 `updateCacheDir()` 保持一致：
 * Windows 下是 %LOCALAPPDATA%\<app.name>-updater，里面有完整安装包和 pending 半截文件。
 */
function updateCacheDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, `${app.name}-updater`)
}

interface TargetDef {
  id: CleanupTargetId
  label: string
  hint: string
  /** fs=直接删目录/文件；web-cache=走 Electron session API（运行中的缓存文件可能被占用） */
  kind: 'fs' | 'web-cache'
  defaultChecked: boolean
  paths: () => string[]
}

const TARGETS: TargetDef[] = [
  {
    id: 'update-cache',
    label: '更新安装包缓存',
    hint: '下载新版本时留下的安装包，通常一百多 MB。删了不影响已装的版本，下次更新重新下载。',
    kind: 'fs',
    defaultChecked: true,
    paths: () => [updateCacheDir()]
  },
  {
    id: 'web-cache',
    label: '网页缓存',
    hint: '界面渲染用的网页与脚本缓存，删了下次打开会自己重建，不碰任何数据。',
    kind: 'web-cache',
    defaultChecked: true,
    paths: () => [join(userDataDir(), 'Cache'), join(userDataDir(), 'Code Cache')]
  },
  {
    id: 'lyrics',
    label: '歌词缓存',
    hint: '查过的歌词存在本机，删了下次播放时联网重查；断网时会显示「暂无歌词」。',
    kind: 'fs',
    defaultChecked: true,
    paths: () => [join(userDataDir(), 'lyrics')]
  },
  {
    id: 'logs',
    label: '诊断日志',
    hint: '启动记录和收起记录，只在排查问题时有用。一般不用清，删了出问题就查不到现场。',
    kind: 'fs',
    defaultChecked: false,
    paths: () => [join(userDataDir(), 'startup.log'), join(userDataDir(), 'collapse-log.txt')]
  }
]

function isTargetId(v: unknown): v is CleanupTargetId {
  return typeof v === 'string' && TARGETS.some((t) => t.id === v)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 递归求一个路径的占用；不存在或读不到都算 0，不抛错 */
async function pathSize(target: string): Promise<number> {
  let st
  try {
    st = await fs.lstat(target)
  } catch {
    return 0
  }
  // 符号链接只算链接本身，不跟进去（避免指向系统目录时扫出天文数字）
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size

  let entries: Dirent[]
  try {
    entries = await fs.readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    total += await pathSize(join(target, e.name))
  }
  return total
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function targetSize(t: TargetDef): Promise<number> {
  let total = 0
  for (const p of t.paths()) {
    total += await pathSize(p)
  }
  return total
}

/** 扫描全部清理项；设置页进入时与清理后各调一次 */
export async function scanCleanup(): Promise<CleanupScanResult> {
  const items: CleanupItem[] = []
  for (const t of TARGETS) {
    const bytes = await targetSize(t)
    let exists = bytes > 0
    if (!exists) {
      for (const p of t.paths()) {
        if (await pathExists(p)) {
          exists = true
          break
        }
      }
    }
    items.push({
      id: t.id,
      label: t.label,
      hint: t.hint,
      bytes,
      defaultChecked: t.defaultChecked,
      exists
    })
  }
  return {
    items,
    totalBytes: items.reduce((n, i) => n + i.bytes, 0),
    scannedAt: Date.now()
  }
}

/**
 * 执行清理。ids 来自渲染层（任意值），这里按白名单过滤；
 * 不在白名单里的 id 一律忽略，不会拼出任何路径。
 */
export async function runCleanup(rawIds: unknown): Promise<CleanupRunResult> {
  const wanted = new Set<CleanupTargetId>(
    Array.isArray(rawIds) ? rawIds.filter(isTargetId) : []
  )
  const warnings: string[] = []

  // 下载中 / 暂停 / 已下好等安装：更新缓存目录正被使用，跳过而不是删半截
  const stage = getUpdateStage()
  if (
    wanted.has('update-cache') &&
    (stage === 'downloading' || stage === 'paused' || stage === 'ready')
  ) {
    wanted.delete('update-cache')
    warnings.push('更新包正在下载或已下好等着安装，这一项这次没清。')
  }

  const before = await scanCleanup()

  for (const t of TARGETS) {
    if (!wanted.has(t.id)) continue

    if (t.kind === 'web-cache') {
      // 运行中的 Chromium 缓存文件可能被占用，用官方 API 清，不直接删目录
      try {
        const ses = session.defaultSession
        await ses.clearCache()
        await ses.clearCodeCaches({})
      } catch (e) {
        warnings.push(`${t.label}没清干净：${errText(e)}`)
      }
      continue
    }

    for (const p of t.paths()) {
      try {
        await fs.rm(p, { recursive: true, force: true })
      } catch (e) {
        warnings.push(`${t.label}没清干净：${errText(e)}`)
      }
    }
  }

  const after = await scanCleanup()
  return {
    ok: true,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    scan: after,
    warnings
  }
}

/** 注册 IPC，必须在 app.whenReady 后调用 */
export function setupCleanupStore(): void {
  ipcMain.handle('cleanup:scan', () => scanCleanup())
  ipcMain.handle('cleanup:run', (_e, ids: unknown) => runCleanup(ids))
}
