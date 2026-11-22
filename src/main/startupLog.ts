import { app } from 'electron'
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
 * 写入失败一律吞掉：只读盘、权限不足等情况下，日志不能反过来把应用搞挂。
 */
export function startupLog(line: string): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'startup.log')
    // 轮转（SPEC-idle-cost-reclaim）：这个文件每次启动、每次避让都追加，
    // 长期不轮转就无限长（本机 2026-11-22 已 2400+ 行）。超过上限就把旧文件改名成 .1，
    // 只留一份；统计/改名失败一律忽略——日志本身不能把应用搞挂。
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
      }
    } catch {
      /* 首次启动还不存在，或正被占用：照常追加 */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* 写不了就算了 */
  }
}
