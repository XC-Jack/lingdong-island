import { app } from 'electron'
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 单个日志文件上限；超过就轮转成 `startup.log.1`（只留一份） */
const MAX_LOG_BYTES = 1_000_000

/**
 * 启动/避让诊断日志（SPEC-startup-diagnostics / SPEC-avoid-show-attribution）。
 *
 * 为什么单独抽一个模块：主进程里两个地方要写同一份日志 —— `index.ts` 记启动信息与
 * 未捕获异常，`fullscreenWatch.ts` 记「岛为什么被隐藏/被叫出来」。写到同一个文件里，
 * 用户排查时只需要发一个 `startup.log`。
 *
 * **2026-11-22 改异步**（SPEC-startup-log-async）：原来是 `appendFileSync`，而它的调用点里
 * 有一条落在**全屏避让切换的瞬间**（`avoidLog()` 每次隐藏/现身写一行）——那正是最不该等磁盘的
 * 时刻。虽然单次只有 0.1–0.5 ms，但 `SPEC-perf-no-sync-ps` 定的口径是「主线程不做同步 I/O」，
 * 这里补齐。唯一的例外是进程即将退出的 FATAL 路径，那条必须同步（见 `startupLogSync`）。
 *
 * 写入失败一律吞掉：只读盘、权限不足等情况下，日志不能反过来把应用搞挂。
 */

/** 串行队列：异步写盘也要保证「调用顺序 = 落盘顺序」 */
let queue: Promise<void> = Promise.resolve()

function logPath(): string {
  return join(app.getPath('userData'), 'startup.log')
}

/** 超过上限就把旧文件改名成 .1（只留一份）。失败一律忽略。 */
async function rotateIfNeeded(): Promise<void> {
  const file = logPath()
  try {
    const st = await stat(file)
    if (st.size <= MAX_LOG_BYTES) return
    await rm(`${file}.1`, { force: true })
    await rename(file, `${file}.1`)
  } catch {
    /* 首次启动还不存在，或正被占用：照常追加 */
  }
}

async function writeOnce(stamped: string): Promise<void> {
  const dir = app.getPath('userData')
  await mkdir(dir, { recursive: true })
  await rotateIfNeeded()
  await appendFile(logPath(), stamped, 'utf8')
}

/**
 * 记一行日志（异步）。
 *
 * 时间戳在**调用时**取、不在写盘时取：排队期间可能已经过了几十毫秒，
 * 拿写盘时刻会与旁边那些同步写的行错位。
 */
export function startupLog(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  queue = queue.then(() => writeOnce(stamped)).catch(() => {
    /* 写不了就算了 */
  })
}

/**
 * 同步版：**只给「马上就要退出」的路径用**（`uncaughtException` → 弹框 → `app.exit(1)`）。
 * 异步写会随进程一起消失，那条 FATAL 恰恰是用户最需要的一条。
 */
export function startupLogSync(line: string): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'startup.log')
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      }
    } catch {
      /* 不存在/被占用：照常追加 */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* 写不了就算了 */
  }
}
