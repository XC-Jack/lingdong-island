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

## 八、追加调整（2026-11-24，用户看预览后反馈）

1. 日期格从圆改**圆角方块**：24×24、`border-radius:8px`（用户原话「不要圆的，要正方形圆四圆角的」）。
2. 日程浮层从「月历中下部、超出就把岛撑高」改成**贴月历顶部、高度不超过月历**：`top:38px` + `max-height:calc(100% - 44px)` + 自身滚动（用户原话「任务显示在上面更好，老是往下挤」）。
3. 空态提示改为「在「待办」里选日期添加」，不再引导用户在日程页添加。
4. 验证 [实测]：`e2e-todo-day-pick` 17/0（D5b 改为断言 `8px`）；`e2e-schedule`、`e2e-schedule-day`、`e2e-schedule-crossmonth` 8/0、`e2e-schedule-edit`、`e2e-schedule-scroll` 6/0、`e2e-todo-today` 全过。探针实测浮层打开前后岛高均为 254.4，不再变高。

## 九、再次调整（2026-11-24，用户第二次看预览）

1. 日程当天视图「只有一半太丑」：改成 `top:38px` + `bottom:6px` 铺满月历区域，列表占满剩余高度并自己滚（`.sched-day .sched-list` 解除全局 3 行限高）；岛高保持 254.4。
2. 置物架 / 通知页「有了消息还没没有小，别老是缩回去了」：给 `.page-fade` 加 `.page-shelf` / `.page-notify` 两个类，`min-height` 分别 87 / 170 布局 px（取空态实测页高），有内容时不再比空态矮。
3. 验证 [实测]：`typecheck` / `build` 通过；探针：置物架空态与 2 个文件均 255×157.1，通知空态 255×219.2，日程浮层 `top 104.3 / bottom 234.1`、岛 254.4；回归 `e2e-schedule`、`e2e-schedule-day`、`e2e-schedule-crossmonth` 8/0、`e2e-schedule-edit`、`e2e-schedule-scroll` 6/0、`e2e-notify`、`e2e-shelf-view-pref`、`e2e-todo-day-pick` 17/0 全过；`e2e-notify-compact` C1/C2 产品断言通过，收尾 taskkill 128 为脚本既有问题。
