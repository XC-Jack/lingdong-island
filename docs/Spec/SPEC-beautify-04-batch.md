# SPEC：beautify-04-batch（界面美化 4 项一批）

## 抬头

| 项 | 内容 |
|---|---|
| 建立日期 | 2026-11-11 |
| 对应基线提交 | `6602e1c`（main，流程改为预览版试用 + 验收与打包按批进行） |
| 任务分支 | `beautify-04-batch` |
| 关联用户故事 | 无独立 US 编号；来源是 2026-11-08 用户看 boardui.com 后逐条提出的美化想法（`docs/交接-美化进度.md` 第二节） |
| 关联事实文档 | `docs/facts/功能清单.md`（待办页 / 通知页 / 日程页三节）、`docs/交接-美化进度.md` |

## 一、目标

把 `docs/交接-美化进度.md` 第二节列的 4 项美化一起做完（用户 2026-11-11 选定「4 项一起做，做完一次给你看」）：

1. **通知页排版升级**：未读条目标一个蓝点；条目内给一个操作入口。~~（原计划是「打开」按钮，用户实机试用后要求去掉，见第八节）~~
2. **待办完成圆环**：面板头右上原来的「0/0」纯数字，改成圆环 + 数字。
3. **日历升级**：今天从「淡蓝底」改成实心高亮；有安排的日子标一个点。~~（原计划是格内显示日程小标签，用户实机试用后要求改回只标点，见第八节）~~
4. **进度条**：待办页列表下方加一条细轨 + 圆头填充 + 百分比的完成度进度条。

参考图在 `docs/assets/beautify-refs/`：`bui-notifcenter.png`、`bui-rings.png`、`bui-cal2.png`、`bui-calendar.png`、`bui-progress.png`。

> **2026-11-11 用户实机反馈后的修订（以第八节为准）**：
> - 通知页：删掉「打开」按钮（点了没效果）；蓝点从时间左边挪到**条目最右端**。
> - 日程页：日历格内**不再显示**日程标签（会把那一行撑高、破坏对齐），改回**只用一个蓝点**表示这天有安排，所有格子保持等高。
>
> 参考图仍保留，作为「未来若再美化」的比对基准，不代表当前实现与它一致。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | `NotifyPanel`：新增 `lastOrder` state + `renderSide()`（相对时间 + 未读蓝点，蓝点在最右）；`markRead` 改为先 `notifyMarkRead()` 再 `notifyList()` 刷新蓝点；`MonthCalendar` 的 props 保持 `markedDays: Set<string>`（第一版曾改成 `tagsByDay`，用户反馈后改回），格子里只放日期数字 + `.cal-mark`；`SchedulePanel` 里 `markedDays` 的 `useMemo`；`TodoPanel` 列表下方加 `.todo-progress`；面板头 `todo-stat` 里加 `.todo-ring` SVG；顶部加常量 `RING_CIRC` |
| `src/renderer/src/styles.css` | 新增 `.notify-side`、`.notify-unread`、`.todo-ring`/`.todo-ring-bg`/`.todo-ring-fg`、`.todo-progress*`；改 `.cal-day`（恢复等高、单一数字）、`.cal-day.today`（淡蓝底 → 实心）、新增 `.cal-day.today.selected`、`.cal-day.today .cal-mark`。**回退**：删掉 `.notify-open`、`.cal-num`、`.cal-tags`/`.cal-tag`/`.cal-more`、`.cal-day.has-tag .cal-mark` |
| `src/main/notifyStore.ts` | `notify:list` / `notify:refresh` / `notify:clear-all` 的返回值加 `lastOrder: readMark()`（已读水位），供渲染层判断每条是否未读 |
| `src/preload/index.ts` | `NotifyListResult` 加 `lastOrder: number` |
| `scripts/e2e-beautify-04.mjs` | **新建** e2e（23 条断言） |
| `docs/facts/功能清单.md`、`docs/状态.md`、`docs/交接-美化进度.md` | 同步事实 |

## 三、预期行为

1. 通知页：未读条目（`order > lastOrder`）在条目**最右端**（相对时间右边）显示一个 6px 蓝色圆点；已读条目不显示。点「已读」后所有蓝点消失（不需要重开页面）。条目右侧**不再有**「打开」按钮（2026-11-11 用户实机反馈：点了没效果，去掉）。
2. ~~通知页：组条与会话条右侧有一个「打开」按钮~~（已按用户反馈删除。要打开就展开到具体条目再点正文，正文本身就是「打开来源应用」）。
3. 待办页头部：自启开关下方显示一个小圆环（底环 + 按完成比例画的前景环，顺时针从 12 点起）+ 右侧纯文本 `n/m`。**`.todo-stat .todo-count` 的文本必须仍然恰好是 `n/m`**（`scripts/e2e-todo-today.mjs`、`scripts/e2e-collapsed-todo.mjs` 做精确字符串比对）。
4. 待办页列表下方：一条进度条（细轨 + 圆头填充 + 右侧「还差 N 件 + 百分比」）。完成度 0 时填充宽度 0 但轨道可见；全部完成时填充满、变实心绿、文案改「今天全部做完」。
5. 日程页日历：今天用实心高亮（不再是不透明度 0.22 的淡蓝）；今天同时被选中时加一圈浅色内描边，与「普通选中日」区分开。**格内不放任何文字标签**（2026-11-11 用户实机反馈：标签会把那一行撑高、破坏对齐），有安排的日子只在格子底部标一个 4px 蓝点，所有格子等高。`aria-label` 保持 `选择 M 月 D 日`（`scripts/e2e-schedule-day.mjs` 依赖）。
6. 日历格子文本**就是日期数字本身**（`scripts/e2e-schedule-crossmonth.mjs` 用 `textContent.trim().startsWith('10')` 找格子）。
7. 以上所有改动只影响渲染层外观：不改数据结构、不改 IPC 语义（除 `NotifyListResult` 新增只读字段）、不改岛的宽高计算逻辑。

## 四、必要依赖

- 无新增 npm 依赖。圆环用内联 SVG（`stroke-dasharray`/`stroke-dashoffset`），进度条用 `transform: scaleX` + CSS 过渡。
- 依赖现有已读水位（`userData/notif-read.json` 的 `lastOrder`）——只是把已有值多暴露一个字段，不改判定逻辑。

## 五、验收条件

- [x] 1. `npm run typecheck` 与 `npm run build` 均 exit 0
- [x] 2. `node scripts/e2e-beautify-04.mjs` 全过（**25 过 / 0 败 / 0 跳过**，用户反馈后已按新行为改写断言）
- [x] 3. 未读蓝点：水位清零后 5 个组条全带蓝点 → 点「已读」→ 0 个；**蓝点都在条目最右端**；**条目右侧没有按钮**
- [x] 4. `todo-count` 文本仍严格等于 `n/m`（`e2e-todo-today` A4/A5/A8/A10、`e2e-collapsed-todo` A6 全过）
- [x] 5. 圆环的 `stroke-dashoffset` 随完成比例变化（0% → 56.55，1/4 → 42.41）
- [x] 6. 进度条填充随比例变化：0% 时 `scaleX(0)`，1/4 时 `scaleX(0.25)`，文本 `25%`
- [x] 7. 日历今天实心（计算样式 `rgb(100,181,246)`，不透明度 1）；今天+选中叠加有内描边
- [x] 8. 格内**没有任何**日程标签；有安排的日子有一个可见蓝点；**所有日历格等高**（实测 min=max=24px）
- [x] 9. 回归（见第七节）
- [x] 10. 预览版 `npm start` 起来，用户实机试过并给出三条修改意见，已全部改完重验（见第八节）
- [ ] 11. 独立验收（按批验收时补）

## 六、不做什么

- 不做通知条目的「回复」「查看主题」类内联按钮 —— 灵动岛的通知是只读的（从 wpndatabase 读），没有回复能力，只有「打开来源应用」是真实可用的动作。
- **不再做条目内「打开」按钮**（做过，用户实机试用后判定「点了没什么效果」，已删除）。
- **不再做日历格内日程标签**（做过，用户实机试用后判定「会把那一行撑高」，已改回只标点）。
- 不做「点日历蓝点直接跳到那条日程」—— 格子太小，命中率低，容易误点。
- 不改通知的两级堆叠（US-040）结构，只在其上加蓝点。
- 不动置物架页、音乐页、设置窗口。
- 不做深色/浅色主题切换（项目只有深色）。
- 不引入任何 UI 组件库或动画库。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-11 | `npm run typecheck` | EXIT=0 | — |
| 2026-11-11 | `npm run build` | EXIT=0（`index-BQBBBQMs.js 106.57 kB`、`index-SbxrJXqu.css 55.70 kB`；本轮前为 102.15 kB / 49.68 kB） | — |
| 2026-11-11 | `node scripts/e2e-beautify-04.mjs`（新建，25 条） | PASS 23 过 / 0 败 / 0 跳过：N1 5 组全带蓝点、N2 已读后 0 个、T2 dasharray 56.5487、T8 offset 42.41、T9 scaleX 0.25、T10 文本 25%、C2 今天 `rgb(100,181,246)`、C3 2 标签、C4 `+1`、C6 日期数字仍在最前、C7 aria-label 未变 | 真实鼠标手感 |
| 2026-11-11 | 用户实机试用预览版，反馈三条（通知页「打开」没用、蓝点应放最右、日历格被标签撑高不对称） | 已按三条全部改完（见第八节），断言语义同步改写 | — |
| 2026-11-11 | 改完后 `npm run typecheck` | EXIT=0 | — |
| 2026-11-11 | 改完后 `npm run build` | EXIT=0（`index-DBvwAAPD.js 105.03 kB`、`index-Codrs0Mq.css 53.83 kB`） | — |
| 2026-11-11 | 改完后 `node scripts/e2e-beautify-04.mjs`（25 条，断言已按新行为重写） | **PASS 25 过 / 0 败 / 0 跳过**：N3 蓝点全在最右端（`rightEdge=true`）、N4 右侧无按钮（`buttons=0`）、C3 格内 0 标签、C4 有蓝点且可见、C5 非今天的日子也有点、C6 所有格子等高（`min=max=24`）、C7 格子文本就是日期数字 | 真实鼠标手感 |
| 2026-11-11 | 改完后回归 `e2e-schedule-day` / `e2e-schedule-crossmonth` / `e2e-schedule-scroll` / `e2e-collapsed-todo` / `e2e-notify-compact` / `e2e-notify-icon` | 全过（PASS / 8 过 0 败 / 6 过 0 败 / PASS / 2 过 0 败 / 8 过 0 败）；`e2e-schedule-day` A6 蓝点仍 2 个 | — |
| 2026-11-11 | 改完后回归 `e2e-todo-today` | 首两次跑在 A7 报 `TypeError: Cannot read properties of undefined (reading 'querySelectorAll')`；单独写探针逐项验证时间弹层（`.sched-time-btn` 能开、2 列 24/12 行、点 14 生效）全部正常，第三次跑 **A1–A10 全过** | 判为该脚本既有的时序抖动（等 250ms 后立刻点下一列），与本次改动无关；未改该脚本 |
| 2026-11-11 | 回归：`e2e-todo-today` / `e2e-collapsed-todo` / `e2e-schedule-day` / `e2e-schedule-crossmonth` / `e2e-schedule-scroll` | 全过（PASS / PASS / PASS / 8 过 0 败 / 6 过 0 败；`e2e-schedule-day` A6 蓝点仍 2 个、A5 副标题「0 条待办」正确） | — |
| 2026-11-11 | 回归：`e2e-notify-icon` / `e2e-notify-live` / `e2e-notify-compact` / `e2e-notify-group` / `e2e-notify` / `e2e-notify-open` | 前三个全过（8/1/2 条）；后三个有失败，**经 `git stash` 对照确认是既有问题**（同一份 `main` 代码同样失败）：`e2e-notify.mjs` `FAIL: dots=0`、`e2e-notify-open.mjs` O1b 本机无 QQ 深链、`e2e-notify-group.mjs` G5b/G7（8 过 2 败） | 这三个脚本与本次改动无关，未修（另开任务） |
| 2026-11-11 | 截图自检 `.tmp/shot-beautify-04.mjs` → `.tmp/shot-b4-{todo,notify,schedule,shelf}.png` | 4 页肉眼确认：通知页蓝点 + 「打开」常显、待办页头部圆环 + 底部「还差 4 件 50%」进度条、日程页今天蓝底实心 + 格内 2 标签 + 「+1」、置物架页未受影响 | 高 DPI 缩放下的观感未逐个核对 |
| 2026-11-11 | 「打开」按钮可见性返工 | 第一版 `opacity:0` 只在 hover 显现，截图自检发现根本找不到按钮 → 改 `opacity:0.5` 常显、hover/focus 变 1，重截图确认 | — |
| 2026-11-11 | 日历「今天+选中」叠加样式补做 | 默认选中的就是今天，两者样式完全相同会看不出今天在哪 → 新增 `.cal-day.today.selected` 内描边 | — |

| 2026-11-11 | 用户第二轮实机反馈：「白色背景和黑点，太丑了，换一个；还有就是刚刚有通知，通知栏没有反应」 | ①`.cal-day.today` 改蓝描边 + 蓝字（不再白底）、`.cal-day.selected .cal-mark` 由黑点改浅点；②`onNotifyArrived` 补未读数重拉（见第八节第二条） | — |
| 2026-11-11 | 写探针 `.tmp/probe-notify-offpage.mjs` 复现「来通知岛没反应」 | 复现成功：展开停在待办页注入 toast，主进程 unread 9→10，铃铛 aria-label 一直「9 条未读通知」6 秒不变 —— 根因是 `NotifyPanel` 只在展开且停在通知页时挂载，卸载后没人更新 `notifyUnread` | — |
| 2026-11-11 | 修完后 `npm run typecheck` / `npm run build` | EXIT=0 / EXIT=0（`index-C7RjkAr8.js 105.12 kB`、`index-FLQr4AX-.css 54.22 kB`） | — |
| 2026-11-11 | 修完后 `node .tmp/probe-notify-fixed.mjs` | **PASS 3 过 / 0 败**：P1 铃铛「10 条未读通知」→「11 条」、P2 界面与主进程一致（11=11）、P3 停在通知页来通知列表顶部自动出现（不用退出重进） | — |
| 2026-11-11 | 修完后 `node scripts/e2e-beautify-04.mjs`（C2 段重写为 C2/C2b/C2c） | **PASS 27 过 / 0 败 / 0 跳过**：C2 `bg=rgb(100,181,246)` 不再是白底、C2b `ring=rgba(242,243,245,0.9) 0 0 0 1.5px inset`、C2c `markColor=rgb(242,243,245)`、C6 `min=24 max=24` | 真实鼠标手感 |
| 2026-11-11 | 修完后回归 `e2e-schedule-day` / `e2e-schedule-crossmonth` / `e2e-schedule-scroll` / `e2e-todo-today` / `e2e-notify-compact` / `e2e-notify-live` | 全过（PASS / 8 过 0 败 / 6 过 0 败 / PASS / 2 过 0 败 / 1 过 0 败）。**注意：必须先杀掉预览版 electron 再跑**，否则互相干扰（首轮 `e2e-todo-today` 报「A1 没进到待办页，标题 = 通知」、schedule 三个脚本 0 过全败） | — |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待批量验收（按 `docs/工程规则.md` 第三节第 5 条，本轮不单独验收） | — | — | — |
