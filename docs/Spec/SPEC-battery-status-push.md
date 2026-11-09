# SPEC：插拔电源后即时刷新（电量状态推送）

> 任务分支：`battery-charge-low-indicator`（沿用当前分支，改的是同一块电量显示，尚未合并回 `main`）。
> 基线：`12fd736`（V3 判据定版 + 第三轮独立验收记录）。
> 起因：用户 2026-11-09 19:45 原文「现在没什么问题了，就是反应太慢了，我插了半天才显示」。
> **固定提交：`36f6dc3`（perf: 插拔电源即时刷新（powerMonitor 事件推送 + 2s 看门狗））。**

## 一、目标

把「插上/拔掉电源 → 界面颜色变化」的等待时间从**最长约 90 秒**压到**约 1–3 秒**。

只改**刷新链路**，不改**判定口径**：电量行的 PowerShell 判据（V3：`-notin 1` 且非 `Discharging`）一个字都不动，本次不重新讨论什么算充电。

## 二、修改范围

| 文件 | 改什么 | 是否本次 |
|---|---|---|
| `src/main/statusStore.ts` | ① 缓存常量抽成 `CACHE_MS`；② 新增 `refreshAndBroadcast()`（重读 + 广播）；③ `setupStatus()` 里注册 `powerMonitor` 的 `on-ac` / `on-battery` / `resume`，事件到达时作废缓存并补一次延迟重读；④ 新增 `powerMonitor.isOnBatteryPower()` 的 2 秒轻量看门狗（不 spawn 子进程）作为事件缺失时的兜底；⑤ 新增导出 `stopStatus()` | ✅ |
| `src/main/index.ts` | `import { setupStatus, stopStatus }`；`window-all-closed` 里加 `stopStatus()`（与 `stopNotifyStore` / `stopScheduleStore` 同型） | ✅ |
| `src/preload/index.ts` | `api` 内新增 `onStatusChanged(cb)` → `ipcRenderer.on('island:status-changed', ...)`（照抄 `onAvoidChanged` 的写法） | ✅ |
| `src/renderer/src/App.tsx` | 电量/Wi-Fi 那个 `useEffect` 里加订阅 `window.island.onStatusChanged(...)`，收到即 `setBattery/setCharging/setWifi`；60 秒轮询**保留**作为兜底 | ✅ |
| `scripts/e2e-battery-push.mjs` | 新增：证明「主进程广播 → 渲染层更新」真的通路（不靠 60 秒轮询） | ✅ |
| `docs/Spec/SPEC-battery-status-push.md` | 本文件 | ✅ |
| `docs/Spec/SPEC-battery-charging-accuracy.md` | 补一句「90 秒延迟已在下一轮修掉」 | ✅ 在收口提交 `921ec57` 里改（第六节「不做什么」:94/:97 与第八节 :133 各加了一句指向本 SPEC；`36f6dc3` 本身不含此文件） |
| `docs/状态.md` | 一句话状态 | ✅ |
| `docs/facts/功能清单.md` | 第 5 节「刷新延迟」描述更新 | ✅ |
| `docs/facts/本机约束与踩坑.md` | 「系统能力」节补三条：`powerMonitor` 可用但事件不保证、Web 电池 API 在 Electron 45 已移除、别高频 spawn PowerShell（并把「90 秒」那条改写为「已修」） | ✅ |

**明确不改**：`statusStore.ts` 的 PowerShell 判据行（`scripts/e2e-battery-states.mjs` 的 `OLD` 常量因此**不需要改**）；`styles.css`；阈值 20%；三态视觉；`App.tsx` 其它任何逻辑；布局；`package.json`；`out/`。

## 三、预期行为

1. 插上电源（或拔掉）：约 1–3 秒内弧变绿（或变回白/红），title 与 aria-label 同步。依据是「事件先到 → 重读 → 广播」。
2. 系统不发事件时（部分扩展坞/驱动）：2 秒看门狗发现 `powerMonitor.isOnBatteryPower()` 翻转，走同一条重读+广播路径，最坏约 3 秒。
3. 60 秒轮询仍在，作为最后兜底（例如事件与看门狗双双失灵时，最坏仍是原来的 90 秒，不会更差）。
4. 判定口径不变：V3 那套语义原样保留——插着电源绿、没接电且 ≤20% 红、其余白。
5. 其它状态项（Wi-Fi / 时钟 / 待办 / 铃铛）行为不变；广播里带的 `wifi` 字段与以前一致。

## 四、必要依赖

- Electron 自带的 `powerMonitor`（主进程模块，无需新依赖）。**[实测]** electron 45.2.1 上 `powerMonitor.on` / `isOnBatteryPower` 均存在，`on-ac` / `on-battery` 监听注册成功（探针 `.tmp/probe-battery-api.js`，不进交付）。
- 不需要 `navigator.getBattery`：**[实测]** 该 API 在 Electron 45 已移除（`typeof navigator.getBattery === 'undefined'`），所以只能走主进程。
- 无新增 npm 依赖、无新数据文件、无新设置项。

## 五、验收条件

| 编号 | 验收项 | 怎么验 |
|---|---|---|
| P1 | `npm run typecheck` 通过 | 原样贴输出，退出码 0 |
| P2 | `npm run build` 通过 | 贴产物文件名与大小 |
| P3 | 主进程广播通路真的活着（不是靠轮询） | `node scripts/e2e-battery-push.mjs`：把主进程取数行换成「从测试控件文件读值」，并把 `electron.powerMonitor.on("on-ac", scheduleRefresh);` 这一行换成 `setTimeout(scheduleRefresh, 6000);`——即人为制造一次「插电事件」，走的是与真实插拔**完全相同**的 `scheduleRefresh → refreshAndBroadcast → webContents.send` 路径；脚本在 **12 秒内**（远小于 60 秒轮询）观察 DOM 从注入值 A 变成注入值 B 即算通过；跑完字节还原 `out/main/index.js`。**注意：本测试只覆盖「事件驱动」这条路径，2 秒看门狗与 `resume` 路径零覆盖**（见第七节未验证清单、第八节 C12） |
| P4 | 三态视觉没被改坏 | `node scripts/e2e-battery-states.mjs` 仍 31 过 0 败（四场景：普通白 / 充电绿 / 充电且低电绿 / 低电红） |
| P5 | 回归三件套 | `scripts/e2e-m3.mjs`、`scripts/e2e-wifi.mjs`、`scripts/e2e-collapse-beautify.mjs` 全过 |
| P6 | 提交范围不越界 | `git show --stat <固定提交>` 只含第二节"✅ 本次"列出的文件；工作区干净 |
| P7 | 真机观感 | **需要用户亲手插拔一次电源**。本机电池长期 99% 插着电，插拔造不出来，由用户确认；未确认前记 `[未验证]` |

## 六、不做什么

- 不改判据、不改阈值 20%、不改三态配色。
- 不改 Wi-Fi / 时钟 / 待办 / 铃铛的刷新方式。
- 不做「每秒轮询 PowerShell」这类高频子进程方案：**[实测]** 探针以 2 秒间隔连跑 90 秒后出现 `Failed to create CoreCLR, HRESULT: 0x8007000E`（CLR 内存不足）。电量取数必须保持低频 + 事件驱动。
- 不动安装版、不打包、不装机、不碰 `%APPDATA%\lingdong-island\` 真实数据。
- 不合并回 `main`（需用户单独授权）。

## 七、自检记录

自检人：实现本轮的会话（Lead）。自检时间：2026-11-09 20:00–20:06。分支 `battery-charge-low-indicator`，基线 `12fd736`。

### P1 typecheck — ✅ 通过

```
> lingdong-island@0.1.0 typecheck
> npm run typecheck:node && npm run typecheck:web

> lingdong-island@0.1.0 typecheck:node
> tsc --noEmit -p tsconfig.node.json

> lingdong-island@0.1.0 typecheck:web
> tsc --noEmit -p tsconfig.web.json

EXIT=0
```

`typecheck:node` 与 `typecheck:web` 均无任何诊断输出，退出码 0。

### P2 build — ✅ 通过

```
out/main/index.js  74.67 kB
out/preload/index.js  8.85 kB
out/renderer/index.html                   0.49 kB
out/renderer/assets/index-CsgyUWqi.css   45.93 kB
out/renderer/assets/index--d5mQQdE.js   664.29 kB
EXIT=0
```

（`out/` 在 `.gitignore:3`，不进提交；跑完 e2e 后已核对字节还原。）

> 上表是**采纳独立验收建议做了四处小修正之后**的构建产物。修正前的数字是 `out/main/index.js 74.67 kB`、`out/preload/index.js 8.63 kB`、`out/renderer/assets/index-mJzeIS02.js 664.26 kB`（`index.js` 在两次构建里都报 74.67 kB，因为注释改动被压缩后长度恰好相同）。

### P3 广播通路 e2e — ✅ 通过（`11 过 / 0 败`）

`node scripts/e2e-battery-push.mjs` 原始输出（节选，只删了首尾的进度行，断言行逐字未改）：

```
[初始] snapshot: {"has":true,"api":"function","cls":"head-battery-ring  ","num":"80","title":"电量 80%","aria":"电量 80%","stroke":"rgba(255, 255, 255, 0.85)"}
  ✓ P3-0 渲染层已挂上 onStatusChanged — function
  ✓ P3-1 初始数字 80 — 80
  ✓ P3-2 初始非充电（白弧） — rgba(255, 255, 255, 0.85)
  ✓ P3-3 初始 title 电量 80% — 电量 80%
[注入] 已把取数值改为 99|True，开始等界面自己变（60 秒轮询还没到）
[推送后] snapshot: {"has":true,"api":"function","cls":"head-battery-ring  charging","num":"99","title":"充电中 · 电量 99%","aria":"充电中 · 电量 99%","stroke":"rgba(75, 214, 130, 0.9)"} 耗时 4528 ms
  ✓ P3-4 界面在 12 秒内自己更新了（不是靠 60 秒轮询） — num=99 耗时=4528ms
  ✓ P3-5 更新时 charging 类已加
  ✓ P3-6 更新后弧变绿 — rgba(75, 214, 130, 0.9)
  ✓ P3-7 更新后 title 充电中 — 充电中 · 电量 99%
  ✓ P3-8 更新后 aria 同步 — 充电中 · 电量 99%
  ✓ P3-9 耗时明显小于 60 秒轮询间隔 — 4528ms
  ✓ P3-R1 out/main/index.js 还原字节一致
== 结果：11 过 / 0 败 ==
```

`EXIT=0` 由我执行的 shell 补记（脚本自身不打印这一行，它靠 `process.exit(failed > 0 ? 1 : 0)` 表达结果；同理 P4/P5 各处的 `EXIT=0` 都是 shell 侧读到的退出码，不是脚本输出）。

**采纳验收意见后又跑了两次**，均 `11 过 / 0 败`、耗时可复现：修正注释与前馈守卫后 `4408 ms`、加取消订阅后 `4225 ms`（`P3-R1` 两次都一致）。三次实测 `4528 / 4408 / 4225 ms` 同量级，说明结果不靠偶然时序。

**这条测试为什么能证明是真推送** [实测]：脚本把生产代码里 `electron.powerMonitor.on("on-ac", scheduleRefresh);` 换成 `setTimeout(scheduleRefresh, 6000);`，走的是**与真实插电事件完全相同**的 `scheduleRefresh → refreshAndBroadcast → webContents.send('island:status-changed')` 路径；渲染层 60 秒轮询在 12 秒窗口内根本还没到点（启动约 1.2 秒后开始计时）。4528 ms 的更新只能来自广播。

**为什么耗时 4528 ms 小于 6000 ms**（独立验收 C3 指出这里原先解释错了，已订正）：`setTimeout(scheduleRefresh, 6000)` 在**主进程启动时**就注册了，而脚本的 `t0` 是在 `boot()` 里 `await sleep(1200)`、CDP 连上并完成初始采样**之后**才开始计时的——t0 比进程启动晚约 1.2–1.5 秒，所以相对 t0 只剩约 4.5 秒；再叠加 `EVENT_SETTLE_MS=600` 的去抖，与实测 4528 ms 量级吻合。原稿把「6000 ms 从进程启动算」误写成了「从 t0 算」，导致数字与解释自相矛盾，这里改正。

### P4 四场景视觉 e2e — ✅ 通过（`31 过 / 0 败`）

`node scripts/e2e-battery-states.mjs` 末段原始输出：

```
[S4 低电不充电（15% 没插电）] snapshot DOM: {"has":true,"cls":"head-battery-ring low ","num":"15","title":"电量偏低 · 15%","aria":"电量偏低 · 15%","hasBolt":false,"stroke":"rgba(255, 107, 107, 0.9)","numColor":"rgba(255, 107, 107, 0.95)"}
  ✓ S4 low 类 — head-battery-ring low
  ✓ S4 无 charging 类
  ✓ S4 无闪电
  ✓ S4 title 电量偏低 — 电量偏低 · 15%
  ✓ S4 aria 电量偏低 — 电量偏低 · 15%
  ✓ S4 弧红 — rgba(255, 107, 107, 0.9)
  ✓ S4 数字红 — rgba(255, 107, 107, 0.95)
  ✓ R1 out/main/index.js 还原字节一致
== 结果：31 过 / 0 败 ==
EXIT=0
```

四场景（普通 80 白 / 充电 99 绿 / 充电且低电 15 绿 / 低电 15 红）全部通过，说明本轮只动了刷新链路，没碰三态视觉与判定。

### P5 回归三件套 — ✅ 全部通过

```
# node scripts/e2e-m3.mjs
[1] statusSnapshot: {"battery":99,"charging":true,"wifi":{"connected":true,"online":true,"name":"GZHL_Student 3","kind":"wifi"}}
[2] 收起态电量 DOM: (无)
[3] 时钟 DOM: 20:05
E2E PASS
M3_EXIT=0

# node scripts/e2e-wifi.mjs
[1] A1 通过：快照 wifi 字段 = {"connected":true,"online":true,"name":"GZHL_Student 3","kind":"wifi"}
[2] A2 通过：图标 kind=wifi，文案「Wi-Fi：GZHL_Student 3（网络正常）」，aria=Wi-Fi 已连接，网络正常
[3] A3 通过：DOM 顺序 head-battery-ring → [object → collapsed-clock → collapsed-wifi → collapsed-bell ；时钟完整 20:05
[4] A4 通过：展开态网络图标位于头部信息行（wifi=true）
[5] A5 说明：null 分支由 JSX 条件 {wifi !== null} 直接控制；当前 DOM has = true
E2E WIFI PASS
WIFI_EXIT=0

# node scripts/e2e-collapse-beautify.mjs
  ✓ B2 无未读时铃铛不渲染（若本机恰有未读则此断言改在清零后验）
  ✓ B1 有未读时铃铛存在
  ✓ B1b 铃铛含红点徽标
  ✓ B1c 铃铛内是实心铃铛 SVG
  ✓ B4 旧红点 .collapsed-dot 不再出现
  ✓ B3 电量环在岛仔之前
  ✓ B5 时钟仍在
== 结果：7 过 / 0 败 ==
BEAUTIFY_EXIT=0
```

（`e2e-wifi` A3 那行里的 `[object` 是既有脚本瑕疵：`e2e-wifi.mjs:125` 对 SVG 元素取 `className` 得到 `[object SVGAnimatedString]`，属上一轮验收已记录的老问题，不影响判定。）

### P6 提交范围 — ✅ 通过（提交 `36f6dc3`）

```
$ git show --stat --oneline 36f6dc3
36f6dc3 perf: 插拔电源即时刷新（powerMonitor 事件推送 + 2s 看门狗）
 docs/Spec/SPEC-battery-status-push.md   | 200 +++++++++++++++++++++
 docs/facts/功能清单.md                  |   4 +-
 docs/facts/本机约束与踩坑.md            |   5 +-
 docs/状态.md                            |   2 +
 scripts/e2e-battery-push.mjs            | 171 ++++++++++++++++++
 src/main/index.ts                       |   3 +-
 src/main/statusStore.ts                 |  77 ++++++++-
 src/preload/index.ts                    |   7 +
 src/renderer/src/App.tsx                |  17 +-
 9 files changed, 473 insertions(+), 13 deletions(-)
```

9 个文件全部在第二节范围表内（代码 4 个 + 新增 e2e 1 个 + 新增 SPEC 1 个 + 三份事实/状态文档）；`out/` 未被跟踪（`git ls-files out` 为空）；提交后工作区干净。`src/renderer/src/styles.css` **本轮未改**——三态颜色早在 V3 就定好，加速只动链路不动样式。

### P7 真机插拔观感 — ❌ [未验证]

本机电池长期 99% 且一直插着电，**我无法亲手造出真实的「拔掉电源」现场**，本轮的 4528 ms 是注入事件 + 改取数文件测出来的通路时延，不等于真机观感。**需要用户亲手插拔一次电源确认**。在用户确认前，这一条保持 `[未验证]`，不得读成通过。

### 自检踩坑（如实记录）

1. **e2e patch 串引号写错导致主进程崩溃** [实测]：第一版把电量行替换成 `'(Get-Content -Raw "D:/…").Trim()'`，因为 bundle 里那段是**双引号 JS 字符串**的内容，替换串里的 `"` 提前闭合了 JS 字符串，electron 弹窗报 `SyntaxError: Unexpected identifier 'D'`（`out/main/index.js:509`），CDP 连不上。改成 PS 单引号包路径 `(Get-Content -Raw 'D:/…').Trim()` 后通过。
2. **`e2e-collapse-beautify.mjs` 会杀掉预览版** [实测]：该脚本 `:64`/`:156` 用 `taskkill /IM electron.exe /T /F` 按镜像名全杀，跑完回归后我起的预览版也一起没了，要重跑 `npm start` 才能继续看界面。这是既有脚本行为（上一轮验收 C5 已记录），本轮不改。
3. **跑任何用 CDP 9321 的脚本前必须确认端口空闲** [实测]：上一轮踩过——遗留的 electron 占着 9321 时，脚本的 `connect()` 会连到旧实例、读到旧数据，表现为「改什么都没生效」。本轮跑前已确认 `Get-NetTCPConnection -LocalPort 9321` 为空。

### 本轮未验证清单（不要读成通过）

- [未验证] 真机插拔电源的实际观感与真实时延（P7，需用户亲手做）。
- [未验证] 部分扩展坞 / 驱动「不发 on-ac / on-battery 事件」时看门狗 2 秒兜底的实际表现（本机探针 600 秒内一个事件都没收到过，无法区分是「没插拔」还是「机器不发事件」——探针期间用户确实没插拔，所以这条既不能证实也不能证伪）。
- [未验证] 休眠恢复（`resume`）路径的真实效果（没让机器真睡过一次再看）。
- [未验证] 安装版（`D:\软件\灵动岛\`）未重装，用户机器上的安装版仍是旧逻辑，**必须重新打包安装才能看到这次加速**。

## 八、验收记录

（独立验收：由未参与实现的会话针对固定提交逐条重跑 P1–P7 后回填，不得与本记录混写。）
