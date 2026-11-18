import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
    appendFileSync(join(dir, 'startup.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* 写不了就算了 */
  }
}
