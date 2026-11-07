import { BrowserWindow, ipcMain, screen } from 'electron'

/**
 * US-041 全屏自动避让。
 *
 * 三种状态：
 *  - normal    岛照常常驻（默认）
 *  - avoided   前台窗口全屏/最大化占满屏幕 → 岛 hide()，摸顶边临时唤回
 *  - manual    用户从菜单选了「暂时隐藏」→ 岛 hide()，摸边无效；托盘点击恢复
 *
 * 全屏判定：长驻 PowerShell 子进程每 1s 输出一行 fullscreen|normal（读
 * GetForegroundWindow 的 rect 是否覆盖整个主屏）。比主进程每秒 spawn 一次
 * 轻得多（一个常驻进程 vs 每秒一次进程创建）。无 npm 新依赖。
 *
 * 摸边唤回：隐藏期间在主屏顶部放一条 4px 高的隐形感应窗（不可聚焦、不进
 * 任务栏、鼠标穿透关不掉也无所谓——它只有 4px，盖在岛平时待的位置），
 * mouseenter 时临时显示岛；鼠标离开岛窗口区域（且仍全屏）再隐藏。
 *
 * 通知优先：横幅/验证码弹出时渲染层调 requestTempShow()，岛临时现身
 * （即使正在避让），横幅结束后渲染层调 requestTempShow(false) 回隐。
 */

/** 感应窗高度（px）：太薄摸不到、太厚挡内容，4px 是任务栏类产品的通行值 */
const EDGE_HEIGHT = 4
/** 全屏判定的去抖延迟：判定翻转后等这么久才动作，防全屏切换瞬间的闪烁 */
const DEBOUNCE_MS = 300
/** 检测脚本轮询周期（脚本侧） */
const WATCH_INTERVAL_MS = 1000
/** 现身期间光标轮询回隐的周期 */
const CURSOR_WATCH_INTERVAL_MS = 400
/** 感应窗实际高度：Windows 对顶层窗口有最小尺寸约束（SM_CXMINTRACK/SM_CYMINTRACK），
 * 请求 4px 会被强制放大到 ~40px（[实测] .tmp/mini-edge2.cjs：height:4 → getBounds 40）。
 * 解决：窗口整体上移、主体悬在屏幕外，屏内只露 EDGE_HEIGHT 像素——命中带仅 4px，
 * 不遮挡全屏应用顶部交互。
 * [实测] .tmp/mini-edge7.cjs：窗口 rect=0,-36,1536,4；WindowFromPoint y=2 命中感应窗、
 * y=20 穿透到下层窗口。 */
const EDGE_WIN_HEIGHT = 40

type AvoidState = 'normal' | 'avoided' | 'manual'

let state: AvoidState = 'normal'
/** 摸边临时现身中（avoided 状态下鼠标在感应区/岛上） */
let tempVisible = false
/** 横幅临时现身中（渲染层 requestTempShow） */
let bannerHold = false
/** 隐藏前的展开态（恢复时不还原，展开即收起，SPEC 明确不做展开记忆） */
let watcherChild: ReturnType<typeof import('node:child_process').spawn> | null = null
let debounceTimer: NodeJS.Timeout | null = null
let edgeWindow: BrowserWindow | null = null
let lastFullscreen = false
/** 摸边探测 interval 集合（退出时统一清） */
const probeTimers = new Set<NodeJS.Timeout>()

/** 检测脚本文本（内嵌，不落盘）。单行分号连接：多行 here-string 嵌套经 -Command 传参必炸（实测）。
 * C# 双引号在 PS 双引号字符串里用 `" 转义（实测 got=True 验证过）。
 * 单发版：去 while 循环，输出一次结果就退出。
 * 实测踩坑（US-041 排障）：不能用「长驻 PowerShell + 逐行读 stdout」模式——
 * electron 主进程 spawn 不退出的 pipe 子进程会让 DevTools HTTP 服务整体 hang
 * （端口 LISTENING 但 /json/list 0 字节无响应，node fetch / .NET / curl 全部超时，
 * 主进程与窗口却正常）。单发短命 PS 实测 ONESHOT-OK 无此问题。 */
function watchScript(): string {
  const TICK = '`"'
  return [
    'Add-Type "using System; using System.Runtime.InteropServices; public class FG { [DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetForegroundWindow(); [DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; } }"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$sw=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width',
    '$sh=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height',
    '$h=[FG]::GetForegroundWindow()',
    '$r=New-Object FG+RECT',
    '[void][FG]::GetWindowRect($h,[ref]$r)',
    'if($r.L -le 0 -and $r.T -le 0 -and $r.R -ge $sw -and $r.B -ge $sh){"fullscreen"}else{"normal"}'
  ].join('; ')
}

export function initFullscreenWatch(getMain: () => BrowserWindow | null, onStateChange: (hidden: boolean) => void): void {
  const { spawn } = require('node:child_process') as typeof import('node:child_process')

  /** 摸边/避让恢复共用的现身动作。
   * 实测踩坑（US-041）：hide 过的窗口 showInactive 单独调用不保证回到最高层——
   * show 会把 alwaysOnTop 级别重置回 floating，岛沉到全屏 TopMost 窗口下面
   * （Chrome occlusion 判定被完全遮挡 → 渲染层 visibilityState=hidden，用户也看不见）。
   * 必须 showInactive + moveTop + 重设 setAlwaysOnTop('screen-saver') 三连。 */
  const revealWindow = (): void => {
    const win = getMain()
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.showInactive()
    win.moveTop()
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  const apply = (hidden: boolean): void => {
    const win = getMain()
    if (!win || win.isDestroyed()) return
    if (hidden) {
      // 隐藏前如果展开着，先收起（不做展开记忆，SPEC 三.5）
      if (win.isVisible()) onStateChange(hidden)
      win.hide()
      ensureEdgeWindow()
    } else {
      if (!win.isVisible()) {
        revealWindow()
        onStateChange(hidden)
      }
      // 先现身再销毁感应窗：岛 showInactive 重绘会盖住感应条并触发其 mouseleave，
      // 若先 destroy 再现身，迟到的 leave 事件仍会进入 IPC 队列误触发回隐（实测竞态）。
      destroyEdgeWindow()
      tempVisible = false
      stopCursorWatch()
    }
  }

  /** 判定结果落地（带 300ms 去抖） */
  const commit = (fullscreen: boolean): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (fullscreen === lastFullscreen) return
      lastFullscreen = fullscreen
      if (state === 'manual') return // 手动隐藏不受全屏变化影响
      if (fullscreen && state === 'normal') {
        state = 'avoided'
        apply(true)
      } else if (!fullscreen && state === 'avoided' && !tempVisible && !bannerHold) {
        state = 'normal'
        apply(false)
      }
    }, DEBOUNCE_MS)
  }

  /** 单发轮询：每 WATCH_INTERVAL_MS spawn 一个短命 PS 查一次前台窗口，读完整输出退出。
   * 不用长驻进程（见 watchScript 注释的 DevTools hang 踩坑）。PS 冷启动 150~300ms 全程异步，不阻塞主进程。
   * 防重入：上一发未结束时跳过本轮。 */
  let probing = false
  const pollOnce = (): void => {
    if (probing) return
    probing = true
    let child: import('node:child_process').ChildProcess | null = null
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', watchScript()],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    } catch {
      probing = false
      return
    }
    watcherChild = child
    let buf = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      probing = false
      watcherChild = null
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line === 'fullscreen') commit(true)
        else if (line === 'normal') commit(false)
      }
    })
    // PS 冷启动 + Add-Type 可能到 3s；兜底 8s 强制结束本轮
    const guard = setTimeout(() => {
      try { child?.kill() } catch { /* noop */ }
      finish()
    }, 8000)
    child.on('exit', () => {
      clearTimeout(guard)
      finish()
    })
    child.on('error', () => {
      clearTimeout(guard)
      finish()
    })
  }
  const pollTimer = setInterval(pollOnce, WATCH_INTERVAL_MS)
  probeTimers.add(pollTimer)

  /** 现身期间的光标轮询回隐（A5 修复）。
   * 实测踩坑（US-041）：岛 showInactive 现身后 Chromium 不认为光标在窗口内（未注册
   * TrackMouseEvent），光标离开不派发 mouseleave → 渲染层 onMouseLeave 永不上报。
   * 且 Electron screen.getCursorScreenPoint() 与外部 SetCursorPos 结果不一致（probe 实测）。
   * 故现身期间由主进程用单发 PS GetCursorPos（OS 层真相）轮询：连续 2 次光标不在岛 bounds
   * （含余量）→ 回隐；光标回岛内重置计数。 */
  let cursorTimer: NodeJS.Timeout | null = null
  let cursorWatching = false
  let cursorOutsideStreak = 0
  const cursorScript = (): string =>
    'Add-Type "using System; using System.Runtime.InteropServices; public class CW { [DllImport(`"user32.dll`")] public static extern bool GetCursorPos(out POINT p); public struct POINT { public int X, Y; } }"; ' +
    '$p=New-Object CW+POINT; [void][CW]::GetCursorPos([ref]$p); "{0},{1}" -f $p.X,$p.Y'
  const stopCursorWatch = (): void => {
    if (cursorTimer) {
      clearInterval(cursorTimer)
      cursorTimer = null
    }
    cursorWatching = false
    cursorOutsideStreak = 0
  }
  const cursorPollOnce = (): void => {
    if (cursorWatching) return // 上一发未结束，跳过
    cursorWatching = true
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      cursorWatching = false
    }
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cursorScript()], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      finish()
      return
    }
    const guard = setTimeout(() => {
      try { child.kill() } catch { /* noop */ }
      finish()
    }, 3000)
    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim()
      const m = line.match(/^(-?\d+),(-?\d+)$/)
      if (!m) return
      const win = getMain()
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      const MARGIN = 8
      const inside = Number(m[1]) >= b.x - MARGIN && Number(m[1]) <= b.x + b.width + MARGIN && Number(m[2]) >= b.y - MARGIN && Number(m[2]) <= b.y + b.height + MARGIN
      if (inside) {
        cursorOutsideStreak = 0
        return
      }
      cursorOutsideStreak++
      if (cursorOutsideStreak < 2) return
      // 连续 2 次在岛外 → 真移开，回隐
      stopCursorWatch()
      if (state !== 'avoided' || bannerHold) return
      tempVisible = false
      if (lastFullscreen) apply(true)
    })
    child.on('exit', () => {
      clearTimeout(guard)
      finish()
    })
    child.on('error', () => {
      clearTimeout(guard)
      finish()
    })
  }
  const startCursorWatch = (): void => {
    stopCursorWatch()
    cursorWatching = false
    cursorTimer = setInterval(cursorPollOnce, CURSOR_WATCH_INTERVAL_MS)
    probeTimers.add(cursorTimer)
  }
  pollOnce()

  // 摸边唤回：感应窗 mouseenter 上报。岛现身会盖住感应条（岛就在顶部），
  // 所以现身即销毁感应窗，把「离开检测」移交给岛自身的 mouseleave（App.tsx）。
  ipcMain.on('island:edge-hover', (_e, entered: unknown) => {
    if (entered !== true) return
    if (state === 'manual') return
    if (state === 'avoided' && !tempVisible) {
      apply(false) // apply(false) 内部已 destroyEdgeWindow + revealWindow
      // apply(false) 会把 tempVisible 重置为 false（恢复/现身共用入口），
      // 摸边现身必须在 apply 之后再置 true，否则「临时现身中」标志被吞（实测 A5 踩坑）。
      tempVisible = true
      startCursorWatch()
    }
  })
  // 鼠标离开岛：渲染层 mouseleave 岛根元素时上报，仍全屏则回隐。
  // 实测竞态兜底：岛现身瞬间会遮挡感应窗触发其迟到 mouseleave（IPC 排队后到达），
  // 事件本身无法与「用户真的移开」区分 → 延迟 400ms 用光标实测确认：
  // 光标仍在岛 bounds（含顶部感应带）内则视为误报，忽略。
  ipcMain.on('island:edge-leave', () => {
    if (state !== 'avoided' || !tempVisible || bannerHold) return
    setTimeout(() => {
      if (state !== 'avoided' || !tempVisible || bannerHold) return
      const win = getMain()
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      const p = screen.getCursorScreenPoint()
      const inIsland = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y - EDGE_HEIGHT && p.y <= b.y + b.height
      if (inIsland) return // 误报（岛现身遮挡感应窗的迟到 leave）
      tempVisible = false
      if (lastFullscreen) apply(true)
    }, 400)
  })

  // 手动隐藏（右键/托盘菜单）
  ipcMain.on('island:manual-hide', () => {
    state = 'manual'
    apply(true)
  })
  // 托盘左键唤回（清手动标志）
  ipcMain.on('island:manual-restore', () => {
    if (state !== 'manual') return
    state = 'normal'
    apply(false)
  })

  // 横幅临时现身（渲染层横幅/验证码弹出时调用，结束回传 false）
  ipcMain.on('island:temp-show', (_e, on: unknown) => {
    bannerHold = on === true
    if (bannerHold && !getMain()?.isVisible()) apply(false)
    if (!bannerHold && state === 'avoided' && !tempVisible && lastFullscreen) apply(true)
    if (!bannerHold && state === 'manual' && getMain()?.isVisible()) apply(true)
  })
}

/** 顶部 4px 隐形感应窗（仅 avoided 状态存在）。
 * 实测踩坑（US-041 排障）：不能用「轮询 screen.getCursorScreenPoint()」做摸边探测——
 * 本机实测该 API 与外部进程的 SetCursorPos 结果严重不一致（e2e 光标已 settled 到 (768,0)，
 * 主进程 probe 恒读到旧位置），无法可靠命中。改为感应窗自身的 mouseenter/mouseleave 事件
 * （Chromium 按物理光标触发，无坐标换算歧义）。感应窗用 nodeIntegration 直连 ipcRenderer
 * （4px 透明空窗、无远程内容，风险可控）。 */
function ensureEdgeWindow(): void {
  if (edgeWindow && !edgeWindow.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  edgeWindow = new BrowserWindow({
    x: workArea.x,
    // 屏外衬底：窗口 40px 高（系统最小尺寸约束，见 EDGE_WIN_HEIGHT 注释），
    // 上移 36px 使屏内只露底部 4px 命中带。
    y: workArea.y - (EDGE_WIN_HEIGHT - EDGE_HEIGHT),
    width: workArea.width,
    height: EDGE_WIN_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false }
  })
  edgeWindow.setAlwaysOnTop(true, 'screen-saver')
  edgeWindow.loadURL(
    'data:text/html,<body style="margin:0;background:transparent"></body>' +
      '<div style="position:fixed;bottom:0;left:0;width:100%;height:4px;background:rgba(0,0,0,0.05)"></div>' +
      '<script>const { ipcRenderer } = require("electron");' +
      'document.addEventListener("mouseenter", () => { ipcRenderer.send("island:edge-hover", true) });' +
      'document.addEventListener("mouseleave", () => { ipcRenderer.send("island:edge-leave") });' +
      '</script>'
  )
  edgeWindow.once('ready-to-show', () => edgeWindow?.showInactive())
  // 感应窗上关闭时清引用
  edgeWindow.on('closed', () => {
    edgeWindow = null
  })
}

function destroyEdgeWindow(): void {
  if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.destroy()
  edgeWindow = null
}

/** 退出时停掉检测子进程与感应窗 */
export function stopFullscreenWatch(): void {
  watcherChild?.kill()
  watcherChild = null
  destroyEdgeWindow()
  for (const t of probeTimers) clearInterval(t)
  probeTimers.clear()
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  state = 'normal'
  tempVisible = false
  bannerHold = false
}



