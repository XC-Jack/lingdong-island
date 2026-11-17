# SPEC：降低判定辅助进程的崩溃面（独占全屏游戏期间弹 powershell 系统错误框）

- **建立日期**：2026-11-17
- **基线提交**：`e163b9e`（main，v0.1.3）
- **任务分支**：`avoid-helper-robustness`
- **关联**：`SPEC-avoid-mode-and-latency.md`（引入常驻辅助进程那份）、`../facts/功能清单.md` 第 14 条

## 一、目标

用户 2026-11-17 报告：**另一台电脑玩《三角洲》（独占全屏）时弹出了一个 Windows 系统错误框**

```
powershell.exe - 系统错误
Exception Processing Message 0xc0000005 - Unexpected parameters
```

当时那台机器装的是**上一个安装包**（0.1.2 或更早，含常驻辅助进程）。用户要求确认当前版本是否也有同样风险。

**风险判断 [推断]**：0.1.3 相对 0.1.2 只加了状态机自愈，**spawn 行为完全一样**，所以同样的风险仍然存在。据现有代码，与 powershell 相关的三处可疑面：

| 面 | 旧行为 | 为什么可疑 |
|---|---|---|
| 常驻辅助进程 | 脚本里 `Add-Type -AssemblyName System.Windows.Forms`，只为拿 `Screen.PrimaryScreen.WorkingArea/Bounds` | 在常驻进程里初始化整个 WinForms（含隐藏的 parking window）。0xc0000005 出现在「Exception Processing Message」这种窗口消息处理场景，WinForms 隐藏窗口是最可疑的相关面 |
| 摸边回隐 | 摸边临时现身期间**每 400ms spawn 一个新的 PowerShell** 读光标 | 每个 spawn 都是完整 .NET 启动；游戏独占全屏切换显示模式时这份高频 churn 会放大风险 |
| 判定回退 | 心跳失败时每 1 秒 spawn 一个短命 PS | 同上（但只在辅助进程挂了才发生） |

目标：**把判断路径上的组件依赖和进程数量压到最少**，让「游戏全屏时弹系统错误框」这类问题没有可依附的载体：
1. 脚本彻底不加载 `System.Windows.Forms`（改用 `user32` 的 `GetSystemMetrics` + `SystemParametersInfo(SPI_GETWORKAREA)`，与 `GetWindowRect` 同处一个 DPI 上下文）。
2. 光标坐标并入心跳文件，**取消摸边期间每 400ms 的 spawn**（判断路径上只剩一个常驻进程，正常游戏期间零新增进程）。
3. 回退路径的短命 PS 同样去掉 WinForms。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/fullscreenWatch.ts` | `probeCs()` 增 `GetSystemMetrics`/`SystemParametersInfo`/`GetCursorPos` + `ProbeAll()`；辅助进程与回退脚本去掉 `Add-Type -AssemblyName System.Windows.Forms`；心跳文件格式改为 `码\|毫秒\|光标x,y` 且每 120ms 覆盖写；摸边回隐改成基于心跳里的光标坐标（`checkCursor()`），删除 `cursorPollOnce`/`cursorScript`/`CURSOR_WATCH_INTERVAL_MS`；`island:edge-leave` 的 400ms 兜底改用同一份坐标（不再依赖不可靠的 `screen.getCursorScreenPoint()`） |
| `scripts/e2e-avoid-mode.mjs` | 新增 M8：断言判断路径上不再有 WinForms、也没有「每 400ms 起 PS」的光标轮询；心跳文件必须带光标坐标 |
| `docs/facts/功能清单.md` | 第 14 条补「零组件依赖 + 光标并入心跳」的说明 |
| `docs/状态.md` | 一句话状态 |

**明确不改**：
- 判定判据本身（工作区基准 + 8px 容差 + `IsZoomed` 区分真全屏）与三档策略语义；
- 轮询节奏（辅助进程 120ms / 主进程读文件 150ms）、去抖 150ms、心跳超时回退机制；
- 4px 感应窗与摸边唤回的交互语义（只是换了光标数据来源）；
- 手动隐藏 / 托盘恢复 / 横幅临时现身。

## 三、预期行为

1. 功能与 0.1.3 完全一致：三档策略、隐藏延迟、摸边唤回、手动隐藏、横幅优先。
2. **正常游戏/办公期间，判断路径上只有 1 个常驻 powershell 进程**；进/出全屏、最大化/还原、摸边现身都不再额外起进程。
3. 该常驻进程**不加载任何 GUI 程序集**（只有 `Add-Type` 编译的一段 user32 P/Invoke）。
4. 辅助进程意外退出时仍回退到「单发短命 PS」轮询（1 秒），且该脚本同样不加载 WinForms。
5. 心跳文件内容形如 `F|1794927222728|400,500`（判定码 / 毫秒时间戳 / 光标坐标）；格式不合法时主进程只忽略这一次读取，不影响判定。

## 四、必要依赖

无新增依赖。C# 只用 `user32.dll`（`GetForegroundWindow`/`GetWindowRect`/`IsWindowVisible`/`IsZoomed`/`GetClassNameW`/`GetWindowThreadProcessId`/`GetSystemMetrics`/`SystemParametersInfo`/`GetCursorPos`）与 `dwmapi.dll`（`DwmGetWindowAttribute`）。**不再需要 `System.Windows.Forms` 这个程序集**。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| R1 | 判断路径无 WinForms 依赖 | 源码断言：`src/main/fullscreenWatch.ts` 内不出现 `-AssemblyName System.Windows.Forms`（真去加载那个程序集才算，注释里提到不算）（e2e M8a） |
| R2 | 摸边期间不再每 400ms spawn | 源码断言：不存在 `CURSOR_WATCH_INTERVAL_MS` / `cursorScript`；`checkCursor` 由读心跳驱动（e2e M8） |
| R3 | 心跳文件带光标坐标且格式合法 | e2e M8 读 `<userData>/avoid-mode-beat.txt`，匹配 `^[FZN]\|\d+\|-?\d+,-?\d+$` |
| R4 | 功能不回归（三档 / 延迟 / 自愈） | `e2e-avoid-mode` 9/0 |
| R5 | 摸边唤回、手动隐藏、横幅优先不回归 | `e2e-fullscreen-avoid` 8/0 |
| R6 | 判定精度不回归（cloak/桌面/贴边窗） | `e2e-fullscreen-misjudge` 7/0 |
| R7 | 类型检查/构建/打包装机 | `npm run typecheck`、`npm run build` EXIT=0；打到 0.1.4 并装机 |
| R8 | 独占全屏游戏实测 | **需用户在自己那台机器上实测**（本轮无法复现该环境） |

## 六、不做什么

- **不承诺「用户那次弹框一定就是这个原因」**：无法复现该场景（另一台电脑 + 独占全屏游戏），本轮做的是**压缩可依附载体**，并在功能清单里记下这条因果假设与验证方法。
- 不改判定判据、轮询节奏、三档语义、摸边/手动隐藏/横幅的交互。
- 不引入原生模块、不改用长驻管道（历史事故）。
- 不在 `main` 上直接提交。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-17 | [实测] `npm run typecheck`、`npm run build` | EXIT=0 | — |
| 2026-11-17 | [实测] 心跳文件实际内容 | `N\|1794927222728\|400,500` —— 三段格式正确、光标随移动实时更新 | — |
| 2026-11-17 | [实测] `node scripts/e2e-avoid-mode.mjs` | **9 过 / 0 败**（三档、双向延迟 296~671ms、M6 自愈、M7 DevTools 秒回；M8 见下） | — |
| 2026-11-17 | [实测] `node scripts/e2e-fullscreen-avoid.mjs` | **8 过 / 0 败**（含 A4 摸边唤回 / A5 移开回隐 —— 光标数据源已换成心跳文件，这两条是它的正面覆盖） | — |
| 2026-11-17 | [实测] `node scripts/e2e-fullscreen-misjudge.mjs` | **7 过 / 0 败**（贴边窗 / 真全屏 / cloak 壳层 / 桌面 / 最大化 / 恢复） | — |
| 2026-11-17 | [实测] 资源占用对比 | 判断路径上常驻 powershell 从 1 个（带 WinForms）→ 1 个（零组件依赖）；摸边期间额外进程从「每 400ms 一个」→ 0 | 常驻进程内存/CPU 的精确对比未单独测（同量级，预期略降） |
| — | 未做 | — | **独占全屏游戏（三角洲）实测**：需要在用户那台机器上装 0.1.4 后实战确认（R8）；「弹框根因是否就是 WinForms / 高频 spawn」仍是 [推断] |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待独立验收 | — | — | — |
