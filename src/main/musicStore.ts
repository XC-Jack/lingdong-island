import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SMTC_SCRIPT } from './smtcScript'
import type { MusicCommand, MusicState } from '../shared/types'

/**
 * 音乐页数据源（SPEC-music-page / US-031）。
 *
 * 为什么不接第三方播放器 API：Windows 自带 SMTC（System Media Transport Controls，
 * 系统媒体传输控制——任何播放器只要实现了它，系统「正在播放」里就能看到，
 * 媒体键也就能控制）。读这一层不绑死任何一家播放器，也不会被某家改接口打断。
 *
 * 为什么是一个常驻 PowerShell 子进程而不是每秒起一个：
 * 实测单次 `powershell.exe` 启动约 755ms，每秒起进程既卡又费内存；
 * 常驻后单次往返约 19ms。代价是常驻进程约占 50MB 内存，所以**懒启动**：
 * 只有渲染层第一次要数据（也就是用户翻到音乐页）时才把子进程拉起来。
 *
 * 为什么脚本要落盘成 .ps1 而不是 `-EncodedCommand`：
 * PS 5.1 用 -EncodedCommand 时，脚本里的反引号与 CLIXML 进度流会让
 * `[System.WindowsRuntimeSystemExtensions]` 的反射查找失败。落盘还有一个好处：
 * 出问题时可以直接拿这个文件手跑一遍定位。
 */

const POLL_MS = 1000
/** 子进程无响应超时：超过这个时间没有任何回包就重拉，避免界面卡死在旧数据上 */
const STALE_MS = 5000

const EMPTY_STATE: MusicState = {
  active: false,
  title: '',
  artist: '',
  album: '',
  position: 0,
  duration: 0,
  playing: false,
  app: '',
  shuffle: false,
  repeat: 0,
  volume: 0,
  canSeek: false,
  canShuffle: false,
  canRepeat: false,
  canVolume: false
}

let child: ChildProcessWithoutNullStreams | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 当前状态缓存：IPC 的 music:get 直接返回它，不等子进程 */
let cache: MusicState = { ...EMPTY_STATE }
/** 最近一次收到任何回包的时间（毫秒），用于判断子进程是不是挂了 */
let lastAliveAt = 0
/** 子进程正在启动（避免重复 spawn） */
let starting = false
/** 应用正在退出时不要再重拉子进程 */
let stopping = false

/**
 * 把脚本写到 userData 下的固定文件名，UTF-8 **带 BOM**。
 * BOM 不是可选项：不带 BOM 时 PS 5.1 按系统 ANSI 解码脚本里的中文注释，
 * 类型名会被解坏，报「找不到类型 [System.Runtime.WindowsRuntimeSystemExtensions]」。
 */
function writeBridgeScript(): string {
  const dir = join(app.getPath('userData'), 'music')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'smtc-bridge.ps1')
  // writeFileSync 的 'utf8' 不写 BOM，所以这里手动拼一个 UTF-8 BOM 头（EF BB BF）
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  writeFileSync(file, Buffer.concat([bom, Buffer.from(SMTC_SCRIPT, 'utf8')]))
  return file
}

/** 把一份状态推给所有还活着的窗口（与 prefsStore / statusStore 同模式） */
function broadcast(s: MusicState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // 已销毁的窗口（设置窗口关掉、全屏避让的 4px 边缘窗）必须先判，否则 send 抛异常
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('music:state', s)
  }
}

function sameState(a: MusicState, b: MusicState): boolean {
  return (
    a.active === b.active &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.playing === b.playing &&
    a.app === b.app &&
    a.shuffle === b.shuffle &&
    a.repeat === b.repeat &&
    a.volume === b.volume &&
    a.canSeek === b.canSeek &&
    a.canShuffle === b.canShuffle &&
    a.canRepeat === b.canRepeat &&
    a.canVolume === b.canVolume &&
    // 进度按整秒比：SMTC 给的是带小数的秒，每毫秒都在变，逐位比会每秒重渲染
    Math.round(a.position) === Math.round(b.position) &&
    Math.round(a.duration) === Math.round(b.duration)
  )
}

/** 收一行子进程输出：state 更新缓存并（真变了才）广播；ack / ready 只记时间 */
function handleLine(text: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(text) as Record<string, unknown>
  } catch {
    return // 非 JSON 行（PS 的杂项输出）直接忽略
  }
  lastAliveAt = Date.now()
  if (msg.type === 'error') {
    // 桥接脚本里的异常（读媒体属性失败等）：打到控制台留证，界面这一轮不发空态以外的变化
    console.warn('[music] 桥接报错：', String(msg.msg ?? '').slice(0, 300))
    return
  }
  if (msg.type !== 'state') return
  const next: MusicState = {
    active: Boolean(msg.active),
    title: String(msg.title ?? ''),
    artist: String(msg.artist ?? ''),
    album: String(msg.album ?? ''),
    position: Number(msg.position ?? 0) || 0,
    duration: Number(msg.duration ?? 0) || 0,
    playing: Boolean(msg.playing),
    app: String(msg.app ?? ''),
    shuffle: Boolean(msg.shuffle),
    repeat: Math.min(2, Math.max(0, Number(msg.repeat ?? 0) || 0)),
    volume: Math.min(1, Math.max(0, Number(msg.volume ?? 0) || 0)),
    canSeek: Boolean(msg.canSeek),
    canShuffle: Boolean(msg.canShuffle),
    canRepeat: Boolean(msg.canRepeat),
    canVolume: Boolean(msg.canVolume)
  }
  if (sameState(cache, next)) return
  cache = next
  broadcast(cache)
}

/**
 * 写一行命令到桥接子进程。
 * 纯文本命令（poll / toggle / next / prev / resync）沿用原行协议；
 * 带参数的新命令序列化成一行 JSON（见 SPEC-music-controls「混合行协议」）。
 */
function send(cmd: string | MusicCommand): void {
  if (!child || !child.stdin.writable) return
  try {
    const line = typeof cmd === 'string' ? cmd : JSON.stringify(cmd)
    child.stdin.write(line + '\n')
  } catch {
    /* 管道已断：交给看门狗重拉 */
  }
}

/** IPC 边界的运行时校验：渲染层传来的东西不能原样拼进子进程 stdin */
function isValidCommand(cmd: unknown): cmd is MusicCommand {
  if (cmd === 'toggle' || cmd === 'next' || cmd === 'prev') return true
  if (!cmd || typeof cmd !== 'object') return false
  const c = cmd as Record<string, unknown>
  switch (c.cmd) {
    case 'seek':
      return typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0
    case 'shuffle':
      return typeof c.value === 'boolean'
    case 'repeat':
      return c.value === 0 || c.value === 1 || c.value === 2
    case 'volume':
      return typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0 && c.value <= 1
    default:
      return false
  }
}

/** 杀掉子进程并清掉轮询（重启时也走这里） */
function killBridge(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const c = child
  child = null
  if (!c) return
  try {
    c.stdin.end()
  } catch {
    /* ignore */
  }
  try {
    c.kill()
  } catch {
    /* ignore */
  }
}

/** 启动常驻桥接子进程（幂等；已在运行则直接返回） */
function startBridge(): void {
  if (child || starting || stopping) return
  starting = true
  let ps1: string
  try {
    ps1 = writeBridgeScript()
  } catch (err) {
    starting = false
    console.error('[music] 写桥接脚本失败：', err)
    return
  }

  let c: ChildProcessWithoutNullStreams
  try {
    c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      windowsHide: true
    })
  } catch (err) {
    starting = false
    console.error('[music] 启动 PowerShell 失败：', err)
    return
  }

  child = c
  starting = false
  lastAliveAt = Date.now()

  let buf = ''
  c.stdout.setEncoding('utf8')
  c.stdout.on('data', (chunk: string) => {
    buf += chunk
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) handleLine(line)
      idx = buf.indexOf('\n')
    }
  })
  // stderr 不往界面甩（用户看不懂 CLIXML），只在诊断日志里留一行
  c.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8').trim()
    if (s) console.warn('[music] ps stderr:', s.slice(0, 400))
  })
  c.on('exit', () => {
    if (child === c) {
      child = null
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      // 非退出流程下的意外死亡：5 秒后再拉一次（播放器刚启动/系统媒体服务重启都可能触发）
      if (!stopping) setTimeout(() => startBridge(), 5000).unref?.()
    }
  })
  c.on('error', () => {
    if (child === c) {
      child = null
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  })

  pollTimer = setInterval(() => {
    // 子进程挂了或长时间没回包：重拉，别让界面停在旧歌上无限显示
    if (!child) return
    if (Date.now() - lastAliveAt > STALE_MS) {
      console.warn('[music] 桥接进程无响应，重启')
      killBridge()
      setTimeout(() => startBridge(), 1000).unref?.()
      return
    }
    send('poll')
  }, POLL_MS)

  send('poll')
}

export function setupMusicStore(): void {
  ipcMain.handle('music:get', (): MusicState => {
    // 首次调用（用户翻到音乐页）时懒启动子进程，避免没人用音乐页也常驻 50MB
    startBridge()
    return cache
  })

  ipcMain.handle('music:control', (_e, cmd: unknown): boolean => {
    if (!isValidCommand(cmd)) return false
    startBridge()
    send(cmd)
    return true
  })
}

/** 退出时收摊（与 stopStatus / stopNotifyStore 同型） */
export function stopMusicStore(): void {
  stopping = true
  killBridge()
  cache = { ...EMPTY_STATE }
}
