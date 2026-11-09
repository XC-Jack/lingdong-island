# SPEC：e2e 脚本数据隔离（不碰真实用户数据）

> 任务分支：`e2e-userdata-isolation`，基线 `main`（`6408646`）。
> 触发原因：2026-11-09 用户授权「做第一件」——给测试脚本单独指定一个放数据的地方，免得它碰真实用户数据。
> 背景：`docs/状态.md`「尚未验证的范围」之外，e2e 脚本默认读写 `%APPDATA%\lingdong-island\` 的真实数据；其中 `e2e-fullscreen-avoid.mjs` / `e2e-fullscreen-misjudge.mjs` 用 `ELECTRON_USER_DATA` 自以为隔离，实测该环境变量无效。

## 一、目标

让 33 个 e2e 脚本启动的 dev electron 全部读写 `.tmp/e2e-userdata/lingdong-island\`（隔离目录），不再读写真实 `%APPDATA%\lingdong-island\`；`src/` 零改动。

## 二、修改范围

只改 `scripts/` 下的 `.mjs`、新增 1 个 helper、同步 `README.md` 计数、新增本 SPEC。

| 文件 | 改什么 |
|---|---|
| `scripts/isolate-userdata.mjs` | 新增 helper：顶层建隔离目录并把 `process.env.APPDATA` 指向伪 Roaming，导出 `USER_DATA` 与包装后的 `spawn`（给带 `--remote-debugging-port` 的 electron 启动追加 `--user-data-dir`），`export *` 透传 `execSync`/`execFileSync` 等 |
| 32 个 `scripts/e2e-*.mjs`（含 `e2e-reorder-run.mjs`，不含 `e2e-reorder.mjs`） | 仅改 1 行：`from 'node:child_process'` → `from './isolate-userdata.mjs'`；spawn 调用行一律不动 |
| `scripts/e2e-notify-clear.mjs` | 删 `homedir` 硬编码路径，改 import `{ spawn, execSync, USER_DATA }` from helper（`platform` 仍在用，保留） |
| `scripts/e2e-fullscreen-avoid.mjs`、`scripts/e2e-fullscreen-misjudge.mjs` | 删 `mkdtempSync`/`tmpdir` 与自以为隔离的无效环境变量；数据隔离靠 helper 的 `spawn` 包装自动加 `--user-data-dir`，这两个脚本不额外 import `USER_DATA`；保留删 `ELECTRON_RUN_AS_NODE` |
| `README.md` | 第 34 行脚本计数 33+2=35 → 33+3=36（新增 1 个辅助 helper） |
| `docs/Spec/SPEC-e2e-userdata-isolation.md` | 新增本文件 |

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
| I8 | `git diff --name-only main..HEAD` 只列 `scripts/*.mjs`、`scripts/isolate-userdata.mjs`、`README.md`、`docs/Spec/SPEC-e2e-userdata-isolation.md`；无 `src/`、无 `package.json`、无 `out/` |
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
| I8 | `git diff --stat` + 抽查 `scripts/e2e-m1.mjs` + 行尾核对 | `33 files changed, 43 insertions(+), 45 deletions(-)`；除 3 个特殊脚本外每个 `2 +-`（仅 1 行 import）；`e2e-m1.mjs` diff 只有 `import { spawn } from 'node:child_process'` → `from './isolate-userdata.mjs'`；备份与当前文件 `CRLF=0 LF-only=109`，行尾未破坏；无 `src/`、`package.json`、`out/` | ✅ 通过 |
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

留空，待独立会话针对本轮固定提交逐条重跑 I1–I9 后填写（按 `docs/工程规则.md` 3.2「自检与独立验收分离、同一固定提交」）。
