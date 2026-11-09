# SPEC：电量显示状态——新增充电态与低电量态

> 任务分支：`battery-charge-low-indicator`，基线 `main`（`7d4089b`，2026-11-09 文档收口）。固定提交：`2c71cca39f9d2cf809e5d202b8f1b693ab5eef7f`（短哈希 `2c71cca`），闪电图标修正追加提交 `2aaa9c0`。
> 设计已由用户确认（本轮开工提示词原文），不再访谈。实现已在本分支完成，SPEC 按要求在提交前补齐；本文件如实写明「实现先于 SPEC 文档落盘」这一时序，自检以最终固定提交为准。
> 时序说明：工程规则要求「先写 SPEC 再开工」，本轮实际是先把改动做完、再补 SPEC——原因是注入验证链路（CDP 无法改 contextBridge 数据，改用 patch out/main bundle 的 PowerShell 电量行）需要反复探索，SPEC 的验收条件依赖探索结论（见第七节「时序与合规说明」）。
> 追加说明（2026-11-09 晚）：首版交付后用户实测指出闪电图标在两态下尺寸不一致且盖住数字，已追加提交 `2aaa9c0` 修正（见第三节 1a 与第七节「追加修正」）。原固定提交 `2c71cca` 保留不重写历史，独立验收请以**最新提交**为准。

## 一、目标

电量环此前只画百分比，充电数据虽然一直读到了但界面没消费。本轮给电量环补齐三种显示状态：

1. **充电中**：进度弧变绿 + 环右上角小闪电图标 + 悬停提示「充电中 · 电量 X%」。
2. **低电量**（没充电且 ≤20%）：进度弧变红 + 数字也变红 + 提示「电量偏低 · X%」。
3. **两者同时**（如 15% 正在充电）：以充电为准——弧绿、有闪电、不出现红色。

收起态胶囊与展开态头部共用 `renderStatusItem()` 的 case 'battery'，改一处两处同时生效。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/renderer/src/App.tsx` | ①新增 `charging` state（:1915）；②轮询 `pull()` 里 `setCharging(s.charging)`（:2103）；③case 'battery' 改块级：`low` 判定改「没充电且 ≤20%」、className 加 `charging`、aria-label/title 三态、charging 时渲染 `.ring-bolt` 小闪电 SVG（:2377-2409） |
| `src/renderer/src/styles.css` | `.head-battery-ring.charging .ring-fg`（弧绿）、`.head-battery-ring.low .ring-num`（数字红）、`.head-battery-ring .ring-bolt`（小闪电定位/填色/投影）（:498-513）；追加修正 `2aaa9c0`：`.head-info .head-battery-ring svg` 改为 `svg:not(.ring-bolt)`（:452），闪电定 7px 去深底（:505-517） |
| `scripts/e2e-battery-states.mjs` | 新增 e2e：四场景注入验证（第七节详述） |
| `docs/Spec/SPEC-battery-charge-low-indicator.md` | 本文件 |
| `docs/状态.md` | 一句话状态加一条本轮记录 |

**明确不改**：`src/main/statusStore.ts`（charging 取数早就有，`:80` `charging = chg === 'True'`）、`src/main/` 其它模块、`src/preload/index.ts`（`:18` 已声明 `charging: boolean`）、阈值（沿用 20）、轮询频率、布局与组件结构、`package.json` 依赖、不新增设置项。

## 三、预期行为

1. `charging === true`：环加 `charging` 类 → `.ring-fg` stroke 变 `rgba(75, 214, 130, 0.9)`（绿）；右上角渲染小闪电 SVG（绿，带淡投影）；title/aria = `充电中 · 电量 X%`；中间数字颜色不变。
   1a. **闪电尺寸（2026-11-09 追加修正 `2aaa9c0`）**：闪电固定 7×7px，钉在环的 1-2 点位置（`top:-3px; right:-4px`），不加深色圆底（圆底会在绿环上切缺口），只用 `drop-shadow(0 0 1px rgba(0,0,0,.9))` 与环线分离；收起态与展开态尺寸必须一致。修正前展开态因 `.head-info .head-battery-ring svg`（选择器权重 0,2,0）覆盖 `.head-battery-ring .ring-bolt`（0,1,0），闪电实际一直是 20px、盖住中间数字，收起态才是 10px——这是首版交付的真实缺陷。
2. `charging === false && battery <= 20`：环加 `low` 类 → 弧变红 `rgba(255, 107, 107, 0.9)`、数字变红 `rgba(255, 107, 107, 0.95)`；title/aria = `电量偏低 · X%`；无闪电。
3. 其余（没充电且 >20%）：保持原样——弧白 `rgba(255, 255, 255, 0.85)`、数字白、title/aria = `电量 X%`、无闪电、无类。
4. `battery === null`（读不到）：与此前一致，整个电量环不渲染。
5. 颜色优先级由判定式保证：`const low = battery !== null && !charging && battery <= 20`（App.tsx:2381）——charging 时 `low` 恒为 false，红不出现。

## 四、必要依赖

无新增依赖。测试链路复用已有：`scripts/isolate-userdata.mjs`（e2e 数据隔离 helper，33 个既有 e2e 均指向它）、Node 22 内置 fetch/WebSocket、CDP（调试端口 9321，见 `docs/facts/本机约束与踩坑.md`）。

## 五、验收条件

| 编号 | 可亲手核对的结果 |
|---|---|
| A1 | `npm run typecheck` 退出码 0（node + web 两个子命令都无错误输出） |
| A2 | 四场景 e2e 全过：S1 普通（80\|false）→ 无类、数字 80、`电量 80%`、弧白、无闪电；S2 充电（99\|True）→ `charging` 类、`充电中 · 电量 99%`、弧绿、有闪电；S3 充电且低电（15\|True）→ `charging` 类且无 `low` 类、弧绿、数字非红（充电优先）；S4 低电不充电（15\|false）→ `low` 类、`电量偏低 · 15%`、弧红、数字红、无闪电 |
| A3 | e2e 结束后 `out/main/index.js` 字节级还原（脚本内 R1 断言，`Buffer.compare === 0`）；真实运行数据 `%APPDATA%\lingdong-island\` 零写入（走 `scripts/isolate-userdata.mjs` 隔离） |
| A4 | 回归通过：`scripts/e2e-m3.mjs`（含 charging boolean 断言链路）、`scripts/e2e-wifi.mjs`（:66 断言 `charging` 是 boolean）、`scripts/e2e-collapse-beautify.mjs`（收起态组件顺序与显隐不被改坏） |
| A5 | `git status --porcelain` 干净；分支 `battery-charge-low-indicator` 上的固定提交只含第二节列出的文件 |
| A6 | aria-label 与 title 三态文案逐字等于第三节 1/2/3（e2e 已断言，A2 覆盖） |

**注入方法说明（A2 的前提）**：本机电池恒 99% 且充电（`docs/facts/本机约束与踩坑.md` 记录），充电态/低电态无法靠自然电量变化获得。采用 **mock 注入**方案：e2e 用文本替换把 `out/main/index.js` 里 `readStatus()` 的 PowerShell 电量行换成固定字面量（如 `'15|True'`，PS 单引号），启动后渲染层 60s 轮询经 `status:snapshot` 拿到的就是注入值；`out/` 在 `.gitignore`，`src/` 一字不动，跑完还原并字节校验。最终四场景 DOM/computed style 断言结果见第七节自检记录（S1–S4、R1 全过 [实测]）。每场景独立 spawn electron（主进程 30s 缓存），CDP 端口 9321，`ELECTRON_RUN_AS_NODE` 先删（同上踩坑文档）。

## 六、不做什么

- 不改 `src/main/statusStore.ts` 取数逻辑，不动 `src/main/` 其它模块，不改 `src/preload/index.ts`。
- 不新增设置项、不加新组件、不挪布局、不改轮询频率（主 30s / 渲染层 60s 照旧）。
- 不重构 `App.tsx` 其它部分（该文件 11 万字节、2700+ 行，只动电量相关 3 处 + 注释）。
- 不打包、不跑 `npm run dist`、不装机（`D:\软件\灵动岛\` 与 `%APPDATA%\lingdong-island\` 零写入）。
- 不合并回 `main`（按工程规则 5.1 等用户明确授权）；本轮授权范围到「任务分支交付 + 等授权」为止。
- 探针脚本（`.tmp/probe-*.mjs`）不进交付提交；`.tmp/` 与 `out/` 均被 git ignore。
- 不动阈值 20%，不删 `.backups/battery-charge-low-indicator-20261109/`（App.tsx 114250B、styles.css 45707B 两份改前备份）。

## 七、自检记录

角色：研发自检（实现者本人），2026-11-09，分支 `battery-charge-low-indicator`。

### 时序与合规说明

工程规则第 2 节要求「没有 SPEC 不开工」。本轮实际顺序：备份 → 实现 → 探索注入链路（CDP 直改 `window.island` 失败——contextBridge 属性 Cannot redefine property [实测]；主进程 CDP 不可触达 [实测]；无编译链造不了假 powershell.exe [实测]）→ 落定 bundle patch 注入方案 → 写新 e2e → 跑通 → **补写本 SPEC** → 提交。SPEC 在**提交前**落盘并覆盖实现范围，验收条件 A1–A6 与实际执行的检查一一对应；「先探索后写 SPEC」的偏差在此如实记录，不掩饰。

### 逐项结果

| 编号 | 命令 / 检查 | 实际结果 | 判定 |
|---|---|---|---|
| A1 | `npm run typecheck` | `typecheck:node`（tsc --noEmit -p tsconfig.node.json）与 `typecheck:web`（tsc --noEmit -p tsconfig.web.json）均无错误输出、退出码 0。过程中曾出现一次 `src/renderer/src/App.tsx(2381,34): error TS18047: 'battery' is possibly 'null'`，将 `low` 判定改为 `battery !== null && !charging && battery <= 20` 后复跑通过 | ✅ 通过 |
| A2 | `node scripts/e2e-battery-states.mjs` | **31 过 / 0 败**。S1：cls（trim 后）`head-battery-ring`、num `80`、title/aria `电量 80%`、stroke `rgba(255, 255, 255, 0.85)`、hasBolt false、数字色 `rgba(255, 255, 255, 0.92)`；S2：cls 含 `charging`、title/aria `充电中 · 电量 99%`、stroke `rgba(75, 214, 130, 0.9)`、hasBolt true；S3：`charging` 且无 `low`、stroke 绿、数字色非红（充电优先成立）；S4：cls `head-battery-ring low`、title/aria `电量偏低 · 15%`、stroke `rgba(255, 107, 107, 0.9)`、数字色 `rgba(255, 107, 107, 0.95)`、无闪电 | ✅ 通过 |
| A3 | e2e 内置 R1 断言 | `out/main/index.js` 还原后 `Buffer.compare === 0`（31 项里最后一项 ✓）；e2e 全程走 `scripts/isolate-userdata.mjs`（APPDATA → `.tmp\e2e-userdata` + `--user-data-dir`），真实运行数据零写入 | ✅ 通过 |
| A4 | 三个既有 e2e 回归 | `e2e-m3.mjs` → `E2E PASS`（statusSnapshot 里 `charging:true` 正常透传）；`e2e-wifi.mjs` → `E2E WIFI PASS`（A3 断言 DOM 顺序 head-battery-ring → collapsed-clock → collapsed-wifi → collapsed-bell 未变）；`e2e-collapse-beautify.mjs` → **7 过 / 0 败**（电量环位置、时钟、旧红点不出现均过） | ✅ 通过 |
| A5 | `git status --porcelain` / `git diff` | 提交前仅 `M src/renderer/src/App.tsx`、`M src/renderer/src/styles.css` + 未跟踪 `scripts/e2e-battery-states.mjs` 与本 SPEC；提交后固定提交内容 = 第二节清单（核对见独立验收） | ✅ 通过（提交前核实） |
| A6 | e2e 断言覆盖 | aria-label 与 title 在 S1–S4 四场景均逐字断言（A2 表内文案） | ✅ 通过 |

### 调试教训（留档）

1. className 模板 `head-battery-ring ${low?'low':''} ${charging?'charging':''}` 在两个插值都空时产生**两个空格**（`'head-battery-ring  '`）——e2e 断言必须 `d.cls.trim()` 比较，裸串比较不可靠 [实测]。
2. bundle patch 必须**每次从备份（原版）读**再替换：从已被 patch 的 bundle 读会让第二场景找不到 OLD 串 [实测]。
3. PS 注入字面量必须带 PS 单引号（`'15|True'`）：裸 `15|True` 是 PS 管道表达式，报错返回 null [实测]。

### 本轮没做的验证（明确列出，不计入通过）

- 未在真机上观察「自然低电量」（本机恒 99% 充电，物理不可得，已用注入方案替代并如实标注）。
- 未跑 `npm run dist` / 未装机 / 未启动安装版（本轮明确不做，用户机器上仍跑旧版）。
- 收起态与展开态头部**共用同一 JSX**（App.tsx:2377-2409 只有一份 case 'battery'），e2e 断言的是收起态 DOM；展开态头部为推断同效 [推断：两处引用同一 renderStatusItem 输出，样式类同名；最可能错在展开态有独立的覆盖 CSS——已查 styles.css 495-513 无展开态作用域选择器，风险低]。
- 闪电图标的实际视觉效果（位置/大小观感）未经人眼在真实界面确认，e2e 只验证了 DOM 存在与 CSS 值正确。

### 追加修正（2026-11-09 晚，提交 `2aaa9c0`）

用户实测指出闪电图标有问题（m00918/m00920/m01026「界面这个图标，你看不到问题吗」「你自己看看你改了啥」）。首版交付的闪电在展开态一直是 20px（原因见第三节 1a），盖住中间数字，与收起态完全不一致，是真实缺陷，不是观感偏好。修正与复检：

| 检查 | 做法 | 结果 |
|---|---|---|
| 几何核实 | 临时给 electron 加 `--remote-debugging-port=9321`，CDP 读 `.ring-bolt` 的 `getBoundingClientRect()` | [实测] 修前展开态 bolt 计算宽高 **20px**、收起态 **10px**；修后两态均 **7px**（展开 ring 20px、收起 ring 22px，比例各自协调） |
| 视觉对比 | CDP `Page.captureScreenshot` 截图元素（10× 放大 + 1× 实尺），四种候选（8px 深底 / 6px 深底 / 7px 无底 / 7px 描边）拼对比图 | [实测] 深底方案会在绿环上切出缺口（A/B 明显）、描边方案把闪电压暗（D）、无底最干净（C）→ 采用 C 风格 |
| 两态一致性 | 点击切换收起/展开各截一次 | [实测] 收起态 bolt 7×7 @ (36.5,7)，ring 22×22 @ (17.6,10)；展开态 bolt 7×7 @ (175.3,36.8)，ring 20×20 @ (158.3,39.8)；两态视觉一致 |
| typecheck | `npm run typecheck` | [实测] `typecheck:node` 与 `typecheck:web` 均无错误输出 |
| 四场景 e2e | `node scripts/e2e-battery-states.mjs` | [实测] **31 过 / 0 败**（改 CSS 尺寸不影响断言项） |
| 回归 | `e2e-m3` / `e2e-collapse-beautify` / `e2e-wifi` | [实测] `E2E PASS` / 7 过 0 败 / `E2E WIFI PASS` |

仍**未验证**：闪电在真实界面（非 CDP 截图）的人眼观感确认——只是把几何尺寸改对、把切缺口和压数字去掉了，好不好看要用户看。

独立验收按 `docs/工程规则.md` 第 3.2 节，由未参与实现的会话针对**固定提交**逐条重跑 A1–A6，结论写进第八节，不以本节自检结果代替。

## 八、验收记录

（占位：待独立验收会话针对固定提交逐条重跑 A1–A6 后回填。固定提交哈希：提交后填写于交付汇报，见 `docs/状态.md` 本轮条目。）
