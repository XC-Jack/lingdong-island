# SPEC：避让三档设置 + 隐藏延迟降到 0.75 秒

- **建立日期**：2026-11-17
- **基线提交**：`cb55136`（`fix-fullscreen-workarea` 分支；本 SPEC **叠在**那笔工作区判据修复之上，因为它还没合并 `main`）
- **任务分支**：`avoid-mode-and-latency`
- **关联**：`../facts/功能清单.md` 第 14 条（US-041 全屏自动避让）、`SPEC-fix-fullscreen-workarea.md`、`SPEC-perf-poll-throttle.md`、`../facts/数据规则.md`（prefs.json 白名单）

## 一、目标

用户要求两件事（2026-11-17 原话：「在设置页里添加三个选项，一个是全屏隐藏，一个是窗口最大化隐藏，一个是不隐藏，还有就是隐藏的时间缩短成 0.75 秒，1.5 秒还是有点长了」）：

1. **设置页「常规」分区加三档避让策略**，立刻生效并跨重启保留：
   - 真全屏时隐藏（最大化窗口保留岛）
   - 最大化窗口时也隐藏（**默认**，等于当前修复后的行为）
   - 不隐藏
2. **隐藏延迟从约 1.5 秒降到 0.75 秒以内**（从窗口最大化/全屏那一刻算起，到岛消失）。

第 2 项不能靠「把轮询调快」实现，理由有实测数据（[实测] 2026-11-17，`.tmp/fw-speed/`）：

| 方案 | 单次耗时/CPU | 说明 |
|---|---|---|
| `powershell -NoProfile -Command 1`（裸启动） | 200~230 ms | 任何 spawn 方案的地板 |
| 现方案：每次 spawn + `Add-Type` 编译 C# | wall 330~415 ms / **CPU 340~516 ms** | 现在常态 1 秒一次 ⇒ 约 40% 一个核 |
| 预编译 dll + `Add-Type -Path` | wall 290~310 ms | 只省 80ms，仍受 spawn 地板限制 |

所以要 0.75 秒，只能**每 400ms 左右判定一次**；按上表那等于把一个核跑满。故改为：**一个常驻的短小 PowerShell 辅助进程**（脚本内 120ms 循环、把状态写进一个心跳文件），主进程按 150ms 读文件。这样延迟降到 0.3~0.6 秒，同时把常态 CPU 从「约 40% 一个核」降到接近 0。

**与 SPEC-perf-poll-throttle 的关系**：那条 SPEC 明确写过「不改成长驻进程（会 hang DevTools HTTP 服务）」。那次事故的根因是**用管道 stdio 读取一个不退出的子进程**（pipe 缓冲写满 → 主进程事件循环/DevTools HTTP 服务被拖死）。本 SPEC 的辅助进程 **stdio 全部 ignore、零管道**，只通过一个文件通信，并且带**心跳超时自动回退**（3 秒没有心跳 → 切回旧的单发轮询），所以属于「换通信方式」而不是「无视那条结论」。这一点必须在自检里实测验证（DevTools `/json/list` 在辅助进程运行时仍然秒回）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `AVOID_MODES = ['maximized','fullscreen','off']` 与 `AvoidMode` 类型 |
| `src/main/prefsStore.ts` | `PrefsShape` 增 `avoidMode`，`normalizeAvoidMode()`，`load()`/`applyPatch()` 白名单接入 |
| `src/main/fullscreenWatch.ts` | 判定改为「常驻辅助进程 + 心跳文件」；判据拆成「盖住工作区 / 盖住整屏 / 是否最大化」三态；按 `avoidMode` 决定是否隐藏；保留摸边唤回、手动隐藏、横幅临时现身的全部既有语义 |
| `src/main/index.ts` | 传入 `getAvoidMode()`（读缓存，`onPrefsWritten` 时刷新）；退出时确保辅助进程被杀 |
| `src/renderer/src/settings/SettingsApp.tsx` | 常规分区加「全屏时怎么办」三档单选（复用 `.pet-set-mode` 那套样式/交互：点一下立刻写 prefs） |
| `scripts/e2e-avoid-mode.mjs` | **新建**：三档策略行为 + 隐藏延迟实测 |
| `scripts/e2e-fullscreen-misjudge.mjs` / `e2e-fullscreen-avoid.mjs` | 被动适配（新判定更快，原有 sleep 不必改；若时序假设失效则调大余量） |
| `docs/facts/功能清单.md` | 第 14 条补三档策略与新的轮询机制 |
| `docs/facts/数据规则.md` | prefs.json 白名单加 `avoidMode` |
| `docs/状态.md` | 一句话状态 |

**明确不改**：
- 摸边唤回（4px 感应带）、手动隐藏（`manual`）、托盘恢复、横幅临时现身（`bannerHold`）的语义；
- 壳层黑名单（`Progman`/`Shell_TrayWnd`/`Windows.UI.Core.CoreWindow` 等）、DWM cloak 排除、本进程排除；
- 判据基准（已经由 `SPEC-fix-fullscreen-workarea` 定成工作区 + 8px 容差）；
- 岛窗口本身的定位/动画、渲染层展开收起逻辑。

## 三、预期行为

1. **三档策略**（`prefs.json` 的 `avoidMode`，缺失/非法 → `maximized`）：
   - `maximized`：前台窗口盖住工作区即隐藏（含真全屏）。等价于当前行为。
   - `fullscreen`：只有**真全屏**才隐藏——即「盖住整屏」且**不是** Windows 意义上的最大化（`IsZoomed=false`）。最大化窗口时岛照常待着。
   - `off`：一律不隐藏（摸边/横幅逻辑自然闲置）。
   - 切换立即生效：从 `off` 切到 `maximized` 时，若当前前台正是最大化窗口，岛在 0.75 秒内自行隐藏；反向切换则立即现身。
2. **延迟**：窗口最大化/进入全屏 → 岛隐藏，常见 ≤ 0.75 秒（验收按 ≤ 1.0 秒断言，实测值记录在案）；反向（退出全屏/取消最大化）同样 ≤ 1.0 秒恢复。
   - 去抖保留但缩短到 150ms（防全屏切换瞬间的闪烁）。
3. **判定精度不退化**：`Progman` 桌面、DWM-cloaked 壳层窗口、本进程窗口、贴边但未最大化的普通窗口都不触发隐藏（沿用已有 e2e）。
4. **辅助进程可降级**：心跳文件 3 秒没更新 → 自动回到旧的「单发短命 PowerShell」轮询（1 秒），并在日志里记一行，行为与现在一致。
5. 退出应用时辅助进程随之结束，不留孤儿进程。

## 四、必要依赖

无新增 npm 依赖、无原生模块。仍只用系统 `powershell.exe` 与 `user32.dll` / `dwmapi.dll`。新增一个运行时文件 `<userData>/avoid-mode-beat.txt`（心跳，内容形如 `F|1731830000123`，含 1 字节状态码与毫秒时间戳），不属于用户数据、可随时删除。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| M1 | 三档设置存在且能落盘 | 设置页常规分区可见三档；点选后 `prefs.json` 出现对应 `avoidMode`；重启后仍是该值（e2e 用 `prefsGet()` 断言） |
| M2 | `maximized`：最大化窗口 → 岛隐藏；还原 → 回来 | `scripts/e2e-avoid-mode.mjs` |
| M3 | `fullscreen`：最大化窗口 → 岛**保持可见**；真全屏 → 隐藏 | 同上 |
| M4 | `off`：最大化/真全屏都不隐藏 | 同上 |
| M5 | 隐藏延迟 ≤ 1.0 秒（目标 0.75），记录实测均值 | 同上，从 `SetForegroundWindow` 起算轮询可见性 |
| M6 | 旧判定精度不回归 | `node scripts/e2e-fullscreen-misjudge.mjs` 7/0、`node scripts/e2e-fullscreen-avoid.mjs` 8/0 |
| M7 | 辅助进程不拖死 DevTools HTTP | e2e 运行期间 `fetch('http://127.0.0.1:<port>/json/list')` 连续 5 次均 < 2s 成功 |
| M8 | 辅助进程 CPU 占用远低于旧方案 | 记录 10 秒内辅助进程 `TotalProcessorTime` 增量，与旧方案（每次 spawn 340~516ms CPU × 1 次/秒）对比 |
| M9 | 退出不留孤儿 PowerShell | 正常退出后 `Get-Process powershell` 中无本应用的辅助进程（按命令行含 `avoid-beat` 判定） |
| M10 | 类型检查/构建/打包装机 | `npm run typecheck`、`npm run build` 均 EXIT=0；本轮**不打包**（按批规则），装机验证等批量验收 |

## 六、不做什么

- 不改判据基准与 8px 容差（上一份 SPEC 已定）。
- 不修「4px 感应带会被更晚置顶的 TopMost 窗盖住」这条已知限制（另开 SPEC）。
- 不做「按进程名白名单」「全屏应用例外名单」这类判据。
- 不改 `manual`（暂时隐藏）与横幅临时现身的交互。
- 不改设置窗口其它分区、不动岛内渲染。
- 不在 `main` 上直接提交；不打包、不合并（等用户试预览版后另行确认）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-17 | [实测] `.tmp/fw-speed/`（临时探针）：裸 PS 启动 / 现方案（每次 spawn + Add-Type）/ 预编译 dll + `Add-Type -Path` 三种方式的墙钟与 CPU | 裸启动 200~230ms（spawn 地板）；现方案 wall 330~415ms、**CPU 340~516ms**；预编译 dll 只省 80ms ⇒ 想靠加频到 400ms 达到 0.75 秒等于把一个核跑满，故改常驻辅助进程 | — |
| 2026-11-17 | [实测] 常驻辅助进程（`.tmp/fw-speed/measure.ps1`，自带 25ms 粒度的可见性轮询） | 最大化→隐藏：313 / 407 / 433ms；还原→现身：315 / 339 / 344ms | 首次测到「有时不隐藏」，定位是光标停在顶部 4px 感应带里 → 岛处于「摸边临时现身」，按设计此时不该隐藏；属探针没复位光标，不是 bug |
| 2026-11-17 | [实测] 辅助进程资源占用 | `TotalProcessorTime` 10 秒增 0.14s（≈1.4% 一个核）；工作集约 80MB；对照旧方案每秒 340~516ms CPU | 数小时级内存增长未测 |
| 2026-11-17 | [实测] 只强杀主进程（`Stop-Process -Id <main>`，不带 /T）后辅助进程是否残留 | 3 秒后辅助进程已退出（脚本内 `GetProcessById(父 pid)` 检查生效） | 主进程被「挂起」而非退出的极端情况未测 |
| 2026-11-17 | [实测] `npm run typecheck`、`npm run build` | 均 EXIT=0 | — |
| 2026-11-17 | [实测] `node scripts/e2e-avoid-mode.mjs`（新建，8 条） | **8 过 / 0 败**：M1 默认 `maximized`；M2 最大化→隐藏 285ms；M3 fullscreen 下最大化→保持可见 642ms；M3b 真全屏→隐藏 300ms；M4 off 下真全屏也不隐藏；M5 隐藏 668/669/306ms（均值 548）、现身 650/308/310ms（均值 423）；M7 辅助进程运行时 `/json/list` 4/4/1/2/1ms | 断言阈值取 1000ms（750ms 是体验目标），单轮峰值 668ms 已接近上限，慢机可能偶发超时 |
| 2026-11-17 | [实测] `node scripts/e2e-fullscreen-misjudge.mjs` | **7 过 / 0 败**（判定精度不回归：贴边窗可见、真全屏隐藏、cloak 壳层/桌面可见、最大化隐藏、恢复） | — |
| 2026-11-17 | [实测] `node scripts/e2e-fullscreen-avoid.mjs` | **8 过 / 0 败**。本轮顺带修了两个测试基础设施 bug：①`cdpConnect` 取「第一个 page」会取到避让态的 4px 感应窗（`data:` 页面、没有 preload），实测表现为 `Runtime.evaluate` 永不返回、整轮卡死 → 改为按 `index.html` 挑页面 + 8 秒超时；②预检 `taskkill electron` 前移（原来在 spawn 之后，会杀掉被测实例）。A8 断言同步改成新机制 | — |
| 2026-11-17 | [实测] 开发中修掉的两个真实缺陷 | ①手动隐藏期间期望值被记成 true 却没落地，`manualRestore` 后「恢复了却再也不自动避让」→ 恢复时清缓存重算（`e2e-fullscreen-avoid` 的 A7 横幅结束不回隐就是这个）；②辅助进程在应用被强杀时残留 80MB 的 `powershell.exe` → 脚本内盯父进程 pid 自行退出 | — |
| — | 未做 | — | **未打包、未装机、未合并 `main`**；设置页三档的真人点击体验待用户确认（M10 装机部分） |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待独立验收 | — | — | — |
