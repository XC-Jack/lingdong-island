# SPEC：`startup.log` 异步写盘（主线程不再在避让切换时等磁盘）

- 建立日期：2026-11-22
- 基线：`main` `6b008c7`
- 任务分支：`startup-log-async`
- 来源：`SPEC-perf-no-sync-ps` 独立验收时记录的一条「顺带发现（只记录、未修）」——`src/main/startupLog.ts` 仍是 `appendFileSync`。用户 2026-11-22 说「都可以」，同意收掉。

## 〇、为什么要改（[实测] + [推断]）

- `startupLog()` 是同步 `appendFileSync`（每行一次写 + 一次 `statSync` 轮转检查）。
- 它的调用点里有一条在**全屏避让的切换瞬间**：`fullscreenWatch.ts` 的 `avoidLog()`，每次岛隐藏/现身都写一行——也就是用户切进/切出全屏游戏的那一刻。同步 I/O 落在这种时刻是最不该的。
- 单次成本很小（SSD 上 0.1–0.5 ms），所以这不是「卡顿主因」，只是把 `SPEC-perf-no-sync-ps` 定下的「主线程不做同步 I/O」补齐。

## 一、目标

`startupLog()` 变成异步、且**保持日志顺序**；唯一的例外是「进程即将退出」的 FATAL 路径——那条必须同步落盘（异步写会随进程一起消失）。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/startupLog.ts` | `startupLog()` 改异步：串行队列（`queue = queue.then(...)`，保证同行序）+ `fs/promises` 的 `mkdir/stat/rename/rm/appendFile`；时间戳在**调用时**取（不是写盘时），避免排队导致时间错位；失败仍然全吞。新增 `startupLogSync()`：同步版，只在即将退出的路径上用 |
| `src/main/index.ts` | `uncaughtException` 那条 `FATAL` 改用 `startupLogSync`（写完还要弹原生错误框再 `app.exit(1)`） |
| `scripts/e2e-avoid-mode.mjs` | `countAvoidLines()` 改成「等日志稳定」：每 120 ms 读一次，连续两次相同或 1.5 s 超时才算最终值（异步写盘后，动作刚结束就读可能少算一条）。断言内容不变 |
| 文档 | `docs/facts/技术方案.md` 决策记录一行、`docs/状态.md` |

## 三、预期行为

1. 所有日志行最终都会落盘，且**顺序与调用顺序一致**（同一毫秒内的多行也按调用序）。
2. 轮转行为不变：文件超过 1 MB → 改名 `startup.log.1`（只留一份），然后继续追加。
3. FATAL（未捕获异常）那条仍然同步写完再退出，用户拿到的 `startup.log` 里一定有这条。
4. 日志写失败（磁盘只读、文件被占用）一律静默，不影响任何功能。
5. 用户可见行为零变化。

## 四、必要依赖

无（`node:fs/promises`）。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2（隔离实例）启动后 `startup.log` 里出现本次启动行（`=== 启动 version=…`）与 `whenReady ok, creating window`；等 500 ms 后 `update: …` 行也在（证明异步写真的落盘）。
- A3 顺序：连续 200 次 `startupLog('seq-<n>')` 之后，文件里 `seq-0…seq-199` 严格递增、无丢失——用一个临时探针在主进程里跑（`--inspect` 或临时脚本），或退化为「至少不丢行、不乱序」的等价检查。
- A4 轮转：预置 1.2 MB 的 `startup.log` → 启动后 `.1` 存在且 = 1,200,000 B，新文件从启动行开始。
- A5 回归：`e2e-avoid-mode`（唯一读 `startup.log` 的 e2e）15 过 / 0 败；`scripts/perf-click-latency.mjs` 全过。

## 六、不做什么

- 不改日志内容、不改轮转阈值（1 MB）、不加日志级别。
- 不引入日志库、不做多文件/按天轮转。
- 不动 `collapse-log.txt`（开发版探针，已经是异步 + 生产不写）。
- 不合并回 `main`、不打包、不发版（等用户点头）。

## 七、自检记录

### 7.1 命令与结果（[实测]）

- `npm run typecheck` → **EXIT=0**；`npm run build` → **EXIT=0**。
- **A2 + A3 + A4（隔离实例，端口 9398；预置 1,200,000 B 的 `startup.log`）**：
  - `.1` 大小 **1,200,000 B**（轮转在异步路径下同样生效）；
  - 新 `startup.log` 3 行，**顺序正确**：`=== 启动 …`（13:12:29.509）→ `whenReady ok, creating window`（.537）→ `update: dev mode, checks disabled`（.604）；
  - 三行时间戳递增 ⇒ 串行队列保证「调用顺序 = 落盘顺序」，异步写确实落盘。
- **A5 回归**：`e2e-avoid-mode` **15 过 / 0 败**（唯一读 `startup.log` 的 e2e，`countAvoidLines()` 改成等日志稳定后仍全过）；`scripts/perf-click-latency.mjs` 全过（启动 712 ms、点击 P95 12 ms、`spawnSync` 0 处）。

### 7.2 未验证的范围

1. **A3 的 200 行压测没做**：`startupLog` 不在全局作用域，无法从调试端口直接连调；只用「同一次启动里 3 行毫秒级连写顺序正确」+「队列实现（`queue = queue.then(...)`）」两重证据代替。高并发下不丢行的结论是**代码层面**的，不是压测出来的。
2. **FATAL 同步路径未实机触发**：`startupLogSync` 只在 `uncaughtException` 里用，要造一次未捕获异常才能验；本轮没造（会弹错误框并退出）。
3. 打包版未测（本轮不打包）。

## 八、独立验收

（另起会话后补）

## 八、独立验收

（另起会话后补）
