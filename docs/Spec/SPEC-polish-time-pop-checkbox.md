# SPEC-polish-time-pop-checkbox

- 建立日期：2026-11-05
- 对应基线提交：`9e7c2cdc9ba9cc4469bc0fb6f24cad587c7de0ed`
- 任务分支：polish-time-pop-checkbox
- 关联用户故事：无独立故事编号（用户 2026-11-05 直接提出的视觉打磨，见会话 m01948）
- 关联事实文档：../facts/功能清单.md（第 1 节待办、第 4 节日程）、../facts/用户角色与用户故事.md

## 一、目标

修两处用户明确点名「不好看」的地方，不改任何功能行为：

1. 时间选择面板：不显示滚动条，面板做窄一点（不再占掉半个岛身的宽度）。
2. 日程页列表的勾选框：从浏览器原生白底方框换成与待办页一致的圆环样式。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/styles.css` | `.sched-time-pop` 宽度 168px → 132px、内边距 8px → 6px、圆角 12px → 14px；`.time-pop-col` 用 `scrollbar-width:none` + `::-webkit-scrollbar{display:none}` 彻底隐藏滚动条（仍可用滚轮/触控板滚动），并加 `overscroll-behavior: contain`；`.time-pop-cell` 高度 24px → 23px、列间距 4px → 2px；`.time-pop-head`/`.time-pop-clear` 字号 11px → 10.5px、内边距收紧 |
| `src/renderer/src/App.tsx` | 日程页（`SchedulePanel`）里两处 `<input type="checkbox" className="todo-check">` 换成与待办页同款的 `<button className="todo-check">` + `<IcoCheck />`，类名带 `checked` 以复用弹跳动画 |

明确**不动**：`.todo-check` 的样式本身（待办页已经是对的，只让日程页复用它）、任何 IPC 与数据读写、时间面板的交互逻辑（点面板外收起、清除按钮、小时/分钟两列）、e2e 脚本的查询选择器（`.todo-check` 类名不变）。

## 三、预期行为

1. 打开时间面板看不到任何滚动条，两列数字宽度合适，面板整体窄于输入框 + 两个按钮的总宽。
2. 时间面板仍可用鼠标滚轮在小时/分钟里滚动（隐藏滚动条不等于禁用滚动）。
3. 日程页每条的勾选框是圆形描边（未完成）/ 绿色圆环带勾（已完成），与待办页视觉完全一致。
4. 日程页点击勾选框仍能切换完成状态，勾上时有同样的弹跳动画。
5. 待办页（page 0）的勾选框外观与点击行为不变。

## 四、必要依赖

无新增依赖。复用既有的 `.todo-check` 样式与 `IcoCheck` 图标组件（`src/renderer/src/App.tsx:63-67`）。

## 五、验收条件

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 截图确认时间面板无滚动条、宽度变窄
- [ ] 截图确认日程页勾选框为圆环样式
- [ ] `node scripts/e2e-schedule.mjs` 通过（该脚本点击 `.sched-list .todo-check`，验证换标签后仍可点）
- [ ] `node scripts/e2e-m2.mjs` 通过（依赖 `.todo-check` 点击触发岛仔开心）
- [ ] `node scripts/e2e-todo-today.mjs` 与 `node scripts/e2e-collapsed-todo.mjs` 通过（待办页未受影响）
- [ ] `npm run dist` 打包并安装到 `D:\软件\灵动岛\`，`Get-Process 灵动岛` 有进程
- [ ] 更新 `docs/facts/功能清单.md` 相关描述

## 六、不做什么

- 不改时间面板的交互方式（不做滑动选择器、不做快捷时间按钮）
- 不改日程页列表的高度、间距、徽标
- 不调整岛的整体尺寸、配色、字体
- 不顺手改其它页面的视觉
- 不合并回 `main`（需用户单独授权）

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 读 `styles.css:1365-1442` 确认滚动条来自 `.time-pop-col` 的 `scrollbar-width: thin` + Chromium 默认 `::-webkit-scrollbar`；读 `App.tsx:1251-1294` 确认日程页用的是原生 `<input type="checkbox">`（待办页早已是 `<button>` + `IcoCheck`） | ✅ 根因确认：两处是不同实现 | — |
| 2026-11-05 | `npm run typecheck` | ✅ exit 0（node + web 两套均无输出） | — |
| 2026-11-05 | `npm run build` | ✅ exit 0（`index-ik2SyyID.css` 33.70 kB、`index-Du88IroK.js` 631.74 kB） | — |
| 2026-11-05 | 截图核对（开发版 + CDP `Page.captureScreenshot`） | ✅ 时间面板只剩两列数字、无滚动条、宽度明显变窄（132px）；日程页三条日程的勾选框均为圆环，已完成那条是绿圈带勾，与待办页一致 | 截图只看了一个静态帧，未录手感（滚轮滚动的顺滑度需真人操作） |
| 2026-11-05 | 回归：`e2e-schedule` / `e2e-m2` / `e2e-todo-today` / `e2e-collapsed-todo` | ✅ 全部 PASS（`E2E SCHEDULE PASS` / `E2E M2 PASS` / `E2E TODO-TODAY PASS` / `E2E COLLAPSED-TODO PASS`）。`e2e-schedule.mjs:106` 点的正是 `.sched-list .todo-check`，换成 button 后仍能点中并切换状态 | 其余 e2e（m1/m3/m4/shelf-missing/notify/schedule-day）本次未跑：改动只碰 `.todo-check` 的标签与时间面板 CSS，未涉及它们的断言路径 |
| 2026-11-05 | `npm run dist` + 卸载旧版 + `/S /D=D:\软件\灵动岛` 安装 + 启动 | ✅ 安装包 121980373 字节 17:23:04；`Get-Process 灵动岛` 4 个进程、主窗口「灵动岛」；`app.asar` 9045431 字节 17:23:02，内检索 `scrollbar-width: none` / `width: 132px` / `overscroll-behavior: contain` 均为 True | — |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-05 | 用户本人（会话记录 m02025「可以」） | `19ec036d7996826dd21bcdb95766519c6c04a9e2`（合并提交 `0fa9f99`） | 用户看过交付里的改动表与截图后同意合并，按「整体通过」记。逐条：①时间面板不再有滚动条、宽度收窄到 132px——交付截图与 asar 字符串核对一致 ②日程页勾选框改成圆环，与待办页同款——交付截图确认 ③功能未变——四个 e2e 回归通过 | 通过（已合并回 `main`） |
