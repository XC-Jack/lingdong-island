# SPEC：插拔电源后即时刷新（电量状态推送）

> 任务分支：`battery-charge-low-indicator`（沿用当前分支，改的是同一块电量显示，尚未合并回 `main`）。
> 基线：`12fd736`（V3 判据定版 + 第三轮独立验收记录）。
> 起因：用户 2026-11-09 19:45 原文「现在没什么问题了，就是反应太慢了，我插了半天才显示」。
> **固定提交：`36f6dc3`（perf: 插拔电源即时刷新（powerMonitor 事件推送 + 2s 看门狗））。**
> **本轮追加（2026-11-09 22:00 之后，尚未提交）**：用户原话「最好就是这个拔插的显示可以实时的…截图是我的笔记本的充电图标，他就是实时的，不像你那么慢」。上一版虽然做到 1–3 秒，但**颜色仍要等一次约 1 秒的 PowerShell 取数**才翻转。本轮改为「事件到达即翻转颜色并广播，百分比随后补」。用户已选定「23 分钟档」：不做独立验收（第八节写 `[未做]`）、不打包、不备份（文件均已提交、可 `git checkout` 还原）。

## 一、目标

把「插上/拔掉电源 → 界面颜色变化」的等待时间从**最长约 90 秒**压到**约 1–3 秒**。

只改**刷新链路**，不改**判定口径**：电量行的 PowerShell 判据（V3：`-notin 1` 且非 `Discharging`）一个字都不动，本次不重新讨论什么算充电。

## 二、修改范围

| 文件 | 改什么 | 是否本次 |
|---|---|---|
| `src/main/statusStore.ts` | ① 缓存常量抽成 `CACHE_MS`；② 新增 `refreshAndBroadcast()`（重读 + 广播）与 `broadcast()`；③ `setupStatus()` 里注册 `powerMonitor` 的 `on-ac` / `on-battery` / `resume`；④ `powerMonitor.isOnBatteryPower()` 的看门狗（不 spawn 子进程）兜住事件缺失；⑤ 新增导出 `stopStatus()`；**⑥（本轮追加）`applyPowerEvent()` 让事件当场翻转颜色并广播、`EVENT_TRUST_MS` 事件优先窗口、`WATCH_MS` 1000 / `EVENT_SETTLE_MS` 300** | ✅ |
| `src/main/index.ts` | `import { setupStatus, stopStatus }`；`window-all-closed` 里加 `stopStatus()`（与 `stopNotifyStore` / `stopScheduleStore` 同型） | ✅ |
| `src/preload/index.ts` | `api` 内新增 `onStatusChanged(cb)` → `ipcRenderer.on('island:status-changed', ...)`（照抄 `onAvoidChanged` 的写法） | ✅ |
| `src/renderer/src/App.tsx` | 电量/Wi-Fi 那个 `useEffect` 里加订阅 `window.island.onStatusChanged(...)`，收到即 `setBattery/setCharging/setWifi`；60 秒轮询**保留**作为兜底 | ✅ |
| `scripts/e2e-battery-push.mjs` | 新增：证明「主进程广播 → 渲染层更新」真的通路（不靠 60 秒轮询） | ✅ |
| `docs/Spec/SPEC-battery-status-push.md` | 本文件 | ✅ |
| `docs/Spec/SPEC-battery-charging-accuracy.md` | 补一句「90 秒延迟已在下一轮修掉」 | ⬜ 本提交不含。该文件在收口提交 `921ec57` 里改（第六节「不做什么」:94/:97 与第八节 :133 各加一句指向本 SPEC）；`36f6dc3` 与 `1006314` 都不含此文件。第二轮验收 C21 指出此列填 ✅ 与 P6 判据冲突，已改为 ⬜ |
| `docs/状态.md` | 一句话状态 | ✅ |
| `docs/facts/功能清单.md` | 第 5 节「刷新延迟」描述更新 | ✅ |
| `docs/facts/本机约束与踩坑.md` | 「系统能力」节补三条：`powerMonitor` 可用但事件不保证、Web 电池 API 在 Electron 45 已移除、别高频 spawn PowerShell（并把「90 秒」那条改写为「已修」） | ✅ |

**明确不改**：`statusStore.ts` 的 PowerShell 判据行（`scripts/e2e-battery-states.mjs` 的 `OLD` 常量因此**不需要改**）；`styles.css`；阈值 20%；三态视觉；`App.tsx` 其它任何逻辑；布局；`package.json`；`out/`。

## 三、预期行为

1. 插上电源（或拔掉）：颜色**当场**翻转（几十毫秒级，不等取数），title 与 aria-label 同步；百分比、Wi-Fi 在 300 ms 后补读一次再更新。依据是「事件先到 → `applyPowerEvent` 直接改 `cache` 并广播 → 再去读真实值」。3 秒事件优先窗口内，即使系统的电量读数还报旧方向，也以事件为准，避免「闪一下又弹回去」。
2. 系统不发事件时（部分扩展坞/驱动）：1 秒看门狗发现 `powerMonitor.isOnBatteryPower()` 翻转，走同一条 `applyPowerEvent` 路径，最坏约 1 秒 + 一帧。
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
| P3 | 主进程广播通路真的活着，且**颜色不等取数** | `node scripts/e2e-battery-push.mjs`：把取数行换成「先睡 2 秒再读测试文件」（制造慢取数），把传感器换成读假文件，把 `on-ac` / `on-battery` 注册行换成两个定时器在 12 秒 / 22 秒分别调用 `applyPowerEvent(true)` / `applyPowerEvent(false)`（与真实插拔同一条代码路径）。断言里最关键的两条：**变绿那一刻百分比还是旧的 80、变白那一刻百分比还是旧的 99**，且百分比更新比变色晚 1 秒以上。跑完字节还原 `out/main/index.js`。**注意：看门狗与 `resume` 路径仍零 e2e 覆盖** |
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

自检人：实现本轮的会话（Lead）。分支 `battery-charge-low-indicator`，基线 `12fd736`。

自检时间分两批（第二轮独立验收 C19 指出首版只写了第一批，已补）：
- **第一批 20:00–20:06**：对应提交 `36f6dc3`，P1–P6 首次自检。
- **第二批 20:41 之后**：对应提交 `1006314`，采纳第一轮验收意见改了 4 个代码文件后，P1/P2/P3/P4/P5 全部重跑。

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

> 上表是**采纳第一轮独立验收意见、改了 4 个代码文件之后**（提交 `1006314`）的构建产物。修正前（提交 `36f6dc3`）的数字是 `out/main/index.js 74.24 kB`、`out/preload/index.js 8.63 kB`、`out/renderer/assets/index-mJzeIS02.js 664.26 kB`。
>
> 修正前那批数字原先被我写成 `74.67 kB` 并加了一句「注释改动被压缩后长度恰好相同」——**这两处都错，第二轮验收 C18 已指出**：① `36f6dc3` 当时的实际输出就是 `74.24 kB`，我串了两次构建的值；② electron-vite 的 main 产物**不压缩注释**，`out/main/index.js:483-486` 就能看到注释原文，所以注释加长必然增加字节（74248 → 74679 B，多 431 B）。`preload` 和 `renderer` 的哈希变化也是 App.tsx / preload 真改了才变，不是巧合。

### P3 广播通路 e2e — ✅ 通过（`11 过 / 0 败`）

`node scripts/e2e-battery-push.mjs` 原始输出。**明确删减了两类**（第二轮验收 C15 指出原稿声称「断言行逐字未改」却漏了后缀，这里说清）：①首尾的进度行；②每条断言末尾的 ` — <实测值>` 后缀（值已在上一行的 snapshot JSON 里给出）。断言名称、`✓` 标记、顺序、结果行逐字保留。

```
[初始] snapshot: {"has":true,"api":"function","cls":"head-battery-ring  ","num":"80","title":"电量 80%","aria":"电量 80%","stroke":"rgba(255, 255, 255, 0.85)"}
  ✓ P3-0 渲染层已挂上 onStatusChanged
  ✓ P3-1 初始数字 80
  ✓ P3-2 初始非充电（白弧）
  ✓ P3-3 初始 title 电量 80%
[注入] 已把取数值改为 99|True，开始等界面自己变（60 秒轮询还没到）
[推送后] snapshot: {"has":true,"api":"function","cls":"head-battery-ring  charging","num":"99","title":"充电中 · 电量 99%","aria":"充电中 · 电量 99%","stroke":"rgba(75, 214, 130, 0.9)"} 耗时 4528 ms
  ✓ P3-4 界面在 12 秒内自己更新了（不是靠 60 秒轮询）
  ✓ P3-5 更新时 charging 类已加
  ✓ P3-6 更新后弧变绿
  ✓ P3-7 更新后 title 充电中
  ✓ P3-8 更新后 aria 同步
  ✓ P3-9 耗时明显小于 60 秒轮询间隔
  ✓ P3-R1 out/main/index.js 还原字节一致
== 结果：11 过 / 0 败 ==
```

（P3-5 在脚本里的额外参数是 `String(d1?.cls)`，实测值 `head-battery-ring  charging`——原稿漏抄了这个后缀，第二轮验收 C15 已指出并在此补齐说明。）

`EXIT=0` 由我执行的 shell 补记（脚本自身不打印这一行，它靠 `process.exit(failed > 0 ? 1 : 0)` 表达结果；同理 P4/P5 各处的 `EXIT=0` 都是 shell 侧读到的退出码，不是脚本输出）。

**采纳验收意见后又跑了两次**，均 `11 过 / 0 败`、耗时可复现：加了 `isDestroyed()` 守卫那次 `4408 ms`、加取消订阅那次 `4225 ms`（`P3-R1` 两次都一致）。三次实测 `4528 / 4408 / 4225 ms` 同量级，说明结果不靠偶然时序。

**这条测试为什么能证明是真推送** [实测]：脚本把生产代码里 `electron.powerMonitor.on("on-ac", scheduleRefresh);` 换成 `setTimeout(scheduleRefresh, 6000);`，走的是**与真实插电事件完全相同**的 `scheduleRefresh → refreshAndBroadcast → webContents.send('island:status-changed')` 路径；渲染层 60 秒轮询在 12 秒窗口内根本还没到点（启动约 1.2 秒后开始计时）。4528 ms 的更新只能来自广播。

**为什么耗时 4528 ms 小于 6000 ms**（独立验收 C3 指出这里原先解释错了，已订正）：`setTimeout(scheduleRefresh, 6000)` 在**主进程启动时**就注册了，而脚本的 `t0` 是在 `boot()` 里 `await sleep(1200)`、CDP 连上并完成初始采样**之后**才开始计时的——t0 比进程启动晚约 1.2–1.5 秒，所以相对 t0 只剩约 4.5 秒；再叠加 `EVENT_SETTLE_MS=600` 的去抖，与实测 4528 ms 量级吻合。原稿把「6000 ms 从进程启动算」误写成了「从 t0 算」，导致数字与解释自相矛盾，这里改正。

### P4 四场景视觉 e2e — ✅ 通过（`31 过 / 0 败`）

`node scripts/e2e-battery-states.mjs` 末段原始输出。**同样删减了两类**（第二轮验收 C16 指出原稿没说明、还把 `EXIT=0` 留在代码块里）：①每条断言末尾的 ` — <实测值>` 后缀；②shell 读到的 `EXIT=0`（脚本不打印它，这里挪到代码块外说明）。断言名称、`✓`、顺序、结果行逐字保留。

```
[S4 低电不充电（15% 没插电）] snapshot DOM: {"has":true,"cls":"head-battery-ring low ","num":"15","title":"电量偏低 · 15%","aria":"电量偏低 · 15%","hasBolt":false,"stroke":"rgba(255, 107, 107, 0.9)","numColor":"rgba(255, 107, 107, 0.95)"}
  ✓ S4 low 类
  ✓ S4 无 charging 类
  ✓ S4 无闪电
  ✓ S4 title 电量偏低
  ✓ S4 aria 电量偏低
  ✓ S4 弧红
  ✓ S4 数字红
  ✓ R1 out/main/index.js 还原字节一致
== 结果：31 过 / 0 败 ==
```

`EXIT=0`（shell 侧补记，不是脚本输出）。

四场景（普通 80 白 / 充电 99 绿 / 充电且低电 15 绿 / 低电 15 红）全部通过，说明本轮只动了刷新链路，没碰三态视觉与判定。

### P5 回归三件套 — ✅ 全部通过

（**节选说明**：`e2e-m3.mjs:25` 有一行 `console.log('已连上:', page.title)` 的进度输出，我删掉了；另外两个脚本没有这一行，内容原样保留。`M3_EXIT` / `WIFI_EXIT` / `BEAUTIFY_EXIT` 是 shell 侧读到的退出码，由我补记，不是脚本输出。第二轮验收 C24 指出原稿删了进度行却没标注，此处补上。）

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

### P6 提交范围 — ✅ 通过

**第一批（`36f6dc3`，首次提交）：**

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

> 上面这段是**转写**，不是逐字符粘贴：终端宽度不同导致对齐空格与我实际终端不一致，文件名与 `|` 后的行数是一致的。第一轮验收 C14 提过这点，我原先声称「已注明」，实际没写——第二轮验收 C17 抓到了，此处补上。

**第二轮（实际固定提交 `1006314`，采纳验收意见后的修正）：**

```
$ git show --stat --oneline 1006314
1006314 fix: 采纳独立验收意见——isDestroyed 守卫、quitApp 停表、订阅可取消、SETTLE 注释订正
 docs/Spec/SPEC-battery-status-push.md | 25 ++++++++++++++++---------
 src/main/index.ts                     |  1 +
 src/main/statusStore.ts               |  8 +++++++-
 src/preload/index.ts                  |  9 +++++++--
 src/renderer/src/App.tsx              |  4 +++-
 5 files changed, 34 insertions(+), 13 deletions(-)
```

5 个文件同样全在第二节范围表内；`git diff 1006314 HEAD -- src scripts` 为空（第二轮验收方实测，证明验收跑的就是自检的代码）。**独立验收针对的固定提交以 `1006314` 为准**，`36f6dc3` 仅作历史记录。

### P7 真机插拔观感 — ❌ [未验证]

本机电池长期 99% 且一直插着电，**我无法亲手造出真实的「拔掉电源」现场**，本轮的 4528 ms 是注入事件 + 改取数文件测出来的通路时延，不等于真机观感。**需要用户亲手插拔一次电源确认**。在用户确认前，这一条保持 `[未验证]`，不得读成通过。

### 自检踩坑（如实记录）

1. **e2e patch 串引号写错导致主进程崩溃** [实测]：第一版把电量行替换成 `'(Get-Content -Raw "D:/…").Trim()'`，因为 bundle 里那段是**双引号 JS 字符串**的内容，替换串里的 `"` 提前闭合了 JS 字符串，electron 弹窗报 `SyntaxError: Unexpected identifier 'D'`（`out/main/index.js:509`），CDP 连不上。改成 PS 单引号包路径 `(Get-Content -Raw 'D:/…').Trim()` 后通过。
2. **`e2e-collapse-beautify.mjs` 会杀掉预览版** [实测]：该脚本 `:64`/`:156` 用 `taskkill /IM electron.exe /T /F` 按镜像名全杀，跑完回归后我起的预览版也一起没了，要重跑 `npm start` 才能继续看界面。这是既有脚本行为（上一轮验收 C5 已记录），本轮不改。
3. **跑任何用 CDP 9321 的脚本前必须确认端口空闲** [实测]：上一轮踩过——遗留的 electron 占着 9321 时，脚本的 `connect()` 会连到旧实例、读到旧数据，表现为「改什么都没生效」。本轮跑前已确认 `Get-NetTCPConnection -LocalPort 9321` 为空。（第二轮验收 C23 建议：更严谨的判据是加 `-State Listen`，因为刚 disconnect 的连接可能还挂在 `TimeWait` 状态；本轮沿用旧写法，记在这里备查。）

### 第三批自检（2026-11-09 22:50 之后）：颜色改由电源事件当场翻转

**改动动机**：上一版 1–3 秒仍不够。链路是「事件到 → 600 ms 去抖 → `readStatus()` 起 PowerShell 约 1 秒 → 广播」，颜色实际跟在那次取数后面。用户要的是「跟任务栏图标一样实时」。

**改法**（`src/main/statusStore.ts`，本次只改这一个源码文件）：

- `WATCH_MS` `2_000`→`1_000`；`EVENT_SETTLE_MS` `600`→`300`。
- 新增 `const EVENT_TRUST_MS = 3_000`（事件优先窗口）。
- 新增 `function applyPowerEvent(chargingFromEvent: boolean)`（`:154`）：把事件给的方向**当场**写进 `cache` 并 `broadcast()`，再 `scheduleRefresh()` 去补百分比。on-ac → `applyPowerEvent(true)`，on-battery → `applyPowerEvent(false)`（`:204`/`:205`），看门狗翻转也走同一条路（`:182`）。
- `refreshAndBroadcast()`（`:132`）里加事件优先窗口：`const inTrust = trustedCharging !== null && Date.now() - trustedAt < EVENT_TRUST_MS`，窗口内 `cache = { ...next, charging: trustedCharging }`，避免「变色 300 ms 后被旧读数打回原色」。

**过程中发现并修掉的一处真缺陷** [实测]：本轮先在 `refreshAndBroadcast()` 里保留了旧代码 `lastOnBattery = !cache.charging`。本机传感器 `powerMonitor.isOnBatteryPower()` 恒返回 `false`（[实测] 探针 `.tmp/probe-sensor.js` 连测 20 次全部 `isOnBatteryPower=false`），而读数可能是 `charging:false`；1 秒一次的回写让看门狗每秒都判定「翻转了」，把界面强行掰成绿——`e2e-battery-states` 的 S4（15% 没插电，应红）当场跑出 `cls="head-battery-ring  charging"`、`stroke` 绿、`title=充电中 · 电量 15%`，`21 过 / 10 败`。修法：`refreshAndBroadcast()` 与 `status:snapshot` 的缓存回填里**都不再写 `lastOnBattery`**，让它只由看门狗采样和电源事件维护；修后 S4 恢复 `cls="head-battery-ring low "`、`stroke=rgba(255, 107, 107, 0.9)`、`title=电量偏低 · 15%`，`31 过 / 0 败`。教训：**「上一份读数」与「上一份传感器采样」是两个不同的事实，不能互相回写**。

**P1 typecheck — ✅ 通过**

```
> lingdong-island@0.1.0 typecheck
> npm run typecheck:node && npm run typecheck:web

> lingdong-island@0.1.0 typecheck:node
> tsc --noEmit -p tsconfig.node.json

> lingdong-island@0.1.0 typecheck:web
> tsc --noEmit -p tsconfig.web.json

TYPECHECK EXIT=0
```

**P2 build — ✅ 通过**

```
out/main/index.js  76.09 kB
out/preload/index.js  8.85 kB
out/renderer/index.html                   0.49 kB
out/renderer/assets/index-CsgyUWqi.css   45.93 kB
out/renderer/assets/index--d5mQQdE.js   664.29 kB
BUILD EXIT=0
```

（`out/main/index.js` 从上一版的 74.67 kB 涨到 76.09 kB，是 `applyPowerEvent` / `broadcast` / 事件优先窗口三段新逻辑；preload 与 renderer 哈希未变，说明本轮没碰渲染层。）

**P3 广播通路 e2e — ✅ `22 过 / 0 败`**

脚本已重写为「三方自洽的假世界」，证明的是**颜色不等取数**这件事：

- 把电量行换成 `$(Start-Sleep -Milliseconds 2000; Get-Content -Raw '<值文件>').Trim()`（制造 2 秒慢取数）；
- 把两处 `powerMonitor.isOnBatteryPower()` 换成读假传感器文件 `__e2eFakeOnBattery()`；
- 把 `on-ac` 注册行换成两个定时器，在 12 秒 / 22 秒时分别写「99|True + AC」并 `applyPowerEvent(true)`、写「15|False + BAT」并 `applyPowerEvent(false)`——走的就是生产代码同一条 `applyPowerEvent` 路径。

原始输出的关键四行：

```
[初始] {"has":true,...,"cls":"head-battery-ring  ","num":"80","title":"电量 80%","stroke":"rgba(255, 255, 255, 0.85)"} 距 spawn 4949 ms
[插电事件后] {"cls":"head-battery-ring  charging","num":"80","title":"充电中 · 电量 80%","stroke":"rgba(75, 214, 130, 0.9)"} 距 spawn 12172 ms
[拔电事件后] {"cls":"head-battery-ring  ","num":"99","title":"电量 99%","stroke":"rgba(255, 255, 255, 0.85)"} 距 spawn 22187 ms
[取数返回后] {"cls":"head-battery-ring low ","num":"15","title":"电量偏低 · 15%","stroke":"rgba(255, 107, 107, 0.9)"} 距启动 25387 ms
== 结果：22 过 / 0 败 ==
```

铁证是那两行：**变绿时百分比还是旧的 80、变白时百分比还是旧的 99**——颜色早于取数 3.2 秒就变了（P3-13 / P3-20 分别断言「数比绿晚 1 秒以上」「红比白晚 1 秒以上」）。事件在 12 000 ms 触发，界面 12 172 ms 变绿，贴着事件；若仍走「等取数」，最早也要 14 秒多。

**P4 四场景 — ✅ `31 过 / 0 败`**（S1 8 + S2 8 + S3 7 + S4 7 + R1 1，字节还原一致）

**P5 回归三件套 — ✅ 全过**

- `e2e-m3`：`[1] statusSnapshot: {"battery":99,"charging":true,"wifi":{...}}` → `E2E PASS`（EXIT=0）
- `e2e-wifi`：`E2E WIFI PASS`（EXIT=0），A3 顺序仍 `head-battery-ring → collapsed-clock → collapsed-wifi → collapsed-bell`
- `e2e-collapse-beautify`：`7 过 / 0 败`（EXIT=0）

**P6 提交范围 — ✅ 通过（固定提交 `4775d4b`）**

```
 docs/Spec/SPEC-battery-status-push.md              |  90 ++++++++++-
 docs/facts/功能清单.md                             |   2 +-
 docs/状态.md                                       |   2 +
 scripts/e2e-battery-push.mjs                       | 169 +++++++++++++++------
 src/main/statusStore.ts                            |  82 +++++++---
 5 files changed, 270 insertions(+), 75 deletions(-)
```

5 个文件全在第二节范围表内；`out/` 未进提交（`.gitignore:3`）；工作区干净。**本轮固定提交 = `4775d4b1c66adacd49ff79309ca39655bea99fad`。**

**P7 真机插拔 — ❌ [未验证]**（同前：本机电池恒 99% 插电，注入测的是通路时延）

**第三批踩坑** [实测]：

1. **PowerShell 里不能用 `(...; ...)` 当子表达式**：第一版把电量行换成 `(Start-Sleep -Milliseconds 2000; Get-Content -Raw '<path>').Trim()`，PowerShell 报 `Missing closing ')' in expression`、`Unexpected token ')' in expression or statement`，整条取数失败 → 电量 `null` → 环根本不渲染 → 20 条断言全败。必须写成 `$(Start-Sleep -Milliseconds 2000; Get-Content -Raw '<path>').Trim()`（`$( )` 才是子表达式）。
2. **假事件时刻要从「进程启动」算**：bundle 里的定时器基准是进程启动，而脚本的 `tStart` 在 CDP 连上之后才取（晚 1–2 秒）。第一版 7 秒/14 秒时初始态来不及观测，P3-2/P3-3 假失败。改为 `tStart` 前置到 `spawn` 之前 + 事件推后到 12 秒/22 秒。
3. **`waitFor` 的截止时间要给足**：红色要等事件②（22 秒）之后再一次 2 秒取数，原来写死 25 秒导致超时，改为 `EVENT_UNPLUG_MS + 12_000`。

### 本轮未验证清单（不要读成通过）

- [未验证] 真机插拔电源的实际观感与真实时延（P7，需用户亲手做）。
- [未验证] 部分扩展坞 / 驱动「不发 on-ac / on-battery 事件」时看门狗 2 秒兜底的实际表现（本机探针 600 秒内一个事件都没收到过，无法区分是「没插拔」还是「机器不发事件」——探针期间用户确实没插拔，所以这条既不能证实也不能证伪）。
- [未验证] 休眠恢复（`resume`）路径的真实效果（没让机器真睡过一次再看）。
- [未验证] 安装版（`D:\软件\灵动岛\`）未重装，用户机器上的安装版仍是旧逻辑，**必须重新打包安装才能看到这次加速**。

## 八、验收记录

> 独立验收：由未参与实现的会话（teammate `verifier-push`，fresh context）针对固定提交逐条重跑 P1–P7 后回填。本节与第七节分开记，不合并。

> **第三轮（本轮「事件当场翻转」改动）：`[未做]`**。用户 2026-11-09 21:52 在「38 分钟（含独立验收）/ 23 分钟（不含）」之间明确选了 **23 分钟档**，原话「23」。因此本轮改动没有另起会话复核，第七节「第三批自检」是唯一记录。**这不算验收通过**：P1–P5 是我自己跑的，P6 待提交后回填，P7 仍未验证。若日后要并入 `main`，建议补一次独立验收。

### 第一轮（针对提交 `36f6dc3`，2026-11-09 20:36）

**结论：有条件通过，阻断项 0 个。** 报告 `.tmp/独立验收-36f6dc3.md`（43949 B / 712 行，被 `.gitignore:15` 忽略，不进仓库）。

验收方逐条重跑结果：

| 项 | 结论 | 关键证据（验收方原始记录） |
|---|---|---|
| P1 typecheck | ✅ 通过 | 两段 `tsc --noEmit` 无诊断，EXIT=0 |
| P2 build | ✅ 通过 | 五个产物名/大小与自检记录一致；按磁盘字节复算确认 vite 打印的是十进制 kB（74248 B→74.25、664265 B→664.26） |
| P3 广播通路 | ✅ 通过（限「事件驱动通路」） | `11 过 / 0 败`，耗时 4538 ms；跑前 9321 完全空闲；跑前跑后 `out/main/index.js` SHA256 均 `9CBD…1019`；无 `.bak` / 值文件残留 |
| P4 四场景 | ✅ 通过 | `31 过 / 0 败`（S1 8 + S2 8 + S3 7 + S4 7 + R1 1） |
| P5 回归三件套 | ✅ 通过 | m3 `E2E PASS`、wifi `E2E WIFI PASS`、beautify `7 过 / 0 败` |
| P6 提交范围 | ✅ 通过 | 9 个文件全在范围表内（A×2 / M×7），无越界；`git diff 36f6dc3 HEAD -- src scripts` 为空；工作区干净 |
| P7 真机插拔 | ❌ **[未验证]** | 本机电池恒 99% 插电，造不出拔电现场，按约定不伪造 |

**验收方挑刺 C1–C14，全部标 `[不阻断]`。** 逐条回应（本表由实现方填写，验收方原话见报告第四节）：

| 编号 | 验收方指出的问题 | 处理 |
|---|---|---|
| C1 | SPEC 第五节 P3 写的「第 3 次调用翻转 / 看门狗发现变化」与脚本实际（只换 `on-ac` 注册行为 6 秒定时器）不是一回事，同文件 :122 的解释却又写对了 | ✅ 已改第五节 P3 的手法描述，并显式写明「2 秒看门狗与 `resume` 路径零覆盖」 |
| C2 | P3 写「10 秒内」，脚本实际 `12_000` | ✅ 已改为 12 秒 |
| C3 | :122 把 4528 ms 解释成 6000 ms 定时器的采样点，但 4528 < 6000 说不通；真因是 6000 ms 从**进程启动**算、`t0` 晚约 1.2–1.5 s | ✅ 已按真因重写解释 |
| C4 | `EVENT_SETTLE_MS = 600` 的注释称「实测口径见 SPEC 第七节」，该节没有这条记录 | ✅ 已把注释改成「经验值，没有实测依据」，并说明折中理由 |
| C5 | P3/P4 标「原始输出」，实际有 3 行手工修剪；7 处 `EXIT=` 是 shell 补记不是脚本输出 | ✅ 标题改成「原始输出（节选，只删了首尾进度行）」；补一句说明 `EXIT=` 由 shell 补记 |
| C6 | :24 注解写「第三节已写明」，实际在第六节 `:94/:97` | ✅ 已连带改写该行（并说明该文件是在收口提交 `921ec57` 里改的） |
| C7 | `onStatusChanged` 无 `removeListener`、`App.tsx` cleanup 不 off；全项目零 `removeListener`；StrictMode 开发态会双订阅 | ✅ 已修：preload 的 `onStatusChanged` 改为返回取消订阅函数，`App.tsx` cleanup 里调用（提交 `1006314`） |
| C8 | `refreshAndBroadcast()` 无 `isDestroyed()` 守卫，会向 fullscreenWatch 的 4px 边缘窗也 send | ✅ 已修：loop 里加 `win.isDestroyed() \|\| win.webContents.isDestroyed()` 跳过（`1006314`） |
| C9 | `quitApp()` 未调 `stopStatus()`（同型 `stopNotifyStore` / `stopScheduleStore` 都调了） | ✅ 已修：`quitApp()` 首行加 `stopStatus()`（`1006314`） |
| C10 | `scheduleRefresh` 去抖：不丢事件，但连续事件会整体延后 | ⬜ 不修。行为符合预期（插拔是低频事件，600 ms 延后可接受），已在此记录备查 |
| C11 | `e2e-battery-push.mjs` 的 `copyFileSync(BUNDLE, BACKUP)` 在 `try` 之外，极端中断会留半写 bundle | ⬜ 不修。脚本 `main().catch` 里还有一次还原，且 `BACKUP` 存在时下次运行会覆盖；风险面仅限「脚本被强杀且同时段再跑」，已在自检踩坑记录 |
| C12 | 看门狗路径零 e2e 覆盖 | ✅ 已写进第五节 P3 与第七节未验证清单，不谎称覆盖 |
| C13 | :27 说「补一条」，实际补了三条 | ✅ 已改为「补三条」并列出内容 |
| C14 | P6 的 `git show --stat` 块文件名与行数全对，但整块不是逐字符相同（终端宽度导致对齐空格不同） | ⚠️ 第一轮我在这里标了「✅ 已注明」，但**实际没写**——第二轮验收 C17 抓到了，说这是「自检声称做了、实际没做」。已在第七节 P6 补上转写声明（见该节末尾的引用块） |

**验收方明确列出 8 条「不得读成通过」**（原文见报告第五节）：
1. P7 真机插拔观感与时延。
2. 2 秒看门狗兜底的实际表现（零 e2e 覆盖）。
3. `resume` 休眠恢复路径。
4. 「插拔后 1–3 秒变色」这一对外承诺（目前只有推断，没有真机数据）。
5. P3 的 4538 ms ≠ 真机时延（注入路径 vs 真实路径）。
6. 600 ms 常量无实测出处。
7. 安装版 `D:\软件\灵动岛\` 仍是旧逻辑（本轮未打包未重装）。
8. e2e 全绿 ≠ 打包产物可用。

### 第二轮（针对修正后提交 `1006314`，2026-11-09 21:00）

**结论：有条件通过，阻断项 0 个。** 报告 `.tmp/独立验收-1006314.md`（47663 B / 801 行，被 `.gitignore:15` 忽略，不进仓库）。

固定提交的背景：采纳第一轮 C1–C9 后代码有 4 个文件改动（`statusStore.ts` / `index.ts` / `preload/index.ts` / `App.tsx`），所以**固定提交从 `36f6dc3` 变成 `1006314`**。

验收方逐条重跑结果：

| 项 | 结论 | 关键证据（验收方原始记录） |
|---|---|---|
| P1 typecheck | ✅ 通过 | 两段 `tsc --noEmit` 零诊断，EXIT=0 |
| P2 build | ✅ 通过 | 五产物 `74.67 / 8.85 / 0.49 / 45.93 / 664.29 kB`，磁盘字节全部对上；渲染层入口哈希 `index-mJzeIS02` → `index--d5mQQdE`（App.tsx 真改了） |
| P3 广播通路 | ✅ 通过（限事件驱动通路） | `11 过 / 0 败`，**4560 ms**；`P3-R1` 字节还原一致；跑后 SHA256 `931C…53F3`；`.tmp` 无 `.bak` / 值文件残留 |
| P4 四场景 | ✅ 通过 | `31 过 / 0 败`（8+8+7+7+1，逐条数过），字节还原一致 |
| P5 回归三件套 | ✅ 通过 | m3 `E2E PASS` / wifi `E2E WIFI PASS` / beautify `7 过 0 败` |
| P6 提交范围 | ✅ 通过 | `1006314` 5 文件全在第二节 ✅ 列内，无越界无删除，工作区干净，`out/` 未跟踪；**关键基线** `git diff --stat 1006314 HEAD -- src scripts` 为空 ⇒ 验收的代码 == 自检的代码 |
| P7 真机插拔 | ❌ **[未验证]** | 本机电池恒 99% 插电，不伪造 |

**C7 / C8 / C9 / C4 四项全部真修（源码 + 编译产物双证）：**

- **C7**：`src/preload/index.ts:124-130` 返回 `() => void`，内部用具名 `h` + `removeListener`；`src/renderer/src/App.tsx:2111` 接 `offStatus`、`:2119` cleanup 里真调。bundle 侧也对上：`out/preload/index.js:92` 有 `removeListener`、`index--d5mQQdE.js:13707` 有 `offStatus()`。
- **C8**：`src/main/statusStore.ts:119` `if (win.isDestroyed() || win.webContents.isDestroyed()) continue`——比建议的单个判更严。
- **C9**：`src/main/index.ts:51` 有 `stopStatus()`，且 `window-all-closed`（`:271`）那条仍保留，两条退出路径都覆盖。
- **C4**：`EVENT_SETTLE_MS` 注释已重写为「**没有实测依据**（本机电池恒 99% 插电，造不出真插拔的时序来量）…独立验收 C4 已指出上一版注释误称…」，不再谎称。

**C1–C14 复核：** C1/C2/C3/C4/C7/C8/C9/C12/C13 真修；**C5、C6 只修一半**；**C14 原先标 ✅ 实际没做**（见下 C17）。

**新挑刺 C15–C24，全部 `[不阻断]`：**

| 编号 | 问题 | 处理 |
|---|---|---|
| C15 | SPEC 第七节 P3 新写「断言行逐字未改」，但漏了 P3-5 的 ` — head-battery-ring  charging` 后缀，声明自相矛盾 | ✅ 已改：把删减范围写清（删首尾进度行 + 删每条断言的值后缀），并单独补一句说明 P3-5 的后缀 |
| C16 | P4 块完全没修：仍标「末段原始输出」、丢尾随空格、丢后缀，`EXIT=0` 还留在代码块里（与 P3 标准不一致） | ✅ 已改：说明删减两类、断言行去掉值后缀、`EXIT=0` 移出代码块 |
| C17 | **本轮唯一一处「自检声称做了、实际没做」**：C14 那行标 ✅ 说「已注明转写」，但全文搜 `转写\|终端宽度\|COLUMNS` 只命中该行自身 | ✅ 已在第七节 P6 补真正的转写声明；C14 那行的处理列改为 ⚠️ 并写明实情 |
| C18 | P2 注记说「修正前是 74.67 kB」，实际 `36f6dc3` 版是 **74.24**；且「注释被压缩后长度恰好相同」不成立——main 产物不压缩注释（`out/main/index.js:483-486` 有注释原文），74248→74679 B 差 431 B | ✅ 已改：修正前数字改为 74.24 / 8.63 / 664.26，并说明注释不做压缩、字节必然增加 |
| C19 | 自检抬头只写「20:00–20:06、基线 12fd736」，但后半数据是 20:41 后第二批；`:125`「前馈守卫」是笔误 | ✅ 已改：抬头拆成两批并各自对应提交；笔误已改为 `isDestroyed()` 守卫 |
| C20 | P6 小节仍只针对 `36f6dc3`（9 文件），没更新到 `1006314`（5 文件） | ✅ 已改：P6 拆成「第一批 36f6dc3」「第二轮 1006314」两段，并写明验收以 `1006314` 为准 |
| C21 | 范围表 `:24` 把「是否本次」列填 ✅，但该文件只在 `921ec57` 里 | ✅ 已改为 ⬜ 并说明它在收口提交里改（三处引用位置经验收方核实全部真实） |
| C22 | `stopStatus()` 只清两个定时器，**不摘 `powerMonitor` 三条监听**（`removeListener` 在 statusStore.ts 零命中）——当前不可达（调用后紧跟 `app.quit()`），但与 C7 同型 | ⬜ 不修。已记在此表备查：将来若有「运行中重启状态监视」的需求，必须补 `removeListener('on-ac', ...)` 等三行 |
| C23 | P3 端口判空用 `Get-NetTCPConnection -LocalPort 9321` 不严谨，刚跑完可能命中 `TimeWait`，应加 `-State Listen` | ✅ 已在第七节自检踩坑第 3 条写明建议判据，本轮沿用旧写法 |
| C24 | P5 块删了 `已连上: ` 首行却未标注节选 | ✅ 已在 P5 说明（本文件 P5 小节标题下已注明节选性质） |

**第二轮验收方列出的 10 条「不得读成通过」**（第一轮 8 条 + 新增 2 条）：
1. P7 真机插拔观感与时延。
2. 2 秒看门狗兜底的实际表现（零 e2e 覆盖）。
3. `resume` 休眠恢复路径。
4. 「插拔后 1–3 秒变色」这一对外承诺（只有推断，无真机数据）。
5. P3 的 4560 ms ≠ 真机时延。
6. 600 ms 常量无实测出处。
7. 安装版 `D:\软件\灵动岛\` 仍是旧逻辑（本轮未打包未重装）。
8. e2e 全绿 ≠ 打包产物可用。
9. **C14 标 ✅ 实际没做**（本轮已补，但说明第一轮自检记录里存在过这类问题）。
10. SPEC 第七节 P3/P4 的「原始输出」声明曾与实跑不符（本轮已把删减范围写清）。

**三个「有条件」的落点：**
1. P7 必须由用户亲手插拔才能销项，在那之前状态页不得写「已通过」。
2. 安装版 `D:\软件\灵动岛\` 仍是旧逻辑，用户机器上看不到这次加速，必须重新打包安装（需用户授权 `npm run dist`）。
3. SPEC 自检记录曾有 4 处与事实不符（C15/C17/C18/C19），**订正前不能视为可信**；本轮已全部订正，但订正本身发生在第二轮验收之后，若要把 C15–C19 的修复也纳入验收，需要第三轮针对订正后的提交重跑「文档一致性」检查（不需重跑 P1–P6，代码未变）。

