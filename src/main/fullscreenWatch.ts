import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { startupLog } from './startupLog'
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
 * 判断顺序：先看「盖住工作区」，再看是否真全屏。真全屏 = 盖住整屏 **且**（不是 Windows 最大化
 * 或 把任务栏盖住了）。这样任务栏显示/自动隐藏两种情况下都能区分「最大化」和「真全屏」；
 * 「盖住任务栏」这条是 2026-11-25 补的——VS Code F11 是带 WS_MAXIMIZE 的无边框窗口，
 * `IsZoomed` 为 true，只按旧判据会被当成最大化，摸边唤回仍然生效（用户实测报障）。
 *
 * 判定精度（判据不是「矩形覆盖整屏」就够了——那会把两类**不是全屏应用**的窗口也算进来，
 * 2026-11-08 用户报「没全屏岛却自己消失了」，[实测] 复现）：
 *   1. DWM 已 cloak（不可见）的 Shell 窗口，典型是 TextInputHost 的
 *      `Windows.UI.Core.CoreWindow`（标题「Windows 输入体验」，rect=0,0,1536,960，
 *      但 cloaked=2，用户在屏幕上根本看不到它）；
 *   2. 桌面本身 `Progman` / `WorkerW`（点桌面时它们会成为前台）。
 * 故判据 = 前台窗口 可见 ∧ 未被 DWM cloak ∧ 类名不属于已知壳层 ∧ 不属于本进程 ∧
 * 矩形覆盖整个**工作区**（四边 8px 容差，吃最大化时外扩的不可见边框）。
 *
 * 前台是本进程窗口时沿 Z 序取判据（2026-11-25 修，SPEC-avoid-self-foreground）：
 * 用户点一下岛，岛自己就成了前台窗口。以前这里直接返回 `N`（「别把自己的窗口当全屏」），
 * 等于点一下岛就告诉状态机「全屏应用没了」——避让被撤销、岛留在最大化窗口上不再自动隐藏
 * （用户实拍视频 + 本机 `.tmp/probe-avoid-self-focus.mjs` 复现：判定 `Z` → 点岛 → `N` →
 * 光标移开仍可见）。现在改为沿 `GetWindow(GW_HWNDNEXT)` 往下找第一个**其它应用**的可见窗口
 * 继续判定，找不到才算 `N`。这样「点岛」不再改变避让结论，鼠标离开岛仍按摸边规则回隐。
 * 注意必须在读前台之后、任何 `N` 返回之前做替换，否则「前台是岛」会先被别的前置条件挡掉。
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
 * 摸边唤回（2026-11-18 改）：不再创建感应窗，改看常驻辅助进程报上来的光标坐标——
 * 光标到屏幕最顶边（y ≤ 2）就临时显示岛，光标离开岛区域（且仍全屏）再隐藏。
 * **但真全屏（judge=F）时这条自动唤回被禁用**：游戏里视角上移会把光标顶到屏幕边，
 * 一唤回就把独占全屏的游戏最小化（用户实测的「玩几分钟突然切到桌面」）。
 * 为什么改：用户实测三角洲在**独占全屏**下切到会隐藏岛的档位就闪退，差别正是隐藏时
 * 多创建了一个置顶透明感应窗（独占全屏交换链上叠/摘 topmost 窗口极易踢出独占模式）。
 * 现在这条路径上零窗口创建、零额外进程。
 *
 * 通知优先：横幅/验证码弹出时渲染层调 requestTempShow()，岛临时现身
 * （即使正在避让），横幅结束后渲染层调 requestTempShow(false) 回隐。
 */

/** 光标到这个 y 就临时唤回（原来是靠一个 4px 高的透明感应窗接 mouseenter，
 * 2026-11-18 改成直接读光标坐标 —— 见下面 REVEAL 的说明） */
const REVEAL_Y = 2
/** 光标必须回到这个 y 以下才重新「上膛」，允许下一次摸边唤回。
 *
 * 为什么需要闩锁：唤回的条件是「光标在顶部（y≤2）」，而收起的条件是「光标离开岛的矩形」。
 * 光标停在顶部但**横向在岛之外**（比如最右边）时，两个条件会互相触发，形成
 * show→hide→show 的闪烁循环（[实测] 2026-11-18 日志里 200ms 一轮的 cursor-left/cursor-top 循环）。
 * 在独占全屏游戏里这种循环等于反复把游戏踢出全屏。加上闩锁后：摸边唤回一次 → 收起 →
 * 必须先把光标移开顶部再回来，才会再次唤回。 */
const REVEAL_REARM_Y = 8
/** 「隐藏」方向的去抖：判定翻转后等这么久才动作，防全屏切换瞬间的闪烁。
 * SPEC-avoid-mode-and-latency：300→150ms（用户要求 0.75 秒内隐藏，去抖不能吃掉太多预算） */
const DEBOUNCE_MS = 150
/** 「现身」方向的去抖（SPEC-avoid-show-attribution，2026-11-18）。
 *
 * 比隐藏方向长得多，因为两个方向代价不对称：晚藏 1 秒只是岛多挡一下；
 * 但**在独占全屏游戏上把岛叫出来一下，游戏就会被踢出全屏/切到桌面**（用户实测每几分钟被切一次）。
 * 所以要「非全屏状态持续 1.2 秒」才允许现身，把一闪而过的前台变化全过滤掉。 */
const SHOW_STABLE_MS = 1200
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
/** 心跳文件名（放在 userData 下，可随时删除，不是用户数据） */
const BEAT_FILE = 'avoid-mode-beat.txt'

/** 记录一次「岛为什么要隐藏/现身」——用户反馈过「玩几分钟突然切到桌面」，
 * 只有把触发原因（judge / banner / cursor / manual）写进日志才能定位到底是谁叫出来的。 */
function avoidLog(action: 'hide' | 'show', reason: string): void {
  const win = getMainForLog?.()
  startupLog(
    '[avoid] ' + action + ' reason=' + reason + ' judge=' + judge + ' mode=' + getMode() +
      ' visible=' + (win ? win.isVisible() : 'no-win') + ' temp=' + tempVisible + ' banner=' + bannerHold
  )
}

/** init 里注入的取窗口函数（avoidLog 在 init 外，只用于日志，拿不到窗口不影响日志） */
let getMainForLog: (() => BrowserWindow | null) | null = null

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
/** 当前「按策略应该避让」的期望值；-1 表示还没算过 */
let wantHidden: boolean | null = null
/** 最近一次判定码 */
let judge: JudgeCode = 'N'
/** 摸边唤回的闩锁：true=可以唤回；false=已经唤回过且还没把光标移离顶部 */
let revealArmed = true
/** 上一次「因为什么被判成全屏」而隐藏 —— F=真全屏（F11/独占全屏游戏）、Z=最大化。
 * 现身方向用它选去抖：从**真全屏**回来时要求的稳定期长得多（见 SHOW_STABLE_MS），
 * 从普通最大化回来还是原来的 150ms，日常用不会变迟钝。 */
let lastAvoidJudge: JudgeCode = 'N'
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

/** 手动隐藏的真正落地函数（init 里赋值）。菜单点击在主进程直接调，
 * 不再绕「主进程发消息 → 渲染层再转发」那条链——2026-11-25 用户实测
 * 「暂时隐藏没有任何反应」：渲染层从来没有监听那个频道，菜单只置了一个标志。 */
let manualHideImpl: (() => void) | null = null

/** 供 index.ts 的菜单项调用：进入 manual 态并隐藏岛。 */
export function hideIslandManually(): void {
  manualHideImpl?.()
}

/** 手动隐藏的恢复落地函数（init 里赋值）。
 * ⚠ 必须直接调，不能像 2026-11-25 之前那样由 index.ts 发
 * `webContents.send('island:manual-restore')`——那个频道只有主进程 `ipcMain.on` 在听、
 * 渲染层没有监听者，消息发出去等于扔掉：窗口被 showInactive 亮出来了，状态机却还停在
 * manual，避让判定整个失效，岛会一直压在最上层（[实测] 2026-11-25 探针 E/F 步）。 */
let manualRestoreImpl: (() => void) | null = null

/** 供 index.ts 的托盘恢复调用：退出 manual 态并按当前判定重算一次。 */
export function restoreIslandFromManual(): void {
  manualRestoreImpl?.()
}

/** 当前是否处于「手动隐藏」。**唯一真源**——index.ts 的菜单文案与恢复路径都用它，
 * 不要再在主进程存一份布尔值：2026-11-25 实测横幅把岛叫亮时主进程那份会被清成 false，
 * 状态机却还停在 manual，托盘恢复于是漏发 island:manual-restore，岛卡在最上层不再避让。 */
export function isIslandManuallyHidden(): boolean {
  return state === 'manual'
}

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
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '[DllImport(' + TICK + 'dwmapi.dll' + TICK + ')] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ')] public static extern int GetSystemMetrics(int i);',
    '[DllImport(' + TICK + 'user32.dll' + TICK + ', CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string w);',
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
    // 窗口是否把任务栏盖住了（面积过半）。用来区分「用户说的全屏」和「窗口最大化」：
    // VS Code F11、部分游戏的全屏窗口是**带 WS_MAXIMIZE 的无边框窗口**（[实测] 2026-11-25：
    // 前台 rect=0,0,1920,1200、IsZoomed=True、任务栏窗口 Shell_TrayWnd 仍 Visible 但被盖住），
    // 只靠 IsZoomed 会把它当成「最大化」，于是摸边唤回仍然生效（用户报「F11 了还能唤出来」）。
    // 任务栏自动隐藏时它滑出屏幕，与本窗口交集接近 0，不会误判。
    'public static bool TrayCovered(IntPtr h) {',
    '  IntPtr t = FindWindowW(' + TICK + 'Shell_TrayWnd' + TICK + ', null);',
    '  if (t == IntPtr.Zero || !IsWindowVisible(t)) return false;',
    '  RECT r; RECT tr;',
    '  if (!GetWindowRect(h, out r)) return false;',
    '  if (!GetWindowRect(t, out tr)) return false;',
    '  long tw = (long)tr.R - tr.L; long th = (long)tr.B - tr.T;',
    '  if (tw <= 0 || th <= 0) return false;',
    '  long ox = Math.Min(r.R, tr.R) - Math.Max(r.L, tr.L); if (ox < 0) ox = 0;',
    '  long oy = Math.Min(r.B, tr.B) - Math.Max(r.T, tr.T); if (oy < 0) oy = 0;',
    '  return ox * oy * 2 >= tw * th;',
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
    '  uint p; GetWindowThreadProcessId(h, out p);',
    // 前台是本进程窗口（点了岛/设置窗/岛仔）：换成 Z 序上第一个其它应用的窗口再判，
    // 不能直接判 N —— 否则「点一下岛」等于告诉状态机「全屏应用没了」（SPEC-avoid-self-foreground）。
    '  if (p == ' + ownPid + ') {',
    '    IntPtr q = h;',
    '    bool found = false;',
    '    for (int i = 0; i < 24; i++) {',
    '      q = GetWindow(q, 2);', // GW_HWNDNEXT = 2
    '      if (q == IntPtr.Zero) break;',
    '      uint p2; GetWindowThreadProcessId(q, out p2);',
    '      if (p2 == ' + ownPid + ') continue;',
    '      if (!IsWindowVisible(q)) continue;',
    '      if (Cloak(q) != 0) continue;',
    '      if (ShellClass(Cls(q))) continue;',
    '      h = q; p = p2; found = true; break;',
    '    }',
    '    if (!found) return ' + TICK + 'N' + TICK + ';',
    '  }',
    '  if (!IsWindowVisible(h)) return ' + TICK + 'N' + TICK + ';',
    '  if (Cloak(h) != 0) return ' + TICK + 'N' + TICK + ';', // DWM 已隐藏：用户根本看不到它
    '  if (ShellClass(Cls(h))) return ' + TICK + 'N' + TICK + ';',
    '  if (!Covers(h, wl, wt, wr, wb)) return ' + TICK + 'N' + TICK + ';',
    // 盖住整屏且（不是 Windows 意义上的最大化 或 把任务栏盖住了）⇒ 真全屏。
    // 后一条给「无边框最大化」这类窗口兜底：VS Code F11 实测 rect 盖满整屏、IsZoomed=True，
    // 但任务栏被它盖住——按用户口径（有任务栏=最大化，没任务栏=全屏）这就是全屏，不能唤回。
    '  if (Covers(h, bl, bt, br, bb)) {',
    '    if (!IsZoomed(h)) return ' + TICK + 'F' + TICK + ';',
    '    if (TrayCovered(h)) return ' + TICK + 'F' + TICK + ';',
    '  }',
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
  getMainForLog = getMain

  const revealWindow = (): void => {
    const win = getMain()
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.showInactive()
    win.moveTop()
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  const apply = (hidden: boolean, reason = 'unspecified'): void => {
    const win = getMain()
    if (!win || win.isDestroyed()) return
    avoidLog(hidden ? 'hide' : 'show', reason)
    if (hidden) {
      // 隐藏前如果展开着，先收起（不做展开记忆，SPEC 三.5）
      if (win.isVisible()) onStateChange(hidden)
      win.hide()
    } else {
      if (!win.isVisible()) {
        revealWindow()
        onStateChange(hidden)
      }
      tempVisible = false
      stopCursorWatch()
      revealArmed = true
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
    // 两个方向代价不对称：藏晚 1 秒无所谓，但在独占全屏上把岛叫出来一下就会把游戏踢出全屏。
    // 只对「从真全屏回来」用长稳定期；从普通最大化回来仍走 150ms，日常手感不变。
    const wait = fullscreen ? DEBOUNCE_MS : lastAvoidJudge === 'F' ? SHOW_STABLE_MS : DEBOUNCE_MS
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (state === 'manual') return // 手动隐藏不受策略/判定变化影响
      if (fullscreen) {
        if (state === 'normal') {
          state = 'avoided'
          lastAvoidJudge = judge
          // 手动恢复刚把岛亮出来（tempVisible），这时别立刻收掉：交给光标回隐那条路，
          // 否则用户点「显示灵动岛」只会看到闪一下。判定码在菜单弹出瞬间常是 N，
          // 菜单关掉才变 Z，所以在恢复那一刻判不出来，只能在这里兜一次。
          if (tempVisible) return
          apply(true, 'judge:' + judge)
        }
      } else if (state === 'avoided' && !tempVisible && !bannerHold) {
        state = 'normal'
        apply(false, 'judge:' + judge)
      }
    }, wait)
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
      if (visible) apply(true, 'reconcile:' + judge)
    } else if (!visible) {
      if (state === 'avoided') state = 'normal'
      apply(false, 'reconcile:' + judge)
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
    // 摸边唤回 / 移开回隐：都只看心跳文件里的光标坐标，不创建窗口、不额外起进程
    if (tempVisible) checkCursor()
    else maybeRevealByCursor()
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
    revealArmed = false // 见 REVEAL_REARM_Y：要么把光标移离顶部，要么等岛因别的原因再次现身
    if (decision(judge)) apply(true, 'cursor-left')
  }

  /** 摸边唤回（2026-11-18 改）：不再创建任何窗口，直接看光标坐标。
   *
   * 历史做法是隐藏期间在屏幕顶部放一条 4px 高的透明感应窗接 mouseenter。但用户实测：
   * 三角洲在**独占全屏**下，前两档（会隐藏岛的档）一切换就闪退 —— 而「不隐藏」档不闪退。
   * 差别正是「隐藏时多创建了一个置顶透明窗口」：在独占全屏交换链上叠/摘一个 topmost 窗口，
   * 很容易把游戏踢出独占模式（叠加反作弊后通常直接崩）。
   * 现在光标坐标已经由常驻辅助进程 120ms 报一次（心跳文件第三段），判定「光标是否到顶」
   * 完全不需要窗口，于是这条路径上**零窗口创建**。
   */
  const maybeRevealByCursor = (): void => {
    if (state !== 'avoided' || tempVisible || bannerHold) return
    // ⚠ 真全屏（F）时**不**做「光标到顶自动唤回」（SPEC-no-reveal-in-fullscreen，2026-11-18）。
    // 用户实测根因：在《三角洲》里视角往上一抬，光标就顶到屏幕最上边 → 触发摸边唤回 →
    // 岛出现 → 独占全屏的游戏立刻最小化/切到桌面。这就是「玩几分钟突然被切到桌面」的来源。
    // 真全屏期间要岛：退出全屏（游戏窗口化）后用托盘/摸边，或直接看游戏。
    // 最大化（Z）/普通窗口（N）不受影响，摸边照旧。
    if (judge === 'F') return
    // 坐标太旧（辅助进程刚重启/走了回退路径）就先不判，免得拿旧坐标误唤回
    if (Date.now() - lastCursor.at > 800) return
    // 闩锁：上一次就是因为「光标还在顶部但已离开岛」而收起的话，先把光标移离顶部再重新上膛，
    // 否则会 show→hide→show 无限闪烁（在独占全屏游戏里等于反复踢游戏）
    if (!revealArmed) {
      if (lastCursor.y > REVEAL_REARM_Y) revealArmed = true
      return
    }
    if (lastCursor.y > REVEAL_Y) return
    apply(false, 'cursor-top')
    tempVisible = true
    startCursorWatch()
  }

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
      const inIsland = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y - REVEAL_Y - 2 && p.y <= b.y + b.height
      if (inIsland) return // 误报（岛现身遮挡感应窗的迟到 leave）
      tempVisible = false
      if (decision(judge)) apply(true, 'edge-leave')
    }, 400)
  })

  // 手动隐藏（右键/托盘菜单，以及渲染层的 island:manual-hide IPC）
  manualHideImpl = () => {
    state = 'manual'
    apply(true, 'manual-hide')
  }
  ipcMain.on('island:manual-hide', () => {
    manualHideImpl?.()
  })
  const doRestore = (): void => {
    if (state !== 'manual') return
    state = 'normal'
    apply(false, 'manual-restore')
    // 别让岛只闪 150ms：按「摸边唤回」同一套口径给它一次临时现身，光标离开岛后回隐。
    // 用户点托盘/菜单本来就是为了看一眼或点一下。这里不按 judge 分支——菜单还开着时
    // 前台常被判成 N，真正的 Z 要等菜单关掉才到（commit 里对 tempVisible 兜了一次）。
    tempVisible = true
    startCursorWatch()
    // 手动隐藏期间期望值可能已经翻成 true 但没落地（commit 里 manual 直接 return），
    // 这里清掉缓存让它按当前判定重新算一次，否则岛会「恢复了却再也不自动避让」
    // （[实测] 2026-11-17：A7 横幅结束不回隐就是这么挂的）。
    wantHidden = null
    evaluate()
  }
  manualRestoreImpl = doRestore
  // 渲染层自己发起的恢复（历史频道，保留）
  ipcMain.on('island:manual-restore', () => {
    doRestore()
  })

  // 横幅临时现身（渲染层横幅/验证码弹出时调用，结束回传 false）
  ipcMain.on('island:temp-show', (_e, on: unknown) => {
    bannerHold = on === true
    bannerHoldAt = bannerHold ? Date.now() : 0
    if (bannerHold && !getMain()?.isVisible()) apply(false, 'banner-on')
    if (!bannerHold && state === 'avoided' && !tempVisible && decision(judge)) apply(true, 'banner-off')
    if (!bannerHold && state === 'manual' && getMain()?.isVisible()) apply(true, 'banner-off')
  })

  // ⚠ 启动计时器/首轮读心跳必须放在这个函数的**最末尾**：`readBeat()` 会立刻跑一轮，
  // 而它要调用的 `checkCursor` / `maybeRevealByCursor` 都是下面才定义的 const，
  // 放前面会踩 TDZ（`Cannot access 'maybeRevealByCursor' before initialization`）。
  // [实测] 2026-11-18：这条就是靠新加的启动诊断日志抓到的（startup.log 里一条 FATAL，
  // 打包版还会弹错误框）—— 正是当初加它的目的。
  startHelper()
  beatTimer = setInterval(readBeat, BEAT_READ_MS)
  probeTimers.add(beatTimer)
  readBeat()
}

/** 退出时停掉辅助进程/回退轮询 */
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
  manualHideImpl = null
  manualRestoreImpl = null
}
