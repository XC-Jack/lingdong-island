# SPEC：充电判定修正 + 去掉充电小闪电

> 任务分支：`battery-charge-low-indicator`（沿用上一轮分支，因为改的是同一块电量显示，尚未合并回 `main`）。
> 基线：上一轮固定提交 `2c71cca` + 闪电修正 `2aaa9c0`。
> **固定提交：`0dfcc8f56acf6e947f59fa9980987b4b052cf12c`（短哈希 `0dfcc8f`）**——独立验收请针对这个提交逐条重跑 B1–B6。
> 起因：用户 2026-11-09 17:06 原文「就绿色就好，不用雷电了；还有就是我刚刚把充电拔了，他还是绿色的」。
> 时序说明：本轮先做了电源数据源探针（只读命令，未改任何文件），确认根因后才写本文件并开工；探针脚本留在 `.tmp/`，不进交付提交。

## 一、目标

两件事，都是用户当面提的：

1. **去掉充电小闪电**：只保留「充电中弧变绿」这一个视觉信号，不再在环右上角画闪电。
2. **修「拔了电还显示绿色」**：充电判定用错了字段语义，导致「插着电但没在充电」也被当成「正在充电」。

第二件的根因 [实测]（命令与输出见第七节）：
`src/main/statusStore.ts` 改动前 `:40` 原文（改动后位置为 `:44`）

```
'$b=Get-CimInstance -ClassName Win32_Battery; if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, ($b.BatteryStatus -eq 2)}else{"null|false"}',
```

用的是 `Win32_Battery.BatteryStatus -eq 2`。但 Windows 对 `BatteryStatus` 的定义是：`1`=放电中、`2`=**接着交流电但没在充电**、`3`=完全充满、`4/5`=低电/临界、`6/7/8/9`=**正在充电**。所以 `-eq 2` 判的是「插着 AC」，不是「正在充」，语义从根上错了。

本机实测（`D:\Users\honor\Documents\Project\灵动岛`，2026-11-09 17:08–17:11）：
- `Win32_Battery`：`BatteryStatus=2`、`EstimatedChargeRemaining=96`
- `root\wmi` `BatteryStatus`：`PowerOnline=True`、`Charging=False`、`Discharging=False`、`ChargeRate=0`、`DischargeRate=0`，25 秒内 `RemainingCapacity` 恒为 `45911`
- 结论：机器**插着电但没在充电**（96% 未达充电门槛），旧判定输出 `True` → 界面显示绿色充电态，与事实不符。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/statusStore.ts` | 电量行（改动后 `:44`）的充电判定：`($b.BatteryStatus -eq 2)` → `(($b.BatteryStatus -in 6,7,8,9) -or [bool]$w.Charging)`，并在一行内先取 `root\wmi` 的 `Charging` 兜底；`:84` 的 `charging = chg === 'True'` 不变（协议约定不变） |
| `src/renderer/src/App.tsx` | 删掉 case 'battery' 里的 `.ring-bolt` 闪电 SVG（改动前的 `:2404-2409`）与相关注释；`charging` state（`:1915`）、`setCharging`（`:2103`）、`low` 判定（`:2382`）、三态 className/title/aria（`:2386-2389`）全部保留 |
| `src/renderer/src/styles.css` | 删掉 `.head-battery-ring .ring-bolt` 规则块（改动前的 `:505-518`）；`.head-info .head-battery-ring svg:not(.ring-bolt)`（`:452`）还原成 `.head-info .head-battery-ring svg`（闪电不存在了，`:not()` 失去意义） |
| `scripts/e2e-battery-states.mjs` | ①patch 目标串 OLD 换成新的 PS 电量行；②断言改为「四场景一律无 `.ring-bolt`」，其余（类名/数字/title/aria/弧色/数字色）不变 |
| `docs/Spec/SPEC-battery-charging-accuracy.md` | 本文件 |
| `docs/Spec/SPEC-battery-charge-low-indicator.md` | 第一节与第二节补一句「闪电已按用户要求移除」，避免两份文档互相矛盾 |
| `docs/状态.md` | 一句话状态追加本轮修正 |
| `docs/facts/功能清单.md` | 第 5 节电量环描述从「`≤20%` 变红」升级为三态（充电绿 / 低电红 / 普通白）+ 充电判据与刷新延迟说明 |
| `docs/facts/本机约束与踩坑.md` | 「系统能力」节新增「充电判定别用 `BatteryStatus -eq 2`」踩坑条目（含四种判据对比）；「验证边界」节补注真实充电 WMI 仍未验证 |

**明确不改**：`src/preload/index.ts`（`charging: boolean` 协议不变）、`src/main/` 其它模块、阈值 20%、轮询频率（主进程缓存 30s / 渲染层 60s）、布局与组件结构、`package.json`、`out/`（构建产物，跑完 e2e 会字节还原）。

## 三、预期行为

1. **充电中**（`BatteryStatus ∈ 6,7,8,9`，或 WMI `Charging=True`）：弧绿 `rgba(75, 214, 130, 0.9)`，无闪电，title/aria = `充电中 · 电量 X%`。
2. **插着电但没在充电**（`BatteryStatus=2`、WMI `Charging=False`）：按普通态显示——弧白、无闪电、title/aria = `电量 X%`。这一条就是本轮修的 bug。
3. **没插电且 ≤20%**：弧红 + 数字红，title/aria = `电量偏低 · X%`（沿用上一轮，不变）。
4. **没插电且 >20%**：普通态（白弧、`电量 X%`）。
5. **充电且 ≤20%**：以充电为准——弧绿、无红、`充电中 · 电量 X%`（沿用上一轮优先级规则）。
6. 读不到电池（`null`）：整环不渲染（不变）。

## 四、必要依赖

无新增依赖。PowerShell 的 `Get-CimInstance -Namespace root\wmi` 是系统自带能力；`-in 6,7,8,9` 需要 PowerShell 3.0+（本机是 Windows 自带 5.1，`npm run dist` 也不改这一层）。

## 五、验收条件

| 编号 | 可亲手核对的结果 |
|---|---|
| B1 | `npm run typecheck` 退出码 0（node + web 两个子命令均无错误输出），原始输出贴进第七节 |
| B2 | 直接跑主进程取数命令，本机当前（插电未充电）输出 `96\|False`（旧判定是 `96\|True`）；第七节附命令原文与输出 |
| B3 | 四场景 e2e 全过：S1 普通 `80\|false`、S2 充电 `99\|True`、S3 充电且低电 `15\|True`、S4 低电 `15\|false`；且**四个场景一律断言无 `.ring-bolt`**（证明闪电已移除） |
| B4 | e2e 结束后 `out/main/index.js` 字节级还原（脚本内 R1 断言 `Buffer.compare === 0`） |
| B5 | 回归：`scripts/e2e-m3.mjs`、`scripts/e2e-wifi.mjs`（`:66` 断言 charging 是 boolean）、`scripts/e2e-collapse-beautify.mjs`（收起态组件顺序与显隐）全部 PASS |
| B6 | `git status --porcelain` 干净；提交只含第二节列出的文件 |

**已移除的验收项（如实记录）**：上一轮 A2/A6 里「S2/S3 有闪电」的断言本轮删除——不是没测，而是按用户要求这个元素不再存在，改由 B3「四场景一律无闪电」覆盖。

**注入方法**：沿用上一轮，e2e 把 `out/main/index.js` 里 PowerShell 电量行替换成固定字面量（PS 单引号），跑完还原并字节校验；`out/` 被 git ignore，`src/` 不受影响。真实的「正在充电」状态本机造不出来（电池 96%、`ChargeRate=0`），该路径由注入 `99|True` 覆盖，**真实硬件充电时的 WMI 读数未验证**。

## 六、不做什么

- 不改 `src/preload/index.ts` 的 IPC 协议（`charging: boolean` 原样保留）。
- 不改轮询频率（主进程 30s 缓存、渲染层 60s 轮询照旧）。已知代价：拔插电源后界面最长约 90 秒才刷新，本轮**不处理**，另行提出。
- 不加充电动画、不改绿的色值、不新增设置项、不加新组件、不挪布局。
- 不重构 `App.tsx` 其它部分（该文件 11 万字节、2700+ 行，只删闪电 6 行 + 注释）。
- 不打包、不跑 `npm run dist`、不装机、不碰 `%APPDATA%\lingdong-island\` 真实数据。
- 不合并回 `main`（等用户明确说「合并」）。
- 不删上一轮的备份目录 `.backups/battery-charge-low-indicator-20261109/`；本轮新增 `.backups/battery-fix2-20261109/`（四个改前文件）。

## 七、自检记录

角色：研发自检（实现者本人），2026-11-09，分支 `battery-charge-low-indicator`。

| 编号 | 命令 / 做法 | 实际输出 | 结论 |
|---|---|---|---|
| B1 | `npm run typecheck` | `typecheck:node`（`tsc --noEmit -p tsconfig.node.json`）与 `typecheck:web`（`-p tsconfig.web.json`）均只有命令行、无错误输出，退出码 0 | ✅ 通过 |
| B2 | 直接内联跑 `src/main/statusStore.ts:44` 那条 PS 电量行（`powershell -NoProfile -Command '...'`，与代码逐字符一致） | `96\|False`（旧判定 `-eq 2` 在同机是 `96\|True`） | ✅ 通过 |
| B3 | `node scripts/e2e-battery-states.mjs` | `== 结果：31 过 / 0 败 ==`；四个场景 DOM 快照见下 | ✅ 通过 |
| B4 | 同上（脚本内 R1） | `✓ R1 out/main/index.js 还原字节一致` | ✅ 通过 |
| B5 | `node scripts/e2e-m3.mjs` / `node scripts/e2e-wifi.mjs` / `node scripts/e2e-collapse-beautify.mjs` | m3：`[1] statusSnapshot: {"battery":96,"charging":false,...}`、`E2E PASS`；wifi：A1–A5 全通过、`E2E WIFI PASS`（A3 DOM 顺序 `head-battery-ring → collapsed-clock → collapsed-wifi → collapsed-bell`）；collapse-beautify：`7 过 / 0 败`（B3 电量环在岛仔之前） | ✅ 通过 |
| B6 | `git status --porcelain` + `git diff --stat` | 提交前只有第二节列出的文件（4 改 + 1 新增 SPEC）；工作区干净见提交时核对 | ✅ 通过 |

B3 四场景原始 DOM 快照（脚本输出照抄）：

```
S1 普通（80% 不充电） cls="head-battery-ring  "  num=80  title="电量 80%"        stroke=rgba(255, 255, 255, 0.85)  numColor=rgba(255, 255, 255, 0.92)  hasBolt=false
S2 充电（99% 充电中） cls="head-battery-ring  charging"  num=99  title="充电中 · 电量 99%"  stroke=rgba(75, 214, 130, 0.9)  numColor=rgba(255, 255, 255, 0.92)  hasBolt=false
S3 充电且低电（15% 充电中） cls="head-battery-ring  charging"  num=15  title="充电中 · 电量 15%"  stroke=rgba(75, 214, 130, 0.9)  numColor=rgba(255, 255, 255, 0.92)  hasBolt=false
S4 低电不充电（15% 没插电） cls="head-battery-ring low "  num=15  title="电量偏低 · 15%"  stroke=rgba(255, 107, 107, 0.9)  numColor=rgba(255, 107, 107, 0.95)  hasBolt=false
```

四条关键点：S2/S3 弧绿且**无** `low` 类（充电优先成立）；S4 弧红且数字红；四场景 `hasBolt` 全 false（闪电已移除）；S1 是纯白普通态。

**本轮未验证 / 已知边界（如实记录）**：

1. **真实硬件正在充电时的 WMI 读数未验证**：本机电池 96%、`ChargeRate=0`，造不出 `BatteryStatus ∈ 6,7,8,9` 的真实现场。S2/S3 的充电态是靠注入 `99|True` / `15|True` 覆盖渲染层，**不是**真实充电。`-in 6,7,8,9` 这段判据在真机充电时能否命中，本轮只有文档语义依据（Microsoft 对 `BatteryStatus` 的定义），没有现场读数。
2. **拔插电源后的刷新延迟未改**：主进程缓存 30s + 渲染层轮询 60s，最坏约 90 秒才更新。用户本轮报的「拔了还绿」根因是判据错（已修，实测命令输出已从 `True` 变 `False`），但「拔电后要等一会儿才变色」这个体验问题**本轮没处理**，另行提出。
3. **视觉未经人眼在真实界面确认**：B3 只验 DOM 与 computed style，绿色/红色到底好不好看、闪电移除后是否够醒目，要用户看。按用户要求闪电已删除，本轮不涉及闪电观感。
4. 未打包、未装机、未碰 `%APPDATA%\lingdong-island\` 真实数据。

## 八、验收记录

角色：独立验收（未参与实现的会话，独立上下文、未读实现过程）。验收对象：固定提交 `0dfcc8f`（实际跑在 `HEAD` = `4e0e194` 上，两者 `src/` 完全一致，`git diff 0dfcc8f 4e0e194` 只差本文件回填固定提交的那一行）。时间：2026-11-09 17:19–17:27。原始报告：`.tmp/独立验收-0dfcc8f.md`（24.9 KB，`.tmp/` 被 git 忽略，不进仓库）。

**结论：有条件通过，无阻断项。**

| 编号 | 独立复跑结果 |
|---|---|
| B1 | ✅ 通过。`npm run typecheck`，node/web 两条 `tsc` 均无输出，EXIT 0 |
| B2 | ✅ 通过。内联跑 `statusStore.ts:44` 电量行实测 `96\|False`；同时实测旧判据 `-eq 2` 在同机输出 `96\|True`（误报实锤）；patch 后 bundle 内同一串也 `96\|False` |
| B3 | ✅ 通过。`31 过 / 0 败`，四场景 DOM 快照与第七节逐字符一致 |
| B4 | ✅ 通过。`✓ R1 out/main/index.js 还原字节一致`；`git ls-files out` 为空 |
| B5 | ✅ 通过。m3 `charging:false` + `E2E PASS`；wifi `E2E WIFI PASS` + A3 顺序正确；collapse-beautify `7 过 / 0 败` |
| B6 | ⚠️ 有条件通过。工作区干净、无缺失文件；但提交含 9 个文件 vs 第二节表列 7 个（见 C1，已在本轮补齐表格） |

**验收方挑刺发现（C1–C5，均非阻断）**：

- **C1 范围表不全**：提交多出 `docs/facts/功能清单.md`、`docs/facts/本机约束与踩坑.md`，第二节表未列。→ 本轮已补进第二节表。
- **C2 行号漂移**：正文写 `statusStore.ts:80`（实际 `:84`）、B2 写 `:43`（实际 `:44`）、App.tsx 闪电写 `:2403-2408`（实际删除 `:2404-2409`）。→ 本轮已订正。
- **C3** `scripts/e2e-collapse-beautify.mjs:64` / `:156` 用 `taskkill /IM electron.exe /T /F` 按镜像名全杀，会误伤并发运行的 electron 实例。它不写用户数据，属脚本侧既有风险，本轮不改（不在本 SPEC 范围）。
- **C4** 验收期间发现有 1 个未带 `--user-data-dir` 的 electron（PID 11624，17:17:41 启动）在 17:19:25 向真实 `%APPDATA%\lingdong-island\collapse-log.txt` 写过一次诊断日志。那是**用户授权的开发版预览**（`npm start`，用户 m00203 授权「做完就直接执行预览版」），不是 e2e 脚本；真实目录仍 114 个文件，`todos` / `prefs` / `shelf` / `schedule` 均未变。严格讲与第六节「不碰真实运行数据」有出入——预览版就是真跑真写，如实记录。
- **C5 脚本瑕疵（既有，不属本轮）**：`e2e-m3.mjs:39` 的 `[2] 收起态电量 DOM: (无)` 是空转断言；`e2e-wifi.mjs:125` 对 SVG 取 `String(el.className)` 输出 `[object SVGAnimatedString]`，使 A3 行出现 `[object`（不影响判定）。

**验收方复核通过的项（专门查过）**：

- `.ring-bolt` 在 `src/` 彻底消失：`git grep -n "ring-bolt" -- src/` 为空（exit 1），`0dfcc8f` 版本的 `src/` 同样为空。
- **charging 三态未被误删**：`App.tsx:1915` state、`:2103` setCharging、`:2382` low 判定、`:2386-2389` 三态 className/title/aria；`styles.css:452`、`:495`、`:499`、`:502` 四条规则全在。
- e2e 隔离真的生效：`isolate-userdata.mjs` 改写 `APPDATA` + 追加 `--user-data-dir`，隔离目录有实时写入；bundle 注入是真还原（从 `.bak` 起步 + `finally` 还原 + `Buffer.compare` 逐字节校验）。
- 第七节「未验证」四条确实仍是未验证，验收方也无法把它们变成通过。

**验收方明确未能验证（不得读成已通过）**：真实充电时 `BatteryStatus ∈ 6,7,8,9` 是否命中 / `root\wmi` `Charging=True` 是否真出现；拔插电源 90 秒真实时延（只核对了 `App.tsx:2109` 的 `setInterval(pull, 60_000)` 与 `statusStore.ts:97` 的 `30_000` 常量）；人眼观感；打包与装机；无电池台式机的 `null|false` 分支。

验收期间验收方未改任何 `src/`、`docs/` 文件，未提交、未合并。
