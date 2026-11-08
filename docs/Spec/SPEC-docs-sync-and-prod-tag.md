# SPEC：文档对账与补发版标签

> 任务分支：`docs-sync-and-prod-tag`，基线 `main`（`15c6da0`）。
> 背景引用 `docs/工程规则.md` 第六节（同一事实只在一处维护）与 `docs/facts/版本历史.md`（可回溯的版本），不复制产品设定。
> 触发原因：对照「已上线项目怎么加新功能」视频第一步/第四步复盘，发现常驻文档里留着已被后续实现推翻的旧结论，且最近一个生产标签停在 198 个提交之前。

## 一、目标

1. 把常驻文档里已经被后续实现推翻、但没同步的旧结论改对，避免下一轮 AI 在「第一步读文档」时按过时规则改代码。
2. 给 2026-11-08 已验收并装机的版本补一个正式生产版本标签，让 `git describe` 从「距上个标签 198 个提交」收敛成明确的锚点。

## 二、修改范围

只改文档与 Git 标签，**不动一行代码、不重新打包、不装机、不改运行数据**。

| 文件 | 改什么 |
|---|---|
| `docs/facts/数据规则.md` | 存储位置表格补 `prefs.json`、修正 5 处源码行号；第 5 条「界面偏好存渲染层 localStorage」改为 `prefs.json` + IPC；导出状态改为已验收合并 |
| `docs/facts/用户角色与用户故事.md` | US-035 存储方式改为 `prefs.json`；US-029 状态从「待验收」改为「已验收合并 `d30e801`」 |
| `docs/facts/功能清单.md` | 总览状态栏去掉「Wi-Fi 未做」；第 11 节删除线补丁重写成干净结论；末尾「需求清单」注清哪些已实现/已否决/仍未排期 |
| `docs/facts/里程碑.md` | M3 完成条件补注 Wi-Fi 后续已补、倒计时已否决；「未排期」清单按现状重列 |
| `docs/facts/技术方案.md` | `App.tsx` / `styles.css` 体积改为实测值；main 模块清单标注不全并指向 README |
| `docs/facts/本机约束与踩坑.md` | localStorage 那条删除线补丁重写成干净结论 |
| `README.md` | 脚本数 10 → 33 + 2；src 文件表补齐缺失的 5 个 main 模块 |
| `docs/facts/版本历史.md` | 新增 `prod-20261108` 一行；补 `prod-<日期>` 命名约定与「发版后即时补标签」 |
| `docs/状态.md` | 一句话状态补本轮；「下次开工」第 2 条去掉已不存在的「P1 未完成」 |
| `docs/Spec/SPEC-docs-sync-and-prod-tag.md` | 新增本文件 |
| Git 标签 `prod-20261108` | 轻量标签，指向 `15c6da0`（当天已验收并装机的那一版代码） |

**明确不改**：`src/` 下任何文件、`package.json`、`scripts/`、`build/`、`D:\软件\灵动岛\`、`%APPDATA%\lingdong-island\`、`docs/archive/`、历史 `docs/Spec/`（历史 SPEC 记录当时决策，不回改）。

## 三、预期行为

1. 全仓库 `docs/facts/` 与 `README.md` 不再出现「界面偏好存 localStorage / 不新建 JSON / 不新增 IPC」作为现行结论；涉及 US-035 早期方案处明确标注「已作废」并给出替代事实。
2. US-029 不再显示「开发完成待验收」或分支名 `us-029-data-export`，统一为已验收合并 `d30e801`。
3. 收起态状态栏不再写「Wi-Fi 未做」；倒计时统一表述为「已否决不做」，不混入「尚未排期」。
4. 数字与清单跟实测一致：脚本 33 个 `e2e-*.mjs` + 2 个辅助 `.mjs`；`App.tsx` 114250 字节、`styles.css` 45707 字节；main 11 个模块。
5. `git tag prod-20261108 15c6da0` 后，`git describe --tags --always 15c6da0` 输出 `prod-20261108`。
6. 不因本次改动触发任何构建、安装或运行数据写入。

## 四、必要依赖

无。纯文本修改 + Git 轻量标签；核对用的 `git`、`node`、`@electron/asar` 均已在仓库/本机可用。

## 五、验收条件

| 编号 | 可亲手核对的结果 |
|---|---|
| D1 | `Select-String -Path "docs\facts\*.md","README.md" -Pattern "不新建 JSON|开发完成待验收|约 55KB|约 29KB|10 个|倒计时未做|Wi-Fi、倒计时未做"` 在**现行结论**里零命中（历史 SPEC 与 `docs/archive/` 不算） |
| D2 | `docs/facts/数据规则.md` 第 5 条含 `prefs.json`、`prefs:get`/`prefs:set`、三道白名单，且明确标注旧 localStorage 结论作废 |
| D3 | `docs/facts/数据规则.md` 存储位置表格的 5 处源码行号与 `grep` 实测一致：`todoStore.ts:37`、`shelfStore.ts:173`、`:174`、`scheduleStore.ts:32`、`notifyStore.ts:195`、`prefsStore.ts:106` |
| D4 | `git show HEAD:docs/facts/用户角色与用户故事.md` 中 US-029 为「已验收合并 `d30e801`」、US-035 为 `prefs.json` |
| D5 | `git tag -l prod-20261108` 有输出；`git rev-parse prod-20261108^{commit}` = `15c6da0` 的完整哈希 |
| D6 | `git describe --tags --always 15c6da0` = `prod-20261108` |
| D7 | `git diff --name-only 15c6da0` 只列本 SPEC 第二节表格里的文件，无 `src/`、无 `package.json`、无 `scripts/` |
| D8 | `docs/状态.md` 一句话状态含本轮；「下次开工」第 2 条不再指向「P1 未完成」 |
| D9 | `docs/facts/版本历史.md` 有 `prod-20261108` 行，且「版本编号约定」含 `prod-<日期>` |

## 六、不做什么

- 不改代码、不加依赖、不跑 `npm run build` / `dist`、不装机、不动 `D:\软件\灵动岛\` 与 `%APPDATA%\lingdong-island\`。
- 不合并回 `main`（按 `docs/工程规则.md` 第 5.1 节需用户明确授权，本轮授权范围是「做这两件事并回报」）。
- 不做独立验收（按第 3.2 节需换会话/人，本轮只做研发自检）。
- 不顺手修 `App.tsx` 单文件过大、不给 e2e 脚本单独指定数据目录、不拆 `App.tsx`、不建三套环境——这些要另开 SPEC。

## 七、自检记录

角色：研发自检（实现者本人），2026-11-09 凌晨跑于任务分支 `docs-sync-and-prod-tag`。以下是实际命令与实际输出，[实测]；未跑的一律写明，不冒充通过。

| 编号 | 命令 / 检查 | 实际结果 | 判定 |
|---|---|---|---|
| D1 | `Select-String -Path "docs\facts\*.md","README.md" -Pattern "不新建 JSON\|开发完成待验收\|约 55KB\|约 29KB\|10 个\|倒计时未做\|Wi-Fi、倒计时未做"` | 首轮命中 2 处「已作废」说明文字里的旧词（数据规则第 5 条、技术方案体积说明），改写成不带旧词的表述后复跑 → **零命中** | ✅ 通过 |
| D2 | `Select-String` 查 `docs/facts/数据规则.md` 第 5 条 | 第 30 行含 `prefs.json`、`prefs:get`/`prefs:set`、三道白名单 `normalizeOrder()` / `normalizePagesCustom()` / `normalizeShelfView()`；第 31 行明确「旧结论作废」 | ✅ 通过 |
| D3 | `Select-String` 查 7 个 `src/main/*.ts` + `index.ts` 的数据文件名 | `todoStore.ts:37` / `shelfStore.ts:173` / `:174` / `scheduleStore.ts:32` / `notifyStore.ts:195` / `prefsStore.ts:106` / `notifyIconStore.ts:262` / `index.ts:289` 与表格逐行一致 | ✅ 通过 |
| D4 | `Select-String` 查 `docs/facts/用户角色与用户故事.md` US-029 / US-035 | US-029 第 216 行「已验收合并 `d30e801`」；US-035 第 162 行写清 `prefs.json` 的 `shelfView` 与迁移时间 | ✅ 通过 |
| D5 | `git tag -l prod-20261108`、`git rev-parse prod-20261108^{commit}`、`git cat-file -t prod-20261108` | 标签存在；指向 `15c6da0f64303664eb79fc1fe3b727496c998429`；类型 `commit`（轻量标签，与既有 11 个标签一致） | ✅ 通过 |
| D6 | `git describe --tags --always 15c6da0` | 输出 `prod-20261108`（改前为 `polish-video-20261104-198-g15c6da0`） | ✅ 通过 |
| D7 | `git diff --name-only 15c6da0`、`git status --porcelain` | 改动仅 9 个已跟踪文档 + 1 个新增 SPEC，全部在第二节表格范围内；**无** `src/`、**无** `package.json`、**无** `scripts/` | ✅ 通过 |
| D8 | `Select-String` 查 `docs/状态.md` | 一句话状态含本轮（第 13 行）；「下次开工」第 2 条已改为「P1 已全部完成」，不再指向不存在的「P1 未完成」 | ✅ 通过 |
| D9 | `Select-String` 查 `docs/facts/版本历史.md` | 第 20 行有 `prod-20261108` 行；第 34 / 36 行约定含 `prod-<日期>` 与「发版后即时补标签」 | ✅ 通过 |

补充核对（非 SPEC 验收项，但属于「数字与清单跟实测一致」）：`e2e-*.mjs = 33`、`scripts/*.mjs = 35`、`src/main/*.ts = 11`、`App.tsx = 114250` 字节、`styles.css = 45707` 字节，均与改后 `README.md`、`docs/facts/技术方案.md` 一致 [实测]。

**本轮没做的验证（明确列出，不计入通过）**：

- 未跑 `npm run typecheck` / `build` / `dist`，未装机，未启动安装版 —— 本轮零代码改动，不需要也不应该触发构建；`D:\软件\灵动岛\` 与 `%APPDATA%\lingdong-island\` 全程未写入 [实测]。
- 未做独立验收 —— 按 `docs/工程规则.md` 第 3.2 节需由未参与实现的会话或用户针对**固定提交**逐条核对 D1–D9，第八节留空待填，不以本节代替。
- 未合并回 `main` —— 按第 5.1 节需用户明确授权，本轮授权范围只到「做这两件事并回报」。

**怎么验收这次改动（给验收方）**：把改动提交成一个固定提交后，切到该提交，逐条跑上表 D1–D9 的命令，重点核对 `git diff --name-only <该提交>^ <该提交>` 只含文档与 Spec、`git rev-parse prod-20261108^{commit}` 仍是 `15c6da0`。纯文档轮次不需要真人实机点界面。

## 八、验收记录

（留空。按 `docs/工程规则.md` 第 3.2 / 3.3 节，由未参与实现的会话或用户针对固定提交逐条核对 D1–D9；不以自检结果代替。）
