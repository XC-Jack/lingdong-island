# SPEC：充电判定修正 + 去掉充电小闪电

> 任务分支：`battery-charge-low-indicator`（沿用上一轮分支，因为改的是同一块电量显示，尚未合并回 `main`）。
> 基线：上一轮固定提交 `2c71cca` + 闪电修正 `2aaa9c0`。
> **固定提交（第一版，已被推翻的判据）：`0dfcc8f`**
> **固定提交（最终版，独立验收请针对这个）：`f42464ef2f6c90372e49d8613d5c8d8ee5697dae`（短哈希 `f42464e`）**——判据在 17:37 因用户驳回而重写，第一版的 B2 结论随之作废，见下方「判据演进」。
> 起因：用户 2026-11-09 17:06 原文「就绿色就好，不用雷电了；还有就是我刚刚把充电拔了，他还是绿色的」；17:37 又原文「我现在冲着电，他是白的；我要的就是充电时是绿色，低于20变红色，正常就是白色」。
> 时序说明：本轮先做了电源数据源探针（只读命令，未改任何文件），确认根因后才写本文件并开工；探针脚本留在 `.tmp/`，不进交付提交。

**判据演进（如实记录，含被推翻的一版）**：

| 版本 | 判据 | 本机（插电 96%、系统已停充）输出 | 用户判定 |
|---|---|---|---|
| V0 原始 | `($b.BatteryStatus -eq 2)` | `96\|True` | 错：拔电后仍绿（系统还报 AC=1） |
| V1（`0dfcc8f`） | `($b.BatteryStatus -in 6,7,8,9) -or [bool]$w.Charging` | `96\|False` | **错：插着电却是白弧**，用户 17:37 驳回 |
| V2 最终 | `($b.BatteryStatus -notin 1,4,5) -and -not [bool]$w.Discharging` | `96\|True` | 独立验收发现 `4/5` 被排除导致「插电 + 15%」走红态，与第 4 条矛盾 |
| V3 定版 | `($b.BatteryStatus -notin 1) -and -not [bool]$w.Discharging` | `96\|True` | 待用户确认观感 |

V1 的错误不是写错代码，是**判据口径错了**：它按 Microsoft 的严格语义（`6/7/8/9`＝正在充电）实现，而电池到 96% 后系统停止充电、仍在供电，`BatteryStatus` 是 `2`（接 AC）或 `3`（已充满），于是显示白弧。用户的实际口径是「插着电源就该是绿的」。V2 改成「不是放电态即为充电态」；V3 再把 `4/5`（低电/临界）也纳入充电态，修掉「插着电的低电量反而显示红色」这个矛盾——只有 `BatteryStatus=1`（放电中）或 WMI 明确报 `Discharging=True` 才算没接电。

## 一、目标

两件事，都是用户当面提的：

1. **去掉充电小闪电**：只保留「充电中弧变绿」这一个视觉信号，不再在环右上角画闪电。
2. **让三态与用户口径一致**：充电（插着电源）= 绿弧、没插电且 ≤20% = 红弧 + 红数字、其余 = 白。用户的抱怨从「拔了电还绿」到「插着电却是白」是同一条：判定要和「插着电源」这个事实对齐，而不是和 Windows 内部的充电状态机对齐。

第二件的根因 [实测]（命令与输出见第七节）：
`src/main/statusStore.ts` 改动前 `:40` 原文（改动后位置为 `:44`）

```
'$b=Get-CimInstance -ClassName Win32_Battery; if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, ($b.BatteryStatus -eq 2)}else{"null|false"}',
```

用的是 `Win32_Battery.BatteryStatus -eq 2`。但 Windows 对 `BatteryStatus` 的定义是：`1`=放电中、`2`=**接着交流电但没在充电**、`3`=完全充满、`4/5`=低电/临界、`6/7/8/9`=**正在充电**。所以 `-eq 2` 判的是「插着 AC」，不是「正在充」，语义从根上错了；而只认 `6/7/8/9` 又会把「插着电已停充」漏成白弧。

本机实测（`D:\Users\honor\Documents\Project\灵动岛`，2026-11-09 17:08–17:11 与 17:37）：
- `Win32_Battery`：`BatteryStatus=2`、`EstimatedChargeRemaining=96`
- `root\wmi` `BatteryStatus`：`PowerOnline=True`、`Charging=False`、`Discharging=False`、`ChargeRate=0`、`DischargeRate=0`，25 秒内 `RemainingCapacity` 恒为 `45911`；17:37 连续 6 次采样（间隔 2s）读数完全不变
- 结论：机器**插着电但没在充电**（96% 未达充电门槛）。对用户而言这就是「充电中」，必须绿。

## 二、修改范围

| 文件 | 改什么 | 落在哪个提交 |
|---|---|---|
| `src/main/statusStore.ts` | 电量行（改动后 `:48`）的充电判定：`($b.BatteryStatus -eq 2)` → `(($b.BatteryStatus -notin 1) -and -not [bool]$w.Discharging)`，先取 `root\wmi` 的 `Discharging` 作排除项；`:88` 的 `charging = chg === 'True'` 不变（协议约定不变） | `0dfcc8f`（V1）→ `f42464e`（V2）→ 本次（V3） |
| `src/renderer/src/App.tsx` | 删掉 case 'battery' 里的 `.ring-bolt` 闪电 SVG（改动前的 `:2404-2408`）与相关注释；`charging` state（`:1915`）、`setCharging`（`:2103`）、`low` 判定（`:2382`）、三态 className/title/aria（`:2386-2389`）全部保留 | `0dfcc8f` |
| `src/renderer/src/styles.css` | 删掉 `.head-battery-ring .ring-bolt` 规则块（改动前的 `:505-518`）；`.head-info .head-battery-ring svg:not(.ring-bolt)`（`:452`）还原成 `.head-info .head-battery-ring svg`（闪电不存在了，`:not()` 失去意义）。现存相关行：`:495` 红弧、`:499` 绿弧、`:502` 红数字 | `0dfcc8f` |
| `scripts/e2e-battery-states.mjs` | ①patch 目标串 OLD 换成新的 PS 电量行；②断言改为「四场景一律无 `.ring-bolt`」，其余（类名/数字/title/aria/弧色/数字色）不变 | `0dfcc8f` → 本次（OLD 串跟 V3） |
| `docs/Spec/SPEC-battery-charging-accuracy.md` | 本文件 | 本次 |
| `docs/Spec/SPEC-battery-charge-low-indicator.md` | 第一节与第二节补一句「闪电已按用户要求移除」，避免两份文档互相矛盾 | `0dfcc8f` |
| `docs/状态.md` | 一句话状态追加本轮修正 | `0dfcc8f` + 本次 |
| `docs/facts/功能清单.md` | 第 5 节电量环描述从「`≤20%` 变红」升级为三态（充电绿 / 低电红 / 普通白）+ 充电判据与刷新延迟说明 | `0dfcc8f` |
| `docs/facts/本机约束与踩坑.md` | 「系统能力」节新增「充电判定别用 `BatteryStatus -eq 2`」踩坑条目（含四种判据对比）；「验证边界」节补注真实充电 WMI 仍未验证 | `0dfcc8f` |

> **范围口径说明（独立验收 C1）**：上表是「本轮累积范围」（相对上一轮交付 `2aaa9c0` 共 9 个文件）。单个提交只含其中一部分：`f42464e` 是 6 个文件，V3 这次只动 `src/main/statusStore.ts`、`scripts/e2e-battery-states.mjs`、本 SPEC 与 `docs/状态.md`。B6 里「只含第二节列出的文件」按累积口径核对。

**明确不改**：`src/preload/index.ts`（`charging: boolean` 协议不变）、`src/main/` 其它模块、阈值 20%、轮询频率（主进程缓存 30s / 渲染层 60s）、布局与组件结构、`package.json`、`out/`（构建产物，跑完 e2e 会字节还原）。

## 三、预期行为

> **2026-11-09 17:37 订正**：用户原话「我现在冲着电，他是白的；我要的就是充电时是绿色，低于20变红色，正常就是白色」。原第 1 条只认 `6/7/8/9`（「正在充电」的严格语义），但电池到 96% 后系统停止充电仍在供电，`BatteryStatus` 是 `2`（接交流电）或 `3`（已充满），于是显示白弧——用户看到的是「插着电却是白的」，判定为错。判据改为第 1a 条，下面 1–5 条按新判据重写。
> **2026-11-09 17:56 再订正（V3）**：独立验收 C3 指出，上一版判据把 `4/5`（低电/临界）排除在充电态之外，于是「插着电 + 15%」会被判成没充电、走红态，与第 4 条「接着电源且 ≤20% → 绿」自相矛盾。判据再放宽为「只有 `BatteryStatus=1`（放电中）或 WMI 明确 `Discharging=True` 才算没接电」，`4/5` 归入充电态。
>
> 模拟对象实测（`EstimatedChargeRemaining=15`）：`1 → 15|False`；`2/3/4/5/6/7/8/9/10/11 → 15|True`；`2 且 Discharging=True → 15|False`。本机现况仍是 `96|True`。

1. **接着电源**（`BatteryStatus` 不是 `1`，且 WMI 没报 `Discharging=True`）：弧绿 `rgba(75, 214, 130, 0.9)`，无闪电，title/aria = `充电中 · 电量 X%`。包含 `2`（接 AC 未充）、`3`（已充满）、`4/5`（低电/临界但插着电）、`6/7/8/9`（正在充）、`11`（部分充电）。
2. **没接电源且 >20%**：普通态——弧白 `rgba(255, 255, 255, 0.85)`、数字白、title/aria = `电量 X%`。
3. **没接电源且 ≤20%**：弧红 `rgba(255, 107, 107, 0.9)` + 数字红 `rgba(255, 107, 107, 0.95)`，title/aria = `电量偏低 · X%`。
4. **接着电源且 ≤20%**：以充电为准——弧绿、不出现红色、`充电中 · 电量 X%`（V3 下这条对 `4/5` 也可达，不再自相矛盾）。
5. 读不到电池（`null`）：整环不渲染（不变）。

**用户口径的三态映射**：充电=绿、≤20% 且没充电=红、其余=白。这三条就是本轮唯一的行为契约，不再引入「严格充电语义」这种用户看不见的区分。

## 四、必要依赖

无新增依赖。PowerShell 的 `Get-CimInstance -Namespace root\wmi` 是系统自带能力；`-notin` / `Where-Object` 需要 PowerShell 3.0+（本机是 Windows 自带 5.1，`npm run dist` 也不改这一层）。

## 五、验收条件

| 编号 | 可亲手核对的结果 |
|---|---|
| B1 | `npm run typecheck` 退出码 0（node + web 两个子命令均无错误输出），原始输出贴进第七节 |
| B2 | 直接跑主进程取数命令（V3 判据），本机当前（插电、95%、系统已停充）输出 `96\|True`；第七节附命令原文与输出。同时附反证：`-in 6,7,8,9`（V1）在同机输出 `96\|False`，说明 V1 会漏判 |
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
| B2 | 直接内联跑 `src/main/statusStore.ts:48` 那条 PS 电量行（`powershell -NoProfile -Command '...'`，与代码逐字符一致） | **V3 判据：`96\|True`**（本机插电 96% 已停充，符合用户口径「插电即绿」）。反证：V1 判据 `-in 6,7,8,9` 同机输出 `96\|False`（白弧，用户 17:37 驳回）；V0 判据 `-eq 2` 输出 `96\|True`（数值对但语义错，拔电仍绿）。逐状态模拟见第九节 | ✅ 通过 |
| B3 | `node scripts/e2e-battery-states.mjs` | `== 结果：31 过 / 0 败 ==`；四个场景 DOM 快照见下 | ✅ 通过 |
| B4 | 同上（脚本内 R1） | `✓ R1 out/main/index.js 还原字节一致` | ✅ 通过 |
| B5 | `node scripts/e2e-m3.mjs` / `node scripts/e2e-wifi.mjs` / `node scripts/e2e-collapse-beautify.mjs` | m3：`[1] statusSnapshot: {"battery":95,"charging":true,...}`（V3 判据下本机插电 → `charging:true`，与 V1 时的 `false` 相反，符合用户口径）、`E2E PASS`；wifi：A1–A5 全通过、`E2E WIFI PASS`（A3 DOM 顺序 `head-battery-ring → collapsed-clock → collapsed-wifi → collapsed-bell`）；collapse-beautify：`7 过 / 0 败`（B3 电量环在岛仔之前） | ✅ 通过 |
| B6 | `git status --porcelain` + `git show --stat` | 提交前只有第二节列出的文件；工作区干净见提交时核对 | ✅ 通过 |

B3 四场景原始 DOM 快照（脚本输出照抄）：

```
S1 普通（80% 不充电） cls="head-battery-ring  "  num=80  title="电量 80%"        stroke=rgba(255, 255, 255, 0.85)  numColor=rgba(255, 255, 255, 0.92)  hasBolt=false
S2 充电（99% 充电中） cls="head-battery-ring  charging"  num=99  title="充电中 · 电量 99%"  stroke=rgba(75, 214, 130, 0.9)  numColor=rgba(255, 255, 255, 0.92)  hasBolt=false
S3 充电且低电（15% 充电中） cls="head-battery-ring  charging"  num=15  title="充电中 · 电量 15%"  stroke=rgba(75, 214, 130, 0.9)  numColor=rgba(255, 255, 255, 0.92)  hasBolt=false
S4 低电不充电（15% 没插电） cls="head-battery-ring low "  num=15  title="电量偏低 · 15%"  stroke=rgba(255, 107, 107, 0.9)  numColor=rgba(255, 107, 107, 0.95)  hasBolt=false
```

四条关键点：S2/S3 弧绿且**无** `low` 类（充电优先成立）；S4 弧红且数字红；四场景 `hasBolt` 全 false（闪电已移除）；S1 是纯白普通态。

**自检踩坑（重要，记入流程）**：第一次跑 B3 得到 `15 过 / 16 败`，四个场景读到的 DOM 全是同一个 `95% / charging` 真机快照——原因是上一轮遗留的预览版 electron 仍占着 CDP 端口 `9321`，e2e 的 `connect()` 连上了那个旧实例，而**新打补丁的实例端口被占、根本没被查**。杀掉预览版（`taskkill /IM electron.exe /T /F`）后重跑才得 `31 过 / 0 败`。教训：跑任何 `--remote-debugging-port=9321` 的 e2e 前必须先确认没有别的 electron 占着这个端口，否则测试会静默连错实例、给出假通过或假失败。

**本轮未验证 / 已知边界（如实记录）**：

1. **真实硬件「正在充电」现场未复现**：本机电池 96%→95%、`ChargeRate=0`，`BatteryStatus` 恒为 `2`、WMI `Charging=False`。V3 判据对本机的结论是 `96|True`（绿弧，与用户口径一致，已真机 CDP 核对两态：收起 ring 22x22、展开 ring 20x20，均 `cls="head-battery-ring  charging"`、`title/aria="充电中 · 电量 95%"`、`bolt=null`），但「`BatteryStatus ∈ 6,7,8,9` 的真充电」只能靠注入 `99|True` 覆盖渲染层，**不是**真实充电现场。
2. **拔插电源后界面不立刻变**：主进程缓存 30s + 渲染层轮询 60s，最坏约 90 秒。用户报「拔了还绿」的直接原因是 V0 判据错，但拔电后要等一会儿才变色这个体验问题**本轮没处理**，另行提出。V3 判据本身依赖系统 `ACLineStatus`，本机之前出现过「用户拔了电、系统仍报 AC=1」的情况（`powercfg /batteryreport` 末条仍记 AC），这类情况 V3 也无法分辨——**这是已知残留风险**。
3. **低电量真机未验证**：本机电池长期 95% 以上，红色低电态只在 e2e 注入 `15|false` 时验过 DOM 与 computed style，真机自然掉电到 ≤20% 未验证。
4. **视觉观感待用户确认**：绿弧已在真机界面看到（收起态与展开态头部，CDP 截元素 10 倍图），红色数字与「电量偏低 · X%」提示只在注入下验过，未人眼确认。
5. 未打包、未装机（用户机器跑的是安装版 `D:\软件\灵动岛\`，仍是旧包）。
6. **`BatteryStatus=10`（Undefined）被算充电态**：独立验收 C10 指出，属极端边界，本轮不改。

## 八、验收记录

> ⚠️ **本记录针对的是第一版（V1 判据）的固定提交 `0dfcc8f`，其 B2 结论（`96|False`）已随 17:37 用户驳回而作废。**保留在此只为如实记录「曾经独立验收通过但产品口径是错的」这一事实——验收能证明代码符合 SPEC，不能证明 SPEC 符合用户。V2 的独立验收见下方「第二轮」。这也说明一条流程教训：**判据类改动应在写 SPEC 前先让用户确认口径**，否则验收得再多也会被一句话推翻。

### 第一轮（V1 判据，`0dfcc8f`，已作废）

角色：独立验收（未参与实现的会话，独立上下文、未读实现过程）。验收对象：固定提交 `0dfcc8f`（实际跑在 `HEAD` = `4e0e194` 上，两者 `src/` 完全一致，`git diff 0dfcc8f 4e0e194` 只差本文件回填固定提交的那一行）。时间：2026-11-09 17:19–17:27。原始报告：`.tmp/独立验收-0dfcc8f.md`（24.9 KB，`.tmp/` 被 git 忽略，不进仓库）。

**当时的结论：有条件通过，无阻断项**（但该结论在 10 分钟后被用户驳回，见上方警告）。

| 编号 | 独立复跑结果 |
|---|---|
| B1 | ✅ 通过。`npm run typecheck`，node/web 两条 `tsc` 均无输出，EXIT 0 |
| B2 | ⚠️ **结论作废**。当时实测 `96\|False` 被判为「正确」；实际用户要的是 `96\|True` |
| B3 | ✅ 通过。`31 过 / 0 败`，四场景 DOM 快照与第七节逐字符一致 |
| B4 | ✅ 通过。`✓ R1 out/main/index.js 还原字节一致`；`git ls-files out` 为空 |
| B5 | ✅ 通过。m3 `charging:false` + `E2E PASS`；wifi `E2E WIFI PASS` + A3 顺序正确；collapse-beautify `7 过 / 0 败` |
| B6 | ⚠️ 有条件通过。工作区干净、无缺失文件；但提交含 9 个文件 vs 第二节表列 7 个（见 C1，已补齐表格） |

**验收方挑刺发现（C1–C5，均非阻断，与判据无关，仍然有效）**：

- **C1 范围表不全**：提交多出 `docs/facts/功能清单.md`、`docs/facts/本机约束与踩坑.md`，第二节表未列。→ 已补进第二节表。
- **C2 行号漂移**：正文写 `statusStore.ts:80`（实际 `:84`）、B2 写 `:43`（实际 `:44`）、App.tsx 闪电写 `:2403-2408`（实际删除 `:2404-2409`）。→ 已订正。
- **C3** `scripts/e2e-collapse-beautify.mjs:64` / `:156` 用 `taskkill /IM electron.exe /T /F` 按镜像名全杀，会误伤并发运行的 electron 实例。它不写用户数据，属脚本侧既有风险，本轮不改（不在本 SPEC 范围）。
- **C4** 验收期间发现有 1 个未带 `--user-data-dir` 的 electron（PID 11624，17:17:41 启动）在 17:19:25 向真实 `%APPDATA%\lingdong-island\collapse-log.txt` 写过一次诊断日志。那是**用户授权的开发版预览**（`npm start`，用户授权「做完就直接执行预览版」），不是 e2e 脚本；真实目录仍 114 个文件，`todos` / `prefs` / `shelf` / `schedule` 均未变。严格讲与第六节「不碰真实运行数据」有出入——预览版就是真跑真写，如实记录。
- **C5 脚本瑕疵（既有，不属本轮）**：`e2e-m3.mjs:39` 的 `[2] 收起态电量 DOM: (无)` 是空转断言；`e2e-wifi.mjs:125` 对 SVG 取 `String(el.className)` 输出 `[object SVGAnimatedString]`，使 A3 行出现 `[object`（不影响判定）。

- `.ring-bolt` 在 `src/` 彻底消失：`git grep -n "ring-bolt" -- src/` 为空（exit 1）。
- **charging 三态未被误删**：`App.tsx:1915` state、`:2103` setCharging、`:2382` low 判定、`:2386-2389` 三态 className/title/aria；`styles.css:452`、`:495`、`:499`、`:502` 四条规则全在。
- e2e 隔离真的生效：`isolate-userdata.mjs` 改写 `APPDATA` + 追加 `--user-data-dir`，隔离目录有实时写入；bundle 注入是真还原（从 `.bak` 起步 + `finally` 还原 + `Buffer.compare` 逐字节校验）。

### 第二轮（V2 判据，`f42464e`）

角色：独立验收（teammate `verifier`，独立上下文，未参与实现）。验收对象：固定提交 `f42464e`。时间：2026-11-09 17:45–18:02。原始报告：`.tmp/独立验收-f42464e.md`（24.7 KB，423 行，`.tmp/` 被 git 忽略）。

**结论：通过，无阻断项。**

| 编号 | 独立复跑结果 |
|---|---|
| B1 | ✅ 通过。`npm run typecheck` EXIT 0，node/web 均无错误输出 |
| B2 | ✅ 通过。内联跑 `src/main/statusStore.ts:46` 那条 PS 行得 **`96\|True`**（V1 时是 `96\|False`，翻转成立，符合用户「插电即绿」口径） |
| B3 | ✅ 通过。`31 过 / 0 败`，四场景 DOM 快照与第七节逐字符一致，四场景 `hasBolt` 全 false |
| B4 | ✅ 通过。`✓ R1 out/main/index.js 还原字节一致`；`git ls-files out` 为空 |
| B5 | ✅ 通过。m3 `statusSnapshot {"battery":95,"charging":true}` + `E2E PASS`；wifi `E2E WIFI PASS` + A3 顺序正确；collapse-beautify `7 过 / 0 败` |
| B6 | ✅ 通过。工作区干净，提交 6 个文件全在第二节累积范围表内 |

**验收方挑刺（C1–C10，均非阻断）**：

- **C1 范围表口径**：第二节 9 项是累积范围（`git diff --name-status 2aaa9c0 f42464e` 正好 9 个），`f42464e` 只含 6 个。→ 已在第二节加「落在哪个提交」列 + 口径说明段。
- **C2 行号漂移**：写 `statusStore.ts:44` 实际 `:46`、`:84` 实际 `:86`、App.tsx 闪电「删 `:2404-2409`」实际 `:2404-2408`。→ 已全部按 V3 后的实际行号重核并订正（见第二节表）。
- **C3 实质语义缺口（本轮唯一真问题）**：第三节第 4 条「接着电源且 ≤20% → 绿」在 `BatteryStatus=4/5` 时不可达——V2 判据 `-notin 1,4,5` 显式排除 4/5，模拟实测 `4 → 15|False`、`5 → 15|False`，渲染层 `low = !charging && <=20` 成立 → 走红态。→ **采纳「放宽判据」方案，产出 V3**（`-notin 1`），详见第三节订正与第九节；`4/5` 矛盾已消除。
- **C7** 第七节 B6 曾写「4 改 + 1 新增 SPEC」，实际 6 个 M、0 个 A。→ 已改为「只含第二节列出的文件」。
- **C8** 第八节第二轮当时是「待填」。→ 本段即回填。
- **C9 预览版进程**：验收窗口实测 electron 进程为 0——`e2e-collapse-beautify.mjs` 的 `taskkill /IM electron.exe /T /F` 会把预览版一起杀掉（本轮第二次踩到）。真实 `%APPDATA%\lingdong-island` 114 个文件、17:44 后零写入；隔离目录 `.tmp/e2e-userdata/lingdong-island` 65 文件、17:44 后 8 个变化 → **数据隔离真生效**。
- **C10** `BatteryStatus=10`（Undefined）被算充电态，属极端边界；`=null` 走 `pct === 'null'` 分支安全。本轮不改，已记入第七节未验证清单第 6 条。
- **C4/C5/C6** 为既有脚本瑕疵（`e2e-m3.mjs:39` 空转断言、`e2e-wifi.mjs:125` `[object SVGAnimatedString]`、`e2e-collapse-beautify.mjs:64/:156` 按镜像名全杀），不在本 SPEC 范围。

**验收方明确列出「不得读成通过」的项**：真实充电现场（`BatteryStatus ∈ 6,7,8,9` / `Charging=True`）、真机自然低电红态、拔插电源 90 秒延迟、拔线后系统仍报 AC=1 的残留风险、人眼观感、打包装机。

### 第三轮（V3 判据，本次提交）

**尚未做独立验收**。V3 只改了 `src/main/statusStore.ts` 一行判据表达式与 e2e 的 `OLD` 常量，其余全部沿用 `f42464e`；等 V3 固定提交落定后，需由未参与实现的会话针对该提交重跑 B1–B6（B2 预期仍为 `96|True`，并追加 `4/5` 两个模拟状态必须得 `15|True`）。**在此之前，本 SPEC 的独立验收结论只覆盖到 V2，V3 只有研发自检，不得当成已验收。**

## 九、判据实测对比记录（2026-11-09，本机）

命令（`powershell -NoProfile -Command`，逐条独立跑，只读）：

```powershell
# V0 原始：把「接着 AC」当「正在充电」
'$b=Get-CimInstance -ClassName Win32_Battery; if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, ($b.BatteryStatus -eq 2)}else{"null|false"}'
# → 96|True

# V1（0dfcc8f）：只认微软严格语义的「正在充电」
'... (($b.BatteryStatus -in 6,7,8,9) -or [bool]($w|Where-Object {$_.Charging})) ...'
# → 96|False   ← 用户 17:37 驳回：插着电却是白弧

# V2（f42464e）：不是放电态即为充电态（但排除了 4/5，见独立验收 C3）
'... (($b.BatteryStatus -notin 1,4,5) -and -not [bool]($w|Where-Object {$_.Discharging})) ...'
# → 96|True；但 15% + BatteryStatus=4/5 时 → 15|False（插着电的低电量走红态，与预期行为第 4 条矛盾）

# V3（定版）：只有「放电中」才算没接电
'$b=Get-CimInstance -ClassName Win32_Battery; $w=@(Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue); if($b){"{0}|{1}" -f $b.EstimatedChargeRemaining, (($b.BatteryStatus -notin 1) -and -not [bool]($w|Where-Object {$_.Discharging}))}else{"null|false"}'
# → 96|True
```

V3 逐状态模拟（`EstimatedChargeRemaining=15`，`$w` 为空）：

```
1 -> 15|False    2 -> 15|True     3 -> 15|True     4 -> 15|True
5 -> 15|True     6 -> 15|True     9 -> 15|True    10 -> 15|True
2 且 Discharging=True -> 15|False
```

同时实测的三种「看起来能用但不行」的替代判据：

| 候选 | 本机输出 | 为什么不用 |
|---|---|---|
| `root\wmi` `BatteryStatus.PowerOnline` | `True` | 语义就是「接着 AC」，和 V0 一样分不清插电与充电 |
| `System.Windows.Forms.SystemInformation.PowerStatus.PowerLineStatus` | `Online` | 同上，只表示插着线 |
| kernel32 `GetSystemPowerStatus().BatteryFlag` bit3 | `1`（不含 8 位） | 本机 `ACLineStatus=1` 但 `BatteryFlag=1`（放电中），自身就矛盾；用户拔线后系统仍报 AC=1 |

**残留风险 [实测依据 + 推断]**：本机曾出现「用户拔了电源、系统仍报 `ACLineStatus=1`、`powercfg /batteryreport` 末条仍写 AC」的情况。V3 判据在这种情况下仍会显示绿弧。最可能错在：那台机器的 USB-C 供电链路在拔线后仍有残余供电/系统状态更新滞后，不是软件能判干净的。真正的兜底是让用户拔线后等一个刷新周期（≤90 秒）再看；若仍绿，说明系统层面仍认为在供电。

真机截面截图（2026-11-09 17:39，预览版 `npm start`）：

- 收起态：绿弧 + `96`，无闪电，`live-shot.png`（237x110）
- 展开态头部：绿弧 + `96`，无闪电，`verify-expanded.png`（525x275）

两张图都在 `.tmp/`，不进仓库；人眼观感仍需用户确认。
