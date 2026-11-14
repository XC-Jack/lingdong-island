# SPEC：后台轮询降频（优化软件占用）

- 建立日期：2026-11-14
- 基线：`main` `efc9905`「docs: 桌宠随机漫步已打包装机完成（安装版 asar 1A1D6EC5），main 前进」
- 任务分支：`perf-poll-throttle`
- 用户原话（m02958）：「看看能不能优化一下软件的占用等一些东西，我也表达不出来优化什么，你想这个软件其实就是一个小工具，要是用起来消耗很大的，对电脑负担也大，玩游戏办公时也不太好」
- 方向（m02984 已答复用户）：全屏轻载 + 轮询降频

## 一、目标

把「不打游戏、不全屏时照样每秒创建一个 PowerShell 子进程」降下来，让这个小工具在游戏 / 办公（全屏或最大化）时尽量不添负担，同时**不破坏全屏自动避让的响应速度与既有判定逻辑**。

诊断 [已核验]，出处为本机 pwsh 实测与 `src/main/` 源码：

1. 安装版 4 个进程共约 350.8 MB（主 106.1 / GPU 106.6 / 渲染 91.8 / 工具 46.3），15 秒累计 CPU 约 297 ms ≈ 1.98% 单核。内存是 Electron 多进程架构的固有开销，本轮不改架构、不承诺降内存。
2. 10 秒采样出现 27 个不同的 powershell / cmd / conhost 进程，其中约 9 个 powershell 的父进程都是灵动岛主进程（`ppid=16612`），基本每秒一个。来源：`src/main/fullscreenWatch.ts:34` `const WATCH_INTERVAL_MS = 1000` + `:239` `const pollTimer = setInterval(pollOnce, WATCH_INTERVAL_MS)`，每轮 `pollOnce()` spawn 一个短命 `powershell.exe`。
3. 用户诉求「玩游戏办公时」正好对应「岛已经 hide() 的全屏避让态」——此时仍以 1s 频率反复创建/销毁 PS 进程，是纯浪费。
4. 关键约束 [已核验]（`src/main/fullscreenWatch.ts:60–66`）：不能改成长驻 PowerShell 逐行读 stdout 的模式，那会让 DevTools HTTP 服务整体 hang；只能保持「单发短命 PS」。所以优化方向只能是降低 spawn 频率或在某些状态下暂停，不能换常驻进程。

口径 [推断]：用户「优化占用」主要指后台空转带来的负担，不是要把 351 MB 内存砍下来；最可能错在用户其实更在意内存或某次具体卡顿（前一次 m02935 已核实是 Explorer.EXE 自身崩溃，与灵动岛无关）。本轮按「降低子进程创建频率」处理，成本最低、风险最小，交付时说明内存部分未动。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/fullscreenWatch.ts` | 固定 `setInterval(..., 1000)` 改为自适应递归 `setTimeout`：normal 1s、avoided 2s、manual 暂停；`stopFullscreenWatch()` 加停止标志防退出后误重启；头注释同步 |
| `scripts/e2e-fullscreen-avoid.mjs` | 新增 A8 源码断言（自适应间隔常量 + 递归调度 + manual 暂停存在），防止以后被改回固定 1s |
| `docs/facts/功能清单.md` | 全屏自动避让条目补「自适应轮询降频」一句 |
| `docs/状态.md` | 顶部插入本轮一句话状态 |
| `docs/Spec/SPEC-perf-poll-throttle.md` | 本 SPEC，含自检记录 |

明确不改：

- `src/main/clipboardStore.ts`（1s 剪贴板轮询：Electron 主进程 `clipboard.readText()`，不创建外部进程，开销极小）
- `src/main/musicStore.ts`（1s 轮询：翻到音乐页才懒启动，不改）
- `src/main/notifyStore.ts`（30s 兜底 + fs.watch 实时，已经很低频）
- `src/main/statusStore.ts`（看门狗只调 `powerMonitor.isOnBatteryPower()`，不 spawn）
- `fullscreenWatch.ts` 的 `watchScript()` 判据、`cursorPollOnce()` / `CURSOR_WATCH_INTERVAL_MS = 400`（摸边唤回的回隐检测，独立且只在现身期间跑）
- `src/main/index.ts`、`src/shared/types.ts`、preload、渲染层、依赖清单、打包配置
- 不改 `app.disableHardwareAcceleration()`（可省约 106 MB GPU 进程，但透明窗口 + 四视图淡入动画在软件渲染下可能掉帧，与「别卡」诉求冲突；作为取舍记录在此，本轮不做）

## 三、预期行为

1. 岛常态可见（normal）：保持 1s 一次全屏判定，进入全屏的响应速度与改前完全一致。
2. 全屏避让中（avoided）：判定降到 2s 一次；退出全屏后仍能在约 2s 内恢复到 normal，用户回到桌面时岛照常现身。
3. 手动隐藏（manual）：完全停止全屏判定 spawn（commit 里 manual 本来就 return，判定无意义）；托盘 / 菜单恢复时立即重新起一轮并对齐当前全屏状态。
4. 全屏横幅临时现身、摸边唤回、回隐、去抖、感应窗、通知优先等既有语义一律不变。
5. `stopFullscreenWatch()` 退出后不会再被在途子进程重新拉起轮询。
6. 内存占用基本不变（本轮不改架构）；CPU / 子进程创建频率在 avoided、manual 状态明显下降。
7. 无新依赖、无新配置项、无用户可见 UI 变化。

## 四、必要依赖

无。复用现有 `setTimeout` / `setInterval`、`spawn` 单发短命 PS 模式、`probeTimers` 集合。

## 五、验收条件

- A1 `npm run typecheck` 与 `npm run build` 通过。
- A2 `scripts/e2e-fullscreen-avoid.mjs` 全过（A2 全屏 4s 内隐藏、A3 退出全屏 4s 内恢复、A4/A5 摸边唤回与回隐、A6 手动隐藏+摸边无效+托盘恢复、A7 全屏横幅临时现身、新增 A8 源码断言）。
- A3 `scripts/e2e-fullscreen-misjudge.mjs`：F1/F5/F6 等全过；F4「最大化应用→岛隐藏」在**未改动的 main 基线**上同样失败（本机最大化窗口未触发隐藏，既有/环境问题），已用 `git stash` 对照实验确认与本轮无关，不作为回归、不改该 e2e。
- A4 验证码回归 `scripts/e2e-code-hint.mjs`（SPEC 起草时误写成 `e2e-clipboard-code.mjs`，该脚本不存在）10/0 全过。
- A5 收起态 / 顺序回归 `scripts/e2e-collapse-order.mjs`（串行批次曾偶发 1 败、单跑 22/0 恢复，属启动时序非回归）、`scripts/e2e-head-order.mjs` 14/0 全过。
- A6 预览版实测：10 秒内灵动岛主进程 spawn 的 powershell 数量较改前（约 9 个 / 10s）明显下降，记录实测值到自检记录。
- A7 未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 攒批）。
- A8 只有真人能验：游戏 / 办公全屏时是否真的更轻、退出全屏恢复的 2s 延迟是否可接受。

## 六、不做什么

1. 不改 Electron 多进程架构、不承诺降内存（351 MB 是固有开销）。
2. 不改成长驻 PowerShell（会 hang DevTools HTTP 服务，`src/main/fullscreenWatch.ts:60–66` 已有实测结论）。
3. 不改全屏判定判据、不改感应窗与摸边唤回逻辑。
4. 不改剪贴板 / 音乐 / 通知 / 电量等其它轮询的周期。
5. 不新增依赖、不新增设置项、不新增 UI。
6. 不改 `app.disableHardwareAcceleration()`（理由见二）。
7. 不合并回 main、不打包、不装机、不做独立验收；这些按既定流程各需用户单独发话。

## 自检记录

自检 [已核验]，均在 `D:\Users\honor\Documents\Project\灵动岛` 分支 `perf-poll-throttle` 执行；跑 e2e 前均先 `Get-Process electron | Stop-Process -Force`。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（tsc --noEmit × tsconfig.node.json / tsconfig.web.json 全通过） |
| `npm run build` | EXIT=0（`index-BvE1zjjf.js` 102.21 kB、`pet-DvW6_AwQ.js` 11.90 kB）；基线对照实验与 stash pop 后各重跑一次，均成功 |
| `node scripts/e2e-fullscreen-avoid.mjs` | `== 结果：8 过 / 0 败 ==`，A1/A2/A4/A5/A3/A6/A7 全绿，新增 **A8 源码断言全绿** |
| `node scripts/e2e-fullscreen-misjudge.mjs` | `6 过 / 1 败`（F4 最大化窗口→岛隐藏失败），单跑稳定复现 |
| 基线对照：`git stash push` → `npm run build` → 同一 e2e → `git stash pop` → `npm run build` | 未改动的 `main` 基线代码同样 `6 过 / 1 败`（F4 失败）⇒ F4 属既有/环境问题，非本轮回归；自适应代码经 `Select-String` 11 处命中确认完整恢复 |
| `node scripts/e2e-code-hint.mjs` | `10 过 / 0 败`，CODE_HINT_EXIT=0（含 C8c 复制后 8s 收回、C7 收起态常驻高度 ≤90） |
| `node scripts/e2e-collapse-order.mjs` | 串行批次曾 `10 过 / 1 败`，**单跑 `PASS（22 过 / 0 败）`** 恢复 ⇒ 启动时序偶发，非回归（本轮未改收起态/顺序逻辑） |
| `node scripts/e2e-head-order.mjs` | `E2E HEAD-ORDER: PASS（14 过 / 0 败）`，HEAD_EXIT=0 |
| 预览版实测 PowerShell spawn 频率（见下） | 常态 8 个 / 10s、全屏避让态 **4 个 / 10s**（≈降一半） |

预览版实测 [已核验]：起预览版（主进程 pid 396、5173 监听、4 个 electron 进程），用 pwsh 每 120ms 采样 `Win32_Process` 中 `ParentProcessId = 396` 的 `powershell.exe` 去重计数。① 常态（normal）10 秒采样到 **8 个**（23:05:09.397 ~ 23:05:18.246，约 1s 一个，与改前约 9 个 / 10s 一致，进全屏响应未变）；② 造一个全屏置顶 WinForms 窗口让岛进入 avoided 态、等 4s 去抖后同样采样 10 秒，只出现 **4 个**（23:06:40.051 / 42.333 / 44.603 / 46.897，约 2s 一个），与 `WATCH_INTERVAL_AVOIDED_MS = 2000` 一致 ⇒ 全屏/游戏/办公时子进程创建频率约降一半。手动隐藏态由 A8 源码断言与 A6 e2e 覆盖，未单独采样（判定 spawn 应为 0）。

未验证 / 边界 [未核验]：① 内存占用未改善（本轮未改 Electron 多进程架构，351 MB 是固有开销）；② 「游戏/办公全屏时是否真的更轻」「退出全屏恢复的约 2s 延迟是否可接受」只有真人长期使用能验；③ 手动隐藏态 spawn=0 只有源码与 A6 行为断言，无独立运行时采样；④ 多显示器、F4 最大化窗口判定的既有/环境失败未修（不在本轮范围）；⑤ 未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 攒批）。

临时探针：曾在 `pollOnce()` 加过一行调试日志（`join_tmp()` 未定义），随即删除，未构建、未运行、未留进交付提交。

## 验收记录

（留空：本轮按批攒独立验收）
