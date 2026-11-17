import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AvoidMode } from '../shared/types'

/**
 * US-041 全屏自动避让。
 *
 * 三种状态：
 *  - normal    岛照常常驻（默认）
 *  - avoided   前台窗口按当前策略该避让 → 岛 hide()，摸顶边临时唤回
 *  - manual    用户从菜单选了「暂时隐藏」→ 岛 hide()，摸边无效；托盘点击恢复
 *
 * 三档策略（SPEC-avoid-mode-and-latency，2026-11-17 用户要求，存 prefs.json 的 `avoidMode`）：
 *  - maximized（默认）  前台窗口盖住工作区就避让 ⇒ 最大化与真全屏都避让
 *  - fullscreen        只有真全屏避让，最大化窗口保留岛
 *  - off               一律不避让
 * 判断顺序：先看「盖住工作区」，再看「盖住整屏且不是 Windows 最大化（IsZoomed）」。
 * 这样任务栏显示/自动隐藏两种情况下都能区分「最大化」和「真全屏」（[实测] 本机任务栏
 * 显示时 bounds 比 workarea 高 48px；自动隐藏时两者相等，只能靠 IsZoomed 区分）。
 *
 * 判定精度（判据不是「矩形覆盖整屏」就够了——那会把两类**不是全屏应用**的窗口也算进来，
 * 2026-11-08 用户报「没全屏岛却自己消失了」，[实测] 复现）：
 *   1. DWM 已 cloak（不可见）的 Shell 窗口，典型是 TextInputHost 的
 *      `Windows.UI.Core.CoreWindow`（标题「Windows 输入体验」，rect=0,0,1536,960，
 *      但 cloaked=2，用户在屏幕上根本看不到它）；
 *   2. 桌面本身 `Progman` / `WorkerW`（点桌面时它们会成为前台）。
 * 故判据 = 前台窗口 可见 ∧ 未被 DWM cloak ∧ 类名不属于已知壳层 ∧ 不属于本进程 ∧
 * 矩形覆盖整个**工作区**（四边 8px 容差，吃最大化时外扩的不可见边框）。
 * 基准用工作区而不是整屏：2026-11-17 用户报「最大化窗口时岛不缩」，真因是旧判据要求
 * 盖住整屏（Bounds 1536×960），而最大化窗口只铺到工作区（1536×912，任务栏 48px），
 * `r.B>=960` 永不成立；旧代码能用只是因为当时本机任务栏恰好「自动隐藏」。
 *
 * 判定怎么跑（SPEC-avoid-mode-and-latency）：**常驻短小 PowerShell 辅助进程 + 心跳文件**。
 *  辅助进程每 120ms 判一次，把「F/Z/N|毫秒时间戳」写进 `<userData>/avoid-mode-beat.txt`
 *  （状态变了立刻写，否则每约 1 秒写一次心跳）；主进程每 150ms 读一次这个文件（不做管道）。
 *  延迟从「约 1.5 秒」降到 0.3~0.6 秒，同时把常态 CPU 从「约 40% 一个核」降到接近 0。
 *  ⚠ 为什么之前是「每次 spawn 一个短命 PowerShell」：旧事故是**用管道 stdio 读一个不退出的
 *  子进程**，pipe 缓冲写满把主进程/DevTools HTTP 服务拖死（SPEC-perf-poll-throttle 记录）。
 *  这里改成 stdio 全 ignore、零管道、只走一个文件，并且带心跳超时回退：辅助进程 3 秒没有
 *  心跳就自动切回「单发短命 PowerShell」的旧路径（1 秒一次），绝不因为辅助进程挂了而失效。
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
/** 判定的去抖延迟：判定翻转后等这么久才动作，防全屏切换瞬间的闪烁。
 * SPEC-avoid-mode-and-latency：300→150ms（用户要求 0.75 秒内隐藏，去抖不能吃掉太多预算） */
const DEBOUNCE_MS = 150
/** 辅助进程内部判定间隔（ms）：决定隐藏延迟的下限 */
const HELPER_TICK_MS = 120
/** 主进程读心跳文件的间隔（ms）：纯本地小文件读，成本可忽略 */
const BEAT_READ_MS = 150
/** 心跳超过这个时间没更新（且连续多轮都是这样）→ 认为辅助进程死了，回退单发轮询。
 * 阈值不能太小：e2e/系统负载高时 PowerShell 循环会被饿住 1~2 秒，误判会导致来回重启。 */
const HEARTBEAT_STALE_MS = 5000
/** 回退路径：单发短命 PowerShell 的轮询周期（旧行为） */
const FALLBACK_POLL_MS = 1000
/** 回退期间多久尝试重启一次辅助进程 */
const HELPER_RETRY_MS = 15000
/** 感应窗实际高度：Windows 对顶层窗口有最小尺寸约束（SM_CXMINTRACK/SM_CYMINTRACK），
 * 请求 4px 会被强制放大到 ~40px（[实测] .tmp/mini-edge2.cjs：height:4 → getBounds 40）。
 * 解决：窗口整体上移、主体悬在屏幕外，屏内只露 EDGE_HEIGHT 像素——命中带仅 4px，
 * 不遮挡全屏应用顶部交互。 */
const EDGE_WIN_HEIGHT = 40
/** 心跳文件名（放在 userData 下，可随时删除，不是用户数据） */
const BEAT_FILE = 'avoid-mode-beat.txt'

/** 判定码：F=真全屏 / Z=最大化（盖住工作区） / N=都不算 */
type JudgeCode = 'F' | 'Z' | 'N'

type AvoidState = 'normal' | 'avoided' | 'manual'

let state: AvoidState = 'normal'
/** 摸边临时现身中（avoided 状态下鼠标在感应区/岛上） */
let tempVisible = false
/** 横幅临时现身中（渲染层 requestTempShow） */
let bannerHold = false
/** bannerHold 置 true 的时刻（看门狗用：横幅最长 8 秒，超时说明结束事件丢了） */
let bannerHoldAt = 0
let edgeWindow: BrowserWindow | null = null
/** 当前「按策略应该避让」的期望值；-1 表示还没算过 */
let wantHidden: boolean | null = null
/** 最近一次判定码 */
let judge: JudgeCode = 'N'
/** 期望值去抖用的定时器 */
let debounceTimer: NodeJS.Timeout | null = null
/** 摸边探测 interval 集合（退出时统一清） */
const probeTimers = new Set<NodeJS.Timeout>()

/** 辅助进程与心跳 */
let helper: ReturnType<typeof spawn> | null = null
let helperStartedAt = 0
let beatTimer: NodeJS.Timeout | null = null
let beatFile = ''
let lastBeatTs = 0
/** 连续读到心跳不新鲜的次数（回退判据，防误判） */
let staleReads = 0
/** 最近一次从辅助进程/回退轮询拿到的光标坐标（OS 层真相，摸边回隐用它） */
let lastCursor: { x: number; y: number; at: number } = { x: 0, y: 0, at: 0 }
/** 回退路径（辅助进程不可用时的单发轮询） */
let fallbackTimer: NodeJS.Timeout | null = null
let fallbackChild: ReturnType<typeof spawn> | null = null
let fallbackProbing = false
let helperRetryTimer: NodeJS.Timeout | null = null
let stopped = false
/** 策略读取（由 index.ts 注入；每 150ms 读一次内存变量，prefs 变更由主进程刷新） */
let getMode: () => AvoidMode = () => 'maximized'

/**
 * 判定用的 C# 探针（内嵌，不落盘）。
 * 单行分号连接：多行 here-string 嵌套经 -Command 传参必炸（[实测]）：
 * C# 双引号在 PS 双引号字符串里用 `" 转义（[实测] got=True 验证过）。
 */
function probeCs(): string {
  const TICK = '`"'
  // 本进程 pid 内插成数字常量：别把灵动岛自己的窗口当成全屏应用
  const ownPid = String(process.pid)
  return [
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class FS {',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetForegroundWindow();',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool IsWindowVisible(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool IsZoomed(IntPtr h);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport(' + TICK + 'dwmapi.dll' + TICK + ')] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern int GetSystemMetrics(int i);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool SystemParametersInfo(uint a, uint p, out RECT r, uint w);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern bool GetCursorPos(out POINT p);',
    'public struct RECT { public int L, T, R, B; }',
    'public struct POINT { public int X, Y; }',
    'public const int TOL = 8;',
    // DWMWA_CLOAKED = 14：返回 0 表示窗口没被 DWM 隐藏
    'public static int Cloak(IntPtr h) { int v; int r = DwmGetWindowAttribute(h, 14, out v, 4); return r == 0 ? v : -1; }',
    'public static string Cls(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }',
    // 已知的壳层/系统 UI 窗口类名：它们可能铺满整屏，但不是「用户在全屏使用某个应用」
    'public static bool ShellClass(string c) {',
    '  if (c == ' + TICK + 'Progman' + TICK + ') return true;', // 桌面
    '  if (c == ' + TICK + 'WorkerW' + TICK + ') return true;', // 桌面的另一层宿主
    '  if (c == ' + TICK + 'Shell_TrayWnd' + TICK + ') return true;', // 任务栏
    '  if (c == ' + TICK + 'Shell_SecondaryTrayWnd' + TICK + ') return true;', // 副屏任务栏
    '  if (c == ' + TICK + 'Windows.UI.Core.CoreWindow' + TICK + ') return true;', // 输入体验等 XAML 壳层（常被 cloak）
    '  if (c == ' + TICK + 'XamlExplorerHostIslandWindow' + TICK + ') return true;',
    '  if (c == ' + TICK + 'ForegroundStaging' + TICK + ') return true;', // 前台切换的过渡窗
    '  if (c == ' + TICK + 'TaskSwitcherWnd' + TICK + ') return true;', // Alt+Tab
    '  if (c == ' + TICK + 'MultitaskingViewFrame' + TICK + ') return true;', // 任务视图
    '  return false;',
    '}',
    'public static bool Covers(IntPtr h, int wl, int wt, int wr, int wb) {',
    '  RECT r; if (!GetWindowRect(h, out r)) return false;',
    '  return r.L <= wl + TOL && r.T <= wt + TOL && r.R >= wr - TOL && r.B >= wb - TOL;',
    '}',
    // 返回单字符判定码：F=真全屏 / Z=最大化（盖住工作区但不算真全屏） / N=都不算
    // ⚠ 不要用 System.Windows.Forms 的 Screen 拿工作区尺寸：那要 Add-Type -AssemblyName
    // System.Windows.Forms，会在常驻辅助进程里初始化整个 WinForms（含隐藏的 parking window），
    // 用户实测在独占全屏游戏期间弹过「powershell.exe - 系统错误 / 0xc0000005」。
    // 改用 user32 的 GetSystemMetrics + SystemParametersInfo(SPI_GETWORKAREA)：
    // 跟 GetWindowRect 处在同一个 DPI 上下文里（都是本进程的 DPI 虚拟化坐标），
    // 既不会与 DPI 缩放打架，也彻底不碰 WinForms。
    'public static string ProbeAll() {',
    '  RECT w; SystemParametersInfo(0x0030, 0, out w, 0);', // SPI_GETWORKAREA
    '  int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);', // SM_CXSCREEN / SM_CYSCREEN
    '  string code = Probe(w.L, w.T, w.R, w.B, 0, 0, sw, sh);',
    '  POINT p; GetCursorPos(out p);',
    '  return code + ' + TICK + '|' + TICK + ' + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ' + TICK + '|' + TICK + ' + p.X + ' + TICK + ',' + TICK + ' + p.Y;',
    '}',
    'public static string Probe(int wl, int wt, int wr, int wb, int bl, int bt, int br, int bb) {',
    '  IntPtr h = GetForegroundWindow();',
    '  if (h == IntPtr.Zero) return ' + TICK + 'N' + TICK + ';', // 没有前台窗口（桌面上什么都没选）
    '  if (!IsWindowVisible(h)) return ' + TICK + 'N' + TICK + ';',
    '  if (Cloak(h) != 0) return ' + TICK + 'N' + TICK + ';', // DWM 已隐藏：用户根本看不到它
    '  if (ShellClass(Cls(h))) return ' + TICK + 'N' + TICK + ';',
    '  uint p; GetWindowThreadProcessId(h, out p);',
    '  if (p == ' + ownPid + ') return ' + TICK + 'N' + TICK + ';', // 别把自己的窗口当全屏
    '  if (!Covers(h, wl, wt, wr, wb)) return ' + TICK + 'N' + TICK + ';',
    // 盖住整屏且不是 Windows 意义上的最大化 ⇒ 真全屏（F11 / 独占全屏 / 无边框铺屏）
    '  if (Covers(h, bl, bt, br, bb) && !IsZoomed(h)) return ' + TICK + 'F' + TICK + ';',
    '  return ' + TICK + 'Z' + TICK + ';',
    '}',
    '}'
  ].join(' ')
}

/** 常驻辅助进程的脚本：编译一次 C#，然后 120ms 一轮把「判定码|毫秒时间戳|光标坐标」
 * 覆盖写进心跳文件（同一份数据同时服务判定与摸边回隐，省掉每 400ms 再 spawn 一个 PS）。
 * 用 -EncodedCommand 传（多行脚本压平成 -Command 会被转义炸，[实测]）。
 * 输出走文件、stdio 全 ignore：绝不使用管道（管道 + 不退出的子进程会拖死 DevTools HTTP）。
 *
 * ⚠ 脚本里刻意**不加载 System.Windows.Forms**：只为了拿「工作区尺寸」就初始化整个 WinForms，
 * 会在常驻进程里留一个隐藏的 parking window；用户实测在独占全屏游戏（三角洲）期间弹过
 * 「powershell.exe - 系统错误 / Exception Processing Message 0xc0000005」。改用 user32 的
 * GetSystemMetrics + SystemParametersInfo(SPI_GETWORKAREA)，零组件依赖。 */
function helperScript(): string {
  const beat = beatFile.replace(/'/g, "''")
  // 父进程（本应用主进程）pid：辅助进程是长驻循环，必须自己盯着父进程是否还活着——
  // 应用被强杀（任务管理器/taskkill 不带 -T）时子进程不会跟着死，会永久留一个
  // 80MB 的 powershell.exe 在后台（[实测] 2026-11-17 验过会残留）。
  const parentPid = String(process.pid)
  return [
    'Add-Type "' + probeCs() + '"',
    '$beat = ' + "'" + beat + "'",
    '$n = 0',
    'while ($true) {',
    // 每约 1 秒（8 轮 × 120ms）确认一次父进程还在
    '  if (($n % 8) -eq 0) { try { [void][System.Diagnostics.Process]::GetProcessById(' + parentPid + ') } catch { break } }',
    '  $n++',
    '  try { [System.IO.File]::WriteAllText($beat, [FS]::ProbeAll()) } catch { }',
    '  Start-Sleep -Milliseconds ' + HELPER_TICK_MS,
    '}'
  ].join('; ')
}

/** 回退路径用的单发脚本：判一次就退出，stdout 输出同样的「码|时间戳|光标」。 */
function oneShotScript(): string {
  return ['Add-Type "' + probeCs() + '"', '[FS]::ProbeAll()'].join('; ')
}

export function initFullscreenWatch(
  getMain: () => BrowserWindow | null,
  onStateChange: (hidden: boolean) => void,
  readMode?: () => AvoidMode
): void {
  stopped = false
  state = 'normal'
  wantHidden = null
  judge = 'N'
  tempVisible = false
  bannerHold = false
  lastBeatTs = 0
  staleReads = 0
  fallbackProbing = false
  if (readMode) getMode = readMode
  beatFile = join(app.getPath('userData'), BEAT_FILE)

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
      // 若先 destroy 再现身，迟到的 leave 事件仍会进入 IPC 队列误触发回隐（[实测] 竞态）。
      destroyEdgeWindow()
      tempVisible = false
      stopCursorWatch()
    }
  }

  /** 按当前策略决定「该不该避让」。 */
  const decision = (code: JudgeCode): boolean => {
    const mode = getMode()
    if (mode === 'off') return false
    if (mode === 'fullscreen') return code === 'F'
    return code === 'F' || code === 'Z'
  }

  /** 期望值落地（带去抖）。按**状态**推进而不是只看「值翻没翻」：
   * 旧实现 `if (fullscreen === lastFullscreen) return` 一旦被误判成 avoided、而判定值又没翻回
   * false（例如误判源一直挂在前台），岛就会永久藏着不回来（2026-11-08 用户报「岛消失后一直没恢复」）。
   * 改成每次判定都对齐一次状态机，重复判定为同值时是幂等的（visible 已对就什么都不做）。 */
  const commit = (fullscreen: boolean): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (state === 'manual') return // 手动隐藏不受策略/判定变化影响
      if (fullscreen) {
        if (state === 'normal') {
          state = 'avoided'
          apply(true)
        }
      } else if (state === 'avoided' && !tempVisible && !bannerHold) {
        state = 'normal'
        apply(false)
      }
    }, DEBOUNCE_MS)
  }

  /** 把「窗口实际可见性」与期望对齐（自愈）。
   *
   * 为什么需要它：`commit()` 只在**期望值翻转**时动作，而 `tempVisible`（摸边临时现身）
   * 与 `bannerHold`（横幅）会合法地压制某次翻转，之后可能留下
   * 「期望隐藏、state 还是 avoided、窗口却还开着」的残留。此时再来一次
   * `commit(true)` 会因为 `state !== 'normal'` 什么都不做，岛就再也不藏了。
   * [实测] 2026-11-17 用户按 F11 岛没藏就是这个序列：摸边临时现过身 → 窗口最大化态
   * 切到真全屏 → 期望变 true 但 state 已是 avoided → 静默失效。
   * 每 150ms 对齐一次，代价可忽略（窗口可见性相同就什么都不做）。 */
  const reconcile = (want: boolean): void => {
    const win = getMain()
    if (!win || win.isDestroyed()) return
    if (state === 'manual' || tempVisible || bannerHold) return
    const visible = win.isVisible()
    if (want) {
      if (state === 'normal') state = 'avoided'
      if (visible) apply(true)
    } else if (!visible) {
      if (state === 'avoided') state = 'normal'
      apply(false)
    }
  }

  /** 重新按当前判定 + 当前策略算一次期望值；变了才进去抖，没变就做一次自愈对齐。 */
  const evaluate = (): void => {
    if (stopped) return
    const want = decision(judge)
    if (want !== wantHidden) {
      wantHidden = want
      commit(want)
      return
    }
    // 正在去抖就等它落地，别抢跑（否则会和去抖抢同一个窗口）
    if (!debounceTimer) reconcile(want)
  }

  /** 读心跳文件：内容 `F|1731830000123`。只有时间戳变化才算「辅助进程还活着」。 */
  const readBeat = (): void => {
    if (stopped) return
    let raw = ''
    try {
      raw = readFileSync(beatFile, 'utf8').trim()
    } catch {
      raw = ''
    }
    const parts = raw.split('|')
    const code = (parts[0] ?? '').trim()
    const ts = Number(parts[1] ?? 0)
    const pos = (parts[2] ?? '').trim()
    // 「辅助进程还活着」只看时间戳；坐标用于摸边回隐（原来每 400ms 再 spawn 一个 PS 读光标，
    // 2026-11-17 改成并进心跳文件：少一个高频 spawn，也少一个可能弹系统错误框的进程）
    if (pos) {
      const m = pos.match(/^(-?\d+),(-?\d+)$/)
      if (m) lastCursor = { x: Number(m[1]), y: Number(m[2]), at: Date.now() }
    }
    const fresh = Number.isFinite(ts) && ts > 0 && Date.now() - ts < 5000
    if (fresh && ts !== lastBeatTs && (code === 'F' || code === 'Z' || code === 'N')) {
      lastBeatTs = ts
      judge = code
      if (fallbackTimer) stopFallback() // 辅助进程活了，关掉回退轮询
    }
    // bannerHold 看门狗：横幅最长 8 秒。若结束事件丢了（渲染层定时器被节流/窗口被隐藏），
    // bannerHold 会一直为 true 把岛钉在屏幕上——超过 20 秒就强制清掉。
    if (bannerHold && bannerHoldAt > 0 && Date.now() - bannerHoldAt > 20000) {
      console.log('[fullscreen] 横幅临时现身超时未结束，强制清除 bannerHold')
      bannerHold = false
      bannerHoldAt = 0
    }
    // 摸边现身后的「光标移开就回隐」检查：数据来自心跳文件（见上），不额外起进程
    if (tempVisible) checkCursor()
    // 每轮都评估一次：策略（avoidMode）改了不会产生新的心跳，靠这里在 150ms 内跟上
    evaluate()
    if (fresh) {
      staleReads = 0
      return
    }
    // 心跳不新鲜：辅助进程还没起来（启动头几秒）或已经死了。连续 3 次才回退，
    // 避免一次系统卡顿就来回切换（切换本身要 spawn/杀进程，代价更大）。
    staleReads++
    if (staleReads >= 3 && Date.now() - helperStartedAt > HEARTBEAT_STALE_MS) startFallback()
  }

  // ---------------- 回退路径：单发短命 PowerShell（SPEC-perf-poll-throttle 的旧行为） ----------------
  const pollOnce = (): void => {
    if (stopped || fallbackProbing) return
    fallbackProbing = true
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', oneShotScript()], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      fallbackProbing = false
      return
    }
    fallbackChild = child
    let buf = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      fallbackProbing = false
      fallbackChild = null
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const line = buf.trim()
      const code = line.slice(-1)
      if (line && (code === 'F' || code === 'Z' || code === 'N')) {
        judge = code as JudgeCode
        evaluate()
      }
    })
    const guard = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        /* noop */
      }
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

  const startFallback = (): void => {
    if (stopped) return
    if (!fallbackTimer) {
      console.log('[fullscreen] 辅助进程无心跳，回退单发轮询（' + FALLBACK_POLL_MS + 'ms）')
      fallbackTimer = setInterval(pollOnce, FALLBACK_POLL_MS)
      probeTimers.add(fallbackTimer)
      pollOnce()
    }
    // 顺手定期尝试重启辅助进程：起来了（有心跳）readBeat 会自动关掉回退
    if (!helperRetryTimer) {
      helperRetryTimer = setInterval(() => {
        if (stopped) return
        startHelper(true)
      }, HELPER_RETRY_MS)
      probeTimers.add(helperRetryTimer)
    }
  }

  const stopFallback = (): void => {
    if (fallbackTimer) {
      clearInterval(fallbackTimer)
      probeTimers.delete(fallbackTimer)
      fallbackTimer = null
    }
    if (fallbackChild) {
      try {
        fallbackChild.kill()
      } catch {
        /* noop */
      }
      fallbackChild = null
    }
    fallbackProbing = false
    if (helperRetryTimer) {
      clearInterval(helperRetryTimer)
      probeTimers.delete(helperRetryTimer)
      helperRetryTimer = null
    }
  }

  /** 起（或重启）常驻辅助进程。stdio 全 ignore —— 不使用管道（见文件头注释）。 */
  const startHelper = (restart = false): void => {
    if (stopped) return
    if (helper && !restart) return
    if (helper) {
      try {
        helper.kill()
      } catch {
        /* noop */
      }
      helper = null
    }
    const enc = Buffer.from(helperScript(), 'utf16le').toString('base64')
    try {
      helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore']
      })
    } catch {
      helper = null
      startFallback()
      return
    }
    helperStartedAt = Date.now()
    lastBeatTs = 0
    staleReads = 0
    helper.on('exit', () => {
      helper = null
      if (!stopped) startFallback()
    })
    helper.on('error', () => {
      helper = null
      if (!stopped) startFallback()
    })
  }

  startHelper()
  beatTimer = setInterval(readBeat, BEAT_READ_MS)
  probeTimers.add(beatTimer)
  readBeat()

  /** 现身期间的「光标移开就回隐」（A5 修复）+ 摸边检查。
   *
   * 实测踩坑（US-041）：岛 showInactive 现身后 Chromium 不认为光标在窗口内（未注册
   * TrackMouseEvent），光标离开不派发 mouseleave → 渲染层 onMouseLeave 永不上报。
   * 另外 Electron 的 `screen.getCursorScreenPoint()` 与外部 SetCursorPos 结果不一致（probe 实测），
   * 所以光标坐标必须走 OS 层 GetCursorPos。
   *
   * 2026-11-17 改法：**不再每 400ms 起一个 PowerShell 读光标**，而是让常驻辅助进程把光标坐标
   * 一起写进心跳文件（120ms 一轮）。用户实测在独占全屏游戏期间弹过
   * 「powershell.exe - 系统错误 / 0xc0000005」，而这类高频 spawn 是最可能的相关面之一。
   * 连续 2 次读到光标不在岛 bounds（含余量）→ 回隐；回到岛内就清零。 */
  let cursorCheckOn = false
  let cursorOutsideStreak = 0
  const stopCursorWatch = (): void => {
    cursorCheckOn = false
    cursorOutsideStreak = 0
  }
  const startCursorWatch = (): void => {
    cursorCheckOn = true
    cursorOutsideStreak = 0
  }
  /** 由 readBeat 每 150ms 驱动一次（辅助进程 120ms 更新一次光标）。 */
  const checkCursor = (): void => {
    if (!cursorCheckOn) return
    if (state !== 'avoided' || !tempVisible || bannerHold) return
    // 坐标太旧（辅助进程走了回退路径、或刚重启）就这一轮先不判，免得拿旧坐标误回隐
    if (Date.now() - lastCursor.at > 2000) return
    const win = getMain()
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const MARGIN = 8
    const inside =
      lastCursor.x >= b.x - MARGIN &&
      lastCursor.x <= b.x + b.width + MARGIN &&
      lastCursor.y >= b.y - MARGIN &&
      lastCursor.y <= b.y + b.height + MARGIN
    if (inside) {
      cursorOutsideStreak = 0
      return
    }
    cursorOutsideStreak++
    if (cursorOutsideStreak < 2) return
    // 连续 2 次在岛外 → 真移开，回隐
    stopCursorWatch()
    tempVisible = false
    if (decision(judge)) apply(true)
  }

  // 摸边唤回：感应窗 mouseenter 上报。岛现身会盖住感应条（岛就在顶部），
  // 所以现身即销毁感应窗，把「离开检测」移交给岛自身的 mouseleave（App.tsx）。
  ipcMain.on('island:edge-hover', (_e, entered: unknown) => {
    if (entered !== true) return
    if (state === 'manual') return
    if (state === 'avoided' && !tempVisible) {
      apply(false) // apply(false) 内部已 destroyEdgeWindow + revealWindow
      // apply(false) 会把 tempVisible 重置为 false（恢复/现身共用入口），
      // 摸边现身必须在 apply 之后再置 true，否则「临时现身中」标志被吞（[实测] A5 踩坑）。
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
      // 用 OS 层 GetCursorPos 的结果（心跳文件里带的），不用 screen.getCursorScreenPoint()：
      // 后者在本机实测与真实光标位置不一致（[实测] US-041 排障记录）
      const p = Date.now() - lastCursor.at < 2000 ? lastCursor : { x: screen.getCursorScreenPoint().x, y: screen.getCursorScreenPoint().y }
      const inIsland = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y - EDGE_HEIGHT && p.y <= b.y + b.height
      if (inIsland) return // 误报（岛现身遮挡感应窗的迟到 leave）
      tempVisible = false
      if (decision(judge)) apply(true)
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
    // 手动隐藏期间期望值可能已经翻成 true 但没落地（commit 里 manual 直接 return），
    // 这里清掉缓存让它按当前判定重新算一次，否则岛会「恢复了却再也不自动避让」
    // （[实测] 2026-11-17：A7 横幅结束不回隐就是这么挂的）。
    wantHidden = null
    evaluate()
  })

  // 横幅临时现身（渲染层横幅/验证码弹出时调用，结束回传 false）
  ipcMain.on('island:temp-show', (_e, on: unknown) => {
    bannerHold = on === true
    bannerHoldAt = bannerHold ? Date.now() : 0
    if (bannerHold && !getMain()?.isVisible()) apply(false)
    if (!bannerHold && state === 'avoided' && !tempVisible && decision(judge)) apply(true)
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

/** 退出时停掉辅助进程/回退轮询与感应窗 */
export function stopFullscreenWatch(): void {
  stopped = true
  if (beatTimer) {
    clearInterval(beatTimer)
    probeTimers.delete(beatTimer)
    beatTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  for (const t of probeTimers) clearInterval(t)
  probeTimers.clear()
  if (helper) {
    try {
      helper.kill()
    } catch {
      /* noop */
    }
    helper = null
  }
  if (fallbackChild) {
    try {
      fallbackChild.kill()
    } catch {
      /* noop */
    }
    fallbackChild = null
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer)
    fallbackTimer = null
  }
  if (helperRetryTimer) {
    clearInterval(helperRetryTimer)
    helperRetryTimer = null
  }
  destroyEdgeWindow()
  try {
    unlinkSync(beatFile)
  } catch {
    /* 可能不存在/已被删，忽略 */
  }
  state = 'normal'
  wantHidden = null
  judge = 'N'
  tempVisible = false
  bannerHold = false
}
