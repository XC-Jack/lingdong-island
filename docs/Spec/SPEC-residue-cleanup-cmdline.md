# SPEC：软件残留「处理」全部失败（spawn ENAMETOOLONG）

- 创建：2026-11-20
- 分支：`residue-cleanup-fix`（从 `space-order-fix` 拉出，一起发 0.4.1）
- 前置：`SPEC-space-residue-cleanup`（残留清理与备份/撤销）

## 1. 目标

修用户报的问题：空间页「软件残留」勾了 19 项点「处理」，一项都没处理，日志里每一项都是「没有返回结果」，并出现一行 `spawn ENAMETOOLONG`。

## 2. 根因

残留清理把整段提权脚本 base64 后塞进 `powershell.exe -EncodedCommand` 的命令行参数里。Windows 单条命令行上限 32767 字符，Node 在 `spawn` 阶段就抛 `ENAMETOOLONG`，**PowerShell 根本没启动，UAC 也没弹**，结果文件自然没有，于是每一项都记成「没有返回结果」。

按用户那次实际的备份清单（`residue-backup/residue-20261120-232926-4ca5/manifest.json`，19 项：5 服务 + 2 计划任务 + 12 空目录）复算：

- 脚本 17,541 字符 → UTF-16LE + base64 得到 46,776 字符；
- 外层 `-Command` 参数总长 47,044 字符，**超出上限 14,277**。

4 项的管理员清理（`adminCleanupStore`）编码后约 13,016 字符，远低于上限，所以那个功能一直正常；残留清理项数随用户机器变化，迟早会撞线。

## 3. 修改范围

- `src/main/softwareResidueCleanup.ts`：`runElevated()` 不再把脚本塞进行命令行。
  - 脚本写到 `%APPDATA%\lingdong-island\residue-cleanup\script-<随机>.ps1`；
  - 主进程算 SHA-256，把「路径 + 哈希」编进一段**很短的加载器**，加载器仍走 `-EncodedCommand`；
  - 提权进程读到脚本后自己算哈希比对，一致才 `Invoke-Expression`，不一致直接退出（码 92），读不到退出（码 91）；
  - 跑完删掉脚本文件（成功、失败、取消都删）。
- 同文件：把启动失败的系统错误（`spawn …`）包成中文提示，不再把 `spawn ENAMETOOLONG` 原样丢给用户。
- 同文件：一次都没删成功（或用户取消了 UAC）时，把刚建的备份目录删掉，返回的 `backupDir` 置空。此前失败的运行会在「清理备份」里留下一条只有 `manifest.json`、实际什么都没备份的批次，列 19 项、还能被点「撤销」。
- 文件头部的安全说明跟着改：从「不落中间文件」改成「落文件 + 命令行钉住哈希」。

## 4. 必要依赖

无（`node:crypto` 已引入）。

## 5. 预期行为

- 勾任意多项（含 19 项这种规模）点处理，正常弹一次 UAC，逐项返回真实结果。
- 命令行长与项数无关：只剩加载器（约 1.2 KB）+ 一次 UAC。
- 中间脚本被第三方在同用户下替换 → 哈希不符 → 拒绝执行，报「校验失败，没有执行任何操作」。
- 撤销（`undoResidueCleanup`）走同一个 `runElevated`，一并修好。

## 6. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 用真实的 19 项清单复算：加载器编码后 < 32767 字符（脚本正文长度不再计入命令行）。
3. 不弹 UAC 的前提下验证加载器：内容一致 → 执行并写出产物；改一个字节 → 退出码 92 且不执行；文件不存在 → 退出码 91。
4. 真实提权执行（点「是」那一下）需要用户在自己机器上点一次；本次不代替用户批准 UAC，如实标为未验证。

## 7. 自检记录（2026-11-20）

- `npm run typecheck`、`npm run build` 均 EXIT=0。[实测]
- 用用户那次处理留下的真实清单（19 项）复算旧写法：外层 `-Command` 参数 **47,044 字符**，超上限 14,277。[实测：`.tmp/measure-cmdline.mjs` 按 `buildScript` 逻辑复算]
- Node 用 40,000 字符参数调 `spawnSync` 复现：`errno ENAMETOOLONG`，与用户看到的 `spawn ENAMETOOLONG` 一致。[实测]
- 新加载器（不提权直接跑，脚本正文换成只写一个标记文件的无害脚本，含中文文案）[实测：`.tmp/probe-elevated-loader.mjs`]：
  - 内容一致：`exit 0`，标记文件写出（中文原文完好）；
  - 追加一个空格后再跑：`exit 92`，标记文件没有生成，说明脚本没有执行；
  - 删掉脚本文件：`exit 91`。
- 新写法的外层 `-Command` 参数 **1,674 字符**，只含加载器、脚本路径与 64 位哈希，**与项数无关**。[实测]
- `stderr` 里那段 `#< CLIXML …` 是 PowerShell 的进度记录（加载模块），不影响退出码，属既有现象。[实测]

**未验证**：

- 真实点「处理」→ UAC 弹窗 → 点「是」→ 逐项返回结果这一整条链路。需要在用户机器上点一次授权，本次没有代替用户批准 UAC。[未验证]
- 空备份目录自动清理只在代码层核对（`readdir` 只剩 `manifest.json` 才删），没有在真实失败流程里触发过。[推断]
- 撤销（`undoResidueCleanup`）走同一个 `runElevated`，机制相同，但同样没有真实提权跑过。[推断]

## 8. 不做什么

- 不改 `adminCleanupStore`（固定 4 项，13,016 字符，离上限远）。
- 不改扫描规则、可清理项判定、备份与撤销逻辑。
- 不改 UI 布局与文案排版，只换失败提示的措辞。
