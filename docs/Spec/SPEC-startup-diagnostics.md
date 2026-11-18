# SPEC：启动失败可诊断（日志 + 错误弹窗）

- **建立日期**：2026-11-18
- **基线提交**：`90f5cb4`（main，v0.1.5）
- **任务分支**：`startup-diagnostics`
- **关联**：`../facts/功能清单.md` 第 13 条（打包安装）、`../facts/本机约束与踩坑.md`（`ELECTRON_RUN_AS_NODE` 那条）

## 一、目标

用户反馈：同学的机器上装了**第一版（v0.1.0）**，「双击打不开」——安装向导能走完，但启动后什么都看不到，也没有任何提示。当前版本既**不写日志**、也不**弹错误框**，所以：

- 用户侧：双击没反应 = 不知道是该软件坏了、被杀软拦了、还是系统不支持；
- 我们侧：拿不到任何现场数据，只能猜（而猜的成本是来回沟通 + 重装）。

目标：让「启动失败」变成**能看见、能取证**的事——
1. 每次启动往 `userData/startup.log` 追一行（版本 / Electron 版本 / 系统 / 参数 / exe 路径 / 可疑环境变量）；
2. 捕获 `uncaughtException` 与 `unhandledRejection`：写日志 + 用**原生对话框**把原因显示出来（含日志路径）；
3. 日志与数据同目录，设置窗口的「打开数据文件夹」就能直达，方便用户发给开发者。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 新增 `startupLog()` / `describeEnv()`；顶部注册 `uncaughtException`（写日志 + `dialog.showErrorBox` + `app.exit(1)`）与 `unhandledRejection`（只记日志）；`whenReady` 成功时记一行 |
| `docs/facts/功能清单.md` | 第 13 条补「启动诊断日志」说明 |
| `docs/状态.md` | 一句话状态 |

**明确不改**：
- 不改启动流程本身（不重排 store 初始化顺序、不加重试）；
- 不改安装器配置（默认安装目录 `%LOCALAPPDATA%\Programs\lingdong-island`、per-user、不需要管理员）；
- 不引入日志库、不做日志轮转（`startup.log` 只在启动和异常时追加，量级极小）。

## 三、预期行为

1. 正常启动时，`%APPDATA%\lingdong-island\startup.log` 里出现两行：`=== 启动 ...`（含 `version` / `electron` / `packaged` / `argv` / `exe` / `cwd`）与 `whenReady ok, creating window`。
2. 若环境里有 `ELECTRON_RUN_AS_NODE` 或 `ELECTRON_NO_ATTACH_CONSOLE`（已知会让打包版「双击没反应」的两个环境变量），对应行会带 `WARN:` 前缀，便于一眼看出。
3. 主进程抛未捕获异常时：日志里出现 `FATAL uncaughtException: <堆栈>`，并弹出一个原生错误框（标题「灵动岛启动失败」，正文含错误消息与日志路径），进程以退出码 1 结束。
4. 未处理的 Promise 拒绝只记日志（`WARN unhandledRejection`），不打断用户。
5. 写日志失败（只读盘/无权限）不阻断启动。

## 四、必要依赖

无新增依赖。用 Electron 自带的 `dialog` 与 Node 的 `fs`。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| D1 | 正常启动会写 `startup.log`（启动行 + whenReady 行） | 用隔离 userData 起 dev 实例，读文件内容 |
| D2 | 第二个实例（单实例锁命中）也会留一行「启动」 | 同一 userData 连起两次，日志出现 3 行且第二次没有 `whenReady ok` |
| D3 | 未捕获异常会写 FATAL + 弹框 | **不单独构造**（构造需要注入崩溃代码），以源码审查为准；[未验证] |
| D4 | 类型检查/构建 | `npm run typecheck`、`npm run build` EXIT=0 |
| D5 | 既有功能不回归 | `e2e-avoid-mode` / `e2e-fullscreen-avoid` / `e2e-fullscreen-misjudge` 全绿 |

## 六、不做什么

- 不试图在代码里修复「`ELECTRON_RUN_AS_NODE` 被系统级设置」这种情况（进程已按 Node 模式跑起来，主进程逻辑根本不执行，代码无法自救）——只做**检测 + 日志暴露**。
- 不猜「同学机器打不开」的具体原因：本轮只保证下次能拿到证据。已知的高概率原因清单写在报告里（系统版本 / 32 位系统 / 杀软静默拦截 / 以管理员身份安装导致装进别的用户目录）。
- 不改安装器默认路径（per-user 的 `%LOCALAPPDATA%\Programs\lingdong-island` 是 NSIS 的标准行为，本身不是问题）。
- 不在 `main` 上直接提交。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-18 | [实测] `npm run typecheck` / `npm run build` | EXIT=0 | — |
| 2026-11-18 | [实测] 隔离 userData 起 dev 实例后读 `startup.log` | 两行齐全：`=== 启动 version=0.1.5 electron=45.2.1 chrome=156.0.8078.75 packaged=false argv=[...] exe=... cwd=...` 与 `whenReady ok, creating window` | — |
| 2026-11-18 | [实测] 同一 userData 再起一次（单实例锁命中） | 追加第三行「=== 启动 …」且没有 `whenReady ok`（正好是「重复启动被拦」的取证） | — |
| — | 未做 | — | `uncaughtException` 的弹框路径没有实际触发过（需要人为注入崩溃）；Windows 7/8.1、32 位系统、杀软拦截这三种「打不开」的真实原因均未复现 |
