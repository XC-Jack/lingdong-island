# SPEC：e2e 脚本数据隔离（不碰真实用户数据）

> 任务分支：`e2e-userdata-isolation`，基线 `main`（`6408646`）。
> 触发原因：2026-11-09 用户授权「做第一件」——给测试脚本单独指定一个放数据的地方，免得它碰真实用户数据。
> 背景：`docs/状态.md`「尚未验证的范围」之外，e2e 脚本默认读写 `%APPDATA%\lingdong-island\` 的真实数据；其中 `e2e-fullscreen-avoid.mjs` / `e2e-fullscreen-misjudge.mjs` 用 `ELECTRON_USER_DATA` 自以为隔离，实测该环境变量无效。

## 一、目标

让 33 个 e2e 脚本启动的 dev electron 全部读写 `.tmp/e2e-userdata/lingdong-island\`（隔离目录），不再读写真实 `%APPDATA%\lingdong-island\`；`src/` 零改动。

## 二、修改范围

只改 `scripts/` 下的 `.mjs`、新增 1 个 helper、同步 `README.md` 计数、新增本 SPEC；验收后的收口阶段按 `AGENTS.md`「交付时必须给」第 4 条补一句 `docs/状态.md` 一句话状态（纯文档，不改代码、不改验收结论）。

| 文件 | 改什么 |
|---|---|
| `scripts/isolate-userdata.mjs` | 新增 helper：顶层建隔离目录并把 `process.env.APPDATA` 指向伪 Roaming，导出 `USER_DATA` 与包装后的 `spawn`（给带 `--remote-debugging-port` 的 electron 启动追加 `--user-data-dir`），`export *` 透传 `execSync`/`execFileSync` 等 |
| 32 个 `scripts/e2e-*.mjs`（含 `e2e-reorder-run.mjs`，不含 `e2e-reorder.mjs`） | 仅改 1 行：`from 'node:child_process'` → `from './isolate-userdata.mjs'`；spawn 调用行一律不动 |
| `scripts/e2e-notify-clear.mjs` | 删 `homedir` 硬编码路径，改 import `{ spawn, execSync, USER_DATA }` from helper（`platform` 仍在用，保留） |
| `scripts/e2e-fullscreen-avoid.mjs`、`scripts/e2e-fullscreen-misjudge.mjs` | 删 `mkdtempSync`/`tmpdir` 与自以为隔离的无效环境变量；数据隔离靠 helper 的 `spawn` 包装自动加 `--user-data-dir`，这两个脚本不额外 import `USER_DATA`；保留删 `ELECTRON_RUN_AS_NODE` |
| `README.md` | 第 34 行脚本计数 33+2=35 → 33+3=36（新增 1 个辅助 helper） |
| `docs/状态.md` | 收口阶段补一条「一句话状态」（按 `AGENTS.md`「交付时必须给」第 4 条），只记本轮做了什么、验证结论与「等用户授权合并」，不改既有状态 |
| `docs/Spec/SPEC-e2e-userdata-isolation.md` | 新增本文件；验收后回填第八节、订正第七节 I8 数字、补记收口提交说明 |

**明确不改**：`src/` 下任何文件、`package.json`、`scripts/e2e-reorder.mjs`（纯 CDP 客户端，不 spawn electron、不读 userData）、`scripts/seed-m1.mjs`、`scripts/verify-export-payload.mjs`、`build/`、`out/`、`D:\软件\灵动岛\`、`%APPDATA%\lingdong-island\`、`docs/facts/`、历史 `docs/Spec/`。

## 三、预期行为

1. helper 模块顶层同步执行：先 `mkdirSync(USER_DATA, {recursive:true})`，再 `process.env.APPDATA = FAKE_ROAMING`。依据 ESM「依赖先求值」——各脚本模块体里 `const USER_DATA = join(process.env.APPDATA, 'lingdong-island')` 会读到伪 APPDATA，自动落到隔离目录。
2. 包装后的 `spawn` 只对「参数数组含 `--remote-debugging-port` 且不含 `--user-data-dir`」的那次 electron 启动追加 `--user-data-dir=${USER_DATA}`；`powershell` / `taskkill` / 子进程 `node` 等其它 spawn 原样透传。
3. 主进程 `app.getPath('userData')` 被 `--user-data-dir` 改到隔离目录，与脚本读文件路径三方对齐；Chromium 的 Cache / Local State / Preferences 等也落在隔离目录。
4. 实跑 e2e 前后，真实 `%APPDATA%\lingdong-island\` 文件清单与时间戳零变化。
5. 隔离目录放 `.tmp/`，已被 `.gitignore:15` 忽略，不进 git。

## 四、必要依赖

无新增依赖。`node`、`npm`、`git`、`pwsh` 均在本机可用；验证用 Electron 已装于 `node_modules/electron/dist/electron.exe`。

## 五、验收条件

| 编号 | 可亲手核对的结果 |
|---|---|
| I1 | `node --check scripts/isolate-userdata.mjs` 无报错；读文件确认顶层有 `mkdirSync`、设 `APPDATA`、导出 `USER_DATA` 与包装 `spawn` |
| I2 | `grep "from 'node:child_process'" scripts/e2e-*.mjs` 零命中（两个脚本的动态 `require`/`await import` 不含 `from`，不受影响）；`grep "from './isolate-userdata.mjs'" scripts/e2e-*.mjs` 命中 32 行 |
| I3 | `e2e-notify-clear.mjs` 无 `homedir` 拼路径；两 fullscreen 脚本无 `ELECTRON_USER_DATA`、`mkdtempSync`、`tmpdir` |
| I4 | `npm run typecheck` 通过（node + web 两份 tsconfig；脚本是 `.mjs` 不进类型检查，此项证明 `src/` 未被破坏） |
| I5 | 代表性 e2e 实跑通过：至少 2 个（一个「离线写 prefs.json 再多次重启」、一个「写 todos/schedule」），贴原始输出 |
| I6 | 实跑前后对真实 `%APPDATA%\lingdong-island` 做文件清单+mtime 快照比对：`added`/`removed` 全空，**本应用业务数据**（`.json` / `.txt` / `icon-cache` / `Local Storage` / `Network`）清单与 mtime 零变化。Chromium 的 GPU/Shader 缓存（`DawnGraphiteCache` / `DawnWebGPUCache` / `GPUCache` / `GrShaderCache` / `ShaderCache` 的 `data_1`）由后台一直运行着的安装版按约 300 秒周期自刷新 mtime，不属本应用业务数据，用「不跑 e2e 空等 320 秒」的对照实验单独排除，不计入本条。**口径说明**：初稿写的是「changed 全空」，自检时发现该写法把不可控的第三方进程自刷新也计入、本机环境下不可能成立，故在自检期依据对照实验证据收窄到「本应用业务数据零变化」，原目标（e2e 不碰真实用户数据）不变；此调整须由独立验收员在第八节确认。 |
| I7 | 隔离目录 `.tmp/e2e-userdata/lingdong-island\` 内出现 `prefs.json`/`todos.json` 等数据文件与 Chromium 缓存目录 |
| I8 | `git diff --name-only main..HEAD` 只列 `scripts/*.mjs`、`scripts/isolate-userdata.mjs`、`README.md`、`docs/Spec/SPEC-e2e-userdata-isolation.md`，以及收口阶段按 `AGENTS.md` 补的 `docs/状态.md`；无 `src/`、无 `package.json`、无 `out/`。独立验收针对的是代码固定提交 `eead21a`（此时尚无 `docs/状态.md`），收口提交只追加文档、不改任何 `.mjs` |
| I9 | 收口提交后 `git status --porcelain` 为空；`git status` 不出现 `.tmp/e2e-userdata/` |

## 六、不做什么

- 不改主进程代码（`src/` 零改动）、不加依赖、不改 `package.json`。
- 不跑 `npm run build` / `dist`、不重新打包、不装机、不动 `D:\软件\灵动岛\`。本轮改的是 e2e 脚本，不是产品代码，构建/装机与本次结果无关。
- 不隔离「系统级副作用」并如实说明：`e2e-notify-live.mjs` 发真系统 toast（AUMID `com.xcjack.lingdong-island`）、`e2e-export.mjs` 的 `app.getPath('documents')` 默认导出目录仍是真实 Documents、`src/main/notifyStore.ts` 读的 WPN 系统通知库用 `LOCALAPPDATA` 只读——这些都不是本应用 userData，不在本轮范围。
- 不合并回 `main`（按 `docs/工程规则.md` 5.1 需用户明确授权）。
- 不把「跑不稳 / 环境不具备」的 e2e 硬算通过；失败的如实标 `[未验证]` 并写明原因。

## 七、自检记录

自检人：实现者本人（lead）。基线 `6408646`，分支 `e2e-userdata-isolation`。以下均为本机 [实测]。

| 编号 | 实际命令 / 操作 | 实际结果 | 判定 |
|---|---|---|---|
| I1 | `node --check scripts/isolate-userdata.mjs` | `exit=0`；读全文 61 行，顶层有 `mkdirSync(USER_DATA, { recursive: true })`、`process.env.APPDATA = FAKE_ROAMING`，导出 `USER_DATA` 与包装 `spawn` | ✅ 通过 |
| I2 | `grep "from 'node:child_process'" scripts/e2e-*.mjs` / `grep "from './isolate-userdata.mjs'" scripts/e2e-*.mjs` | 前者 0 命中，后者 32 命中 | ✅ 通过 |
| I3 | 3 个特殊脚本扫 `homedir\(\|mkdtempSync\|tmpdir\(\|ELECTRON_USER_DATA:` | 0 命中；`e2e-notify-clear.mjs` 现为 `import { spawn, execSync, USER_DATA } from './isolate-userdata.mjs'`，两 fullscreen 脚本 env 现为 `env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },` | ✅ 通过 |
| I4 | `npm run typecheck` | `exit=0`（node + web 两份 tsconfig） | ✅ 通过 |
| I5 | `node scripts/e2e-todo-today.mjs`、`node scripts/e2e-pages-custom.mjs` | 前者 `E2E TODO-TODAY PASS`（A1–A10）、`[收尾] todos.json / schedule.json 已恢复`；后者 `E2E PAGES-CUSTOM: PASS（6 项通过）`（P1a–P6a，含跨重启持久化）。原始输出在 `.tmp/e2e-todo-today-output.txt`、`.tmp/e2e-pages-custom-output.txt` | ✅ 通过 |
| I6 | 真实 `%APPDATA%\lingdong-island` 跑前/跑后快照（`.tmp/snap-before.json` / `.tmp/snap-after.json`）+ `.tmp/compare-appdata.cjs` + 对照实验 `.tmp/control-idle.cjs` | `beforeCount=114 / afterCount=114`、`added=[]`、`removed=[]`；`changedCount=5`（全是 `DawnGraphiteCache` / `DawnWebGPUCache` / `GPUCache` / `GrShaderCache` / `ShaderCache` 的 `data_1`，size 270336 不变、mtime 间隔约 300 秒）；`appDataChanged=[]`、`appDataAdded=[]`、`appDataRemoved=[]`、应用数据口径 `pass=true`。对照实验不跑任何 e2e、空等 320 秒，结果 `changedAllGpuCache=true`、`appDataChanged=[]`、`added=[]`、`removed=[]`（`.tmp/control-idle-result.json`） | ⚠️ 按第五节收窄后的口径（应用业务数据零变化 + `added`/`removed` 全空）达成、GPU 缓存变化经对照实验排除；但**该口径调整是自检期做的，实现者不自判通过，交独立验收员在第八节确认**（见下方「I6 专项说明」） |
| I7 | 列 `.tmp/e2e-userdata/lingdong-island\` | 63 个文件：`collapse-log.txt`(306)、`prefs.json`(2，内容 `{}`)、`DevToolsActivePort`(59)、`DIPS`/`DIPS-wal`、`declarative_performance_observer.db`(+journal)、`icon-cache/` 及 Chromium 缓存目录；`collapse-log.txt` 内容为 `2026-11-09T04:08:27.887Z collapse by schedule timer; no active input` 等主进程日志 | ✅ 通过 |
| I8 | `git diff --stat` + 抽查 `scripts/e2e-m1.mjs` + 行尾核对 | **收口提交前**的 `git diff --stat` 为 `33 files changed, 43 insertions(+), 45 deletions(-)`（此数只含已改的 33 个文件，尚未含新增的 `SPEC-e2e-userdata-isolation.md` 与 `isolate-userdata.mjs`；独立验收指出该数与固定提交不符，已按第八节订正：固定提交 `eead21a` 实测 `35 files changed, 199 insertions(+), 45 deletions(-)`，改动范围本身无误）。除 3 个特殊脚本外每个 `2 +-`（仅 1 行 import）；`e2e-m1.mjs` diff 只有 `import { spawn } from 'node:child_process'` → `from './isolate-userdata.mjs'`；备份与当前文件 `CRLF=0 LF-only=109`，行尾未破坏；无 `src/`、`package.json`、`out/` | ✅ 通过 |
| I9 | 收口提交后 `git status --porcelain`、`git status` | 本项只针对「已提交后的工作区状态」，由独立验收员在第八节针对固定提交核对 `git status --porcelain` 为空、`git status` 不出现 `.tmp/e2e-userdata/`；实现者提交前先核 `git status` 无 `src/` / `package.json` / `out/` / `.tmp/e2e-userdata/`（[实测] 已核，见 I8） | 交第八节核对 |

补充证据（不替代 I1–I9，仅佐证）：

- 全量 `node --check scripts/*.mjs`：`ok=36 fail=0`（33 e2e + helper + seed-m1 + verify-export-payload）。
- `.tmp/check-paths.cjs`：`totalScripts=33, withAppdata=17, withHomedirFallback=9, suspicious=[], noHelperButSpawns=[], pass=true`。
- `.tmp/check-imports.cjs`：`total=33, withHelperImport=32, problems=[], pass=true`（32 个脚本具名 import 的符号 helper 都能提供）。
- `.tmp/smoke-helper-fn.cjs`：`childArgv = ["--remote-debugging-port=1234","--user-data-dir=D:\\Users\\honor\\Documents\\Project\\灵动岛\\.tmp\\e2e-userdata\\lingdong-island"]`、`exitCode=0`、`pass=true` → 显式 `spawn` 确实覆盖 `export *` 同名透传并追加参数。
- `.tmp/smoke-helper.cjs`：`beforeAppData=C:\Users\honor\AppData\Roaming` → `afterAppData=...\.tmp\e2e-userdata`、USER_DATA 已建、`hasExecSync/execFileSync/spawnSync` 均 true。
- 决定性探针 `.tmp/probe-decisive-*`（真实 app 名 + `--user-data-dir`）：真实目录 `114 → 114`、delta 全空；组合探针 `.tmp/probe-final-*`（同时改 APPDATA + 加开关）：`114 → 114`、delta 全空。

**I6 专项说明（如实标注，不把跑不稳的算通过）**

实跑前后真实目录的 5 个 GPU/Shader 缓存 `data_1` 的 mtime 变了（size 不变，间隔精确约 300 秒）。原因是：**本机一直运行着用户日常在用的安装版「灵动岛」4 个进程**（PID 708 / 3320 / 16128 / 18504，StartTime `2026/11/8 17:04:27`，Path `D:\软件\灵动岛\灵动岛.exe`），它按约 5 分钟周期刷新自己的 GPU 缓存；本轮没有停止它，也不该停止。

为坐实归因，做了对照实验：不跑任何 e2e、空等 320 秒，那 5 个缓存照样按 300 秒变 mtime，`appDataChanged=[]`；而跑 e2e 前后，本应用的业务数据（`collapse-log.txt` 91180 / 2026-11-9 11:02:52、`notif-read.json` 37、`prefs.json` 23 / 9:40:45、`schedule.json` 17、`shelf.json` 176 / 9:40:38、`todos.json` 17）size 与 mtime 全部未变。

结论 [实测+推断]：本轮隔离目标（e2e 不碰真实应用数据）达成；但第五节 I6 的**初稿**写法「added/removed/changed 全空」把不可控的第三方进程自刷新也计入，本机环境下不可能成立。自检期已据对照实验证据把第五节 I6 收窄为「应用数据文件（`.json`/`.txt`/`icon-cache`/`Local Storage`/`Network`）清单与 mtime 零变化，且 added/removed 全空；GPU/Shader 缓存变化用对照实验排除」，原目标不变。**实现者不自行宣布这次口径调整有效、也不自行宣布 I6 通过**，调整是否接受与最终判定交独立验收员在第八节裁定。

## 八、验收记录

本节与第七节「自检记录」分开记录，按 `docs/工程规则.md` 3.2 / 3.3「自检与独立验收分离、针对同一固定提交、分别记录、不得合并成一句已通过」。本节由 Lead 依据独立验收员的只读回报回填，验收员本人未改文件、未回填。

- 验收角色：`e2e-isolation-acceptance`（未参与实现的独立会话，fresh 上下文）。
- 固定提交：`eead21a60ac5748c81d2363da20117f7dcbe54a2`（短 `eead21a`），分支 `e2e-userdata-isolation`，`git describe --tags --always HEAD` = `prod-20261108-5-geead21a`，基线 main = `6408646`。
- 提交身份核对：`git rev-parse HEAD` = `eead21a60ac5748c81d2363da20117f7dcbe54a2`；`git log -1 --oneline` = `eead21a test(e2e): 给测试脚本单独指定数据目录，不再碰真实用户数据`；`git status --porcelain` 为空；`git diff --name-only main..HEAD` = 35 个文件（README.md、本 SPEC、`scripts/*.mjs`），无 `src/`、无 `package.json`、无 `out/`、无 `build/`；`git diff --stat main..HEAD` = `35 files changed, 199 insertions(+), 45 deletions(-)`。验收员全程只读，未改文件、未切分支、未 commit、未跑 build/dist、未装机、未联网、未合并。

### 逐条独立重跑 I1–I9

| 编号 | 验收员实际命令 / 操作 | 实际输出 | 判定 |
|---|---|---|---|
| I1 | `node --check scripts/isolate-userdata.mjs` + 读全文 61 行 | `exit=0`；逐行确认 `scripts/isolate-userdata.mjs:44` 原文 `mkdirSync(USER_DATA, { recursive: true })`、`:45` 原文 `process.env.APPDATA = FAKE_ROAMING`、`:39` 原文 `export const USER_DATA = join(FAKE_ROAMING, 'lingdong-island')`、`:52` 原文 `export function spawn(file, args, options) {`、`:55`–`:56` 原文 `    args.some((a) => String(a).startsWith('--remote-debugging-port')) &&` / `    !args.some((a) => String(a).startsWith('--user-data-dir'))`、`:58` 原文 `    args = [...args, \`--user-data-dir=${USER_DATA}\`]`、`:35` 原文 `export * from 'node:child_process'` | ✅ 完成 |
| I2 | 本机无 `grep`，改用 `git grep -n` + PowerShell `Select-String` 双等效复核 | `from 'node:child_process'` 命中 0（`git grep` 无匹配时 `exit=1` 属正常语义）、`from './isolate-userdata.mjs'` 命中 32；`e2eScriptFileCount=33`。两 fullscreen 脚本保留项核对：`scripts/e2e-fullscreen-avoid.mjs:245` 原文 `    try { require('node:child_process').execSync(\`taskkill /PID ${child.pid} /T /F\`, { stdio: 'ignore' }) } catch { /* noop */ }`、`scripts/e2e-fullscreen-misjudge.mjs:299` 原文 `      const { execSync } = await import('node:child_process')`，均不含 `from`，属正常保留、未误判 | ✅ 完成 |
| I3 | `git grep -n -E "homedir\(\|mkdtempSync\|tmpdir\(\|ELECTRON_USER_DATA"` 三个特殊脚本 + 全量 e2e 扫 `ELECTRON_USER_DATA` | 命中 0。逐行确认 `scripts/e2e-notify-clear.mjs:13` 原文 `import { spawn, execSync, USER_DATA } from './isolate-userdata.mjs'`、`:16` 原文 `import { platform } from 'node:os'`、`:106` 原文 `  if (platform() !== 'win32') {`、`:19` 原文 `const MARK_FILE = join(USER_DATA, 'notif-read.json')`；`scripts/e2e-fullscreen-avoid.mjs:133` 原文 `  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },`、`scripts/e2e-fullscreen-misjudge.mjs:220` 原文 `    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },`。两 fullscreen 注释只写「早期这里设过一个自以为能改路径的环境变量」，未写出变量名，故 0 命中、无漏网赋值 | ✅ 完成 |
| I4 | `npm run typecheck` | `typecheck:node` + `typecheck:web` 两份 tsconfig 均无报错，`typecheckExit=0` | ✅ 完成 |
| I5 | `node scripts/e2e-todo-today.mjs`、`node scripts/e2e-pages-custom.mjs` | 前者 `E2E TODO-TODAY PASS`（A1–A10）、`[收尾] todos.json / schedule.json 已恢复`，`exit=0`；后者 `E2E PAGES-CUSTOM: PASS（6 项通过）`（P1a–P6a，含跨重启持久化），`exit=0`。实跑后 `git status --porcelain` 仍 0 行、dev electron 残留 0、CDP 端口监听 0 | ✅ 完成 |
| I6 | 重跑 `.tmp/compare-snapshots.cjs` / `.tmp/compare-appdata.cjs` + 独立脚本重算 + 读 `.tmp/control-idle-result.json` / `.tmp/control-idle.cjs` / 两个探针结果 + `Get-Process` 核对安装版 + 独立加验 | 详见下方「I6 独立裁定」 | ✅ 完成（裁定通过） |
| I7 | 列 `.tmp/e2e-userdata/lingdong-island\` + 读 `collapse-log.txt` + 对照 `src/main/index.ts:289` + `git check-ignore` | 出现 `collapse-log.txt`(306)、`prefs.json`(2)、`DevToolsActivePort`(59)、`icon-cache/` 及 Chromium 缓存目录；日志含 `2026-11-09T04:08:27.887Z collapse by schedule timer; no active input`；`src/main/index.ts:289` 原文 `    const file = path.join(app.getPath('userData'), 'collapse-log.txt')` 证明主进程写进隔离目录；`.gitignore:15` 原文 `.tmp/`、`git check-ignore -v` 指向该行，不进 git 属正常 | ✅ 完成 |
| I8 | `git diff --name-only main..HEAD` / `--stat` + 抽查 `git diff main..HEAD -- scripts/e2e-m1.mjs` | 范围仅 `README.md`、本 SPEC、`scripts/*.mjs`；`35 files changed, 199 insertions(+), 45 deletions(-)`；`e2e-m1.mjs` 只改 1 行 import（`-import { spawn } from 'node:child_process'` / `+import { spawn } from './isolate-userdata.mjs'`）。**发现记录不一致**：第七节自检 I8 写的 `33 files / 43 insertions` 是收口提交前的中间态，与固定提交实测 `35 / 199` 不符；已在第七节 I8 行内订正并说明，改动范围本身无误，不阻断 | ✅ 完成 |
| I9 | 固定提交上 `git status --porcelain` / `git status` 全文 | `git status --porcelain` 0 行；`git status` = `On branch e2e-userdata-isolation` / `nothing to commit, working tree clean`；全文不含 `.tmp/e2e-userdata`；实跑 2 个 e2e 后 `git rev-parse HEAD` 仍 `eead21a60ac5748c81d2363da20117f7dcbe54a2` | ✅ 完成 |

### I6 独立裁定（验收员）

**裁定：通过——口径调整可接受、证据充分、原目标「e2e 不碰真实用户数据」确实达成。**

- 原始口径证据：`node .tmp/compare-snapshots.cjs` → `beforeCount=114, afterCount=114, added=[], removed=[]`，`changed` 5 个，全是 `DawnGraphiteCache` / `DawnWebGPUCache` / `GPUCache` / `GrShaderCache` / `ShaderCache` 的 `data_1`，size 270336 不变，mtime `1794197012259.6702` → `1794197312365.663`（约 300 秒），`pass=false`。
- 归因链条：读 `.tmp/control-idle-result.json` → `windowMs=320025`、`changedAllGpuCache=true`、`appDataChanged=[]`、`added=[]`、`removed=[]`，5 个变化文件集合与实跑完全一致，mtime `1794197312365.663` → `1794197612489.4321`（同周期），且对照起点恰等于实跑终点 mtime、时间线连续；`.tmp/control-idle.cjs:43` 原文 `    changedAllGpuCache: changed.length > 0 && changed.every((c) => isGpuCache(c.rel) && c.sizeSame),` 逻辑正确；`Get-Process` 核对安装版 `matchCount=4`（PID 708 / 3320 / 16128 / 18504，Path `D:\软件\灵动岛\灵动岛.exe`，StartTime `2026/11/8 17:04:27`），确证噪声来源；`.tmp/probe-decisive-result.json` / `.tmp/probe-final-result.json` 证明隔离机制本身（无后台安装版干扰时）能做到 `114 → 114`、`delta` 全空。
- 收窄口径未放宽硬要求：`node .tmp/compare-appdata.cjs` → `added=[], removed=[], changedCount=5, appDataChanged=[], appDataAdded=[], appDataRemoved=[], pass=true`；`.tmp/compare-appdata.cjs:30` 原文 `out.pass = out.added.length === 0 && out.removed.length === 0 && out.appDataChanged.length === 0 && out.appDataAdded.length === 0 && out.appDataRemoved.length === 0`（`added`/`removed` 整体全空仍保留）；分类口径见 `.tmp/compare-appdata.cjs:9` 原文 `const isAppData = (rel) => /\.(json|txt)$/.test(rel) || rel.startsWith('icon-cache') || rel.startsWith('Local Storage') || rel.startsWith('Network')`。6 个业务文件 mtime 逐一吻合，全部未变。
- 验收员独立加验：自己又实跑 2 个 e2e、时间再过十几分钟后重新递归取真实目录快照与 `snap-before.json` 比对 → `nowCount=114, added=[], removed=[], changedBiz=[]`，6 个业务文件 `unchanged` 全 true、`allBizUnchanged=true`；另用独立脚本重算 `changedCount=5, dMs=300106, changedNonGpu=[]`（5 个变化全部是 GPU 缓存，没有任何其它文件变化）。
- 验收员保留意见（建议、不阻断）：① 第八节补一句「本轮实测 `changed` 全部落在 GPU/Shader 缓存，非 GPU 文件（含其它 Chromium 文件）零变化（`changedNonGpu=[]`）」使口径闭环——本记录已在此纳入；② `isAppData` 白名单未覆盖 `Code Cache` / `Session Storage` / `Shared Dictionary` / `Local State` / `Preferences` / `DIPS` 等其它 Chromium 文件，理论上这些文件若变化不会被 `pass` 捕获，但本轮实测 `changedNonGpu=[]`，该漏洞未触发。
- 流程合规说明 [推断]：口径是「验收字面变更」（从 `changed` 全空 → 应用数据零变化 + 噪声排除），按 `docs/工程规则.md` 3.2 / 3.3 由实现者自检期单方面收窄、再由独立验收明确裁定并记入本节，流程合规；前提正是本节的明确裁定。最可能错在「本机还有第二个未知进程也周期刷这 5 个文件」——但即便如此也与 e2e 无关，不影响结论。

### 存疑点 / 陷阱（验收员如实报，均不阻断，均未自行修）

1. 本机无 `grep`，I2 / I3 改用 `git grep` + `Select-String` 双等效复核，结论不受影响。
2. `export *` 与显式 `spawn` 同名：验收员 `node -e` 动态 import helper 实测 `sameAsNodeSpawn:false`、`spawnSourceHasUserDataDir:true`、`nodeSpawnSourceHasUserDataDir:false`、`hasExecSync/hasExecFileSync/hasSpawnSync` 均 true；复现 `.tmp/smoke-helper-fn.cjs` → `childArgv` 含 `--user-data-dir=...\.tmp\e2e-userdata\lingdong-island`、`pass=true`。ESM 显式本地导出遮蔽同名星号导出，32 个脚本 `import { spawn }` 拿到的是包装版，Lead 结论站得住。
3. 32 个脚本具名 import 符号 helper 全可提供：`.tmp/check-imports-result.json` → `total=33, withHelperImport=32, problems=[], pass=true`；去重后只有 `{spawn}` / `{spawn, execFileSync}` / `{spawn, execSync}` / `{spawn, execSync, USER_DATA}` 四种；第 33 个 `e2e-reorder.mjs` 是纯 CDP 客户端、不接 helper 合理。
4. 9 个脚本仍留 `homedir()` / 硬编码 `'C:' + '' , 'Users', 'honor', 'AppData', 'Roaming'` 兜底，例如 `scripts/e2e-collapsed-todo.mjs:13` 原文 `const USER_DATA = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'lingdong-island')`、`scripts/e2e-notify-icon.mjs:22` 原文 `  process.env.APPDATA || join(platform() === 'win32' ? 'C:' + '' : '', 'Users', 'honor', 'AppData', 'Roaming'),`。`.tmp/check-paths-result.json` → `suspicious=[], noHelperButSpawns=[], pass=true`；验收员独立验证 import helper 后 `process.env.APPDATA` 为非空伪 Roaming，`??` / `||` 均走左侧、`pointsToIsolated:true`，兜底当前不可达。**潜在脆弱点**：安全性依赖「helper 一定先被 import 且 APPDATA 非空」，将来若漏接 helper 会退回真实 `C:\Users\honor\AppData\Roaming`；建议后续 SPEC 记一笔，不阻断本轮。
5. `scripts/e2e-m1.mjs:4` 原文 `import { mkdtempSync, readFileSync, rmSync } from 'node:fs'`、`:5` 原文 `import { tmpdir } from 'node:os'`；读全文确认 `mkdtempSync` 是未使用的历史遗留 import，`tmpdir` 只用于 `scripts/e2e-m1.mjs:105` 原文 `    try { rmSync(join(tmpdir(), 'e2e-m1'), { recursive: true, force: true }) } catch {}` 清理，不读用户数据，不在 I3 范围内。
6. 第七节自检 I8 的 `33 files / 43 insertions` 与固定提交 `35 / 199` 不符，已在第七节 I8 行内订正并说明（见上表 I8）。
7. 未隔离的系统级副作用经核对属实且不在范围：`scripts/e2e-notify-live.mjs:84` 原文 `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.xcjack.lingdong-island').Show($toast)`（发真系统 toast）；`src/main/exportStore.ts:92` 原文 `      defaultDir = app.getPath('documents')`（默认导出目录仍是真实 Documents，脚本本身不直接写 documents，是主进程行为）；`src/main/notifyStore.ts:16` 原文 `const WPN_DIR = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications')`（WPN 系统通知库 `LOCALAPPDATA` 只读）。SPEC 第六节第 56 行声明准确。

### 合并前置与总体结论

- 合并前置：`docs/工程规则.md:42` 原文 `1. 合并回 \`main\` 需要用户明确授权，前置条件是验收记录已写明通过。`；`:25` 原文 `2. **独立验收**：由**未参与本次实现**的会话或人，针对**同一个固定提交**逐条核对 SPEC 的验收条件，结果记录在 SPEC 的「验收记录」一节。`；`:26` 原文 `3. 自检和验收**分别记录**，不得合并成一句「已通过」，也不得用自检结果代替验收结论。`。
- 验收员指出的唯一硬性阻断项「第八节验收记录留空」，已由本节回填解除。
- **总体结论**：固定提交 `eead21a` 的 I1–I9 独立验收**全部通过**，I6 口径调整裁定通过、证据充分、原目标达成；代码与隔离目标本身无阻断问题（`src/` 零改动、无漏改脚本、拿到的是包装版 `spawn`、真实业务数据零变化、工作区干净）。存疑点 7 条均不阻断、无需本轮修。
- **仍未满足的合并条件**：按 `docs/工程规则.md` 5.1，合并回 `main` 还需用户明确授权；本轮用户只授权「做第一件（改测试脚本）」，未授权合并。故本轮停在任务分支，等用户说「合并」再按规则快进合并。

### 收口提交说明（解除阻断 + 交付状态，不改代码）

独立验收员针对的「固定提交」是 `eead21a`（代码 + 自检记录，此时第八节留空）。按验收结论，Lead 在**其后**另做一个纯文档的收口提交，内容包括：

1. 回填本文件第八节「验收记录」（解除验收员指出的唯一硬性阻断项）。
2. 订正第七节 I8 自检数字说明（收口提交前的 `33 files / 43 insertions` 是中间态，固定提交实测 `35 / 199`）。
3. 在第二、五节补记 `docs/状态.md` 属收口交付文档、不进独立验收的 `eead21a` 固定提交。
4. 按 `AGENTS.md`「交付时必须给」第 4 条，在 `docs/状态.md`「一句话状态」补一条本轮记录。

收口提交只改 `docs/Spec/SPEC-e2e-userdata-isolation.md` 与 `docs/状态.md` 两个文档，**不改任何 `scripts/*.mjs`、不碰 `src/`、不重新打包、不装机、不改运行数据**；因此独立验收的 I1–I9 结论对代码仍然成立，`eead21a` 仍是「代码固定提交」。合并时应把这两个提交一起快进到 `main`。
