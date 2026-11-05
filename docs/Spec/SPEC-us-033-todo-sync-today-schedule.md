# SPEC-us-033-todo-sync-today-schedule

- 建立日期：2026-11-05
- 对应基线提交：`5844799ac3dfe46b80552c8db901cd0633559d43`（分支 `us-014-schedule-cross-day` 的 HEAD，US-014 尚未合并回 `main`）
- 任务分支：us-033-todo-sync-today-schedule
- 关联用户故事：US-033（见 ../facts/用户角色与用户故事.md 第 3.2 节）
- 关联事实文档：../facts/功能清单.md（第 1 节 待办、第 4 节 日程）、../facts/数据规则.md（存储归属）、../facts/用户角色与用户故事.md

## 一、目标

让「待办」页成为**今天要做什么**的速览页：除了待办，也把**今天**的日程一起列出来，能直接勾掉，也能在这一页直接加一条（可选时间）。

现状：待办页（展开态第 1 页）只显示 `todos.json` 里的待办，完全不显示日程；今天的日程只在日程页（第 4 页）里看。用户 2026-11-05 提出：「代办得界面可以和当天得任务同步，就是我今天设置的任务，代办界面会显示，但是只显示当天得，不显示后面的天得任务」。

这是**纯渲染层改动**：不改数据模型、不做迁移、不动主进程与 preload 的接口。待办页新增的内容按用户选定（甲方案）写入**今天的日程**，走已有的 `schedule:add`。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | 抽模块级 `localDayKey()`（本地日期 `YYYY-MM-DD`，替换 `SchedulePanel` 内联的那个）；`TodoPanel` 增加「今天的日程」数据源与混排渲染（勾选、时间徽标、逾期橙标、删除）；添加框改成「输入 + 可选时间按钮」，新增内容写入今天的日程；`onStats` 上抛的统计改为「待办 + 今天日程」的完成数/总数；`App` 的 `refreshTodoStats()`（收起态用）同步改成同一口径；收起态标记的悬停文案由「件待办」改为「件没做完」。 |
| `src/renderer/src/styles.css` | 仅按需微调：待办行里的时间徽标沿用 `.sched-badge`；如混排后间距不合适再补一条小规则。不新增大块样式。 |
| `scripts/e2e-todo-today.mjs`（新增） | 端到端验证：今天日程出现在待办页、明天/昨天不出现、可勾选并与日程页同步、时间显示为 `HH:mm`、待办页新增落到今天的日程、计数含日程、全部完成与全空时的表现。CDP 9321，自带启动与清理，测试前备份 `todos.json` 与 `schedule.json`、结束原样恢复。 |
| `scripts/e2e-collapsed-todo.mjs` | 收起态统计口径变成「待办 + 今天日程」，脚本需一并备份/清空 `schedule.json`（否则用户真实数据里的今天日程会污染断言），断言文案随新标题调整。 |
| `docs/facts/功能清单.md` | 第 1 节待办补「同步今天的日程」；第 4 节备注待办页也能加日程。 |
| `docs/facts/数据规则.md` | 新增一条：待办页新增的内容写入 `schedule.json`（今天的日程），不再写入 `todos.json`；待办本身仍不分日期。 |
| `docs/facts/用户角色与用户故事.md` | US-033 现状改为已实现。 |
| `docs/状态.md` | 一句话状态更新；P1 表新增 US-033 一行。 |

明确**不动**：`todos.json` 与 `schedule.json` 的数据结构（都不加字段、不做迁移）；`src/main/*`（主进程逻辑一律不改）；`src/preload/index.ts`（接口签名不变）；日程页（第 4 页）的布局与行为；通知页、置物架、岛仔、窗口尺寸与动画；不引任何新依赖。

## 三、预期行为

1. 待办页列表 = **待办**（不分日期，全部显示）+ **今天**（本地日期）的日程，混在一起排。
2. 明天、后天的日程**不出现**在待办页；昨天及更早的也不出现。
3. 日程条目可以直接在这一页勾选，勾掉后切到日程页看同一条也是已完成（共用同一份数据）。
4. 有时间的日程显示 `HH:mm`（如 `14:00`），**不显示日期**；时间已过且未完成时该徽标变橙（与日程页一致）。
5. 待办页的添加框可以只输入文字直接回车（存为今天、不带时间的日程），也可以先点时钟按钮选时间再加。
6. 待办页新加的内容**今天**同时出现在待办页和日程页的今天那一格；**明天**从待办页消失，仍在日程页「今天」那一格（即它成了昨天的日程，未完成会显示「逾期」）。
7. 顶部计数 `n/m` 与收起态的数字都按「待办 + 今天日程」计算；收起态数字为 0 时不显示标记。
8. 待办与今天的日程都为空时，列表显示一句空状态提示。
9. 待办原有的能力不变：双击改名、`×` 删除、勾选后岛仔开心一下。

## 四、必要依赖

- 已有：`window.island.scheduleList()` / `scheduleAdd(text, time, day)` / `scheduleToggle(id)` / `scheduleRemove(id)`（`src/preload/index.ts`），本次只需在渲染层调用，不新增通道。
- 已有：`window.island.todosList()/todosAdd/todosToggle/todosRemove/todosRename`。
- 已有：`IcoClock` 图标、`.sched-badge` 徽标样式、`.sched-time-pop` 自绘时间面板的交互方式（本次在待办页复用同一套小时/分钟按钮逻辑，代码内联在 `TodoPanel`，不抽公共组件以避免跨面板耦合）。
- 已有：`localDayKey` 的算法（`SchedulePanel` 里已有一份内联实现，本次抽到模块级复用）。
- 不新增任何 npm 依赖。

## 五、验收条件

- [ ] `npm run typecheck` 通过（`typecheck:node` + `typecheck:web` 均无报错）。
- [ ] `npm run build` 通过。
- [ ] `node scripts/e2e-todo-today.mjs` 通过，覆盖：今天日程出现在待办页且带 `HH:mm`、明天的日程不出现、勾选与日程页同步、待办页新增落到今天的日程（`schedule.json` 里出现、`todos.json` 里不出现）、计数含日程、全完成时收起态数字消失。
- [ ] 回归：`node scripts/e2e-collapsed-todo.mjs`、`node scripts/e2e-m1.mjs`、`node scripts/e2e-m2.mjs`、`node scripts/e2e-m4.mjs`、`node scripts/e2e-shelf-missing.mjs`、`node scripts/e2e-schedule.mjs`、`node scripts/e2e-schedule-day.mjs` 仍全过。
- [ ] 开发版真实启动截图确认：待办页混排显示、时间徽标、逾期橙标、添加框带时钟按钮。
- [ ] `npm run dist` 成功产出 `release\灵动岛 Setup 0.1.0.exe`。
- [ ] 安装到 `D:\软件\灵动岛\`（`/S` + `/D=`），`Get-Process 灵动岛` 有进程存活，主窗口标题为「灵动岛」。
- [ ] 安装版 asar 内能检索到本次新增的字符串（证明装的是新代码）。
- [ ] 真实数据目录 `%APPDATA%\lingdong-island\` 下 `todos.json`、`schedule.json` 升级后均为合法 JSON，结构未变。

## 六、不做什么

- 不给 `todos.json` 加日期或时间字段（数据模型不动，避免迁移风险）。
- 不做「待办页显示明天/本周的日程」（用户明确只要当天）。
- 不做日程条目在待办页的双击改名（改名只在日程页保留现状；本次不扩散）。
- 不做两个页面的合并或互相跳转按钮。
- 不做拖拽排序、不做重复日程。
- 不改日程页的布局与文案。
- 不合并回 `main`、不打标签、不发布（合并要用户单独授权）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 读 `TodoPanel`（`App.tsx:200-340`）、`SchedulePanel`（`App.tsx:951-1167`）、`App()` 的统计链（`App.tsx:1308-1325`）、`.todo-*` 与 `.sched-badge` 样式，确认待办页当前只读 `todos.json` | ✅ 已确认。关键点：`onStats` 只算待办；收起态 `refreshTodoStats()` 也只读 `todos.json`，两处必须同口径改，否则展开态与收起态数字会不一致 | — |
| 2026-11-05 | 建 SPEC、登记 US-033、从 `us-014-schedule-cross-day`（`5844799`）建分支 `us-033-todo-sync-today-schedule` | ✅ 完成 | 基线不是 `main`：US-014 尚未合并，合并时要按「先 US-014、再本任务」的顺序 |
| 2026-11-05 | 改 `App.tsx`：抽出模块级 `localDayKey()`；`TodoPanel` 增加今天日程混排（`todo-sched` 行）、可选时间的添加框（复用 `.sched-time-pop` 面板）、`onStats` 改为「待办 + 今天日程」同口径；`App()` 的 `refreshTodoStats()` 同步同口径；收起态文案改「今天还有 N 件没做完（共 M 件）」；`SchedulePanel` 两处内联日期计算改为复用 `localDayKey()` | ✅ 完成 | — |
| 2026-11-05 | 改 `styles.css`：`.todo-add` 加 `position: relative`，让时间面板能定位；其余全部复用既有 `.sched-badge`/`.sched-time-btn`/`.sched-time-pop`/`.time-pop-*` | ✅ 完成 | — |
| 2026-11-05 | `npm run typecheck` | ✅ exit 0（`typecheck:node` 与 `typecheck:web` 均无输出） | — |
| 2026-11-05 | `npm run build` | ✅ exit 0（`out/preload/index.js` 4.65 kB、`index-BOp_0jsi.js` 631.41 kB、`index-D-1QzItg.css` 33.43 kB） | — |
| 2026-11-05 | 新增 `scripts/e2e-todo-today.mjs` 并运行 → `E2E TODO-TODAY PASS`（A1–A10） | ✅ A1 进到待办页；A2 只显示今天 2 条日程 + 1 条待办（明天/昨天不出现）；A3 时间徽标 `09:00` 且无日期；A4 计数 `0/3`；A5 勾选日程写回数据、计数 `1/3`；A6 日程页同步显示已完成；A7 待办页新增落到今天日程 `time=14:30` 且 `todos.json` 未被写入；A8 新条目显示、计数 `1/4`；A9 收起态数字 `3`、文案「今天还有 3 件没做完（共 4 件）」；A10 全勾完后收起标记消失 | 首次跑 A2 失败：种子数据把待办写到了 `items` 键，而 `todos.json` 实际结构是 `{ todos: [...] }`（`src/main/todoStore.ts:11-18`），改正后通过 |
| 2026-11-05 | 改 `scripts/e2e-collapsed-todo.mjs`：备份并清空 `schedule.json`、文案断言改为新口径 | `node scripts/e2e-collapsed-todo.mjs` → `E2E COLLAPSED-TODO PASS`（A1–A6，时钟宽 41px 未被挤压） | 该脚本只断言待办，日程清空后验证；「收起态数字含日程」的组合场景由 `e2e-todo-today` 的 A9 覆盖 |
| 2026-11-05 | 回归：`e2e-m1` / `e2e-m2` / `e2e-m3` / `e2e-m4` / `e2e-m4-drop` / `e2e-schedule` / `e2e-schedule-day` / `e2e-shelf-missing` / `e2e-notify` | ✅ 全部 PASS（`E2E PASS` / `E2E M2 PASS` / `E2E PASS` / `E2E PASS` / `E2E DROP PASS` / `E2E SCHEDULE PASS` / `E2E SCHEDULE-DAY PASS` / `E2E SHELF-MISSING PASS` / `E2E NOTIFY PASS`） | `scripts/e2e-reorder.mjs` 未跑通：它是依赖外部预先启动 9225 端口实例的临时脚本（文件头注释写明），本次未单独起实例；该脚本本次未改动，风险低 |
| 2026-11-05 | 开发版截图核对（CDP `Page.captureScreenshot`） | ✅ 待办页显示：标题「待办」+ 完成度 `1/5` + 输入框「加一条今天要做的事，回…」+ 时钟按钮 + `+`；列表 3 条日程（`14:30` 橙标过点、无时间一条、`09:00` 已完成划线）与 2 条待办混排，未完成在前 | 截图用临时种子数据，核对后已删 `.tmp/` 并还原用户 `todos.json`/`schedule.json` |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-05 | 用户本人（实机操作，会话记录 m01888「可以了」） | `d421e7ffd296667654a6aaa778cb2fed2bb6dd2d`（合并提交 `1f6189e`） | 用户对含本改动的打包安装版整体确认无问题，按「整体通过」记。逐条细节（待办页只显示今天、时间徽标不带日期、勾选与日程页同步、可选时间新增、收起态数字含日程）由交付说明的 3 步自助验证与 `E2E TODO-TODAY` 的 A1–A10 覆盖，用户未逐条回报 | 通过（合并回 `main`，在 US-014 之后合并） |
