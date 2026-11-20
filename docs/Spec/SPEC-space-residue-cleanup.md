# SPEC：软件残留清理第一批（死服务 / 死计划任务）

- 创建：2026-11-20
- 分支：`space-merge-junk`
- 前置：`SPEC-space-software-residue`（只读检测）
- 本批范围：**只删「确定」级的服务和计划任务登记**，其余类型（驱动、目录、需确认项）一律不碰

## 1. 目标

在只读清单的基础上，允许用户清理两类风险最低的残留：

1. 服务：`Win32_Service` 登记还在，但 `PathName` 指向的 exe 已经不存在；
2. 计划任务：动作指向的 exe 已经不存在。

删除前把登记导出成备份，删完告诉用户删了什么、备份在哪，并支持「撤销上次清理」。

## 2. 修改范围

- `src/main/softwareResidueCleanup.ts`（新增）：备份、提权脚本生成、执行、撤销。
- `src/main/softwareResidueStore.ts`：保留最近一次扫描结果，供清理校验；注册新 IPC。
- `src/shared/types.ts`：清理与撤销的结果类型。
- `src/preload/index.ts`：`softwareResidueCleanup(ids)`、`softwareResidueUndo()`。
- `src/renderer/src/settings/SpaceSection.tsx` + `settings.css`：勾选、二次确认、结果提示、撤销按钮。
- 文档：`docs/facts/功能清单.md` 第 16 节、`docs/状态.md`。

## 3. 预期行为

### 3.1 哪些能选

- 只有 `kind` 为 `service` / `task` **且** `level` 为 `definite` 的行显示勾选框。
- 驱动、目录、进程、`likely` / `check` 行不可选，即使被伪造 id 传入也会被主进程拒绝。
- 默认全部不勾选。

### 3.2 校验（不信任渲染层）

1. 渲染层只传 id；主进程拿**最近一次扫描**的结果表核对，不在表里的 id 直接忽略。
2. 只接受服务/计划任务的 `definite` 项。
3. 提权脚本执行前再检查一次：目标 exe 若又出现了，就跳过该项并说明原因。

### 3.3 备份

- 位置：`%APPDATA%\lingdong-island\residue-backup\residue-<时间戳>\`。
- 服务：`reg export HKLM\SYSTEM\CurrentControlSet\Services\<名字>` 导出为 `.reg`。
- 计划任务：`schtasks /query /tn <全路径> /xml` 导出为 `.xml`。
- 同目录写 `manifest.json`（类型、名字、任务全路径、备份文件名、删除时间），撤销只读这份清单。
- **备份失败就不删除该项**。

### 3.4 执行

- 一次 UAC：脚本用 `-EncodedCommand` 传入，不落 `.ps1` 中间文件（沿用 `SPEC-space-admin-cleanup` 的做法）。
- 服务用 `sc delete`；计划任务用 `schtasks /delete /f`。
- 结果写入随机文件名的 JSON，读完即删；只接受普通文件。
- 用户取消 UAC：返回「已取消，没有删除任何东西」，不做任何改动。

### 3.5 撤销

- 「撤销上次清理」读取最近一个 `residue-*` 备份目录的 `manifest.json`。
- 服务：`reg import` 导回注册表；计划任务：`schtasks /create /xml` 重新登记。
- 同样需要一次 UAC；撤销结果逐项返回。

### 3.6 界面

1. 可清理的行走勾选框，底部出现「清理选中项（需要管理员）」。
2. 第一次点击只提示：将删哪几项、已备份、可用撤销恢复；按钮变「确认清理」，再点才执行。
3. 勾选变化、重新扫描后，确认状态作废。
4. 执行完显示每项结果与备份目录，并提供「撤销上次清理」。
5. 不可选的行保持只读展示，不加勾选框。

## 4. 必要依赖

无新增依赖。使用系统自带 `reg.exe`、`sc.exe`、`schtasks.exe` 与 PowerShell 的 RunAs。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 隔离实例中，自建的测试服务与测试计划任务（exe 指向不存在的路径）能被扫描为「确定」，勾选后清理成功，扫描结果中消失。
3. 备份目录生成 `.reg` / `.xml` 与 `manifest.json`；撤销后测试服务与任务重新出现。
4. 驱动、目录、`需确认` 项不出现在可选行；伪造 id 传入被拒绝。
5. 取消 UAC 时不做任何改动。

## 6. 不做什么

1. 不删驱动、不删目录、不结束进程。
2. 不处理 `likely` / `check` 项。
3. 不做批量自动清理，必须用户勾选 + 二次确认。
4. 不动系统自带服务、OEM 服务（检测阶段已被白名单排除）。
5. 不在提权脚本里接受任何来自渲染层的路径或文本。

## 7. 自检记录（2026-11-20）

测试靶子（自建，测完全部删除）：服务 `LdResidueTestSvc`、计划任务 `\LdResidueTestTask`，动作程序都指向不存在的 `C:\ProgramData\lingdong-test\gone.exe`；另在数据盘根建空目录 `E:\LdResidueTestEmptyDir`。

- `npm run typecheck`、`npm run build` EXIT=0。[实测]
- 隔离实例（假 `APPDATA`/`LOCALAPPDATA`/`TEMP`，CDP 端口 9338）扫描：三项都判为 `definite`、`cleanable=true`。[实测]
- 清理（一次 UAC，人工点「是」）：三项全部 ok —— 服务「服务登记已删除」、任务「计划任务已删除」、目录「空目录已删除」；清理后重扫三项消失。[实测]
- 备份目录生成 `service-1.reg`、`task-1.xml`、`manifest.json`；任务 XML 用 `Export-ScheduledTask` 导出，避开 `schtasks /query` 的编码问题。[实测]
- 撤销（一次 UAC）：`restored=3`，重扫三项全部回来。[实测]
- 界面（CDP 9339）：52 行里 14 行显示勾选框，底部「共 52 项 · 可清理 14 项」；勾一行后变「已选 1 项」；第一次点「清理选中项（需要管理员）」只出现确认提示、按钮变「确认清理」，没有弹 UAC。[实测]
- 不可清理的行（驱动、非空目录、需确认项）没有勾选框。[实测]

**实现中修掉的两个问题**：

1. 任务项的 `name` 误取了 exe 路径（导致「读不到任务定义」）。改为服务/任务取任务名或服务名，目录取路径。
2. 服务撤销最初用 `reg import`：键能写回，但 SCM 不重新登记，`sc query` 仍报「未安装」。改为先用 `New-Service` 走 SCM 重建（用扫描时记下的启动方式和显示名），失败再退回 `reg import`（提示「重启后生效」）。

**未验证**：真实系统上的 UAC 拒绝分支（测试时都点了「是」）；撤销后服务能否正常启动（靶子的 exe 本来就不存在）；打包版。

**遗留**：测试用的空目录 `E:\LdResidueTestEmptyDir` 被安全策略拦下，没有删除（在盘根，命令被判为高风险），需要用户手动删除。
