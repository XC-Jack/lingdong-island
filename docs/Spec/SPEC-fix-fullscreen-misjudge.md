# SPEC：修复全屏避让误判（岛在非全屏场景自己消失）

- **建立日期**：2026-11-08
- **基线提交**：`8ea93f9`（main，含美化-03 合并 `e9b9710`）
- **任务分支**：`fix-fullscreen-misjudge`
- **关联**：`../facts/功能清单.md` 全屏避让条目、US-041

## 一、目标

修掉 US-041 全屏自动避让的**误判**：目前只要前台窗口的矩形覆盖整个主屏就判定为「全屏」，于是把两类**不是全屏应用**的窗口也当成全屏，导致岛在用户正常使用电脑时自己消失：

1. DWM 已 cloak（不可见）的 Shell 窗口，典型是 `TextInputHost` 的 `Windows.UI.Core.CoreWindow`（标题「Windows 输入体验」，`rect=0,0,1536,960`，`cloaked=2`）；
2. 桌面本身 `Progman`（`class=Progman`，`title=Program Manager`，`rect=0,0,1536,960`）。

目标是：**只有真正占据屏幕、用户实际在用的全屏应用**才触发避让；上述两类窗口成为前台时岛保持可见。同时修复「前台恢复后岛不自动回来」——目前 `commit()` 里 `if (fullscreen === lastFullscreen) return` 只在判定翻转时动作，一旦被误判隐藏、前台又回到普通窗口，只要判定值没翻转岛就一直藏着。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/fullscreenWatch.ts` | 重写 `watchScript()` 的全屏判据；必要时调整 `commit()` 的恢复逻辑 |
| `scripts/e2e-fullscreen-misjudge.mjs` | **新建**：覆盖三类误判场景 + 真全屏对照 |
| `docs/facts/功能清单.md` | 全屏避让条目补一句判据说明 |
| `docs/状态.md` | 一句话状态 + 进行中段落 |

**明确不改**：
- `src/main/index.ts` 的窗口定位/尺寸、动画补间；
- 摸边唤回（感应窗）、手动隐藏、托盘恢复的状态机语义；
- 渲染层 `App.tsx` / `styles.css`（美化-01/02/03 的成果）；
- `prefs.json` 结构与 IPC 通道。

## 三、预期行为

1. 前台是**真全屏应用**（如全屏视频、全屏游戏、全屏浏览器）→ 岛仍然 hide，摸顶边可临时唤回。行为与现在一致。
2. 前台是 DWM-cloaked 的 Shell 窗口（`TextInputHost` 等）→ **岛保持可见**，不 hide。
3. 前台是桌面 `Progman` / `WorkerW` → **岛保持可见**，不 hide。
4. 前台是**最大化并占满屏幕**的普通应用（本机 `PrimaryScreen.WorkArea` == `Bounds`，最大化窗口 rect `-8,-8,1544,968` 已覆盖整屏）→ 岛仍然 hide。这与 US-041 的原始设计一致（`src/main/fullscreenWatch.ts` 模块注释：「前台窗口全屏/最大化占满屏幕 → 岛 hide()」），**作为回归保护，本轮不改成「保持可见」**（[实测] 2026-11-08 `.tmp/probe-zoomed.mjs`：最大化窗口 `covers=True zoom=True`，真全屏无边框窗 `covers=True zoom=False`——若日后要区分两者，`IsZoomed` 是可用判据，但本轮不做）。
5. 从前台窗口 A 切到普通窗口 B 后，即使出现过误判，岛也必须自动恢复可见（不需要用户摸边）。

## 四、必要依赖

无新增 npm 依赖。判据仍用 PowerShell 单发短命子进程（既有 `watchScript()` 机制），新增的 C# 声明只用 `user32.dll` 的 `GetClassNameW`、`GetWindowTextW`、`GetWindowThreadProcessId`、`DwmGetWindowAttribute`（`dwmapi.dll`），均为系统 DLL。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| F1 | 真全屏应用置前 → 岛隐藏 | e2e 用 WinForms 无边框窗铺满主屏 + TopMost + SetForegroundWindow（沿用 `e2e-fullscreen-avoid.mjs` 的 `makeFullscreen`），断言岛不可见 |
| F2 | `TextInputHost` 的 cloak 窗口置前 → 岛**保持可见** | e2e 用 PowerShell 强制置前，断言岛仍可见 |
| F3 | `Progman` 置前 → 岛**保持可见** | 同上；桌面窗口句柄取 `GetShellWindow()`（`FindWindowW` 若不声明 `CharSet=CharSet.Unicode` 会返回零句柄，[实测] 曾因此误报「无法置前」） |
| F4 | 最大化并占满屏幕的普通应用置前 → 岛**仍然隐藏**（US-041 原设计，作为回归保护） | e2e 造最大化 WinForms 窗口（`WindowState='Maximized'`，rect `-8,-8,1544,968`），断言岛不可见 |
| F5 | 误判场景结束后岛自动恢复 | F1 之后把前台还给普通窗口，断言 3s 内岛自动现身 |
| F6 | 既有全屏避让行为不回归 | `node scripts/e2e-fullscreen-avoid.mjs` A1-A7 全 PASS |
| F7 | 全部既有 e2e 不回归 | `e2e-collapse-order`、`e2e-collapse-beautify`、`e2e-pages-custom`、`e2e-collapsed-todo`、`e2e-wifi`、`e2e-todo-today`、`e2e-head-order` 全 PASS |
| F8 | typecheck / build / 打包装机 / 安装版 4 进程 | `npm run typecheck`、`npm run build`、`npm run dist` + 静默安装 + 启动 |
| F9 | 安装版实机验证 | 安装版上重放 F2/F3，岛保持可见；用户实机确认 |

## 六、不做什么

- 不改成「按进程名白名单」这种脆弱的判据（用户装的任何全屏应用都该被识别，不该靠名单）。
- 不改摸边唤回的交互（感应窗高度、mouseenter 语义）。
- 不引入 Windows hook / 事件订阅，仍用现有轮询模型。
- 不改手动隐藏/托盘恢复的语义。
- 不顺手改美化相关的 UI。
- 不在 `main` 上直接提交。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-08 | [实测] `.tmp/probe-classnames.ps1` / `.tmp/probe-inline-diag.mjs`：枚举覆盖整屏的全部顶层窗口，读出类名/可见性/DWM cloak | 误判源确认：`TextInputHost` 的 `Windows.UI.Core.CoreWindow`（rect=0,0,1536,960，cloaked=2，`IsWindowVisible=True`）、`Progman`（cloaked=0） | 其他机器上是否还有别的壳层类名会铺满屏（本机只复现这两类） |
| 2026-11-08 | [实测] `.tmp/probe-newwatch.mjs`：先用独立脚本验证新判据 | 连跑 3 次全返回 `normal`（旧判据此时返回 `fullscreen`），判定耗时约 300ms | — |
| 2026-11-08 | [实测] `npm run typecheck`（node + web） | PASS，无输出 | — |
| 2026-11-08 | [实测] `npm run build` | 成功；产物 `out/renderer/assets/index-DJ8QQ9dS.js` 663.78 kB、`index-DsYoRyWi.css` 45.70 kB（渲染层未改，产物与美化-03 一致） | — |
| 2026-11-08 | [实测] `node scripts/e2e-fullscreen-misjudge.mjs`（新建，7 条断言） | **PASS 7 / 0 败**：F0 常态可见、F1 真全屏→隐藏、F5 关全屏→自动恢复、F2 cloak 壳层→保持可见、F3 桌面 Progman→保持可见、F4 最大化→仍隐藏（原设计）、F6 收尾自动恢复 | 全屏判定仍是 1s 轮询，极端时序（<1s 内来回切换）未覆盖 |
| 2026-11-08 | [实测] `node scripts/e2e-fullscreen-avoid.mjs`（既有 US-041 回归） | **PASS 7 / 0 败**：A1 常态可见、A2 全屏→隐藏、A4 摸边唤回、A5 移开回隐、A3 退出全屏→恢复、A6 手动隐藏+摸边无效+托盘恢复、A7 全屏横幅临时现身+结束回隐 | 真实全屏游戏/视频（独占全屏模式）未实测，沿用既有 A2 的 WinForms 铺屏模拟 |
| 2026-11-08 | [实测] 其余 7 套 e2e 回归 | 全 PASS：`e2e-head-order` 14/0、`e2e-collapse-order` 22/0、`e2e-collapse-beautify` 7/0、`e2e-pages-custom` 6/6、`e2e-collapsed-todo` PASS、`e2e-wifi` PASS、`e2e-todo-today` PASS | — |
| 2026-11-08 | [实测] `npm run dist` + 静默安装 + 启动 | `release\灵动岛 Setup 0.1.0.exe` 打包成功（electron 45.2.1、无代码签名）；`D:\软件\灵动岛\resources\app.asar` = 9148248 字节 / 17:02:44；asar 内 UTF-8 校验含 `Windows.UI.Core.CoreWindow`、`Progman`、`MultitaskingViewFrame`、`IsWindowVisible`、`DwmGetWindowAttribute`；启动后 `灵动岛` 4 进程存活（PID 2152/8236/18700/22916） | — |
| 2026-11-08 | [实测] `.tmp/probe-installed-misjudge.mjs` 安装版运行时重放 | **3 过 / 0 败**：V0 初始可见、V1 `TextInputHost` 场景岛保持可见、V2 把 `Progman` 强制置前（`fg=Progman`）岛仍可见 | **V1 未真正复现成功**：该探针回报置前后前台仍是 `Chrome_WidgetWin_1`，说明当时 `TextInputHost` 的 cloak 窗口不存在或未铺满屏，等于没测到；该场景只有开发态 e2e F2 覆盖 |
| 2026-11-08 | [实测] 安装版「前台=Progman」直接核对（重启安装版后复查） | 前台类名为 `Progman` 时读主窗口 `hwnd=18286372`：`vis=True rect=674,6,864,94` —— 岛**没有被隐藏**，正是修复目标 | — |

**自检过程中踩到并已修的坑（记录以免复发）**：

1. `FindWindowW` 未声明 `CharSet = CharSet.Unicode` 时，字符串按 ANSI 传给宽字符 API 匹配不上，返回零句柄——e2e 的 F3 因此一直报「无法置前」。改用 `GetShellWindow()`（不传字符串）后正常。
2. PowerShell 里 `IntPtr` 用 `-eq` 与 `[IntPtr]::Zero` 比较不可靠，零句柄会漏判；一律改 `.ToInt64() -eq 0` / `.ToInt64() -eq $h.ToInt64()`。
3. node 派生的 PowerShell 属于后台进程，`SetForegroundWindow` 会被系统静默拒绝（返回 False 且前台不变）；e2e 里改用 WinForms 窗体在 `Add_Shown` 里自己抢前台，再由它把前台交给目标窗口。
4. `Add-Type "..."` 外层是 PS 双引号，C# 源码里不能再出现裸双引号（会截断字符串导致空输出）；C# 字符串字面量一律用 `` `" `` 转义。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-08 | 用户实机（安装版 `D:\软件\灵动岛\`） | `350d6c0`（代码）+ `f245070`（文档） | 用户原话（m01517）：「自检好了，就合并把」——确认自检结果可信并授权合并；本轮为「岛莫名消失」的根因修复，用户实机观察正常使用期间不再消失 | **通过** |
