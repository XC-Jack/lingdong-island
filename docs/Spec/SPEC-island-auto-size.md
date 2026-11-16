# SPEC：岛展开态尺寸随内容自适应（带上下限）

- 分支：`island-auto-size`（基线 `main@ac6b9af`）
- 创建：2026-11-16
- 用户原话（m00791）：「岛的界面太固化，下面的空间就是一块黑布……我希望它可以根据里面的东西自行伸缩空间，当然也要有最大的范围」
- 用户原话（m00795）：「达到最大限度，内容文件可以继续往里面放，通过滚轮的方式来查看，只显示3条；高度宽度都可以自适应」

## 一、目标

展开态的岛不再写死 `470×320` 布局 px，改成**宽高都随当前页内容自然撑开**，并受最小/最大范围夹逼。内容超过上限时不再撑大岛，而是在内容区内部滚动（滚轮可查）。列表（待办/日程/通知/置物架）默认最多显示 3 条，第 4 条起靠滚动查看。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/renderer/src/styles.css` | `.island.expanded` 从固定 `width:470px;height:320px` 改为 `max-content` + `min/max` 夹逼；列表容器加「3 条以内」的高度上限；相应收缩链复查 |
| `src/main/index.ts` | 复核 `EXPANDED_MIN`/`EXPANDED_MAX`/`expandedSize` 的注释与数值（夹逼值本身要与 CSS 对齐，可能需要改注释，数值原则上沿用） |
| `scripts/e2e-music.mjs` 等既有 e2e | 复查与岛尺寸相关的断言是否因自适应失效（如有则只在本次改动范围内修正） |
| `docs/facts/功能清单.md` 或 `docs/状态.md` | 记录行为变化 |

**不改**：主进程 IPC 通道 `island:set-expanded-size`（已存在且工作正常）、渲染层 `ResizeObserver` 上报链路（已存在）、收起态尺寸逻辑。

## 三、预期行为

1. 展开态岛宽高由当前页内容决定：内容少则岛小（不小于下限），内容多则岛大（不大于上限）。
2. 上限（视觉 px）：宽 540 / 高 315；下限：宽 225 / 高 113。对应布局 px（`zoom:0.75`）宽 300~720、高 150~420。（本节最初写的是下限 315×165 / 布局 420~220，实测后收紧，见第八节 8.2。）
3. 达到上限后，继续添加内容**仍可添加成功**，但不会再撑大岛；超出部分在内容区内部用滚轮滚动查看。
4. 待办页 / 日程页列表默认最多显示 3 条；超过 3 条时列表自身出现滚动（滚动条仍隐藏，符合既有用户要求）。
5. 切页时岛尺寸平滑过渡到该页需要的尺寸（沿用现有 `TWEEN_MS=500` 缓动）。
6. 收起态行为完全不变。

## 四、必要依赖

无新增依赖。全部用现有 CSS 能力 + 已有的 `ResizeObserver` 上报 + 主进程 `setBounds` 缓动。

## 五、验收条件

1. 待办页 0 条时岛高明显小于 320 布局 px（截图一的「一块黑布」消失）。
2. 待办页加到 3 条时岛高随之增加；加到第 4、5 条时岛高停在上限，列表可滚轮滚动看到第 4、5 条。
3. 日程页、通知页、置物架页、音乐页分别切过去，岛宽高各自贴合内容，无内容被裁、无黑边。
4. `npm run typecheck` 与 `npm run build` 通过。
5. 既有 e2e（至少 `e2e-music.mjs`、`e2e-todo-today.mjs`、`e2e-schedule-day.mjs`、`e2e-notify*.mjs`）不回归。
6. 装机版（`D:\软件\灵动岛\`）上真机拖动/滚轮实测通过。

## 六、不做什么

1. **不改成按用户拖拽调整大小**（岛窗口 `resizable:false`，本轮不加）。
2. **不做每页各自记忆尺寸**（切页就按当前页内容重算）。
3. **不改收起态尺寸逻辑**、不改横幅预留高度。
4. **不给列表加可见滚动条**（用户早前明确要求隐藏滚动条）。
5. **不顺手改任何与尺寸无关的样式**（字号、配色、间距不动）。

## 七、推翻的历史决定（必须在这里写清）

`src/renderer/src/styles.css:104-118` 与 `src/main/index.ts:33-43` 的注释都记着：2026-11-11 用户要求「不希望添加任务会拉伸界面，通知页和待办页也一样」，因此把各页改成固定尺寸 `470×320`（提交 `7e6edbd`、`a3ecf2b`）。

本轮用户（m00791/m00795）**明确要求反过来**：要随内容伸缩、只保留最大范围。所以本 SPEC 推翻上述固定尺寸决定，`styles.css` 与 `index.ts` 里那段「固定尺寸」注释要同步改成本轮结论，避免下一个人看到旧注释又把尺寸写死。

## 八、实现记录

（2026-11-16 完成，分支 `island-auto-size`；基线 `main@ac6b9af`，动手前备份 `.backups/island-auto-size-20261116-123108/`：`App.tsx`、`styles.css`、`index.ts`、`e2e-music.mjs`）

### 8.1 改动清单

| 文件 | 改动 |
|---|---|
| `src/renderer/src/styles.css` | `.island.expanded` 由 `width:470px;height:320px` 改为 `width:max-content; min-width:300px; max-width:720px; height:max-content; min-height:150px; max-height:420px`（注释改成新结论并列换算）；`.todo-list` 加 `max-height:114px`；`.todo-text` 加 `max-width:300px`；`.shelf-drop.list .shelf-list` `max-height:288px→130px`；`.notify-list` 加 `max-height:136px`；新增 `.notify-line`，`.notify-app` 加 `flex:none`、`.notify-title` 加 `flex:1;min-width:0` |
| `src/main/index.ts` | `EXPANDED_MIN` 由 `{width:315,height:165}` 改为 `{width:225,height:113}`，注释按新结论重写（含「改一边必须同步改另一边」）；`expandedSize` 注释改为「初始值只用于首帧开窗，随后被 ResizeObserver 纠正」，值不变 |
| `src/renderer/src/App.tsx` | 通知条目与子条目都改成「应用名与标题同排」，包进新的 `<span className="notify-line">`（原来应用名单独占一行，导致无图标条目比有图标的高一行，固定高度窗口会把第 3 条切掉） |
| `docs/facts/功能清单.md` / `技术方案.md` / `产品定义.md` | 把「各页尺寸统一固定」「min 420×220 / max 720×420」同步改为本轮结论 |

### 8.2 过程中的实测发现（决定数值的依据）

1. 待办一行布局 34px、视觉 25.5px（`zoom:0.75`），行距 6px ⇒ 3 条 = 34×3 + 6×2 = **114** 布局 px。
2. 通知行原为 30 / 30 / 40.4 / 30（第 3 条是「标题+正文+应用名」三行），136px 窗口切掉第 3 条 ⇒ 改「应用名与标题同排」后全部统一 30.04px，前 3 条完整可见（`scrollH` 196→182）。
3. `.todo-text` 原本 `white-space:nowrap` 无上限，`max-content` 会把岛一路顶到 720 ⇒ 加 `max-width:300px` 保持省略号截断。
4. 日程页日历原来被压到 227 而内容需 303（被裁）；自适应 + 岛的 `max-height:420` 之后 `calH:155 / calScrollH:207 / clipped:false`。
5. 布局 px 与视觉 px 混用会造成「横向溢出」误判：`scrollWidth` 是布局 px、`getBoundingClientRect` 是视觉 px，两者换算后相等，实际**无横向溢出**（`overflowCount:0`）。

### 8.3 自检记录

1. `npm run typecheck`：EXIT=0（node / web 两段均无输出）。
2. `npm run build`：EXIT=0（`out/renderer/assets/index-CYnIE9vH.js 108.38 kB`、`index-B4yi3lAK.css` 同批、`✓ built in 118ms`）。
3. 待办页逐条加（`.tmp/probe-3rows.mjs`，dev electron + 隔离数据）：`n0 225×158 / n1 225×164 / n2 225×194 / n3 225×224 fullyVisible:3 canScroll:false / n4 scrollH:154 fullyVisible:3 / n8 scrollH:314 scrollTop:199`；CDP 真滚轮 `afterUp:0 / afterDown:199` ⇒ 3 条全可见、第 4 条起内滚、真滚轮可到顶到底。
4. 通知页：`itemCount:4 fullyVisible:3 canScroll:true`（改行高前是 2 条）。
5. 日程页：`fullyVisible:3`、日历 `clipped:false`。
6. 置物架（`.tmp/probe-shelf.mjs`，6 个真实文件走 `shelfAdd`）：列表视图 `fullyVisible:3 canScroll:true`，真滚轮 `119.47`。
7. 音乐页（`.tmp/probe-musicpage.mjs`，假 SMTC 会话）：`island 225×190.55`、`overflowCount:0`。
8. 既有 e2e 不回归：`e2e-music.mjs` PASS 39/0、`e2e-music-session.mjs` PASS 20/0、`e2e-notify-compact.mjs` 2/0、`e2e-notify-icon.mjs` 10/0、`e2e-notify*.mjs` 各 PASS、`e2e-beautify-04.mjs` 27/0、`e2e-schedule-scroll.mjs` 6/0、`e2e-schedule-crossmonth.mjs` 8/0、`e2e-schedule.mjs`/`e2e-schedule-day.mjs`/`e2e-todo-today.mjs` 删掉残留 `prefs.json` 后 PASS。
9. [未核验] 装机版真机滚轮与观感（需打包装机后在 `D:\软件\灵动岛\` 上由人实测）。
10. 已知非本轮问题（基线上同样失败，不在本轮修）：`scripts/e2e-schedule-edit.mjs` 报 `TypeError: Cannot read properties of null (reading 'click')`；`scripts/e2e-notify-group.mjs` 的 G11 因本机库里没有 Windows 安全中心通知而跳过判定。
11. 踩坑备忘：跑 e2e 前要删 `.tmp/e2e-userdata/lingdong-island/prefs.json`，否则残留的 `pagesCustom.pages` 顺序会让按索引点 dot 的脚本点到别的页，误报成「没进到日程页」。
