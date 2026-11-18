# SPEC：独占全屏游戏闪退（隐藏岛时创建的置顶感应窗把游戏踢出独占模式）

- **建立日期**：2026-11-18
- **基线提交**：`cd9b6ae`（main，v0.1.6）
- **任务分支**：`fix-exclusive-fullscreen-crash`
- **关联**：`SPEC-us-041-fullscreen-avoid.md`、`SPEC-avoid-mode-and-latency.md`、`../facts/功能清单.md` 第 14 条

## 一、问题（用户实测，含录屏与截图）

用户另一台电脑（Windows 用户 `Administrator`，装 v0.1.6，开机自启开）打《三角洲》，屏幕上出现：

| 游戏显示模式 | 「只在真全屏时隐藏」 | 「窗口最大化时也隐藏」 | 「不隐藏」 |
|---|---|---|---|
| **全屏（独占全屏，1920×1080）** | **闪退** | **闪退** | 正常 |
| **无边框窗口** | 正常 | 正常 | 正常 |

证据文件（用户提供，转存于 `.tmp/game/`）：录屏 `e20faaecc088288add4810f2673985b7.mp4`（26.8 秒，1280×720，抽帧成 contact sheet 后可见「游戏 → 桌面」来回切换）、截图 `885444c0ddcaf6c3e6c890783598f035.jpg`（游戏「视频」设置页：显示模式=全屏、分辨率 1920×1080）、以及录屏中放大的设置窗口截图（版本 0.1.6、数据目录 `C:\Users\Administrator\AppData\Roaming\lingdong-island`、三档单选）。

**关键对照**：「不隐藏」不闪退 ⇒ verdict 不是「岛盖在游戏上」，而是**隐藏这个动作**带来的副作用。而「隐藏」时除了 `win.hide()`，还会 `ensureEdgeWindow()` **创建一个 1536×40 的置顶透明窗口**（顶部 4px 感应带，用来接 mouseenter 实现摸边唤回）。在独占全屏的交换链上叠加/摘除一个 topmost 窗口，极易把游戏踢出独占模式（叠加反作弊后通常直接崩）。无边框窗口对 topmost 覆盖不敏感，所以那一组三档都正常。

## 二、目标

**让避让路径上不再创建任何窗口**，从而不打扰独占全屏游戏：

1. 删掉 4px 感应窗（`ensureEdgeWindow` / `destroyEdgeWindow` / `edgeWindow` / `EDGE_HEIGHT` / `EDGE_WIN_HEIGHT` / `island:edge-hover`）。
2. 摸边唤回改为**直接读光标坐标**：常驻辅助进程已经在心跳文件里每 120ms 报一次光标（`码|毫秒|x,y`），主进程判定「光标到屏幕最顶边（y ≤ 2）」就临时现身、离开岛区域就回隐——语义与原来的 4px 感应带一致，但**零窗口创建**。
3. 顺带消掉一条已记录的已知限制：「更晚置顶的 TopMost 全屏窗会盖住 4px 感应带，导致摸边失效」（没有感应带了，这条自然不存在）。

## 三、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/fullscreenWatch.ts` | 删除感应窗相关代码与 IPC；新增 `REVEAL_Y = 2` 与 `maybeRevealByCursor()`，由读心跳的 150ms 循环驱动；`apply()` 里不再建/销窗口；`island:edge-leave` 的兜底改用 `REVEAL_Y`；把「启动计时器 + 首轮读心跳」挪到 `init` 末尾（避免 TDZ，见自检） |
| `src/preload/index.ts` | `edgeLeave()` 注释改为「只用于鼠标离开岛 → 收起」 |
| `scripts/e2e-avoid-mode.mjs` | 新增 M8d：源码断言避让路径不再 `new BrowserWindow` |
| `docs/facts/功能清单.md` | 第 14 条：摸边机制改写（4px 感应窗 → 光标判定）、删掉 TopMost 遮挡那条已知限制、补本 SPEC 记录 |
| `docs/状态.md` | 一句话状态 |

**明确不改**：判定三态（F/Z/N）、三档策略语义、隐藏/现身延迟、常驻辅助进程与心跳格式、`bannerHold`/`manual`/`tempVisible` 语义。

## 四、必要依赖

无新增依赖；反而少用了一个 `BrowserWindow` 实例和它的渲染进程。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| X1 | 避让路径不再创建窗口 | `e2e-avoid-mode` M8d（源码断言无 `new BrowserWindow` / `ensureEdgeWindow`） |
| X2 | 摸边唤回仍可用（光标到顶 → 现身） | `e2e-fullscreen-avoid` A4 |
| X3 | 光标离开岛 → 自动回隐 | 同上 A5 |
| X4 | 手动隐藏期间摸边无效 | 同上 A6 |
| X5 | 三档策略与延迟不回归 | `e2e-avoid-mode` M1–M8e 全绿 |
| X6 | 判定精度不回归 | `e2e-fullscreen-misjudge` 7 条全绿 |
| X7 | 类型检查/构建 | `npm run typecheck`、`npm run build` EXIT=0 |
| X8 | **独占全屏游戏不再闪退** | **需用户在那台机器上实测**（本轮无法复现独占全屏 + 反作弊环境） |

## 六、不做什么

- 不引入「独占全屏不避让」这一档（若 X8 实测仍闪退，说明触发点是 `win.hide()` 本身，那时候再谈要不要在独占全屏下改成「不隐藏 / 移出屏幕」，需要新证据）。
- 不改判定逻辑与三档策略；不动安装器配置。
- 不承诺「闪退根因 100% 是感应窗」：无法复现该环境，结论是**基于对照实验（不隐藏档不闪退）的推断**，靠 X8 验证。
- 不在 `main` 上直接提交。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-18 | [实测] 用户录屏抽帧（`.tmp/game/contact.jpg`、`crop10.png`） | 确认录屏里那个「小窗」就是我们的**设置窗口**（版本 0.1.6、数据目录在 `C:\Users\Administrator\...`、三档单选，光标正点在「窗口最大化时也隐藏」上），且录像在「游戏 ↔ 桌面」之间来回 —— 与用户口述（切到会隐藏的档位就闪退）一致 | 录屏分辨率 1280×720 且大量帧是桌面，看不到闪退瞬间的错误弹窗；没有游戏崩溃日志 |
| 2026-11-18 | [实测] `npm run typecheck` / `npm run build` | EXIT=0 | — |
| 2026-11-18 | [实测] 改完首次启动 dev 实例 | **启动即崩**：`startup.log` 记 `WARN unhandledRejection` + `FATAL uncaughtException: Cannot access 'maybeRevealByCursor' before initialization`（TDZ：`readBeat()` 在 init 中段被同步调用，而它要调的函数定义在后面）→ 把「启动计时器 + 首轮读心跳」挪到 init 末尾后恢复 | 这条同时验证了 v0.1.6 新加的启动诊断确实能在真崩时抓到原因并留证 |
| 2026-11-18 | [实测] `e2e-fullscreen-avoid` | **8 过 / 0 败**（A4 摸边唤回 / A5 移开回隐在「没有感应窗」的新实现下仍然通过） | — |
| 2026-11-18 | [实测] `e2e-avoid-mode` | **13 过 / 0 败**（新增 M8d「避让路径不再创建窗口」；三档与双向延迟 287~667ms） | — |
| 2026-11-18 | [实测] `e2e-fullscreen-misjudge` | **7 过 / 0 败** | — |
| — | 未做 | — | **独占全屏游戏的实测（X8）**：需要用户在那台机器上装新版本打一局确认；闪退根因仍是推断 |
