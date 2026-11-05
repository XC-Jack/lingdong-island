# SPEC-us-036-schedule-edit

- 建立日期：2026-11-05
- 对应基线提交：`4167361fddc06a92a0e7951d2dcfe88ed4ff1b31`
- 任务分支：us-036-schedule-edit
- 关联用户故事：US-036（本文档落盘时在 `docs/facts/用户角色与用户故事.md` 第 3.3 节登记）
- 关联事实文档：`docs/facts/功能清单.md` 第 4 节（日程）；`docs/facts/数据规则.md`（日程存储规则）；`docs/facts/本机约束与踩坑.md`（e2e 与打包流程）

## 一、目标

日程条目目前只能「整条删掉重加」——写错一个字或想改个时间，都得先删再加，还丢掉勾选状态。本任务给日程条目补上编辑能力：**双击日程文字进入行内编辑改名**，与待办页已有的双击编辑（`todos:rename`）体验对齐；同时给主进程补 `schedule:edit` 接口，支持改文字、改时间、改日期三个字段，为以后可能的「改时间」「挪天」留好地基。本任务只做「改文字」的界面入口，改时间/改日期的界面不做（见第六节）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/scheduleStore.ts` | 新增 `schedule:edit` IPC：签名 `(_e, id, payload)`，payload 支持 `{ text?, time?, day? }` 三个可选字段；text 规范化同 add（trim，空串不更新）；time 规范化同 add（`HH:mm` 正则，非法存 null）；day 规范化同 add（`YYYY-MM-DD` 正则，非法忽略该字段）；`reminded` 在 time 或 day 变化时重置为 false（改了时间/日期，旧提醒标记必须作废，否则新时间不提醒）；改完 `save()` 返回 items |
| `src/preload/index.ts` | 新增 `scheduleEdit(id, payload): Promise<ScheduleItem[]>` → `invoke('schedule:edit', id, payload)` |
| `src/renderer/src/App.tsx` | `SchedulePanel` 增加行内编辑 state（`editingSchedId` / `schedEditDraft`），日程条目的文字双击进入编辑（与待办同款 `.todo-edit` 输入框样式），Enter 提交 / Escape 取消 / 失焦提交，空文本视为取消不误删 |
| `scripts/e2e-schedule-edit.mjs` | 新增：CDP 9321；备份并还原 schedule.json；断言双击进入编辑、改名后列表更新、磁盘落盘、Escape 取消、空文本不覆盖 |
| `docs/facts/功能清单.md` | 第 4 节日程补「双击改名」条目 |
| `docs/facts/数据规则.md` | 补一条：编辑改名不影响 day/time/done；改时间或日期时 reminded 重置（本任务只接通了 text 通道，条款写全） |
| `docs/facts/用户角色与用户故事.md` | 第 3.3 节登记 US-036 与现状 |
| `docs/状态.md` | 一句话状态 + 未排期表 |
| `docs/Spec/SPEC-us-036-schedule-edit.md` | 本文件；第七节自检记录随开发填写 |

明确**不动**：待办页（已有编辑）、置物架、通知页、月历组件 `MonthCalendar`、提醒逻辑 `remindDue()`、数据文件结构（字段不增不减）。

## 三、预期行为

1. 日程页里**双击任意日程条目的文字**，文字原位变成输入框（样式同待办编辑框），内容全选，可直接输入。
2. **回车或点输入框外**：提交改名；日程列表立刻更新；磁盘 `schedule.json` 同步更新；其余字段（day/time/done/reminded）不变。
3. **Esc 或清空后回车/失焦**：取消编辑，原文保留。
4. 改名不影响该日程的提醒状态：若已提醒过（reminded=true），只改文字不重置提醒，避免同一条目重复弹通知。
5. 勾选状态、时间徽标、逾期徽标在编辑前后保持不变。
6. 双击编辑只对日程条目生效；待办徽标条目（今天视图混排的待办）仍走待办自己的编辑通道，互不影响。

## 四、必要依赖

无新增依赖。全部用现有 Electron IPC（`ipcMain.handle` / `ipcRenderer.invoke`）、React state 与已有 CSS 类（`.todo-edit`）。

## 五、验收条件

- [ ] `npm run typecheck` 通过（typecheck:node + typecheck:web）
- [ ] `npm run build` 通过
- [ ] `node scripts/e2e-schedule-edit.mjs` 输出 `E2E SCHEDULE-EDIT PASS`：断言双击进入编辑、回车改名后 UI 与磁盘一致、Escape 取消、空文本不覆盖
- [ ] 回归：`e2e-schedule`、`e2e-schedule-day`、`e2e-todo-today`、`e2e-collapsed-todo`、`e2e-shelf-missing` 全部 PASS
- [ ] 开发版真实启动确认：双击日程文字可编辑、改名后月历蓝点与计数正常
- [ ] `npm run dist` 打包成功；静默安装到 `D:\软件\灵动岛\`（`/S /D=`）；`Get-Process 灵动岛` ≥ 4 进程
- [ ] 安装版 asar 内可检索到 `schedule:edit` 字符串，确认装的是新代码
- [ ] 真实数据 `%APPDATA%\lingdong-island\schedule.json` 编辑后仍是合法 JSON 且字段结构不变
- [ ] `docs/状态.md` 一句话状态更新；`docs/facts/` 三处文档同步
- [ ] SPEC 第七节自检记录填写完整（含「未验证部分」列）

## 六、不做什么

- 不做「双击改时间」「双击改日期」的界面入口（主进程接口支持，界面只接文字通道；用户要改时间/日期就删了重加，成本可接受）
- 不做日程拖拽挪天、不做「推迟到明天」按钮
- 不改待办页编辑、不改月历组件
- 不做撤销/历史
- 不合并回 main、不打 Git 标签（等用户验收后另行授权）

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 通读 `src/main/scheduleStore.ts` 全文 166 行、`src/main/todoStore.ts` 的 `todos:rename`（:66-76）、待办编辑 JSX（App.tsx:474-494）、日程渲染 JSX（App.tsx:1284-1310） | [实测] 确认日程无任何编辑通道；待办 rename 的 payload 模式与提醒重置需求可复用 | 无 |
| 2026-11-05 | `npm run typecheck` | [实测] exit 0（typecheck:node + typecheck:web 均无输出） | 无 |
| 2026-11-05 | `npm run build` | [实测] exit 0（renderer js 633.93 kB、css 33.70 kB） | 无 |
| 2026-11-05 | 首跑 `e2e-schedule-edit` 失败 `CDP page not found` | [实测] 根因：DSH 宿主 shell 自带 `ELECTRON_RUN_AS_NODE=1`，脚本里 `env: {...env, ELECTRON_RUN_AS_NODE: ''}` 传空串不清除，electron 退化纯 Node 秒退。改为 `delete childEnv.ELECTRON_RUN_AS_NODE` 后解决（与既有脚本写法一致） | 无 |
| 2026-11-05 | e2e A3 失败：回车提交后 `texts=[]`，面板消失 | [实测] 根因：岛根 `onKeyDown`（App.tsx:1660）对 Enter/空格调 `toggle()` 收起岛；编辑框回车提交的事件冒泡到岛根把岛收走。这是**真实用户也会踩的 bug**（回车改名后岛突然收起）。修复：编辑框 `onKeyDown` 加 `e.stopPropagation()`（Esc 另有「收起岛」全局监听，也一并拦住） | 无 |
| 2026-11-05 | e2e A1/A2/A4/A5/A6 多轮断言修正 | [实测] 四处都是**断言写错**（排序规则「有时间排前」、A4 对照基准误用 backup 而非 seed、A5/A6 目标条目已被 A3 改名），产品代码无问题；已修正断言 | 无 |
| 2026-11-05 | `node scripts/e2e-schedule-edit.mjs` | [实测] `E2E SCHEDULE-EDIT PASS`（A1 初始列表 / A2 双击进编辑 / A3 回车改名 / A4 磁盘与其余字段不变 / A5 Escape 取消 / A6 空文本不覆盖 / A7 界面存活） | 无 |
| 2026-11-05 | 回归 5 个：`e2e-schedule` / `e2e-schedule-day` / `e2e-todo-today` / `e2e-collapsed-todo` / `e2e-shelf-missing` | [实测] 全部 PASS（exit 0，PASS 行逐一确认） | 无 |
| 2026-11-05 | `npm run dist`（带两镜像环境变量） | [实测] exit 0 → `release\灵动岛 Setup 0.1.0.exe` 121988929 B、18:54:13 | 无 |
| 2026-11-05 | 安装：停进程 → 旧卸载器 `/currentuser /S` → `Setup /S /D=D:\软件\灵动岛` → 启动 | [实测] `Get-Process 灵动岛` 4 个进程、主窗口标题「灵动岛」 | 未验证「卸载器无历史记录时的首次卸载路径」（机器上一直有旧版） |
| 2026-11-05 | 安装版 asar 检索 | [实测] `D:\软件\灵动岛\resources\app.asar` 9058869 B，含 `schedule:edit` / `双击编辑` / `scheduleEdit` 三个字符串 → 装的是新代码 | 无 |
| 2026-11-05 | 真实数据健康 | [实测] `%APPDATA%\lingdong-island\schedule.json` 仍为合法 `{ "items": [] }`（用户数据为空，e2e 备份还原未污染） | 无 |
| 2026-11-05 | 用户反馈「改不了」→ 一次性探针复现：待办**本体**双击改名正常（P1–P3 PASS），真正缺口是待办页里**混排的日程条目**（带时间徽标那些）没有编辑入口 | [实测] 根因定位成功，产品代码无缺陷、是本任务初版只接了待办本体 | 无 |
| 2026-11-05 | 修复：待办页日程条目接 `startSchedEdit`/`commitSchedEdit`（复用 `schedule:edit`）；探针扩展 P4/P5 断言日程条目双击改名 + 磁盘落盘 + 岛不收起 → PASS；回归 5 个 e2e 全 PASS；重新打包安装（asar 9060155 B、19:13:32，4 进程存活） | [实测] 修复完成，提交 `d3eb447` | 真实鼠标双击手感待用户实机验收 |
| 2026-11-05 | 开发版真实启动人工点验 | [未验证] e2e 已覆盖双击/回车/Esc 全链路；鼠标双击手感与失焦时序未人工复核，留给用户实机验收 | 双击改名的人工手感 |

## 已知踩坑（留给后续任务）

- **岛根 onKeyDown 会吞编辑框的 Enter/Esc**：岛根对 Enter/空格调 `toggle()`（收起/展开岛），对 Esc 有全局「收起岛」监听。任何「行内编辑框」都必须在 `onKeyDown` 里 `e.stopPropagation()`。日程编辑框已修；**待办编辑框（`TodoPanel` 的 `commitEdit` 路径）曾有同样问题，2026-11-05 应用户要求在同一分支顺手修复（`290b499`），待办 e2e 回归通过。**

## 补充修复（用户验收反馈，同一分支）

- 用户反馈①「待办输入框打字时岛立刻缩小退出」②「日历输入完回车后立刻缩小退出」。[推断] 根因：中文输入法候选窗是独立系统窗口，打字/选字时主窗口瞬时失焦又得焦，主进程 `blur` 事件立即触发「点桌面自动收回」逻辑把岛收走（依据：两个现象都发生在 IME 交互时点；e2e 合成打字无法复现，因为 CDP 注入不走 OS 输入）。
- 修复（`App.tsx` onWindowBlur 路径）：blur 后延迟 800ms 再判断，期间窗口拿回焦点（IME 选字完成）就不收起；800ms 后仍无焦点（真的点了桌面）才收起。真实点桌面场景的收起延迟从 0ms 变 800ms，属可接受取舍。
- [未验证] 真实输入法路径无法自动化复现，需用户实机验收：待办输入框连续打中文、日程页输入完回车，岛都保持展开。

## 二次修复（2026-11-05 晚，m03648 用户报告「问题都还在」后）

- **blur 假说被实机证伪**：800ms 去抖版装到用户机器后，用户仍「立刻缩小」。重新排查收起路径，找到真凶：岛根 `onKeyDown`（App.tsx:1734-1739）对 Enter/空格调 `toggle()` 收起岛，而**待办输入框（App.tsx:378-380）和日程页输入框（App.tsx:1275-1277）的 onKeyDown 都没有 `stopPropagation`** → 中文输入法用**空格选字**时 keydown（key=' '）冒泡到岛根 → 收岛（现象①）；**回车提交**冒泡（key='Enter'）→ 收岛（现象②）。第一轮把 Enter 冒泡修在了编辑框上，漏了这两个「新增」输入框，故用户看到「没改变」。
- 修复：两个输入框 onKeyDown 均加 `e.stopPropagation()`（含中文注释说明原因）。
- 验证：`npm run typecheck` exit 0；`npm run build` exit 0；`e2e-schedule-edit` 新增 **A8 断言**（输入框内派发 bubbles 空格/回车 keydown，岛保持展开）PASS；真实键盘实验（SendKeys 字母+空格+回车）岛保持展开、待办成功新增、blur 事件零次；回归 6 个 e2e 全 PASS（todo-today / schedule / schedule-edit / collapsed-todo / schedule-day / shelf-missing）。
- 重新打包安装：`npm run dist` exit 0 → `Setup /S /D=D:\软件\灵动岛`；安装版 asar 9060694 B（19:44:28），解包比对 `out/renderer/assets/index-DghUpkVT.js` 与本地构建**哈希一致**；4 进程存活、主窗口「灵动岛」。
- **实验污染与恢复（如实记录）**：真实键盘实验用的开发版进程前台运行期间，实验数据被写入 schedule.json；e2e 种子（us036-a/b）也一度残留。已在停掉全部应用进程后把 `%APPDATA%\lingdong-island\schedule.json` 恢复为 `{ "items": [] }`（与用户原始状态一致）并重启安装版，实测重启后仍为空。用户在实验窗口里输入的测试条目未能保留——应用本身的数据此前就是空的，没有覆盖任何用户原有数据。
## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 待填 | | | | |
