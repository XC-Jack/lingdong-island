import { app, ipcMain } from 'electron'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 日程（M8 → US-014 跨天）。
 *
 * - 每条：{ id, text, day: 'YYYY-MM-DD', time: 'HH:mm' | null, done, reminded, createdAt }
 * - day 是日程归属的日期；旧数据（没有 day 字段）在首次启动时迁移到「迁移当天」
 * - time 为空 = 当天无具体时间；有时到点前触发提醒（Electron Notification）
 * - 持久化到 userData\schedule.json，与待办/置物架同模式
 * - 提醒只在日程自己那一天触发，reminded 标记持久化防重复弹
 */

export interface ScheduleItem {
  id: string
  text: string
  day: string // 'YYYY-MM-DD'
  time: string | null // 'HH:mm' 24 小时制，null = 无具体时间
  done: boolean
  reminded: boolean
  createdAt: number
}

let items: ScheduleItem[] = []
let timer: ReturnType<typeof setInterval> | null = null

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function filePath(): string {
  return join(app.getPath('userData'), 'schedule.json')
}

/** 本地时间的 'YYYY-MM-DD'（不能用 toISOString，那是 UTC，会差一天） */
function dayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function load(): void {
  let raw: { items?: unknown }
  try {
    raw = JSON.parse(readFileSync(filePath(), 'utf8'))
  } catch {
    items = []
    return
  }
  const list = Array.isArray(raw.items) ? (raw.items as Partial<ScheduleItem>[]) : []
  const today = dayKey()
  let migrated = 0
  items = list.map((it) => {
    const okDay = typeof it.day === 'string' && DAY_RE.test(it.day)
    if (!okDay) migrated += 1
    return {
      id: String(it.id ?? randomUUID()),
      text: String(it.text ?? ''),
      day: okDay ? (it.day as string) : today,
      time: typeof it.time === 'string' ? it.time : null,
      done: Boolean(it.done),
      reminded: Boolean(it.reminded),
      createdAt: typeof it.createdAt === 'number' ? it.createdAt : Date.now(),
    }
  })
  if (migrated > 0) {
    // 迁移前先把原文件整份留底，出问题可以人工找回
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-')
    try {
      copyFileSync(filePath(), `${filePath()}.bak-${stamp}`)
    } catch {
      /* 备份失败不阻断迁移：内存里的数据仍可用，下一次写盘会落新格式 */
    }
    save()
    console.log(`[schedule] 已迁移 ${migrated} 条旧日程到日期字段，备份 schedule.json.bak-${stamp}`)
  }
}

function save(): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(filePath(), JSON.stringify({ items }, null, 2), 'utf8')
}

/** 当前时刻的 'HH:mm' */
function nowHm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 只提醒「今天」的、还没提醒过的、时间已到的条目 */
function remindDue(): void {
  const hm = nowHm()
  const today = dayKey()
  let changed = false
  for (const it of items) {
    if (!it.time || it.reminded) continue
    if (it.day !== today) continue
    if (it.time <= hm) {
      it.reminded = true
      changed = true
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
  if (changed) save()
}

export function setupScheduleStore(): void {
  load()
  // 每分钟检查一次提醒；对齐到整分（setInterval 从启动时刻起算，误差最多一个周期）
  timer = setInterval(remindDue, 60_000)

  ipcMain.handle('schedule:list', () => items)
  ipcMain.handle('schedule:add', (_e, text: string, time: string | null, day?: string | null) => {
    const t = String(text ?? '').trim()
    if (!t) return items
    // time 规范化：接受 'HH:mm'，其它/null 一律存 null
    const norm = typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time.trim())
      ? time.trim().padStart(5, '0')
      : null
    // day 规范化：接受 'YYYY-MM-DD'，其它/缺省一律落到今天
    const d = typeof day === 'string' && DAY_RE.test(day.trim()) ? day.trim() : dayKey()
    items.push({
      id: randomUUID(),
      text: t,
      day: d,
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
