# SPEC：订正状态页一句话状态里的过时合并表述

> 任务分支：`docs-status-correct`，基线 `main`（`8f8a56d`）。
> 背景引用 `docs/状态.md`「一句话状态」第 17 行与 `docs/工程规则.md` 第一、三、五节，不复制产品设定。
> 触发原因：2026-11-09 用户已说「合并」，`eead21a` + `8f8a56d` 已快进合入 `main`、任务分支已删；但第 17 行开头仍写「待用户授权合并」、末尾仍写「本轮停在任务分支 `e2e-userdata-isolation`，等用户说『合并』」，与现状不符。用户随后说「订正」，授权单开极小文档分支修正。

## 一、目标

把 `docs/状态.md` 第 17 行里两处已经过时的表述改成与现状一致：合并已完成、分支已删除；其余正文一字不动，避免下一轮 AI 读文档时把这轮又当成「还没合并」。

## 二、修改范围

只改文档，**不动一行代码、不重新打包、不装机、不改运行数据、不直接在 `main` 上提交**。

| 文件 | 改什么 |
|---|---|
| `docs/状态.md` | 第 17 行开头的「（已自检 + 独立验收，待用户授权合并）」改为已验收合并的表述；末尾「本轮停在任务分支 `e2e-userdata-isolation`，等用户说「合并」。」改为已快进合并、分支已删的准确表述。该行其余正文一字不动 |
| `docs/Spec/SPEC-docs-status-correct.md` | 新增本文件 |

**明确不改**：`src/` 下任何文件、`package.json`、`scripts/`、`build/`、`out/`、`D:\软件\灵动岛\`、`%APPDATA%\lingdong-island\`、`docs/facts/`、`docs/archive/`、历史 `docs/Spec/`、状态页其它行（第 9/11/13/15 行与「下次开工」一节）。

## 三、预期行为

1. 第 17 行开头不再出现「待用户授权合并」。现状是已快进合并回 `main`（`6408646..8f8a56d`），故改为「（已验收，用户授权合并 `8f8a56d`）」这一与第 15 行一致的说法。
2. 第 17 行末尾不再出现「本轮停在任务分支」或「等用户说「合并」」，改为写明：用户 2026-11-09 授权后快进合并回 `main`（代码提交 `eead21a` + 收口提交 `8f8a56d`）、任务分支 `e2e-userdata-isolation` 已删除、生产锚点 `prod-20261108` 未动。
3. 第 17 行正文关于 helper 原理、I1–I9 自检与独立验收、I6 的 GPU 缓存对照实验、6 个业务数据文件零变化、三处未隔离系统级副作用的描述**全部保留原文**，不借机改写或删减。
4. 「一句话状态」其它四条与「下次开工」一节一字不动。
5. 不因本次改动触发任何构建、安装或运行数据写入。

## 四、必要依赖

无。纯文本修改；核对用的 `git`、`pwsh` 均在本机可用。

## 五、验收条件

| 编号 | 可亲手核对的结果 |
|---|---|
| W1 | 读 `docs/状态.md` 第 17 行：开头不含「待用户授权合并」，含「已验收，用户授权合并 `8f8a56d`）」 |
| W2 | 第 17 行末尾不含「本轮停在任务分支」「等用户说「合并」」，含「快进合并回 `main`」「分支已删除」与两个提交哈希 `eead21a` / `8f8a56d` |
| W3 | 第 17 行除上述两处外的正文与 `main` 版本逐字一致（用 `git show main:docs/状态.md` 取第 17 行比对，只做两处字面替换后应完全相同） |
| W4 | `git diff main..HEAD --unified=0 -- docs/状态.md` 只有 1 个 hunk、精确 +1/−1，且是第 17 行；其它行零变化（工作区干净时 `git diff -- docs/状态.md` 输出为空，不能用；`--unified=0` 必须放在 `--` 之前，放后面会被 git 当成路径） |
| W5 | `git diff --name-only main..HEAD` 只列 `docs/状态.md` 与本 SPEC 两个文件，无 `src/`、无 `package.json`、无 `scripts/`，且不含 `.tmp/` |
| W6 | 固定提交上 `git status --porcelain` 为空；`git describe --tags --always HEAD` 为 `prod-20261108-6-g8f8a56d` 再加 1 个提交；`prod-20261108` 仍指 `15c6da0f64303664eb79fc1fe3b727496c998429` |

## 六、不做什么

- 不改代码、不加依赖、不跑 `npm run build` / `dist` / `typecheck`、不装机、不动 `D:\软件\灵动岛\` 与 `%APPDATA%\lingdong-island\`。零代码改动，不需要也不应该触发构建。
- 不借订正之名改写第 17 行的技术结论或压缩篇幅。
- 不合并回 `main`（按 `docs/工程规则.md` 第 5.1 节需用户明确授权）；本轮授权范围只到「订正这句话，改完等授权合并」。
- 不删除 `.backups/` 下本轮备份。
- 不重跑 e2e / 探针：本轮零代码改动，与 `scripts/isolate-userdata.mjs` 的行为无关。

## 七、自检记录

角色：研发自检（实现者本人），2026-11-09。纯文档轮次，无类型检查 / 构建 / e2e 可跑，自检只覆盖文本一致性与 Git 范围。

基线 [实测]：分支 `docs-status-correct`（从 `main` `8f8a56d` 建），工作区改前干净，状态页备份到 `.backups/docs-status-correct-20261109/状态.md`（12570 字节）。

| 编号 | 命令 / 检查 | 实际结果 | 判定 |
|---|---|---|---|
| W1 | 读 `docs/状态.md` 第 17 行开头 | 不含「待用户授权合并」，含「（已验收，用户授权合并 `8f8a56d`）」 | ✅ 通过 |
| W2 | 读第 17 行末尾 | 不含「本轮停在任务分支」「等用户说「合并」」；含「快进合并回 `main`」「已删除」「eead21a」「8f8a56d」 | ✅ 通过 |
| W3 | 用 `git show main:docs/状态.md` 取 `main` 版第 17 行，只做两处字面替换后与当前行 `-ceq` 逐字比对 | `identicalAfterTwoReplacements=True`（正文其余部分一字未动） | ✅ 通过 |
| W4 | 全文件过时词扫描 `Select-String -LiteralPath 'docs\状态.md' -Pattern '待用户授权合并\|本轮停在任务分支\|等用户说「合并」'` | 零命中；`git diff main -- docs/状态.md --unified=0` 仅 1 个 hunk（`@@ -14,7 +14,7 @@` 上下文内的第 17 行）、`numstat = 1 1`，无其它行变化。写法注记 [实测]：此处 `--unified=0` 放在 `--` 之后被 git 当成路径、实际仍用默认 3 行上下文；正确写法 `git diff main..HEAD --unified=0 -- docs/状态.md` 得 `@@ -17 +17 @@`。两种写法都只有 1 hunk、numstat 1 1、只改第 17 行，判定不受影响，第五节 W4 已按正确写法订正 | ✅ 通过 |
| W5 | `git diff --name-only main` 与 `git status --porcelain` | 已跟踪改动只列 `docs/状态.md`；另有未跟踪 `?? docs/Spec/SPEC-docs-status-correct.md`（本 SPEC）；无 `src/`、无 `package.json`、无 `scripts/`、无 `.tmp/` | ✅ 通过 |
| W6 | 提交前状态 | `HEAD=8f8a56d`、`describe=prod-20261108-6-g8f8a56d`、`porcelain` 仅本轮两文件；固定提交后的 `porcelain` 空 / `describe` / 锚点未动由独立验收在第八节核对 | ⏳ 交第八节核 |

**本轮没做的验证（明确列出，不计入通过）**：未跑 `npm run typecheck` / `build` / `dist`，未装机，未启动安装版，未跑任何 `e2e` —— 本轮零代码改动，`D:\软件\灵动岛\` 与 `%APPDATA%\lingdong-island\` 全程未写入 [实测]。

独立验收按 `docs/工程规则.md` 第 3.2 节，由未参与实现的独立会话针对**固定提交**逐条重跑 W1–W6，结论见第八节，不以本节自检结果代替。

**怎么验收这次改动（给验收方）**：切到本轮固定提交，逐条跑 W1–W6；工作区干净时 `git diff -- docs/状态.md` 输出为空，必须用 `git diff main..HEAD --unified=0 -- docs/状态.md`（`--unified=0` 要放在 `--` 之前）；重点看是否只改第 17 行两处字面、其余正文与第 9/11/13/15 行是否一字未动。纯文档轮次不需要真人实机点界面。

## 八、验收记录

角色：独立验收（独立会话 `status-correct-acceptance`，fresh 上下文、未参与实现），2026-11-09。针对固定提交 `9cf9fb1c21610444e700879d645d0f4add732db4` 逐条重跑 W1–W6；全程只读，收尾时 `git status --porcelain` 仍为空。

前置核实 [实测]：`git rev-parse HEAD` = `9cf9fb1c21610444e700879d645d0f4add732db4`（=固定提交）；父提交 = `8f8a56dac345e505f8834f811f8d4602693a8e20` = `git rev-parse main`；当前分支 `docs-status-correct`；`git status --porcelain` 空。

| 编号 | 独立验收实际结果 | 判定 |
|---|---|---|
| W1 | 第 17 行与 `git show HEAD:docs/状态.md` 第 17 行 `-ceq` 一致；「待用户授权合并」命中 0；含「（已验收，用户授权合并 `8f8a56d`）」且位于开头（`IndexOf=32`） | ✅ 通过 |
| W2 | 同行不含「本轮停在任务分支」「等用户说「合并」」；含「快进合并回 `main`」「已删除」「eead21a」「8f8a56d」；全文件 `Select-String -SimpleMatch` 三个过时词均 0 命中 | ✅ 通过 |
| W3 | `git show main:docs/状态.md` 取第 17 行，只做两处字面替换（两旧串各命中 1 次）后与当前行 `-ceq` = True，UTF-8 逐字节相等（1986/1986），前/中/后三段独立比对全 True；第 9/11/13/15 行与「下次开工」节第 19–25 行 main 版 vs HEAD 版逐行 `-ceq` 全 True；全 92 行除第 17 行外不同行数 = 0 | ✅ 通过 |
| W4 | `git diff -- docs/状态.md` 在干净工作区下 0 行（不能用）；`git diff main..HEAD --numstat -- docs/状态.md` = `1 1`；`git -c core.quotepath=false diff main..HEAD --unified=0 -- docs/状态.md` = 1 个 hunk、头 `@@ -17 +17 @@`、删 1 行 / 增 1 行、正是第 17 行，其它行零变化 | ✅ 通过 |
| W5 | `git -c core.quotepath=false diff --name-only main..HEAD` 仅 `docs/Spec/SPEC-docs-status-correct.md` 与 `docs/状态.md` 两行（fileCount=2）；不含 `src/`、`package.json`、`scripts/`、`.tmp/` | ✅ 通过 |
| W6 | `git status --porcelain` 空；`git describe --tags --always HEAD` = `prod-20261108-7-g9cf9fb1`，`git describe --tags --always main` = `prod-20261108-6-g8f8a56d`（即「再加 1 个提交」）；`git rev-parse "prod-20261108^{commit}"` = `15c6da0f64303664eb79fc1fe3b727496c998429` | ✅ 通过 |

**验收提出的一处命令写法瑕疵（已订正，不影响判定）** [实测]：第五节 W4 与第七节原把 `--unified=0` 写在 `-- docs/状态.md` 之后，git 视其为路径、仍用默认 3 行上下文（`@@ -14,7 +14,7 @@`）；把选项移到 `--` 前才得 `@@ -17 +17 @@`。两种写法都只有 1 hunk、numstat 1 1、只改第 17 行。第五节 W4、第七节 W4 与「怎么验收」已按正确写法订正。另 W6 两种期望表述（`7-g9cf9fb1` 与「6-g8f8a56d 再加 1」）实测均成立，非矛盾。

**明确回答的三个问题** [实测/推断]：
- SPEC 第八节验收记录原本留空（`git show HEAD:docs/Spec/SPEC-docs-status-correct.md` 第 74 行起仅占位说明、无通过字样）。按 `docs/工程规则.md` 第 42 行原文「1. 合并回 `main` 需要用户明确授权，前置条件是验收记录已写明通过。」，留空构成合并前置阻断项；本收口提交已回填本节，阻断解除。
- 合并回 `main` 仍需用户单独明确授权 [推断]：实测 `git merge-base --is-ancestor HEAD main` 退出码 1、`git branch --contains 9cf9fb1` 仅 `* docs-status-correct`，本轮提交尚未进 `main`；用户此前那句「合并」针对的是上一轮 e2e 数据隔离分支（已快进为 `8f8a56d`），不覆盖本轮新分支；SPEC 第六节亦写明「本轮授权范围只到『订正这句话，改完等授权合并』」。
- 本轮纯文档改动不涉及打包装机，按 `docs/工程规则.md` 5.2「合并 ≠ 上线」，合并也不触发上线动作 [推断]。

**验收结论** [实测]：W1–W6 全部通过，无 ❌；改动范围与 SPEC 第二节、第六节一致，文档订正与「已快进合并回 `main`、任务分支已删」的现状相符；唯一命令写法瑕疵已在收口提交订正，阻断项已补齐，无遗留阻断。未跑 `build` / `dist` / `typecheck` / `e2e`（本轮零代码改动，SPEC 第六节明确不跑）。合并回 `main` 仍按 `docs/工程规则.md` 5.1 需用户明确授权，本记录不代替授权。

说明：独立验收针对固定提交 `9cf9fb1`；收口提交只订正第五节/第七节 W4 命令写法与本节验收记录，不改 `docs/状态.md` 一个字，未重跑任何检查（该瑕疵不影响任何判定）。
