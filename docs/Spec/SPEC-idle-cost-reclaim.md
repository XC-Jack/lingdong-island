# SPEC：第三批 · 常年占用回收（音乐桥空闲回收 / CDP 轮询分档 / 日志轮转）

- 建立日期：2026-11-22
- 基线：分支 `island-window-resize`（`906788d`）。叠在第二批上是为了避免 `src/main/index.ts` 冲突；`main` 仍是 `3981b62`（第一批已合并）。
- 任务分支：`idle-cost-reclaim`
- 承接：`SPEC-perf-no-sync-ps` 第三批「治常驻占用」清单。

## 〇、问题（[实测]，2026-11-22）

| 项 | 实测 |
|---|---|
| 音乐桥（PowerShell + WinRT） | 打开一次音乐页就**永久常驻**：RSS **116.3 MB**、40 秒里烧 **1.77 s CPU（≈4.4% 单核）**，每秒 `poll` + 每秒 `appvol` |
| 网易云 CDP 轮询 | `setInterval(…, 1000)` 从启动就跑；`isNeteaseRunning()` 用 `tasklist.exe` 子进程、缓存 2 s ⇒ **每 2 秒起一个 tasklist**，有没有人在用音乐页都一样 |
| `startup.log` | 只追加不轮转，本机已 2400+ 行 |
| `collapse-log.txt`（US-036 诊断探针） | 每次窗口失焦/收起同步写一行，**打包版也在写**；US-036 已收口，探针对用户没有价值 |

（`docs/状态.md` 里「第三批」条目、`SPEC-perf-no-sync-ps` 第六节「不做什么」都指向这三项。）

## 一、目标

把「用户根本没在用音乐页」时的常驻成本降下来：桥接子进程 2 分钟没需求就回收（释放约 116 MB / 4% 单核），CDP 轮询在没需求时降到 5 秒一档，日志不再无限增长、生产不再写排障探针。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/musicStore.ts` | ① 新增 `bridgeDemandUntil` + `touchBridgeDemand()` + `BRIDGE_IDLE_MS = 120_000`；`music:get`/`music:control`/`music:set-source` 续期；新增 IPC `music:demand`（渲染层音乐页挂载/卸载时报）；在已有的 1 秒 CDP 定时器里检查「空闲到期 → `killBridge()` + 状态清空 + 广播 + 记一行 startup.log」。② CDP 轮询分档：门控 `nextCdpAt`，有需求（页面开着 / 已有 CDP 会话）1 秒、空闲 5 秒；**不新增定时器** |
| `src/main/neteaseCdp.ts` | `isNeteaseRunning()` 的 `tasklist` 缓存 2 s → 6 s（配合 5 秒档，空闲时 `tasklist` 从每 2 秒一次降到约每 10 秒一次） |
| `src/preload/index.ts` | 新增 `musicDemand(on: boolean)` |
| `src/renderer/src/App.tsx` | MusicPanel 挂载时 `musicDemand(true)`、卸载时 `musicDemand(false)`（一处即可，`MusicSourceChip` 只在音乐页内渲染） |
| `src/main/startupLog.ts` | 超过 1 MB 轮转成 `startup.log.1`（只留一份），失败不影响写日志 |
| `src/main/index.ts` | `appendDiagLog()` 在打包版直接返回（诊断探针只在开发版写） |
| 文档 | `docs/facts/技术方案.md` 决策记录 + 音乐一行、`docs/状态.md` |

## 三、预期行为

1. 打开音乐页 → 桥接起来（与现在一致，1–2 秒内出数据）；**离开音乐页 2 分钟后**桥接被回收，内存/CPU 归还；再打开音乐页会重新拉起（会先显示空态约 1–2 秒）。
2. 桥接被回收时，音乐状态清空并广播（此时页面不在音乐页，用户看不到跳变）。
3. 不在音乐页、也没有网易云 CDP 会话时：CDP 轮询 5 秒一档；一旦进音乐页或检测到 CDP 会话，回到 1 秒一档。
4. 自动开启网易云调试端口的功能不变（只是检测粒度从 1 秒变 5 秒）。
5. `startup.log` 超过 1 MB 时轮转一份 `.1`；`collapse-log.txt` 只在开发版产生。
6. 播放/暂停等控制行为不变；音乐页开着时仍每秒推送状态。

## 四、必要依赖

无。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2（隔离实例 CDP）打开音乐页后主进程下存在常驻 `powershell.exe`（桥接）；把页面切离音乐页后等 **130 秒**，该进程消失；再进音乐页，1–2 秒内重新出现。
- A3 桥接被回收后 `music:get` 返回 `active:false` 的空态（不会残留上一首）。
- A4 `startup.log` 轮转：预置一个 > 1 MB 的 `startup.log` 后启动（隔离 userData），启动后 `startup.log.1` 存在且大小 > 1 MB、新 `startup.log` 重新从启动行开始。
- A5 回归：`e2e-music`、`e2e-music-session`、`e2e-m4`、`e2e-code-hint`（剪贴板轮询未动，作对照）、`e2e-collapse-order`、`e2e-avoid-mode`、`scripts/perf-click-latency.mjs`。
- A6 空闲 60 秒的主进程 CPU 不高于改动前（本机基线：15 秒 0.17 s ≈ 主进程 1.1% 单核）。

## 六、不做什么

- **不做「统一调度器」重构**：把 9 个定时器合并成一个调度器是结构改动，收益主要在可维护性，风险却覆盖全仓；本轮只做有量化收益的三项。
- 不动剪贴板 1 s 轮询（`clipboard.readText()` 在主进程，实测开销极小，且验证码提示的实时性依赖它）。
- 不动全屏避让的辅助进程（120 ms 心跳）——那是避让响应速度的核心，代价已由 `SPEC-perf-poll-throttle` 定过档。
- 不动通知库 30 s 轮询 + 文件监听。
- 不合并回 `main`、不打包、不发版。

## 七、自检记录

### 7.1 命令与结果（[实测]）

- `npm run typecheck` → **EXIT=0**；`npm run build` → **EXIT=0**。
- **A2/A3（隔离实例 CDP，端口 9390）**：进音乐页前 `smtc-bridge` 进程数 1（那个是**已安装版** 0.4.1 自己开着的，不是本次实例）；点进音乐页 4 秒后 **2**（本实例桥接起来了）；切离音乐页 3 秒后仍 2；切离 **126 秒后回到 1**（本实例的桥接被回收）；此时 `music:get` 返回 `active:false` 的空态（不是残留上一首）；再进音乐页 4 秒后回到 **2**（重新拉起）。
- **A4 日志轮转**：预置 1_200_000 字节的 `startup.log` → 启动后 `startup.log.1` 存在且 1,200,000 字节，新 `startup.log` 只有 **479 字节**且含 `=== 启动` 行。
- **A6 空闲占用（30 秒采样，隔离实例）**：electron 进程 CPU 增量 **0.59 s ≈ 2.0% 单核**（改前同一台机器分别量到主 1.1% + 渲染 0.6% + GPU 0.9% ≈ 2.6%）；期间 `tasklist.exe` 出现 **5 个/30 秒**（旧实现每 2 秒一个 ⇒ 约 15 个）。内存 383 MB（未变，本轮不降基础内存）。
- **A5 回归**：`e2e-music` **17 过 / 0 败 / 3 跳过**；`e2e-music-session` SKIP（本机构造不出「≥2 会话且播放中的不在索引 0」，环境限制，脚本自己判定前置不成立）；`e2e-m4` PASS；`e2e-code-hint` 10 过 / 0 败；`e2e-collapse-order` 22 过 / 0 败；`e2e-avoid-mode` 15 过 / 0 败；`scripts/perf-click-latency.mjs` 全过（启动 705 ms、点击 P95 9 ms）。

### 7.2 一个实测发现（不算 bug，但值得记住）

探针里进音乐页前就已经有 1 个 `smtc-bridge` 进程——那台机器上**已安装版**（0.4.1）自己开着的，不是孤儿进程。父进程被 `taskkill /T` 杀掉时，子进程的 stdin 会被关闭、`ReadLine()` 返回 `$null` 从而自行退出，所以强杀不会留下 116 MB 的孤儿。这条是推断 + 观测一致，但**没有**专门做「强杀主进程后桥接是否残留」的对照实验。

### 7.3 未验证的范围

1. 打包版未测（本轮不打包）；`appendDiagLog` 的「生产版不写」是用 `app.isPackaged` 判断的，只有打包版才走得到那条分支——本轮**没有**打包，所以这条分支只在代码上成立，未实机验证。
2. 「离开音乐页 2 分钟回收」只在隔离实例上验过；真实使用中「切走又切回」的体感（重进音乐页会有 1–2 秒空态）没有真人评估。
3. 有歌在播、但用户长时间不在音乐页时桥接仍会被回收（本轮设计如此），这时**桌面歌词**（走 CDP，不走桥接）不受影响，但没有任何界面提示「音乐状态暂停刷新」——没有验证用户会不会觉得奇怪。
4. A6 的 CPU 对比是两次不同时间的采样（不是同一进程 A/B），只能算量级一致。
5. 16 位 Unicode/多用户场景未涉及。

## 八、验收记录

（独立验收后补）
