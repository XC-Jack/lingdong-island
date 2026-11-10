# SPEC：点收起态铃铛 → 直接展开并跳到通知页

> 任务分支：`bell-opens-notify-page`（从 `main` 的 `67c055f` 建）。
> 起因：用户 2026-11-10 13:36 原文「我们继续往下优化功能；如截图，我希望我点这个ui的时候可以直接跳转到信息通知界面」。
> 流程档位：用户 2026-11-09 选定的「23 分钟档」——不备份（待改文件均已提交、`git checkout` 可还原）、e2e 只加断言不重写、不做独立验收（第八节写 `[未做]`）、不打包。

## 一、目标

收起态胶囊上的**通知铃铛**（`.collapsed-bell`，右上角带红点）从「纯展示」变成「可点击的入口」：点它 = 展开岛 + 直接落在**通知页**（`page === 2`），省掉「先展开到待办页、再翻两下」。

## 二、修改范围

| 文件 | 改什么 | 是否本次 |
|---|---|---|
| `src/renderer/src/App.tsx` | ①新增 `openNotifyPage()` 回调（展开 + `setPage(2)` + 切页动画 + 续命收起计时器）；②`case 'bell'` 的 `<span>` 加 `onClick`（`stopPropagation`）、`onKeyDown`（Enter/Space）、`role="button"`、`tabIndex={0}`；③`title` / `aria-label` 补「点击查看」语义 | ✅ |
| `src/renderer/src/styles.css` | `.collapsed-bell` 加 `cursor: pointer` 与焦点可见样式（`:focus-visible` 描边），不改尺寸/颜色 | ✅ |
| `scripts/e2e-bell-notify.mjs` | 新增：点铃铛后 `page === 2`、面板标题为「通知」、收起→展开尺寸变化；以及「不点铃铛时仍落在第一页」的反证 | ✅ |
| `docs/Spec/SPEC-bell-opens-notify-page.md` | 本文件 | ✅ |
| `docs/状态.md` | 一句话状态 | ✅ |
| `docs/facts/功能清单.md` | 第 5 节铃铛条目补「点击直达通知页」 | ✅ |

**明确不动**：铃铛的显隐语义（勾着且无未读仍不显示）、`pagesCustom` 的显隐/顺序、岛的根节点 `onClick`（空白处点击行为）、自动收起时长（`AUTO_COLLAPSE_MS=700` / `SHELF_COLLAPSE_MS=4000`）、通知页 `NotifyPanel` 自身、主进程任何模块、阈值、布局、`package.json`、`out/`。

## 三、预期行为

1. **收起态**点铃铛：岛展开，并且**直接显示通知页**（页徽章/标题为「通知」，`page === 2`），页面切换带既有淡入动画。
2. 点铃铛**只**做这一件事，不额外触发岛的空白点击逻辑（`stopPropagation`），也不会被 700ms 自动收起立刻收掉——切页后按非首页口径（4000ms）计时，与手动翻到通知页完全一致。
3. **展开态**头部那枚铃铛点下去同样跳到通知页（两处共用 `renderStatusItem`，行为自然一致）；已经在通知页时再点无副作用。
4. 键盘可达：铃铛可聚焦，`Enter` / `Space` 等同点击；`title` 与 `aria-label` 显示为「N 条未读通知，点击查看」。
5. 铃铛的显示条件一个都不变：`pagesCustom.collapsed.bell` 关掉不渲染；`notifyUnread === 0` 仍不渲染（所以「无未读时点不到铃铛」是既有语义，不是本次退化）。
6. 鼠标悬停在铃铛上显示手型光标。

## 四、必要依赖

无新增依赖。只用到既有 `setExpanded` / `setPage` / `setPageAnim` / `clearCollapseTimer` 与既有 `prefs` 面板逻辑。

## 五、验收条件

| 编号 | 判据 | 手段 |
|---|---|---|
| N1 | `npm run typecheck` 退出码 0，无诊断输出 | 命令原始输出 |
| N2 | `npm run build` 退出码 0 | 命令原始输出 |
| N3 | 新 e2e `scripts/e2e-bell-notify.mjs` 全过：注入一条未读 → 收起态点 `.collapsed-bell` → `.island.expanded` 存在、`page === 2`、面板标题为「通知」、页点第 3 个为 active | CDP + 断言 |
| N4 | 反证：不点铃铛、只点胶囊空白处 → 展开后落在第一页（`page === 0`，标题「待办」），证明 N3 不是「本来就到通知页」 | 同一脚本第二条路径 |
| N5 | 回归：`scripts/e2e-collapse-beautify.mjs`、`scripts/e2e-collapse-order.mjs`、`scripts/e2e-head-order.mjs` 全过（铃铛 DOM 结构、顺序、显隐都没被改坏） | 三个脚本 |
| N6 | 回归：`scripts/e2e-battery-states.mjs` 仍 `31 过 / 0 败`，`scripts/e2e-battery-push.mjs` 仍全过（确认没碰电量链路） | 两个脚本 |
| N7 | 工作区干净、改动文件不越出第二节表 | `git status` + `git show --stat` |

## 六、不做什么

- 不做「点红点标记已读」、不做「点铃铛直接打开某条通知的来源应用」（那是横幅 `openFromBanner` 的语义）。
- 不改铃铛的显隐条件，不加「无未读也能点」的入口。
- 不改自动收起时长，不为「通知页」单独设一套计时。
- 不动通知页内部（`NotifyPanel`）的任何逻辑与样式。
- 不重构 `App.tsx`；新回调放在既有回调群附近，沿用既有命名与注释风格。
- 不做独立验收（用户选的 23 分钟档），不打包、不合并回 `main`。

## 七、自检记录

> 自检人：实现方（lead）本人。时间：2026-11-10 13:40–14:05。分支 `bell-opens-notify-page`，基线 `67c055f`。
> 按用户 2026-11-09 选定的「23 分钟档」：不备份、不重写 e2e（只新增一个）、不做独立验收。
> 为便于复验，下面每段都在命令前先清场（`taskkill /IM electron.exe /T /F` + 确认 9321 无监听），这是本项目既有教训（遗留 electron 会占端口，e2e 连到旧实例造成假失败）。

### 7.1 N1 typecheck

```
> lingdong-island@0.1.0 typecheck
> npm run typecheck:node && npm run typecheck:web

> lingdong-island@0.1.0 typecheck:node
> tsc --noEmit -p tsconfig.node.json

> lingdong-island@0.1.0 typecheck:web
> tsc --noEmit -p tsconfig.web.json

TYPECHECK_EXIT=0
```

（两条 tsc 均无任何诊断输出，只有命令行本身。）

### 7.2 N2 build

```
out/main/index.js                       76.09 kB
out/preload/index.js                     8.85 kB
out/renderer/index.html                  0.49 kB
out/renderer/assets/index-ZD9_PFK2.css   46.23 kB
out/renderer/assets/index-DL3orNn3.js   664.90 kB

✓ built in 122ms
BUILD_EXIT=0
```

产物哈希变了（CSS `index-CsgyUWqi` → `index-ZD9_PFK2`、JS `index--d5mQQdE` → `index-DL3orNn3`），符合预期：本轮改了 `App.tsx` 与 `styles.css`；`out/main/index.js` 与 `out/preload/index.js` 的 kB 数与上一轮完全一致，因为主进程与 preload 零改动。

### 7.3 N3 / N4 新 e2e（`node scripts/e2e-bell-notify.mjs`）

```
  ✓ N0 启动后是收起态
  ✓ N0b 收起态有未读 → 铃铛存在
  ✓ N4 只点胶囊空白处 → 展开并在第一页（待办），不是通知页
  ✓ N4b Esc 收回收起态
  ✓ N3b-1 铃铛 role=button 且可聚焦
  ✓ N3b-2 铃铛 title 与 aria-label 带「点击查看」
  ✓ N3a 点到了铃铛元素
  ✓ N3 点铃铛 → 岛展开
  ✓ N3c 展开后标题是「通知」
  ✓ N3d 页点第 3 个（index 2）active
  ✓ N5 没有被岛根 onClick 立刻收回去（仍是展开态）
  ✓ N3e 展开态头部也有铃铛（共用一份实现）
  ✓ N3f 已在通知页时再点头部铃铛，仍停在通知页且保持展开
  ✓ N3g Esc 回到收起态
  ✓ N3h 从第一页展开过之后，再点铃铛仍直达通知页
== 结果：15 过 / 0 败 / 0 跳过 ==
EXIT=0
```

**N4 为什么重要**：同一个脚本先点胶囊空白处，断言落点是「待办」（index 0），再点铃铛断言落点是「通知」（index 2）。如果「展开本来就到通知页」，N4 会一起红——它没有。这是「铃铛真的改变了落点」的直接反证。

**未读从哪来**：铃铛只在有未读时渲染，而未读来自只读的 Windows 通知库（`wpndatabase.db`），e2e 造不出来。本机恰好有未读，所以 N3 系列全部真跑了；脚本里保留了一条「无未读 → 打印 ⚠ 跳过并计入 skipped、绝不算通过」的分支（skipped 不计入 passed）。

### 7.4 N5 回归（铃铛 DOM / 顺序 / 显隐没被改坏）

`node scripts/e2e-collapse-beautify.mjs`：

```
  ✓ B2 无未读时铃铛不渲染（若本机恰有未读则此断言改在清零后验）
  ✓ B1 有未读时铃铛存在
  ✓ B1b 铃铛含红点徽标
  ✓ B1c 铃铛内是实心铃铛 SVG
  ✓ B4 旧红点 .collapsed-dot 不再出现
  ✓ B3 电量环在岛仔之前
  ✓ B5 时钟仍在
== 结果：7 过 / 0 败 ==
```

`node scripts/e2e-collapse-order.mjs`：

```
  ✓ R1 收起态组件按自定义 order 排列
  ✓ R2a 旧偏好不崩，仍读到 pagesCustom
  ✓ R2b 缺 order 时补全为默认顺序
  ✓ R2c 缺 bell 键时视为开启
  ✓ R2d 旧偏好下电量排在岛仔前（默认顺序生效）
  ✓ R3a 铃铛开启 + 有未读 → 收起态渲染
  ✓ R4a 「收起态组件」区 6 行（原 5 行，铃铛新增）
  ✓ R4b 面板含「通知铃铛」一项
  ✓ R4c 面板行顺序与 order 一致
  ✓ R3b 取消勾选铃铛写进 prefs.json
  ✓ R3c 铃铛关闭后收起态不再渲染
  ✓ R3d 重新勾选写回 true
  ✓ R5a 拖动开始前 order 为默认顺序
  ✓ R5b 拖动时可派发事件
  ✓ R5c 悬停在目标行上半时出现「插到前面」提示类
  ✓ R5d 插入到前面：order 变为 battery,pet,todo,clock,net,bell
  ✓ R5e 不是互换语义（clock 没被顶到 todo 原位置）
  ✓ R5f 悬停在目标行下半时出现「插到后面」提示类
  ✓ R5g 插入到后面：order 变为 battery,bell,pet,todo,clock,net
  ✓ R5h order 长度仍为 6 且无重复
  ✓ R5i 拖到自身不改变 order
  ✓ R5j 收起态视觉顺序随 order 改变

E2E COLLAPSE-ORDER: PASS（22 过 / 0 败）
EXIT2=0
```

`node scripts/e2e-head-order.mjs` —— **第一次跑是 `10 过 / 4 败`**（H2a–H2d，全部围绕「取消勾选时钟」）。没有直接归因给本轮，先做了两步排查：

1. 把本轮改动 `git stash` 掉、用基线 `67c055f` 重建后跑同一脚本 → **`14 过 / 0 败`**，说明这是**间歇性失败**而不是「基线本来就坏」。
2. 写一次性探针 `.tmp/probe-head2.mjs`（不进交付）单独验证 `openPanel()` 依赖的 IPC：先在主进程 `Runtime.evaluate` 里发 `island:manage-pages`，再读渲染层 —— `IPC 后 expanded: true`、`IPC 后 rows: 6`、`panel-title: 页面管理`、`clock checkbox: true`，说明面板通路本身正常。

恢复改动后连跑两次：

```
  ✓ H2a 取消勾选时钟写进 prefs.json
  ✓ H2b 取消勾选后展开态不渲染时钟
  ✓ H2c 重新勾选写回 true
  ✓ H2d 勾回后展开态重新渲染时钟
  ✓ H4a 有未读时展开态信息行渲染铃铛
  ✓ H4b 铃铛只出现在信息行内（没有散落到面板其它位置）

E2E HEAD-ORDER: PASS（14 过 / 0 败）   ← 第 1 次 EXIT1=0
E2E HEAD-ORDER: PASS（14 过 / 0 败）   ← 第 2 次 EXIT2=0
```

结论（分档）：**H2 那 4 条败是脚本自身的时序不稳，不是本轮功能问题**——[实测] 同一份改后代码连跑两次全过、基线也全过、IPC 通路单独验过正常；[推断] 最可能错在哪：H2 段在 `openPanel()` 后只 `sleep(700)` 就读 `prefs.json` 并点 checkbox，而面板从 IPC 到渲染完成、偏好写入落盘的时间偶发超过 700 ms，于是读到旧值、后续 4 条连锁失败。本轮**不去改这个既有脚本**（不在本次范围，改了就是顺手动别人的测试），只如实记录：**这是既有脚本的已知不稳，不是本轮引入**。

### 7.5 N6 回归（电量链路没被碰）

`node scripts/e2e-battery-states.mjs`：

```
  ✓ S4 title 电量偏低 — 电量偏低 · 15%
  ✓ S4 aria 电量偏低 — 电量偏低 · 15%
  ✓ S4 弧红 — rgba(255, 107, 107, 0.9)
  ✓ S4 数字红 — rgba(255, 107, 107, 0.95)
  ✓ R1 out/main/index.js 还原字节一致
== 结果：31 过 / 0 败 ==
EXIT1=0
```

`node scripts/e2e-battery-push.mjs`：

```
  ✓ P3-16 变白时刻贴着事件（拔电后 1.5 秒内） — 22174ms
[取数返回后] {"has":true,"api":"function","cls":"head-battery-ring low ","num":"15","title":"电量偏低 · 15%","aria":"电量偏低 · 15%","stroke":"rgba(255, 107, 107, 0.9)"} 距启动 25576 ms
  ✓ P3-17 取数带回 15% 后弧变红（低电态） — rgba(255, 107, 107, 0.9)
  ✓ P3-18 变红时 title 电量偏低 — 电量偏低 · 15%
  ✓ P3-19 变红时数字也是 15 — 15
  ✓ P3-20 变红比变白晚 1 秒以上（同样不等取数） — 白=22174ms 红=25576ms
  ✓ P3-R1 out/main/index.js 还原字节一致
== 结果：23 过 / 0 败 ==
EXIT=0
```

### 7.6 N7 范围

`git status` 改动只有第二节表里的四个路径：`M src/renderer/src/App.tsx`、`M src/renderer/src/styles.css`、`?? docs/Spec/SPEC-bell-opens-notify-page.md`、`?? scripts/e2e-bell-notify.mjs`（外加本文档回填时更新的 `docs/状态.md`、`docs/facts/功能清单.md`）。`out/` 与 `.tmp/` 均被 git 忽略，未入库。

### 7.7 本轮没验证的（不得读成通过）

1. **真机人眼观感**：手型光标、`:focus-visible` 描边、点下去的手感，只用 DOM/计算样式断言过，没有截图给人眼确认。
2. **真实鼠标点击**：e2e 用的是元素 `.click()`（等价合成点击，React 事件委托能收到），没有用真实鼠标坐标点屏幕。岛是点穿透/置顶窗口，坐标点击另有风险，本轮不覆盖。
3. **无未读时的行为**：铃铛根本不渲染，所以「无未读点不到」只是代码推理（`notifyUnread > 0` 才渲染），没有 e2e 断言。
4. **通知页在收起态→展开态的窗口尺寸动画期间的表现**：切页与窗口放大是并行的，没做逐帧核对，只断言动画结束后的稳定态。
5. **`e2e-head-order.mjs` 的 H2 时序不稳**（见 7.4）——本轮没修，属既有脚本问题。
6. **独立验收未做**（用户选的 23 分钟档）。

## 八、验收记录

`[未做]` —— 用户 2026-11-09 选定「23 分钟档」，本轮不含独立验收；若后续要求补做，须另起未参与实现的会话针对本 SPEC 的固定提交重跑 N1–N7。
