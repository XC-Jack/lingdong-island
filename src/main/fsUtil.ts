import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * 「空间」页三组清理共用的文件系统小工具。
 * 从 cleanupStore 里抽出来，卸载残留与管理员清理共用同一套判断，避免各处实现漂移。
 */

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 递归求一个路径的占用；不存在或读不到都算 0，不抛错 */
export async function pathSize(target: string): Promise<number> {
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

export async function sumPaths(paths: string[]): Promise<number> {
  let total = 0
  for (const p of paths) total += await pathSize(p)
  return total
}

/**
 * 清空一个目录里的内容（不删目录本身）。
 * 被占用的文件（EBUSY/EPERM/EACCES/ENOTEMPTY）记为「跳过」，其它错误原样汇报。
 */
export async function removeChildren(dir: string): Promise<{ skipped: number; warnings: string[] }> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { skipped: 0, warnings: [] }
  }
  let skipped = 0
  const warnings: string[] = []
  for (const e of entries) {
    try {
      await fs.rm(join(dir, e.name), { recursive: true, force: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') {
        skipped += 1
      } else {
        warnings.push(errText(err))
      }
    }
  }
  return { skipped, warnings }
}

/**
 * 保守判断路径是否存在。
 * ENOENT/ENOTDIR = 真的不在；没权限（EPERM/EACCES，例如 WindowsApps）按「存在」处理。
 */
export async function existsConservative(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}
