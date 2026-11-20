# SPEC：PowerShell 输出编码与回收站「假失败」

- 创建：2026-11-20
- 分支：`space-merge-junk`
- 前置：`SPEC-space-system-junk`、`SPEC-space-recycle-folder-size`

## 1. 目标

用户清理回收站后，界面出现一段乱码的错误提示。查明两件事：

1. **编码**：`runPowerShell` 用 `-Command` 拉起 Windows PowerShell 5.1，它把中文按系统代码页（GBK/936）写到 stdout/stderr，而 Node 按 UTF-8 解码，中文全变成 `�`，报错里的行号、命令文本、提示混成乱码。
2. **假失败**：回收站已经为空时，`Clear-RecycleBin -Force` 会抛 `Win32Exception: 系统找不到指定的文件`（`FailedToClearRecycleBin`）。用户看到「回收站没清干净」，但实际上没有东西可清，属于误报。

## 2. 修改范围

- `src/main/runPs.ts`：`runPowerShell` 在脚本前加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，让所有 PowerShell 输出按 UTF-8 编码。
- `src/main/cleanupStore.ts`：`emptyRecycleBin` 先看条目数——为 0 直接视为完成；清空过程中报错时再看一眼，确实空了也算完成；真失败只回一行可读的原因。
- 文档：`docs/状态.md`、`docs/facts/本机约束与踩坑.md`。

不改清理项白名单、不改提权脚本、不改其他清理逻辑。

## 3. 预期行为

1. `runPowerShell` 的 stdout / stderr 中，中文按 UTF-8 正常显示；`residueStore`、`adminCleanupStore` 的同类输出一并受益。
2. 回收站为空时点清理：不报错、不出现「没清干净」。
3. 回收站里确实有文件、清空失败时：提示只保留第一行原因（如「系统找不到指定的文件」），不再整段堆栈。
4. 其他清理项的提示文案不变。

## 4. 必要依赖

无新增依赖。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. Node 直接调用带编码前缀的 PowerShell 抛中文错误，stderr 解码后是完整中文（无 `�`）。
3. 回收站为空时执行新的 `emptyRecycleBin` 脚本：输出 `EMPTY`、退出码 0，不调用 `Clear-RecycleBin`。
4. 隔离实例/界面不需要为此专门点第二次清理。

## 6. 不做什么

- 不把 PowerShell 的完整堆栈展示给用户。
- 不改 `runCommand`（`reg.exe` 等输出本来就是 ASCII 路径为主）。
- 不用外部依赖做 GBK 转码。

## 7. 自检记录

1. `npm run typecheck` 通过；`npm run build` 通过；`out/main/index.js` 里能找到 `OutputEncoding`。
2. 编码对比（Node `spawn` 直接解码 stderr）：`throw "测试中文错误"` 无前缀 → `�������Ĵ���`；加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` → 完整中文（含「所在位置 行:1 字符」「CategoryInfo」等）。
3. 空回收站（先只读确认条目数为 0）：新脚本输出 `EMPTY`、退出码 0、stderr 为空；脚本在条目数为 0 时 `exit 0`，不会执行 `Clear-RecycleBin`。
4. 复现「假失败」时也先确认条目数为 0，执行 `Clear-RecycleBin` 只得到异常、没有删除任何东西；报错为 `Win32Exception: 系统找不到指定的文件`、`FailedToClearRecycleBin`。
5. 预览版已用新构建重启。

**未验证**：回收站里有文件且清空真的失败时的界面文案（需要真实删除，未制造）；打包版。

## 8. 验收记录

（待用户验收）
