# SPEC-us-014-schedule-cross-day

- 建立日期：2026-11-05
- 对应基线提交：`1cb07bc044ed5282aa7330d07d9d860a2be9838e`
- 任务分支：us-014-schedule-cross-day
- 关联用户故事：US-014（见 ../facts/用户角色与用户故事.md 第 3.3 节）
- 关联事实文档：../facts/数据规则.md（存储与迁移规则）、../facts/功能清单.md（第 4 节 日程）、../facts/技术方案.md

## 一、目标

让日程能安排到「明天的、下周的」等任意日期，而不是全部堆在「今天」。

现状：`schedule.json` 里每条日程只有 `{ id, text, time, done, reminded, createdAt }`，**没有日期字段**，渲染层干脆把整个日程列表当成「今天」的（`src/renderer/src/App.tsx:1005-1007` 的注释和代码都写死了 `todayKey = selDay`，`markedDays` 也是把每条都算到今天）。结果是：日历能点别的日期，但点哪一天看到的都是同一批日程，蓝点永远在今天。

本次要动数据模型，因此**数据迁移是本次的主要风险点**，迁移失败必须能回退。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/scheduleStore.ts` | `ScheduleItem` 加 `day: string`（`'YYYY-MM-DD'`）；`load()` 里做一次性迁移：缺 `day` 或格式不合法的旧条目一律补成**迁移当天**的日期，迁移前先把原文件整份备份成 `schedule.json.bak-<YYYYMMDD-HHmmss>`；`schedule:add` 接收第三个参数 `day`；`remindDue()` 只检查 `day === 今天` 的条目（旧代码注释说「跨天会重置 reminded」但实现里没有，本次把这个洞一起堵上）。 |
| `src/preload/index.ts` | `ScheduleItem` 接口同步加 `day`；`scheduleAdd(text, time, day)` 多传一个参数。 |
| `src/renderer/src/App.tsx` | `ScheduleItem` 接口加 `day`；`SchedulePanel` 按 `selDay` 过滤（不再全按今天）；`markedDays` 改成「有日程的日期集合」；新增日程时带上 `selDay`；待办只在选中「今天」时混排显示；过期橙标只在「今天且过点」或「比今天更早且未完成」时出现。 |
| `src/renderer/src/styles.css` | 仅按需微调（如日程行里显示「明天」这类相对日期的小徽标样式）；无新增大块样式则不动。 |
| `scripts/e2e-schedule-day.mjs`（新增） | 端到端验证：跨天新增、按天过滤、日历蓝点、旧数据迁移、备份文件生成。自带启动与清理，CDP 端口 9321，测试前备份 `schedule.json`、结束原样恢复。 |
| `docs/facts/数据规则.md` | 新增「日程日期字段与迁移」条款，订正第 34 行「全部按今天处理」的描述。 |
| `docs/facts/功能清单.md` | 第 4 节日程补跨天能力；总览表备注同步。 |
| `docs/facts/用户角色与用户故事.md` | US-014 现状改为已实现。 |
| `docs/状态.md` | 一句话状态更新；P1 表第 4 行改为已完成。 |

明确**不动**：待办（`todos.json`）不加日期字段——待办仍是「不分日期的一件事」，本次不改它的数据模型；通知页、置物架、岛仔、窗口尺寸与动画一律不动；不引任何新依赖。

## 三、预期行为

1. 在日历上点任意一天，右侧列表只显示**那一天**的日程；换一天列表跟着换。
2. 在选中某一天时新增的日程，归属那一天。想给下周三加一条，点下周三、输入、回车即可。
3. 日历上**有日程的日子显示蓝点**（以前蓝点永远落在今天）。
4. 顶部计数「N 条日程」是**选中那天**的条数，不是全部日程总数。
5. 有时间的日程仍然到点弹系统提醒，但**只在它自己那一天**提醒：昨天没做完的日程不会在今天早上突然弹一遍。跨天不会重复提醒同一条。
6. 待办是「不分日期」的，所以只在日历选中**今天**时和日程混排显示；看别的日期时不显示待办（避免以为那是那天的待办）。
7. 过期橙色标记：今天的、时间已过且未完成的显示橙标；比今天更早且未完成的也显示橙标（提醒你还欠着）；未来日期不显示橙标。
8. **旧数据自动迁移**：升级后第一次启动，旧日程（没有日期字段）全部归到「升级当天」，看起来跟升级前一模一样，不会凭空消失。迁移前的原文件会被备份成 `schedule.json.bak-<时间戳>`，放在同一个数据目录里。
9. 迁移是幂等的：已经是新格式的数据不会重复迁移、不会重复备份。

## 四、必要依赖

- 已有：`app.getPath('userData')` 数据目录（`src/main/scheduleStore.ts:27-29`），无需新增路径。
- 已有：`node:fs` 的 `readFileSync/writeFileSync/mkdirSync/copyFileSync`（标准库），不引新依赖。
- 已有：`randomUUID`（`node:crypto`，`scheduleStore.ts:4` 已引入），新条目继续用它生成 id。
- 已有：月度日历组件 `MonthCalendar`（`src/renderer/src/App.tsx:874-949`）本身就带 `markedDays` 参数，本次只是把真实数据喂进去，不需要改它的接口。

## 五、验收条件

- [ ] `npm run typecheck` 通过（`typecheck:node` + `typecheck:web` 均无报错）。
- [ ] `npm run build` 通过。
- [ ] `node scripts/e2e-schedule-day.mjs` 通过，覆盖：跨天新增、按天过滤、日历蓝点落在正确的日子、待办只在今天混排、旧格式数据迁移后 `day` = 迁移当天、备份文件已生成、迁移后 `schedule.json` 里每条都有合法 `day`。
- [ ] 回归：`node scripts/e2e-schedule.mjs`、`node scripts/e2e-m1.mjs`、`node scripts/e2e-m4.mjs`、`node scripts/e2e-shelf-missing.mjs`、`node scripts/e2e-collapsed-todo.mjs` 仍全过。
- [ ] 开发版真实启动截图确认：日历有蓝点、点不同日期右侧列表不同、跨天日程显示正常。
- [ ] `npm run dist` 成功产出 `release\灵动岛 Setup 0.1.0.exe`。
- [ ] 安装到 `D:\软件\灵动岛\`（`/S` + `/D=`），`Get-Process 灵动岛` 有进程存活，主窗口标题为「灵动岛」。
- [ ] 安装版 asar 内能检索到本次新增的字符串（证明装的是新代码）。
- [ ] 真实数据目录 `%APPDATA%\lingdong-island\schedule.json` 在升级后仍然是合法 JSON，且每条都有 `day` 字段。

## 六、不做什么

- 不做重复日程（每天/每周一次）——那是另一个功能，需要另一套数据模型。
- 不做拖拽日程换天、不做跨天的拖动排序。
- 不做日程的「推迟到明天」快捷按钮。
- 不做日历上的「回到今天」快捷按钮（点日历里高亮的今天即可，本次不加新控件）。
- 不改待办的数据模型（待办仍然不分日期）。
- 不做云端同步、导出导入。
- 不合并回 `main`、不打标签、不发布（合并要用户单独授权）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 阅读 `scheduleStore.ts` 全文（119 行）、`SchedulePanel`（`App.tsx:951-1152`）、`MonthCalendar`（`App.tsx:874-949`）、`e2e-schedule.mjs`（134 行），确认日期字段缺失是根因 | ✅ 已确认。关键事实：`scheduleStore.ts:45` 注释声称「跨天时重置 reminded」，但实现里**没有任何重置逻辑**——这是顺带要修的既有 bug | — |
| 2026-11-05 | 读当前真实数据 `%APPDATA%\lingdong-island\schedule.json` | ✅ 内容 `{ "items": [] }`，空数组（2026-11-05 16:22） | 用户身边若还有一台有真实日程的机器，那边的迁移未验证 |
| 2026-11-05 | 建 SPEC、从 `main` 建分支 `us-014-schedule-cross-day` | ✅ 完成 | — |
| 2026-11-05 | 改 `src/main/scheduleStore.ts`（169 行）：加 `dayKey()` 本地日期、`load()` 迁移 + 备份、`remindDue()` 只提醒当天、`schedule:add` 收 `day` 参数 | ✅ 完成。迁移用 `copyFileSync` 备份成 `schedule.json.bak-<YYYYMMDD-HHmmss>`；`remindDue()` 由「每轮都写盘」改成只在真改了 `reminded` 时写 | 时区只在 Asia/Shanghai 下验证过；UTC 负时区机器上的 `dayKey()` 未验证 |
| 2026-11-05 | 改 `src/preload/index.ts`（`ScheduleItem` 加 `day`、`scheduleAdd` 三参）与 `src/renderer/src/App.tsx`（按 `selDay` 过滤、`markedDays` 取真实日期、待办只在今天混排、过期/逾期判定） | ✅ 完成 | — |
| 2026-11-05 | `npm run typecheck` | ✅ 通过（`typecheck:node` + `typecheck:web` 均无输出，exit 0） | — |
| 2026-11-05 | `npm run build` | ✅ 通过（out/main/index.js、out/preload/index.js、out/renderer assets 齐全） | — |
| 2026-11-05 | 新增 `scripts/e2e-schedule-day.mjs`（9 项断言 M1/M2/A1–A9），`node scripts/e2e-schedule-day.mjs` | ✅ `E2E SCHEDULE-DAY PASS`。实测输出：旧条目补 `day = 2026-11-05`、生成 `schedule.json.bak-20261105-082511`、明天副标题「1 条日程 · 待办只在今天」、日历蓝点 2 个、昨天无时间未完成显示「逾期」、3 条日程分属 3 天格式全部合法 | 只在同一天内跨「昨天/今天/明天」验证；跨月翻页路径写了但本次未实际走到（目标日期与当前视图同月） |
| 2026-11-05 | 回归 7 个脚本：`e2e-schedule` / `e2e-m1` / `e2e-m2` / `e2e-m3` / `e2e-m4` / `e2e-m4-drop` / `e2e-shelf-missing` / `e2e-collapsed-todo` | ✅ 全部通过（`E2E SCHEDULE PASS`、`E2E PASS`、`E2E M2 PASS`、`E2E M3`… 逐个见提交说明） | — |
| 2026-11-05 | 开发版截图核对（CDP `Page.captureScreenshot`，临时数据 3 条今天 + 明天 1 条 + 昨天 1 条） | ✅ 今天页：月历 4/5/6 号有蓝点、右侧「11月5日 · 3 条日程 · 0 条待办」、过期条目橙标；昨天页：「11月4日 · 1 条日程 · 待办只在今天」+「逾期」徽标 | 截图用的是临时注入数据，用完已删 |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 待填 | — | — | — | — |
