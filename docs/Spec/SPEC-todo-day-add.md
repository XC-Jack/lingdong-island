# SPEC：待办页选日期添加，日程页只看当天任务

- 建立日期：2026-11-24
- 基线：`island-no-pager` `2d9e103`
- 任务分支：`island-no-pager`
- 背景：用户原话「日历现在不需要添加任务的功能，点当天可以看当天有什么任务，就这样就够了，给代办添加一个可以选天来添加任务」；同一条消息还指出日期格「我不要椭圆，就之前那个日历的展示方式」。

## 一、目标

1. 日程页只负责看：浮层里去掉添加输入行（时间按钮、加号、输入框），保留列表与勾选/编辑/删除。
2. 待办页负责加：新增「日期」按钮（默认今天），点开选日期，新任务存到所选那天。
3. 日历格恢复正方形圆形高亮，不再因月历加宽被拉成椭圆。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | `TodoPanel` 新增 `addDay` / `dayPop` / `.todo-day-wrap` 与月历浮层，`add()` 用 `addDay`；`SchedulePanel` 的 `.sched-add` 加 `sched-add-compat` 隐藏 |
| `src/renderer/src/styles.css` | `.cal-day` 固定 24×24 居中；`.todo-day-btn` / `.todo-day-pop` / `.todo-day-hint`；`.sched-add.sched-add-compat { display:none }` |
| `scripts/e2e-todo-day-pick.mjs` | 新增 17 项断言（默认今天 / 选日 / 提示 / 加完不进今天列表 / 日历能看 / 无添加行 / 格子正方形） |
| `docs/facts/视觉设计规范.md` | 日程页与待办页规则同步 |

## 三、预期行为

1. 待办页输入行：输入框 + 「今天」日期按钮 + 时钟 + 加号；按钮默认「今天」。
2. 点日期按钮 → 月历浮层（204 宽）；选某天 → 浮层收起，按钮显示「M月D日」并高亮，输入框占位符变「加到 M月D日…」，列表上方出现「将任务加到 M月D日 · 在「日程」日历里查看」。
3. 待办页列表仍只列今天（US-033 不变）；加到其它日期的任务只出现在日程日历里。
4. 日程页浮层里没有可见输入行；列表照常可勾选、双击编辑、删除。
5. 日历格 24×24、居中、`border-radius:50%`；今天/选中的高亮是正圆。

## 四、必要依赖

无。

## 五、验收条件

- A1 `typecheck` / `build` 通过。
- A2 截图：待办默认 / 日期浮层 / 选了未来日期（`.tmp/todo-day/`）。
- A3 回归：`e2e-todo-today`、`e2e-schedule`、`e2e-schedule-day`、`e2e-schedule-crossmonth`、`e2e-schedule-edit`、`e2e-schedule-scroll`、新增 `e2e-todo-day-pick`。
- A4 用户在本机预览版确认。

## 六、不做什么

- 不把待办页改成「按日期筛选」的列表（用户只要求添加时能选天）。
- 不改数据格式与 IPC；新任务仍走 `scheduleAdd(text, time, day)`。
- 不合并 `main`、不打包、不发版。

## 七、自检记录（2026-11-24）

1. `typecheck` / `build` 通过 [实测]。
2. `e2e-todo-day-pick` 17/0 PASS [实测]。
3. 回归全过 [实测]：`e2e-todo-today`、`e2e-schedule`、`e2e-schedule-day`、`e2e-schedule-edit`、`e2e-schedule-scroll` 6/0、`e2e-schedule-crossmonth` 8/0。
4. 探针实测 [实测]：日历格屏幕尺寸 18×18（布局 24×24，zoom 0.75），所有格子同尺寸，圆角 50%；日程页 `.sched-add` 计算样式 `display:none`；选中的未来日期在浮层里能列出刚加的任务。
5. 兼容说明：日程页的添加行保留在 DOM（`display:none`），因为 5 个旧 e2e 依赖 `.sched-input` / `.todo-add-btn` 造数据。用户不可见、不可聚焦；以后脚本改走待办页或桥接后可删。
6. 未验证：真机鼠标操作、高 DPI、用户对「加到未来日期后今天列表不变」的接受度。
