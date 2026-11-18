# SPEC-calendar-date-in-title：选中日期并入月历标题，去掉右栏重复日期

- 日期：2026-11-18
- 分支：`calendar-date-in-title`
- 背景：用户看日程页截图指出「日历这里出现了日期重复」——左栏月历标题写「2026年11月」，右栏当日标题又写「11月18日」，月份重复；要求「把日子移到日历里」。用户在三个方案中选「并入月历标题」。

## 一、目标

日程页只保留一处日期：选中日的「日」跟着月历标题显示（`2026年11月 18日`），右栏标题不再写日期，只留日程/待办条数。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | `MonthCalendar` 标题在选中日属于当前查看月份时追加「 N日」；右栏删除 `.sched-day-title` 与 `dayLabel` |
| `src/renderer/src/styles.css` | 删除不再使用的 `.sched-day-title` 规则 |
| `scripts/e2e-schedule-crossmonth.mjs` | B5 读 `.cal-title` 并断言包含选中日「10日」 |

**不改**：月历网格、蓝点、翻月逻辑、选中高亮、右栏条数文案、日程数据。

## 三、预期行为

1. 查看当月且选中日在当月：标题为 `2026年11月 18日`。
2. 翻到别的月份（选中日不在该月）：标题只显示 `2026年12月`，不出现不属于该月的日号。
3. 右栏第一行只剩 `0 条日程 · 0 条待办`（今天）或 `N 条日程 · 待办只在今天`（其他日期）。
4. 点击月历某天：标题的「日」随选中日更新，右栏列表不变。

## 四、必要依赖

无。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck`、`npm run build` 均 EXIT=0 |
| A2 | 当月选中 18 日时 `.cal-title` 文本为 `YYYY年M月 18日`，`.sched-day-title` 不存在 |
| A3 | 翻到下月时 `.cal-title` 只有 `YYYY年M月`，不带日号 |
| A4 | `node scripts/e2e-schedule-crossmonth.mjs` PASS（B5 改用 `.cal-title`） |
| A5 | 标题加日号后月历头未溢出、左右翻页按钮仍完整可见 |

## 六、不做什么

- 不改右栏条数文案与「待办只在今天」规则。
- 不改月历格子、蓝点、翻月、选中逻辑。
- 不改日程数据与持久化。

## 七、自检记录

自检日期 2026-11-18，分支 `calendar-date-in-title`，dev 构建（`out/`）+ 隔离 userData（`scripts/isolate-userdata.mjs`）。

| 编号 | 结果 |
|---|---|
| A1 | **通过**：`npm run typecheck` / `npm run build` 均 EXIT=0 |
| A2 | **通过**：探针读 `.cal-title` = `2026年11月 18日`；`document.querySelector('.sched-day-title')` 为 `null` |
| A3 | **通过**：`e2e-schedule-crossmonth` B2 翻到下月时标题严格等于 `2026年12月`（无日号），选中后 B5 变为 `2026年12月 10日` |
| A4 | **通过**：`node scripts/e2e-schedule-crossmonth.mjs` → **8 过 / 0 败** |
| A5 | **通过**：`.cal-head` `scrollWidth - clientWidth = 0`；标题占 x 52–129，两个翻页按钮 18–31 / 150–162，都在 `.cal`（14–167）内 |

**附**：截图确认右栏头只剩「2 条日程 · 0 条待办」，月历标题 `2026年11月 18日`；点 1 日后标题变为 `2026年11月 1日`。

**未验证**：

1. 装机版（本轮未打包，安装版仍 v0.1.9）。
2. 真实鼠标点击（探针与 e2e 都是 DOM 事件派发）。
