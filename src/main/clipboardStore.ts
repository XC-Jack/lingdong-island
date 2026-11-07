/** US-039 验证码提示：主进程轮询剪贴板，识别验证码后推给渲染层弹横幅。
 *
 * 设计要点（详见 docs/Spec/SPEC-us-039-code-hint.md）：
 * - Electron 主进程剪贴板没有变更事件（Chrome 的 clipboardchange 是 web 平台特性），
 *   用 1s 轮询 clipboard.readText()（Electron 45 主进程 Promise API）。
 * - 识别防误报优先：整段短文本匹配码模式直接弹；长文本只在含验证码关键词时提取行内数字。
 * - 同码 30s 去重；展开态不弹（渲染层自行判断）；内容只在内存，不落盘。
 */
import { clipboard, ipcMain, BrowserWindow } from 'electron'

const POLL_MS = 1000
const REPEAT_SUPPRESS_MS = 30_000

/** 判断文本是否像验证码；返回码字符串或 null */
export function extractCode(text: string): string | null {
  const t = text.trim()
  if (!t) return null

  // 短文本：整段就是码，或「验证码 5544」这类带关键词前缀的
  if (t.length <= 16) {
    // 纯数字 4-8 位
    if (/^\d{4,8}$/.test(t) && !/^(\d)\1+$/.test(t)) return t
    // 字母数字混合 6-8 位（必须同时含字母和数字，排除纯数字已在上面）
    if (/^[a-zA-Z0-9]{6,8}$/.test(t) && /[a-zA-Z]/.test(t) && /\d/.test(t) && !/(.)\1{3,}/.test(t)) return t
    // 短文本含验证码关键词：提取行内首个 4-8 位数字
    if (/验证码|verification code|OTP|code is|验证代码/i.test(t)) {
      const m = t.match(/(?<![\dA-Za-z])(\d{4,8})(?![\dA-Za-z])/)
      if (m && !/^(\d)\1+$/.test(m[1])) return m[1]
    }
    return null
  }

  // 长文本：只认验证码关键词行内的 4-8 位数字
  const keyline = t.split(/\n|。|；|;|,|，/)
    .find((line) => /验证码|verification code|OTP|code is|验证代码/i.test(line))
  if (!keyline) return null
  const m = keyline.match(/(?<![\dA-Za-z])(\d{4,8})(?![\dA-Za-z])/)
  if (m && !/^(\d)\1+$/.test(m[1])) return m[1]
  return null
}

let lastText = ''
let lastCode: string | null = null
let lastShownAt = 0
let timer: ReturnType<typeof setInterval> | null = null

export function initClipboardWatch(): void {
  if (timer) return
  void clipboard.readText().then((t) => { lastText = t }) // 初值对齐，避免启动时把旧剪贴板当新变化
  timer = setInterval(() => { void pollOnce() }, POLL_MS)
  // 渲染层点击验证码横幅 → 写入剪贴板（渲染层已弃用 clipboard，统一走主进程）
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string' || text === '' || text.length > 64) return false
    lastText = text // 写入来自我们自己，防止下一轮轮询把这次写入当新变化再弹一次
    void clipboard.writeText(text)
    return true
  })
}

async function pollOnce(): Promise<void> {
  let text: string
  try {
    text = await clipboard.readText()
  } catch {
    return // 读失败（个别格式/权限）保持静默
  }
  if (text === lastText) return
  lastText = text
  const code = extractCode(text)
  if (!code) return
  const now = Date.now()
  if (code === lastCode && now - lastShownAt < REPEAT_SUPPRESS_MS) return
  lastCode = code
  lastShownAt = now
  BrowserWindow.getAllWindows()[0]?.webContents.send('island:code-arrived', code)
}
