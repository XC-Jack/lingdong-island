import { app, ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 日程（M8）：今天的安排列表。
 *
 * - 每条：{ id, text, time: 'HH:mm' | null, done, createdAt }
 * - time 为空 = 全天无具体时间；有时到点前 5 分钟触发提醒（Electron Notification）
 * - 持久化到 userData\schedule.json，与待办/置物架同模式
 * - 提醒触发时置 done 不变，只发一次（reminded 标记持久化防重复弹）
 */

export interface ScheduleItem {
  id: string
  text: string
  time: string | null // 'HH:mm' 24 小时制，null = 无具体时间
  done: boolean
  reminded: boolean
  createdAt: number
}

let items: ScheduleItem[] = []
let timer: ReturnType<typeof setInterval> | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'schedule.json')
}

function load(): void {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8'))
    items = Array.isArray(raw.items) ? raw.items : []
  } catch {
    items = []
  }
}

function save(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(filePath(), JSON.stringify({ items }, null, 2), 'utf8')
}

/** 今天的 'HH:mm'；跨天时重置 reminded（第二天的日程重新可提醒） */
function nowHm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function remindDue(): void {
  const hm = nowHm()
  for (const it of items) {
    if (!it.time || it.reminded) continue
    if (it.time <= hm) {
      // 已过点（含刚好）且未提醒过 → 弹系统通知
      it.reminded = true
      try {
        // 动态 import 避免测试环境无窗口时报错
        const { Notification } = require('electron') as typeof import('electron')
        if (Notification.isSupported()) {
          new Notification({
            title: `日程提醒：${it.text}`,
            body: it.time === hm ? `现在是 ${it.time}，该做这件事了` : `日程 ${it.time} 已到`,
            silent: false,
          }).show()
        }
      } catch {
        /* 通知失败不影响数据 */
      }
    }
  }
  // 有过期未提醒的才写盘，避免每分钟白写
  if (items.some((i) => i.reminded)) save()
}

export function setupScheduleStore(): void {
  load()
  // 每分钟检查一次提醒；对齐到整分（setInterval 从启动时刻起算，误差最多一个周期）
  timer = setInterval(remindDue, 60_000)

  ipcMain.handle('schedule:list', () => items)
  ipcMain.handle('schedule:add', (_e, text: string, time: string | null) => {
    const t = String(text ?? '').trim()
    if (!t) return items
    // time 规范化：接受 'HH:mm'，其它/null 一律存 null
    const norm = typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time.trim())
      ? time.trim().padStart(5, '0')
      : null
    items.push({
      id: randomUUID(),
      text: t,
      time: norm,
      done: false,
      reminded: false,
      createdAt: Date.now(),
    })
    save()
    return items
  })
  ipcMain.handle('schedule:toggle', (_e, id: string) => {
    const it = items.find((i) => i.id === id)
    if (it) it.done = !it.done
    save()
    return items
  })
  ipcMain.handle('schedule:remove', (_e, id: string) => {
    items = items.filter((i) => i.id !== id)
    save()
    return items
  })
}

export function stopScheduleStore(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
