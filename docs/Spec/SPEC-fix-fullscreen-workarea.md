# SPEC：全屏避让判据改用工作区（修「最大化窗口时岛不隐藏」）

- **建立日期**：2026-11-17
- **基线提交**：`d83af95`（main）
- **任务分支**：`fix-fullscreen-workarea`
- **关联**：`../facts/功能清单.md` 第 14 条（US-041 全屏自动避让）、`SPEC-us-041-fullscreen-avoid.md`、`SPEC-fix-fullscreen-misjudge.md`、`SPEC-perf-poll-throttle.md`

## 一、目标

修掉「前台窗口最大化时岛不自动隐藏」。2026-11-17 用户实机上报（截图：最大化 VS Code + 岛仍在）。

**真因 [实测]**：判据要求前台窗口矩形覆盖**整个主屏 Bounds**，而最大化窗口只能覆盖**工作区**（任务栏占 48px）：

| 量 | 值 |
|---|---|
| `PrimaryScreen.Bounds` | 1536×960 |
| `PrimaryScreen.WorkingArea` | 1536×912 |
| 当时前台窗口（最大化 VS Code） | `rect=-7,-7,1543,919`，`zoomed=True`，`cloak=0` |
| 现判据输出 | `normal` —— `r.B=919 ≥ 960` 不成立 |
| 若按工作区判定 | `fullscreen` |

根因不是判据写错，而是它依赖的前提失效：`../facts/功能清单.md:152` 记录「本机 `WorkArea` 与 `Bounds` 相同（任务栏自动隐藏）」，现在任务栏「自动隐藏」是关闭状态（[实测] `HKCU\...\Explorer\StuckRects3` 的 `Settings[8]=2`），最大化窗口底边只能到 919。

目标：**判据基准从「整屏 Bounds」换成「工作区 WorkingArea」**，使工作区被完全占满时（无论任务栏显示还是自动隐藏）都判定为避让。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/fullscreenWatch.ts` | `watchScript()`：额外读 `PrimaryScreen.WorkingArea`，`Covers()` 改与工作区四边比较（带 8px 容差，吃 Windows 最大化时外扩的不可见边框）；模块注释同步 |
| `scripts/e2e-fullscreen-misjudge.mjs` | 新增「贴边但不最大化」反例（F0/W3）+ 「工作区<整屏」前提打印；**测试基础设施修正**：岛可见性改用 C# 枚举（旧写法恒 false）、前台抢占改为 attach+重试、Progman 用二传手窗下发前台、F2 改用 DWM cloak 合成窗口、预检清理残留实例 |
| `scripts/e2e-fullscreen-avoid.mjs` | 同上修岛可见性；A1/A3 先把前台换成普通窗再断言；测试全屏窗去掉 TopMost（它会盖住 4px 感应带） |
| `docs/facts/功能清单.md` | 第 14 条「本机 WorkArea==Bounds」的前提改为「工作区/整屏两种任务栏状态均成立」+ 判据说明 |
| `docs/状态.md` | 一句话状态 + 进行中段落 |

**明确不改**：
- 轮询节奏（1s / 避让 2s / 手动隐藏停发）、去抖 300ms、`commit()` 状态机；
- 摸边唤回感应窗（4px 感应带）、`island:edge-hover` / `island:edge-leave` 语义；
- 手动隐藏（`manual`）与托盘恢复、横幅临时现身（`bannerHold`）；
- 壳层黑名单（`Progman`/`Shell_TrayWnd`/`Windows.UI.Core.CoreWindow` 等）、DWM cloak 判据、本进程排除；
- 渲染层 `App.tsx` / `styles.css`、`prefs.json`、任何 IPC 通道。

## 三、预期行为

1. 前台是**最大化**的普通应用（如最大化 VS Code），工作区被完全盖住 → 岛 **hide**（摸顶边可临时唤回）。**不论任务栏自动隐藏是否开启**。
2. 前台是**真全屏**应用（F11、独占全屏游戏、无边框铺满整屏的视频）→ 岛 hide，与现在一致（覆盖整屏必然覆盖工作区，行为是旧判据的超集，无回归）。
3. 前台是**贴边但未最大化**的窗口（例：`rect=41,30,1499,942`，用户实测当时的另一个窗口）→ 岛 **保持可见**。8px 容差远小于这类偏移，不会误收。
4. 前台是 `Progman` / DWM-cloaked 壳层窗口 → 岛保持可见（既有行为不变）。
5. 关掉/还原全屏窗口后岛自动恢复；手动隐藏与摸边唤回不受影响。

## 四、必要依赖

无新增 npm 依赖、无新增原生模块。仍走既有「单发短命 PowerShell 子进程」机制，只多用一次已在引用的 `System.Windows.Forms`（`Screen.PrimaryScreen.WorkingArea`），C# 侧不新增 P/Invoke 声明。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| W1 | 本机「工作区 < 整屏」（任务栏显示）时，最大化普通窗口置前 → 岛隐藏 | `node scripts/e2e-fullscreen-misjudge.mjs` 的 F4 断言岛不可见；脚本先打印实测 bounds/workarea 供核对 |
| W2 | 真全屏窗口置前 → 岛隐藏（旧行为不回退） | 同脚本 F1 |
| W3 | 贴边但未最大化的窗口置前 → 岛保持可见（不因容差误收） | 同脚本新增 W3 用例（造 `Bounds` 内缩 40px 的普通窗口） |
| W4 | cloaked 壳层 / 桌面 Progman 置前 → 岛保持可见（2026-11-08 的修复不回归） | 同脚本 F2 / F3 |
| W5 | 摸边唤回、移开回隐、手动隐藏、托盘恢复、横幅临时现身不回归 | `node scripts/e2e-fullscreen-avoid.mjs` A1–A7 全 PASS |
| W6 | 类型检查与构建干净 | `npm run typecheck`、`npm run build` 均 EXIT=0 |
| W7 | 安装版实机生效 | 打包安装后，最大化任何窗口岛藏起来、还原后自动出现（需用户实机确认） |

## 六、不做什么

- 不改 US-041 的产品语义：**最大化也算要避让**（用户 2026-11-17 确认按方案 1 实施）。如果日后只想「真全屏才避让」，另开 SPEC。
- 不引入 `IsZoomed` 作为判据（不看显示器，副屏最大化的窗口会造成主屏误判；无边框全屏游戏本来就只能靠矩形判据）。
- 不改成事件订阅 / hook，不动轮询模型。
- 不改任务栏设置（不要求用户把「自动隐藏」打开来迁就代码）。
- **不顺手修**「4px 感应带会被更晚置顶的 TopMost 全屏窗盖住」这个已发现的限制（测试中撞到，已在 `../facts/功能清单.md` 第 14 条记录），另开 SPEC。
- 不在 `main` 上直接提交；本轮不打包、不装机、不合并（等用户试预览版后另行确认）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-17 | [实测] `.tmp/fswatch-probe/probe4.ps1`：同一前台窗口分别按旧/新判据算 | 前台=最大化 VS Code `rect=-7,-7,1543,919 zoom=True`，Bounds 1536×960 / WorkArea 1536×912 → **旧判据 normal、新判据 fullscreen**（根因与修复方向同时坐实） | — |
| 2026-11-17 | [实测] `.tmp/fswatch-probe/taskbar.ps1` | `StuckRects3.Settings[8]=2`（任务栏自动隐藏已关）+ WorkingArea 比 Bounds 少 48px → 旧文档「本机 WorkArea==Bounds」的前提已失效 | 该开关是被系统更新还是用户手动改的，未确认 |
| 2026-11-17 | [实测] `npm run typecheck`、`npm run build` | 均 EXIT=0（typecheck 无输出；build `✓ built`，`out/main/index.js` 含 `WorkingArea`） | — |
| 2026-11-17 | [实测] **A/B**：`git stash` 掉 `fullscreenWatch.ts` 的改动 → build → `node scripts/e2e-fullscreen-misjudge.mjs` | **旧判据：6 过 / 1 败**，唯一失败就是 `F4/W1 最大化应用→岛隐藏`（`island=true`，前台 `MKmax rect=-8,-8,1544,920 zoom=True`）——正是用户上报的现象 | — |
| 2026-11-17 | [实测] 恢复改动 → build → 重跑同一脚本 | **新判据：7 过 / 0 败**（F0/W3 贴边窗可见、F1 真全屏隐藏、F5 关全屏恢复、F2 cloak 壳层可见、F3 桌面可见、F4/W1 最大化隐藏、F6 收尾恢复） | — |
| 2026-11-17 | [实测] **A/B**：旧判据跑 `node scripts/e2e-fullscreen-avoid.mjs` | 8 过 / 0 败 | 该轮的 A1/A3 能绿是因为旧判据把「最大化窗口」当常态，环境前提已变 |
| 2026-11-17 | [实测] 新判据第一次跑 avoid | 6 过 / 2 败（A4 摸边唤回、A3 退出全屏→恢复）。定位后确认**都是测试自身的前提问题**，不是功能回归：①A3 只 kill 全屏窗、前台跑回用户那个最大化窗口，按新判据岛「应该继续藏着」；②A4 的测试全屏窗带 `TopMost`，比感应带更晚置顶把 4px 感应带盖住（另配临时 console.log 探针确认 A4 期间 `island:edge-hover` 压根没到过主进程）；③A1 起手就可能已是避让态 | — |
| 2026-11-17 | [实测] 修完测试前提后重跑 `e2e-fullscreen-avoid.mjs` | **8 过 / 0 败**（A1/A2/A4/A5/A3/A6/A7/A8） | — |
| 2026-11-17 | [实测] 给两个全屏 e2e 写的测试基础设施修正（只改 `scripts/`） | ①两个脚本的「岛可见性」旧写法在 PowerShell 脚本块回调里计数，**恒返回 false**（avoid 版还写错了变量名：初始化 `$found` 却累加 `$script:found`）→ 改为在 C# 里枚举；②misjudge 的前台抢占失败率高 → 改为 attach thread + `SwitchToThisWindow` + 400ms 重试 10 次；③Progman 无法被后台进程置前 → 改用「8×8 二传手窗先抢前台、再下发给桌面」；④TextInputHost 被 cloak 后系统不允许抢前台 → F2 改为用 `DwmSetWindowAttribute(DWMWA_CLOAK=13)` 合成等价窗口；⑤预检 `taskkill electron` 一开始误写在 spawn **之后**，把刚起的被测实例一起杀了（导致整轮无岛窗口）→ 移到 spawn 之前，并按类名/标题清理残留的测试窗口 | 独占全屏（exclusive fullscreen）游戏未实测；多显示器环境未覆盖 |
| 2026-11-17 | 未做 | — | **未打包、未装机、未合并 main**；安装版实机效果待用户确认（W7） |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待独立验收 | — | — | — |
