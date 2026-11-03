import { app, clipboard, ipcMain, Notification } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 验证码监听：轮询剪贴板，识别"短信验证码"式文本。
 * 工作方式：手机短信同步到电脑（如手机连接/微信传文件）后用户复制短信，
 * 或电脑上直接复制含验证码的文本 → 岛收起态直接显示「验证码 xxxxxx 已复制」。
 *
 * 识别策略（保守，宁缺毋滥）：
 * - 6 位数字（可带空格/连字符分隔）→ 最典型
 * - 4~8 位数字，且文本含「验证码/verification code/code/OTP」提示词
 * - 排除：纯数字恰好是年份/时间/金额等常见误报场景尽量靠提示词兜底
 */

export interface CaptchaState {
  /** 当前展示的验证码；null 表示没有 */
  code: string | null
  /** 抓到的时间戳（毫秒），用于 60 秒后自动淡出 */
  at: number
}

interface StoreShape {
  /** 上次已读的剪贴板内容（轮询去重基准） */
  lastRaw: string
  /** 当前验证码状态 */
  current: CaptchaState
}

const CODE_TTL_MS = 60_000

let store: StoreShape = { lastRaw: '', current: { code: null, at: 0 } }
let file = ''
let pollTimer: NodeJS.Timeout | null = null

function load(): void {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    if (typeof parsed.lastRaw === 'string') store.lastRaw = parsed.lastRaw
    if (parsed.current && typeof parsed.current.code === 'string') {
      store.current = parsed.current as CaptchaState
    }
  } catch {
    /* 首次运行无文件 */
  }
}

function save(): void {
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
}

/** 从一段文本里提取验证码；没有则返回 null */
export function extractCode(text: string): string | null {
  if (!text) return null
  const t = text.trim()
  // 太长的不像短信验证码场景（一般整条短信 < 200 字）
  if (t.length > 200) return null

  // 形态 1：有提示词 → 抓 4~8 位数字（允许空格/连字符分隔）
  const hintRe = /(验证码|校验码|verification\s*code|\bcode\b|otp)/i
  if (hintRe.test(t)) {
    const m = t.match(/\b(\d[\d\s-]{2,10}\d)\b/)
    if (m) {
      const digits = m[1].replace(/[\s-]/g, '')
      if (digits.length >= 4 && digits.length <= 8) return digits
    }
  }

  // 形态 2：整条内容就是一个 6 位数字（用户只复制了码本身）
  if (/^\d{6}$/.test(t.replace(/[\s-]/g, '')) && t.replace(/\D/g, '').length === 6) {
    return t.replace(/\D/g, '')
  }

  return null
}

/** Electron 45 的 clipboard.readText 返回 Promise（W3C 风格异步 API），轮询改 async */
async function pollOnce(): Promise<void> {
  let raw: string
  try {
    raw = await clipboard.readText()
  } catch {
    return
  }
  if (raw === store.lastRaw) return
  store.lastRaw = raw
  const code = extractCode(raw)
  if (code) {
    store.current = { code, at: Date.now() }
    // 已复制（到剪贴板本来就是复制的终点）；弹一个系统通知兜底（岛在收起态不一定盯着看）
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: '灵动岛 · 验证码',
          body: `${code}（已复制，点击岛可直接看）`
        })
        n.show()
      }
    } catch {
      /* 通知失败不影响主流程 */
    }
  }
  save()
}

export function setupCaptchaStore(): void {
  file = join(app.getPath('userData'), 'captcha.json')
  mkdirSync(app.getPath('userData'), { recursive: true })
  load()

  // 初始基准：把启动时的剪贴板当已读，避免每次开机都弹旧验证码
  void clipboard.readText().then((t) => {
    store.lastRaw = t
  })

  ipcMain.handle('captcha:current', (): CaptchaState => {
    // 读时惰性清理过期码
    if (store.current.code && Date.now() - store.current.at > CODE_TTL_MS) {
      store.current = { code: null, at: 0 }
    }
    return store.current
  })

  // 用户点掉验证码（收起态上的 × 或点击复制后）
  ipcMain.handle('captcha:dismiss', (): CaptchaState => {
    store.current = { code: null, at: 0 }
    save()
    return store.current
  })

  // 供 e2e 用：注入一条"新剪贴板内容"，走同一条识别链路。
  // 注入负样本（识别不出）时主动清空当前码，方便断言"不误报"。
  ipcMain.handle('captcha:test-inject', (_e, text: unknown): CaptchaState => {
    const t = String(text ?? '')
    const code = extractCode(t)
    if (code) store.current = { code, at: Date.now() }
    else store.current = { code: null, at: 0 }
    save()
    return store.current
  })

  // 轮询剪贴板：1.5 秒一次足够跟手，开销可忽略（读文本而已）
  pollTimer = setInterval(() => {
    void pollOnce()
  }, 1500)
}

export function stopCaptchaPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
