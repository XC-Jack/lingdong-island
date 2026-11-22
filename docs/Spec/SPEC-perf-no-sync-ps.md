# SPEC：点击路径去掉同步 PowerShell（治「点一下就卡」）

- 建立日期：2026-11-22
- 基线：`main` `dfc4f20`（docs: 合并视觉设计规范入框架）
- 任务分支：`perf-no-sync-ps`
- 用户原话（2026-11-22，附视频）：「是在别人的电脑上出现的一些bug，不是一次性的，是只要一点击切换就卡，确实有很多人反应就是这个岛在使用过程中很卡……我自己感觉这个软件对电脑的适配性不高」
- 用户授权（2026-11-22）：「你做吧，我也看不懂」——按对话里给出的三批方案执行第一批，电量/网络允许「稍后刷新」，生产诊断写文件可收。

## 〇、问题定位（[实测]，本机 i5-12450H / SSD / 125% 缩放，隔离实例）

| 测量 | 结果 |
|---|---|
| 真派发 `pointerdown` 后，主进程回一条空 IPC | **942 / 996 / 955 ms**（3 轮，缓存过期时） |
| `statusSnapshot()` 冷读 / `statusRefresh()` | 976 ms / 945 ms |
| 那条状态 PowerShell 脚本本身 | 830–925 ms（墙钟 1.07–1.17 s） |
| 进程启动 → 界面可交互 | **5.95 s**；前 11 秒主进程同步起了约 18 个 `powershell.exe`（每个 280–600 ms） |
| 切一次页 → 窗口被真实 resize | 9–19 次、跨 400–520 ms（`TWEEN_MS 500 / 8ms` 的 setBounds 补间，属第二批） |

根因链：

1. `App.tsx` 在 capture 阶段挂 `pointerdown → statusSnapshot()`，**岛里任何一次点击**都会触发；
2. `statusStore.ts` 的 `readStatus()` 是 `spawnSync`，主进程整段阻塞；缓存 `CACHE_MS = 10_000`，而渲染层兜底轮询是 **15 s** → 每 15 秒里有 5 秒缓存是过期的，约三分之一的点击必然撞上，且**不发点击也会每 15 秒卡一次**；
3. `notifyIconStore.ts` / `shelfStore.ts` 的图标解析是 4 段 `spawnSync` 串行（280–600 ms 一段），启动、首次见到某个通知来源应用、首次见到某扩展名时各冻结 1.5–2.5 s；
4. `notifyStore.ts` 的 `openSource` 兜底用 `spawnSync('cmd.exe', ...)`。

本机是 0.95 s；杀软扫描 / WMI 慢 / 机械盘的机器上是 2–5 s，卡片即来自此。

## 一、目标

把「主进程在 UI 线程上同步等子进程」从**点击路径与启动路径上彻底去掉**：岛的任何点击都不再可能冻结主进程，启动不再被同步 PowerShell 拖到 6 秒；电量/网络的「稍后刷新」成为可接受代价。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/runPs.ts` | 新增 `runPowerShellArgs()`（跑 `-File` 脚本用，异步 + 超时 kill），复用现有 `runPowerShellRaw()` 的约定 |
| `src/main/statusStore.ts` | `readStatus()` 的 `spawnSync` → 复用 `runPowerShellRaw()`；拆出纯函数 `parseStatusOutput()`；单飞（并发请求共用一次读）；`CACHE_MS` 10 s → 60 s；`status:snapshot` / `status:refresh` 改为 `await` 异步读（不阻塞主进程） |
| `src/main/notifyIconStore.ts` | 四段 `spawnSync` → 异步；`appIcon()` 拆成「同步只查缓存」`appIconCached()` + 「后台队列解析」`ensureAppIcon()`（并发 1，成功/失败都进缓存），解析完成回调通知调用方 |
| `src/main/notifyStore.ts` | 用 `appIconCached()` 读列表；`refresh()` 后把没图标的来源入队；图标就绪后重读一次并推 `island:notify-icons-updated`（带最新列表）给岛；`openSource` 的 `spawnSync('cmd.exe')` → 异步 `spawn` + `unref` |
| `src/main/shelfStore.ts` | `systemIconPng()` 的 `spawnSync` → 异步（同 key 单飞），`shelf:icon` 处理器改 async |
| `src/main/index.ts` | `appendDiagLog()` 的 `appendFileSync` → 异步 `appendFile`（探针照旧可用，主线程不再等盘） |
| `src/renderer/src/App.tsx` | 删掉 `pointerdown → statusSnapshot`（capture 监听）；轮询 15 s → 60 s；NotifyPanel 订阅 `island:notify-icons-updated` 直接套用主进程推来的列表 |
| `src/preload/index.ts` / `index.d.ts` | 新增 `onNotifyIconsUpdated()` 订阅 |
| `scripts/perf-click-latency.mjs`（新） | 回归护栏：隔离实例量「启动 → 界面可查」「pointerdown → 主进程空 IPC 往返」，并静态断言 `src/main/**` 里没有 `spawnSync` |
| `docs/facts/技术方案.md` | 「电量」一行同步口径改为异步 |
| `docs/状态.md` | 顶部一句话状态 |

## 三、预期行为

1. 岛内任何点击都不再触发主进程阻塞；`pointerdown` 不再拉状态。
2. 电量/网络：缓存新鲜时立刻返回；过期时**先返回上次的值**并在后台重读，读完通过 `island:status-changed` 广播更新（用户可见：点开岛时图标可能是上一秒的值，1 秒内自己刷新）。`statusSnapshot()` / `statusRefresh()` 仍返回真实读数（IPC 变成异步等待，不再冻主进程）。
3. 插拔电源、休眠恢复、`online/offline`、TCP 探针翻转的响应路径不变（颜色仍由事件当场翻转）。
4. 通知图标：列表先返回、图标缺失时显示文字徽标；后台解析完把新列表推给岛，图标原地补上（不重放淡入动画、不动已读水位）。
5. 置物架图标：先出 SVG 折角纸片，PNG 就绪后替换（与现在失败退化一致）。
6. 首次解析仍会起 PowerShell，但**不再阻塞任何 IPC / 窗口动画**。
7. 无新依赖、无新配置项、无界面结构变化。

## 四、必要依赖

无新增依赖。复用 `node:child_process` 的 `spawn`、现有 `runPs.ts`、`ipcRenderer`/`contextBridge`。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2 `node scripts/perf-click-latency.mjs`：启动到 `.island` 可查 **< 2500 ms**（实测基线 5953 / 5979 ms）；缓存过期后 `pointerdown` → 主进程空 IPC 往返 **P95 < 50 ms**（基线 942 / 996 / 955 ms）。
- A3 同一脚本静态断言 `src/main/**/*.ts` 的 `spawnSync` 命中数为 **0**。
- A4 回归（受本次改动影响的路径）：`scripts/e2e-m3.mjs`（statusSnapshot 真实数据）、`scripts/e2e-wifi.mjs`、`scripts/e2e-battery-push.mjs`、`scripts/e2e-battery-states.mjs`、`scripts/e2e-bell-notify.mjs`、`scripts/e2e-code-hint.mjs`、`scripts/e2e-exit-and-shelf-view.mjs`。
- A5 通知图标：隔离实例里伪造一条带未知来源的通知不可能（wpndatabase 只读），改为**代码路径验证**：队列函数在假短名下返回 null 且不抛、并发 5 个短名时同时最多 1 个 PowerShell 在跑（脚本里用 `Get-Process powershell` 采样或日志断言）。
- A6 手动：预览版点岛展开 / 连点圆点切页 / 打开通知与置物架页，主观上不再有「点一下停半秒」。

## 六、不做什么

- 不动窗口几何（`animateTo` 的 500 ms setBounds 补间、CSS `transition`）——第二批，单独 SPEC。
- 不改 `App.tsx` 的组件结构 / 不拆文件 / 不加 memo——第四批。
- 不合并轮询定时器、不给音乐桥加空闲超时、不动 `fullscreenWatch` 心跳频率——第三批。
- 不删 `collapse-log.txt` / `startup.log` 诊断机制（只把同步写改异步）；不做日志轮转。
- 不改 `softwareResidue*` / `cleanupStore`（那批本来就走异步 `runPs`，不在点击热路径）。
- 不碰 `notifyStore` 的横幅判定、已读/清空水位语义。
- 不打包、不合并回 `main`、不发版。

## 七、自检记录

### 7.1 改动落点（[实测] 读代码确认）

| 文件 | 实际改动 |
|---|---|
| `src/main/runPs.ts` | 新增 `runPowerShellArgs(args, timeoutMs)`（`-File` 脚本用，异步 + 超时 kill），HEAD 注释写明「主进程不许出现 spawnSync」 |
| `src/main/statusStore.ts` | 删掉 `readStatus()` 的 `spawnSync`；新增 `STATUS_SCRIPT` 常量、纯函数 `parseStatusOutput()`、单飞 `readStatusOnce()`、`applyRead()`（事件优先窗口逻辑原样搬过去）、`refreshAndBroadcast()` 改 async；`CACHE_MS` 10 s → 60 s；两个 IPC 改 `await`；`stopStatus()` 清 `reading` 引用 |
| `src/main/notifyIconStore.ts` | 四段 `spawnSync` → 异步（`runPowerShellRaw` / `runPowerShellArgs`）；`appIcon()` 拆成同步 `appIconCached()`（只查内存+磁盘缓存）+ 后台队列 `ensureAppIcon()`（一次一个，成功/失败都落缓存）+ `initIconCache(onResolved)` 回调 |
| `src/main/notifyStore.ts` | `readWpnDatabase` 用 `appIconCached()`；`refresh()` 末尾把没图标的来源 `ensureAppIcon()`；新增 `onIconResolved()`（去抖 200 ms → 重读列表 → 推 `island:notify-icons-updated`）；`openSource` 的 `spawnSync('cmd.exe')` → 异步 `spawn` + `unref`；`stopNotifyStore` 清 iconFlush 定时器 |
| `src/main/shelfStore.ts` | `systemIconPng()` → `Promise`，缓存命中直接 resolve，未命中去排队；同 key 单飞（`iconPending`）+ 不同 key 串行（`runSerial`，避免一页 10 个 PowerShell 同时在跑）；`shelf:icon` 处理器改 async |
| `src/main/index.ts` | `appendDiagLog()` 的 `appendFileSync` → `appendFile`（探针照旧，主线程不等盘） |
| `src/renderer/src/App.tsx` | 删掉 `pointerdown → statusSnapshot` capture 监听与 15 s 轮询（改 60 s）；NotifyPanel 新增 `onNotifyIconsUpdated` 订阅，直接套用主进程推来的列表 |
| `src/preload/index.ts` | 新增 `onNotifyIconsUpdated(cb)`（返回取消订阅函数） |
| `scripts/perf-click-latency.mjs` | 新增回归护栏（P1 静态断言 / P2 启动 / P3 点击延迟） |
| 文档 | `docs/facts/技术方案.md`（电量与图标两行口径 + 一条决策记录）、`docs/facts/功能清单.md`（通知图标后台队列）、`docs/状态.md` |

### 7.2 命令与结果（[实测]）

- `npm run typecheck` → **EXIT=0**（node + web 两段都过）。
- `npm run build` → **EXIT=0**（`out/renderer/assets/index-*.js` 147.51 kB）。
- **`node scripts/perf-click-latency.mjs` → 全部通过**：
  - P1 `src/main` 里 `spawnSync(` 命中数 **0**（改前 9 处）。
  - P2 启动到 `.island` 可查 **702 ms**（改前 5953 / 5979 ms）。
  - P3 后台正在读状态时，pointerdown → 主进程空 IPC 往返 **P95=10 ms、P50=1 ms**（样本 `[1,1,1,1,1,10]`；改前同步实现 942 / 996 / 955 ms）。
  - `statusSnapshot()` 仍返回真实读数：`{"battery":31,"charging":true,"wifi":{"connected":true,"online":true,"name":"GZHL_Student 3","kind":"wifi"}}`。
- 回归（均 EXIT=0）：
  - `node scripts/e2e-m3.mjs` → PASS（`statusSnapshot` 真实数据、收起态时钟正常）。
  - `node scripts/e2e-wifi.mjs` → PASS（快照 wifi 字段、图标 kind/文案/aria、DOM 顺序）。
  - `node scripts/e2e-battery-push.mjs` → **23 过 / 0 败**。关键：「颜色由事件当场变、百分比晚 1 秒以上才到」的两段语义没被异步破坏（P3-13 / P3-14b / P3-20）；`out/main/index.js` 还原字节一致。
  - `node scripts/e2e-battery-states.mjs` → **31 过 / 0 败**。
  - `node scripts/e2e-bell-notify.mjs` → 15 过 / 0 败 / 0 跳过。
  - `node scripts/e2e-code-hint.mjs` → 10 过 / 0 败。
  - `node scripts/e2e-exit-and-shelf-view.mjs` → PASS（含 quitApp 退出、置物架视图持久化）。

### 7.3 额外探针（`.tmp/`，不进交付提交）

- 通知图标后台队列：清掉隔离目录的 `notify-*.png` 后启动——列表首次 **2 ms** 返回 47 条、有图的先给有图的；后台 25 秒内补齐并推了 **12 次** `island:notify-icons-updated`；期间 click→IPC **P50 1 ms / max 2 ms**；PowerShell 峰值进程数 4（含常驻全屏辅助进程），证明队列是一次一个。
- 置物架图标：新扩展名首次 **488 ms**（异步）、同扩展名第二次 **0 ms**；同时请求 4 种新扩展名总 **2601 ms**（串行 ≈650 ms/个）、4 个全部成功，期间点击延迟 **max 9 ms**。

### 7.4 未验证的范围（必读）

1. **只在本机（i5-12450H / SSD / 125% 缩放）测过**。用户反馈卡的那台机器（视频里那台）无法接触：本机 0.95 s 的冻结在那边应是 2–5 s，改后同为「不再阻塞」；但「那边到底是不是这个原因」仍未被对方机器证实。**想确认需要**：对方升级后体感对比，或取 `%APPDATA%\lingdong-island\startup.log` 与任务管理器读数（见状态文档留下的核对方法）。
2. **打包版已验（2026-11-22 合并后补测）**：安装版 `灵动岛.exe --remote-debugging-port=9321 --user-data-dir=.tmp/pkg-ud` 实测——启动到界面可查 **633 ms**；读在飞时 `pointerdown` → 主进程空 IPC **P50 1 ms / P95 8 ms**；`statusSnapshot` 返回真实读数；`startup.log` 里 `whenReady ok` → `update: armed` 只隔 **46 ms**（改前同两行隔 5.5 s）。
3. **真实新通知到达时的图标补齐**：本机通知库是历史数据，没有制造「陌生应用新通知」；用的是历史列表 + 清空图标缓存来验证队列，未验真实新来源应用的端到端（图标出现时机 / 是否影响横幅）。
4. **网络真断/真连**：只验了「读到的快照字段正确」，没有拔网线实测图标在多少秒内翻转（判据路径未改，只是改异步 + 缓存变长）。
5. **电量百分比在 60 秒缓存 + 事件驱动下的边界**：插拔电源仍由 `powerMonitor` 事件 + 300 ms 补读负责（e2e 已验），但「系统不发事件的机器」（看门狗兜底那条）只靠 1 s 采样 `powerMonitor.isOnBatteryPower()`，未在真机上复现。
6. **窗口几何仍是第二轮**：切页时 500 ms 的 setBounds 补间没动，弱机器上仍可能顿（SPEC 六节已写明不做）。

## 八、验收记录

**验收方式（重要，别当成独立验收）**：本节的核对于 2026-11-22 由**参与实现的同一个会话**完成，**不满足** `docs/工程规则.md` 第三节「由未参与本次实现的会话/人核对」的要求。它只解决「交付前有没有漏项」，规则意义上的独立验收仍需另起一个会话对 `main` `8b23f3c` 做一次（四个 SPEC 一起）。

**核对基准**：提交 `8b23f3c`；`git diff 3e0f195 HEAD -- src/ scripts/ docs/Spec/` 为空 ⇒ 代码与今日跑 e2e 的分支尖端逐文件相同，因此下面「引用今日运行」的条目指向同一份代码，不是另一次构建。装好的安装版 `D:\软件\灵动岛\` 为 0.4.2（asar SHA `AE0EBBC7…69395214`）。

| 条件 | 结果 |
|---|---|
| A1 typecheck / build | ✅ 重跑，均 EXIT=0 |
| A2 启动 < 2500 ms、点击 P95 < 50 ms | ✅ **打包版**实测：启动 **675 ms**；读在飞时 `pointerdown` → 空 IPC **P50 1 ms / P95 8 ms**；`statusSnapshot` 返回真实读数（电量 92%、Wi-Fi 名正确） |
| A3 `src/main` 无 `spawnSync(` | ✅ 去注释后静态扫描 **0 处** |
| A4 回归 e2e | ✅ 引用今日同一份代码的运行：`e2e-m3` PASS、`e2e-wifi` PASS、`e2e-battery-push` 23/0、`e2e-battery-states` 31/0、`e2e-bell-notify` 15/0、`e2e-code-hint` 10/0、`e2e-exit-and-shelf-view` PASS |
| A5 图标后台队列 | ✅ 引用今日运行：列表首次 2 ms 返回 47 条，25 秒内补齐并推 12 次事件，期间点击 P50 1 ms / max 2 ms，PowerShell 峰值 4 个 |
| A6 手动体感 | ⚠️ 未验（需真人在弱机器上体感） |

**结论**：A1–A5 通过，A6 未验。

---

## 九、独立验收（2026-11-22 / 提交 `109465f`）

**验收方式**：由**未参与实现**的会话执行；对象是 `main` 的 `109465f`（工作树干净，`git status` 空）。
所有测试都用 `out/` 里**从该提交重新构建**的 dev 版 + 隔离 userData（`--user-data-dir=.tmp/acceptance/…`，
或 e2e 自带的 `scripts/isolate-userdata.mjs`）；真实数据目录 `%APPDATA%\lingdong-island\` 的 json/log
mtime 全程未变（只剩安装版自己在写的 `startup.log` / `avoid-mode-beat.txt`）。

| 条件 | 判定 | 实测证据 |
|---|---|---|
| A1 typecheck / build | ✅ 通过 | `npm run typecheck` EXIT=0（node + web 两段）；`npm run build` EXIT=0（`index-PforF8hV.js` 150.88 kB） |
| A2 启动 < 2500 ms、点击 P95 < 50 ms | ✅ 通过 | `node scripts/perf-click-latency.mjs`：启动 **738 ms**；读在飞时 `pointerdown` → 空 IPC **P95=8 ms / P50=1 ms**（样本 `[1,1,1,1,1,8]`）；`statusSnapshot` 真实读数 `{"battery":94,"charging":true,"wifi":{..."GZHL_Student 3"}}` |
| A3 `src/main` 无 `spawnSync(` | ✅ 通过 | 同一脚本 P1：去注释后命中 **0 处** |
| A4 回归 e2e | ✅ 通过 | `e2e-m3` PASS；`e2e-wifi` PASS（4 条 A1–A4 全过）；`e2e-battery-push` **23 过 / 0 败**；`e2e-battery-states` **31 过 / 0 败**；`e2e-bell-notify` **15 过 / 0 败 / 0 跳过**；`e2e-code-hint` **10 过 / 0 败**；`e2e-exit-and-shelf-view` PASS |
| A5 图标后台队列 | ✅ 通过（一条只有代码证据，见下） | 隔离实例（全新 userData，无 `icon-cache`）：首次列表 **21–36 ms** 返回 50 条 / 9 个来源（首帧已有 15–16 条带图）；30 s 内推 `island:notify-icons-updated` **11 次**（时间点间隔 0.3–1.4 s），带图数 **15 → 45**，其余保持文字徽标兜底。**串行性用进程级采样证明**：采样器按「父进程 = 本实例主进程 + 命令行含 `Get-AppxPackage`/`SHGetFileInfo`/`App Paths`/`extract-notify-icon`」计数，32 s 内约 320 次采样，**MAX_ICON=1**（若按来源并行应为 9） |
| A6 手动体感 | ⚠️ **未验证** | 需要真人在弱机器上主观判断，本会话无法替代 |

**A5 的例外（必须写明）**：A5 里的「队列函数在**假短名**下返回 null 且不抛」**没有可执行入口**（`ensureAppIcon()`
是主进程内部函数，不走 IPC），只能算**代码核对**：`pump()` 对 `resolveIcon()` 包了 try/catch → `png=null` → 记入
`failed`，且 `queued` Set 去重。这条不是本轮跑出来的观测。

**装机版对应关系（[实测]）**：安装版 `D:\软件\灵动岛\resources\app.asar` 里的 `out/main/index.js`（414473 B）、
`out/preload/index.js`（20750 B）、`out/renderer/index.html`、`out/renderer/assets/index-PforF8hV.js`（150883 B）
与本提交重新构建的产物**逐字节相同** ⇒ 装机 0.4.2 就是这一份代码。

**顺带发现（只记录、未修）**：`src/main/startupLog.ts` 仍是 `appendFileSync`，即「主线程同步写盘」还留着一处。
它不在本 SPEC A1–A6 任何一条的判据内（A3 只禁 `spawnSync`），但和「点击路径不留同步 I/O」的意图不完全一致，
建议另开 SPEC 评估。

**证据留存**：`.tmp/acceptance/*.log`（e2e 输出）与该目录下的探针脚本（`perf-click-latency.mjs` 的输出见本节引用）。
