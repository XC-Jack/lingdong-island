# SPEC：日程页只留月历，点日期弹当日安排浮层

- 建立日期：2026-11-24
- 基线：`island-no-pager` `e8f45df`
- 任务分支：`island-no-pager`（与翻页器移除同分支，属同一轮优化）
- 背景：用户原话「日程这个只要显示日历就行了，右边的不要了，和代办重复了」。右栏（输入 + 当日列表 + 空态）与待办页撞脸。三张方案图对比后，用户选 **B · 点日期弹浮层**。
- 后续（2026-11-24，SPEC-todo-day-add）：用户再要求「日历不需要添加任务」，浮层里的输入行已隐藏、添加挪到待办页；本文第三节第 4 条描述的「新增」能力仅保留在隐藏的兼容 DOM 里，不再是可见界面。

## 一、目标

1. 日程页默认只显示月历，与待办页不再长得一样。
2. 点某一天 → 弹出浮层，里面是这一天的安排列表和新增入口，功能一个不少。
3. 再点同一天、点浮层外、按 Esc 都能收起；换日期不用先关再开。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | `SchedulePanel` 新增 `dayOpen` / `pickDay`；右栏改成 `.sched-day` 浮层（常驻 DOM，用 `visibility` 开关）；浮层头部加日期与「收起」；月历 `onSelect` 改走 `pickDay` |
| `src/renderer/src/styles.css` | `.sched-split` 改单列 308 宽；`.cal` 撑满；`.sched-day` 改绝对定位浮层；浮层内列表滚动/空态收小；浮层内时间面板改向上展开 |
| `src/renderer/src/popFit.ts` | `fitIslandToPopover` 支持一次传多个浮层，按最靠下的底边补偿（浮层里套着时间面板，各写各的 `--pop-extra` 会互相覆盖） |
| `docs/facts/视觉设计规范.md` | 补日程页导航/浮层规则 |

## 三、预期行为

1. 默认：整页只有月历（含今天高亮、有安排的小蓝点），与组件网格 308 同宽。
2. 点日期：浮层在月历中下部弹出，头部写「M月D日 · N 条日程 · 待办规则」，下面是列表与输入行。
3. 收起：再点同一天 / 点浮层外（月历区域不算外）/ 点「收起」/ Esc。
4. 保留全部旧能力：新增（可带提醒时间）、勾选完成、双击编辑、删除、今天混排待办、逾期标记。
5. 浮层比岛高时窗口跟着长；关掉缩回。
6. 浮层常驻 DOM（关闭时 `visibility:hidden` + `pointer-events:none`），旧 e2e 仍可直接查 `.sched-input` / `.sched-list`。

## 四、必要依赖

无。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2 截图：默认、浮层打开、有日程、时间面板、三主题（`.tmp/sched-pop/`）。
- A3 回归：`e2e-schedule`、`e2e-schedule-day`、`e2e-schedule-crossmonth`、`e2e-schedule-edit`、`e2e-schedule-scroll`、`e2e-todo-today`、`e2e-shelf-view-pref`。
- A4 用户在本机预览版确认。

## 六、不做什么

- 不改待办页、不改数据格式与主进程接口。
- 不合并 `main`、不打包、不发版。

## 七、自检记录（2026-11-24）

1. `typecheck`（node + web）、`build` 通过 [实测]。
2. 探针 `.tmp/sched-pop-probe.mjs` [实测]：
   - 默认整页：岛 256.6×254.4，月历 231×162.8，浮层计算样式 `visibility: hidden`。
   - 点今天：浮层 `visible`，盒子 216×107.5；岛高从 254.4 长到 264.9（内容顶出时按需补高）。
   - 点岛内标题区（浮层外）：收起，岛缩回 254.4。
   - 再点同一天：收起；换一天再点：保持打开并换日期。
   - 浮层内新增一条：`.sched-list` 出现该条文本。
   - 时间面板：改为向上展开后底边 181.7 < 岛底 254.4，不再越界（向下开时底边 349.1，被 `EXPANDED_MAX.height=315` 裁掉）。
3. 回归全部通过 [实测]：`e2e-schedule` PASS、`e2e-schedule-day` PASS、`e2e-schedule-crossmonth` 8/0、`e2e-schedule-edit` PASS、`e2e-schedule-scroll` 6/0、`e2e-todo-today` PASS、`e2e-shelf-view-pref` PASS。
4. 未验证：真机鼠标下的浮层观感、高 DPI、浮层盖住月历下半部时用户是否觉得别扭。
5. 既有失败（与本轮无关，已用 `git stash` 在基线复现）：`e2e-beautify-04` C2b 断言的蓝色参考值是旧的 `#64b5f6`，而主题 token `--accent` 是 `#0a6cf0`，距离超阈值 → 该断言在基线上同样失败。
