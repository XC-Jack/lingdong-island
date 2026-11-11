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

1. **通知页排版升级**：未读条目前加蓝点；条目内给一个「打开」操作按钮。
2. **待办完成圆环**：面板头右上原来的「0/0」纯数字，改成圆环 + 数字。
3. **日历升级**：今天从「淡蓝底」改成实心高亮；日期格里直接显示当天日程的小标签，超过 2 条显示「+N」。
4. **进度条**：待办页列表下方加一条细轨 + 圆头填充 + 百分比的完成度进度条。

参考图在 `docs/assets/beautify-refs/`：`bui-notifcenter.png`、`bui-rings.png`、`bui-cal2.png`、`bui-calendar.png`、`bui-progress.png`。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | `NotifyPanel`：新增 `lastOrder` state + `renderSide()`（未读蓝点 / 相对时间 / 「打开」），组条与会话条用带 `onOpen` 的重载、具体条目只带蓝点；`markRead` 改为先 `notifyMarkRead()` 再 `notifyList()` 刷新蓝点；`MonthCalendar` 的 `markedDays: Set<string>` → `tagsByDay: Map<string, CalTag[]>`，格子内加 `.cal-num` + `.cal-tags`/`.cal-tag`/`.cal-more`；`SchedulePanel` 里 `markedDays` 换成 `tagsByDay` 的 `useMemo`；`TodoPanel` 列表下方加 `.todo-progress`；面板头 `todo-stat` 里加 `.todo-ring` SVG；顶部加常量 `RING_CIRC` |
| `src/renderer/src/styles.css` | 新增 `.notify-side`、`.notify-unread`、`.notify-open`、`.todo-ring`/`.todo-ring-bg`/`.todo-ring-fg`、`.todo-progress*`、`.cal-num`/`.cal-tags`/`.cal-tag`/`.cal-more`；改 `.cal-day`（改纵向 flex）、`.cal-day.today`（淡蓝底 → 实心）、新增 `.cal-day.today.selected`、`.cal-day.has-tag .cal-mark`（隐藏视觉） |
| `src/main/notifyStore.ts` | `notify:list` / `notify:refresh` / `notify:clear-all` 的返回值加 `lastOrder: readMark()`（已读水位），供渲染层判断每条是否未读 |
| `src/preload/index.ts` | `NotifyListResult` 加 `lastOrder: number` |
| `scripts/e2e-beautify-04.mjs` | **新建** e2e（23 条断言） |
| `docs/facts/功能清单.md`、`docs/状态.md`、`docs/交接-美化进度.md` | 同步事实 |

## 三、预期行为

1. 通知页：未读条目（`order > lastOrder`）在右侧时间旁显示一个 6px 蓝色圆点；已读条目不显示。点「已读」后所有蓝点消失（不需要重开页面）。
2. 通知页：组条与会话条右侧有一个「打开」按钮（常显、淡），点它 = 打开来源应用 + 标已读；点正文仍走原来的展开/收起。具体条目的正文本身就是「打开来源应用」，不再重复给按钮。
3. 待办页头部：自启开关下方显示一个小圆环（底环 + 按完成比例画的前景环，顺时针从 12 点起）+ 右侧纯文本 `n/m`。**`.todo-stat .todo-count` 的文本必须仍然恰好是 `n/m`**（`scripts/e2e-todo-today.mjs`、`scripts/e2e-collapsed-todo.mjs` 做精确字符串比对）。
4. 待办页列表下方：一条进度条（细轨 + 圆头填充 + 右侧「还差 N 件 + 百分比」）。完成度 0 时填充宽度 0 但轨道可见；全部完成时填充满、变实心绿、文案改「今天全部做完」。
5. 日程页日历：今天用实心高亮（不再是不透明度 0.22 的淡蓝）；今天同时被选中时加一圈浅色内描边，与「普通选中日」区分开。每个日期格内显示当天日程的小标签（时间加粗 + 标题），最多 2 条，超过显示「+N」。`aria-label` 保持 `选择 M 月 D 日`（`scripts/e2e-schedule-day.mjs` 依赖）。
6. 日历格子内日期数字（`.cal-num`）仍在该格文本最前面（`scripts/e2e-schedule-crossmonth.mjs` 用 `textContent.trim().startsWith('10')` 找格子）。
7. 以上所有改动只影响渲染层外观：不改数据结构、不改 IPC 语义（除 `NotifyListResult` 新增只读字段）、不改岛的宽高计算逻辑。

## 四、必要依赖

- 无新增 npm 依赖。圆环用内联 SVG（`stroke-dasharray`/`stroke-dashoffset`），进度条用 `transform: scaleX` + CSS 过渡。
- 依赖现有已读水位（`userData/notif-read.json` 的 `lastOrder`）——只是把已有值多暴露一个字段，不改判定逻辑。

## 五、验收条件

- [x] 1. `npm run typecheck` 与 `npm run build` 均 exit 0
- [x] 2. `node scripts/e2e-beautify-04.mjs` 全过（23 过 / 0 败 / 0 跳过）
- [x] 3. 未读蓝点：水位清零后 5 个组条全带蓝点 → 点「已读」→ 0 个
- [x] 4. `todo-count` 文本仍严格等于 `n/m`（`e2e-todo-today` A4/A5/A8/A10、`e2e-collapsed-todo` A6 全过）
- [x] 5. 圆环的 `stroke-dashoffset` 随完成比例变化（0% → 56.55，1/4 → 42.41）
- [x] 6. 进度条填充随比例变化：0% 时 `scaleX(0)`，1/4 时 `scaleX(0.25)`，文本 `25%`
- [x] 7. 日历今天实心（计算样式 `rgb(100,181,246)`，不透明度 1）；今天+选中叠加有内描边
- [x] 8. 格内标签数 = min(当天日程数, 2)，3 条时出现「+1」
- [x] 9. 回归（见第七节）
- [ ] 10. 预览版 `npm start` 起来，4 项在真机肉眼可见、可点（待用户试）
- [ ] 11. 独立验收（按批验收时补）

## 六、不做什么

- 不做通知条目的「回复」「查看主题」类内联按钮 —— 灵动岛的通知是只读的（从 wpndatabase 读），没有回复能力，只有「打开来源应用」是真实可用的动作。
- 不给日历做「点标签直接跳到那条日程」—— 格子太小，命中率低，容易误点。
- 不改通知的两级堆叠（US-040）结构，只在其上加蓝点与按钮。
- 不动置物架页、音乐页、设置窗口。
- 不做深色/浅色主题切换（项目只有深色）。
- 不引入任何 UI 组件库或动画库。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-11 | `npm run typecheck` | EXIT=0 | — |
| 2026-11-11 | `npm run build` | EXIT=0（`index-BQBBBQMs.js 106.57 kB`、`index-SbxrJXqu.css 55.70 kB`；本轮前为 102.15 kB / 49.68 kB） | — |
| 2026-11-11 | `node scripts/e2e-beautify-04.mjs`（新建，25 条） | PASS 23 过 / 0 败 / 0 跳过：N1 5 组全带蓝点、N2 已读后 0 个、T2 dasharray 56.5487、T8 offset 42.41、T9 scaleX 0.25、T10 文本 25%、C2 今天 `rgb(100,181,246)`、C3 2 标签、C4 `+1`、C6 日期数字仍在最前、C7 aria-label 未变 | 真实鼠标手感 |
| 2026-11-11 | 回归：`e2e-todo-today` / `e2e-collapsed-todo` / `e2e-schedule-day` / `e2e-schedule-crossmonth` / `e2e-schedule-scroll` | 全过（PASS / PASS / PASS / 8 过 0 败 / 6 过 0 败；`e2e-schedule-day` A6 蓝点仍 2 个、A5 副标题「0 条待办」正确） | — |
| 2026-11-11 | 回归：`e2e-notify-icon` / `e2e-notify-live` / `e2e-notify-compact` / `e2e-notify-group` / `e2e-notify` / `e2e-notify-open` | 前三个全过（8/1/2 条）；后三个有失败，**经 `git stash` 对照确认是既有问题**（同一份 `main` 代码同样失败）：`e2e-notify.mjs` `FAIL: dots=0`、`e2e-notify-open.mjs` O1b 本机无 QQ 深链、`e2e-notify-group.mjs` G5b/G7（8 过 2 败） | 这三个脚本与本次改动无关，未修（另开任务） |
| 2026-11-11 | 截图自检 `.tmp/shot-beautify-04.mjs` → `.tmp/shot-b4-{todo,notify,schedule,shelf}.png` | 4 页肉眼确认：通知页蓝点 + 「打开」常显、待办页头部圆环 + 底部「还差 4 件 50%」进度条、日程页今天蓝底实心 + 格内 2 标签 + 「+1」、置物架页未受影响 | 高 DPI 缩放下的观感未逐个核对 |
| 2026-11-11 | 「打开」按钮可见性返工 | 第一版 `opacity:0` 只在 hover 显现，截图自检发现根本找不到按钮 → 改 `opacity:0.5` 常显、hover/focus 变 1，重截图确认 | — |
| 2026-11-11 | 日历「今天+选中」叠加样式补做 | 默认选中的就是今天，两者样式完全相同会看不出今天在哪 → 新增 `.cal-day.today.selected` 内描边 | — |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待批量验收（按 `docs/工程规则.md` 第三节第 5 条，本轮不单独验收） | — | — | — |
