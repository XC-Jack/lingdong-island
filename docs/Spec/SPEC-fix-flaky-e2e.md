# SPEC-fix-flaky-e2e

| 项 | 值 |
|---|---|
| 建立日期 | 2026-11-12 |
| 对应基线提交 | `cebb8e6` |
| 任务分支 | `fix-flaky-e2e` |
| 关联用户故事 | 无（工程质量，非用户可见功能） |
| 关联事实文档 | `docs/facts/本机约束与踩坑.md`、`docs/状态.md` |

> 说明（如实记录）：本轮先动手改脚本、后补 SPEC，与 `docs/工程规则.md` 第二节「SPEC 先行」不符。
> 原因是这四条失败在上一批已被记录为「既有遗留」（`docs/状态.md` 已知遗留第 ⑨⑫ 条 + 独立验收报告），
> 属于修既有缺陷而非新功能。SPEC 在此补建，内容按实际改动回填。

## 一、目标

用户 2026-11-12 选定「先把 4 个失效的测试修好」。四个脚本长期红/假绿，导致：

1. 跑全量回归时无法区分「新改动坏了」和「脚本自己就不稳」，回归结果不可信；
2. 其中两条是**假绿**（跳过而非失败），真出问题时不会报警——2026-11-11 音乐页多会话缺陷就是这么漏过去的。

目标：四个脚本在**本机现有环境**下稳定通过，且失败时能真的失败（非 0 退出码）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `scripts/e2e-notify.mjs` | 新增 `waitFor()` 轮询，替换固定 `sleep(2000)` 后立刻点击 |
| `scripts/e2e-notify-group.mjs` | G5b 改为点「G3 展开过的那个组」（记录 `maxIdx`），不再盲点第一个 |
| `scripts/e2e-notify-open.mjs` | 整文件重写：去掉 QQ 硬依赖，改为读 `wpndatabase.db` 逐条核对；种子 toast 改 opt-in |
| `scripts/e2e-todo-today.mjs` | `gotoPage()` 改为轮询页面标题，不再固定 `sleep(500)` |
| `src/main/notifyStore.ts` | `parseToastLaunch()` 补 `decodeEntities()`（先解 XML 实体，再解百分号） |

## 三、预期行为

1. `node scripts/e2e-notify.mjs` → PASS、EXIT=0。
2. `node scripts/e2e-notify-group.mjs` → 10 过 0 败（G5b 展开会话数归零、G7 `leaves === stated`）。
3. `node scripts/e2e-notify-open.mjs` → 8 过 0 败：O1 断言「launch 里没有残留 `&amp;` 这类未解码实体」，O1b 断言「launch = 库原始值经解实体+解百分号后的结果」；本机无带 launch 通知时 O1/O1b 跳过而不失败；不再因为「没有 QQ」失败。
4. `node scripts/e2e-todo-today.mjs` → A1–A10 全过，A7 不再偶发 `TypeError: Cannot read properties of undefined`。
5. 深链里的 `&amp;` 被还原成 `&`（`ms-screensketch:edit?&filePath=...`），交给 `shell.openExternal` 是合法 URI。

## 四、必要依赖

无新增依赖。用到 `node:sqlite`（Node 22.5+ 内置 `DatabaseSync`，本机 Node 24 已有）、全局 `WebSocket`/`fetch`、`powershell -EncodedCommand`。

## 五、验收条件

- [x] `npm run typecheck` EXIT=0
- [x] `npm run build` EXIT=0
- [x] `e2e-notify` PASS / EXIT=0
- [x] `e2e-notify-group` 10 过 0 败 / EXIT=0
- [x] `e2e-notify-open` 8 过 0 败 / EXIT=0
- [x] `e2e-todo-today` PASS / EXIT=0
- [x] **负对照**：把 `parseToastLaunch` 退回旧实现（`decodeEntities(m[1])` → `m[1]`）后 `e2e-notify-open` 必须变红（实测 6 过 2 败 / EXIT=1），恢复后回到 8 过 0 败
- [x] 回归：`e2e-notify-icon` 8 过 0 败、`e2e-notify-compact` 2 过 0 败
- [x] `docs/facts/本机约束与踩坑.md` 记两条新坑（通知库只追加删不掉 / 五页根节点同名）
- [x] `docs/状态.md` 同步

## 六、不做什么

- 不改产品交互（唯一产品改动是 `launch` 解码顺序，属缺陷修复）。
- 不清理 `wpndatabase.db` 里探针留下的 `lingdongtest://` 条目（系统库只追加，无官方删除接口；已实测 `History.Clear`/`Remove` 都不删库行）。
- 不给 `e2e-notify-open` 加「默认注入种子 toast」——会永久污染用户通知列表。
- 不动其余 30+ 个 e2e 脚本。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-12 | `npm run typecheck` | EXIT=0 | — |
| 2026-11-12 | `npm run build` | EXIT=0（`index-DGoQXE0C.js 105.04 kB`、`index-BxySBjEO.css 58.14 kB`） | — |
| 2026-11-12 | `node scripts/e2e-notify.mjs` | PASS，`notifyList {"n":34,"unread":18}` | — |
| 2026-11-12 | `node scripts/e2e-notify-group.mjs` | 10 过 0 败，`G7 leaves=34 stated=34`、`G8 threads=19` | — |
| 2026-11-12 | `node scripts/e2e-notify-open.mjs` | 8 过 0 败（O1 「13 条都干净」、O1b「核对 13 条全部一致」） | 未在「通知库为空」的机器上跑过 |
| 2026-11-12 | `node scripts/e2e-todo-today.mjs` | PASS A1–A10 | 只在当前机器时序下验证过 |
| 2026-11-12 | 负对照：`parseToastLaunch` 退回旧实现 → build → 跑 `e2e-notify-open` | **6 过 2 败 / EXIT=1**（O1b 报 `raw` 含 `&amp;`、`got` 未还原） | — |
| 2026-11-12 | 恢复修复版 → build → 复跑 | **8 过 0 败 / EXIT=0** | — |
| 2026-11-12 | `e2e-notify-icon` / `e2e-notify-compact` | 8 过 0 败 / 2 过 0 败 | — |

### 实现要点

- **`e2e-notify.mjs`**：`waitFor(wsUrl, expr, {timeoutMs, gapMs, label})` 轮询直到表达式为真，超时打印最后的值再抛。原来 `spawn → sleep(2000) → click`，实测 `.island` 首次出现可晚到 2.9 秒，`click()` 静默失败 → 岛停在收起态 → `.dot` 只在展开态渲染 → 读到 0。
- **`e2e-notify-group.mjs`**：G3 探测块返回 `{ n: bestN, idx: best }`，G5b 用 `document.querySelectorAll('.notify-list > .notify-group')[${maxIdx}]?.querySelector(':scope > .notify-body')`。原来盲点第一个组，等于新开了一个组，`threads` 从 13 变 14。
- **`e2e-notify-open.mjs`**：删除「必须有 QQ 深链」的硬断言。O1 改为「launch 里没有残留未解码 XML 实体」——不能用「都是合法 URI」判，实测本机存在 `magpie` 的 base64 JSON（`eyJhY3Rpb24i…`）与 `SecurityCenter` 的 `439#enable&av&火绒安全软件` 两类非 URI 值，那不是本项目的 bug。O1b 用 `node:sqlite` 复制 `wpndatabase.db` 快照逐条核对。
- **`e2e-todo-today.mjs`**：`gotoPage()` 先读圆点 `aria-label`（格式「跳到第 N 页：日程」）取出页名，点完轮询 `.panel-title` 文本直到匹配，8 秒超时抛错。
- **`src/main/notifyStore.ts`**：`parseToastLaunch` 先 `decodeEntities` 再 `decodeURIComponent`。顺序不能反（含 `%26` 的值会被二次解码）。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 待批量验收 | — | — | — | — |
