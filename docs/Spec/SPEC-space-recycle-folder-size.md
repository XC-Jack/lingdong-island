# SPEC：回收站文件夹大小与空条目可选

- 创建：2026-11-20
- 分支：`space-merge-junk`
- 前置：`SPEC-space-system-junk`、`SPEC-space-confirm-unchecked`

## 1. 目标

修两个问题：

1. 回收站里的**文件夹**用 Shell 的 `Size` 属性读出来恒为 0，里面有文件也显示「无」，用户以为没东西可清。
2. 回收站里只有空文件夹时（0 字节但条目真实存在），该行不可选，二次确认流程无法使用。用户 2026-11-20 决定：**回收站只要有条目就允许勾选**，0 字节也显示 0 B。

## 2. 修改范围

- `src/main/cleanupStore.ts`：`recycleBinSize` 改为 `recycleBinStats`，返回 `{ bytes, exists }`；文件夹用显式栈递归累加文件大小（跳过 reparse point）。
- `src/shared/types.ts`：新增 `CleanupItemScan`（`bytes` + `exists`）。
- `src/main/cleanupStore.ts`：`Target.scan` 统一返回 `CleanupItemScan`；`scanCleanup` / `scanCleanupItem` 使用它。
- `src/preload/index.ts`：`cleanupScanItem` 返回 `CleanupItemScan`。
- `src/renderer/src/settings/SpaceSection.tsx`：行状态增加 `exists`；`exists` 为真时 0 字节项可选、显示「0 B」；清理后刷新与自动取消勾选同步考虑 `exists`。
- 文档：`docs/状态.md`、`docs/facts/功能清单.md` 第 16 节。

不改清理实现（`Clear-RecycleBin` 不变），不改 IPC 名称，不改其他清理项的判定。

## 3. 预期行为

1. 回收站扫描：
   - 普通文件项：沿用 Shell 的 `Size`。
   - 文件夹项：递归累加其中文件的大小；遇到 reparse point（junction / 符号链接）不进入。
   - `exists` = 回收站条目数 > 0（用同一次 PowerShell 调用的条目数判断）。
2. 界面：
   - `exists` 为真但 `bytes === 0`：该行**可勾选**，大小显示「0 B」；合计也显示「0 B」而不是「无」。
   - `exists` 为假且 `bytes === 0`：行为不变，显示「无」、不可选。
   - 其他清理项不受影响：0 字节仍不可选。
3. 确认流程：回收站仍属于「默认不勾」，第一次点「清理选中项」只提示，第二次才执行。
4. 扫描失败（PowerShell 报错 / 超时）维持现状：按 0 处理，不弹错误。
   - 超时从默认 25 秒放宽到 60 秒，回收站条目多时递归统计更慢。

## 4. 必要依赖

无新增依赖。仍用系统自带 PowerShell 与 Shell COM。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 离线脚本（同一段递归逻辑）对「含 5 KB 文件的文件夹」统计出 5120；对空文件夹为 0。
3. 隔离实例里，回收站只有空文件夹时：该行可勾选、显示「0 B」；第一次点「清理选中项」只出现确认提示，回收站条目仍在；不点第二次。
4. 其他 0 字节项（如假 TEMP 里的空项）仍显示「无」且不可选。
5. 真实回收站在测试中不被清空。

## 6. 不做什么

- 不统计其他用户或其他盘的回收站命名空间（`Namespace(10)` 只含当前用户）。
- 不跟随 junction / 符号链接（避免循环与越界统计）。
- 不改回收站的清理方式，不加新的清理项。
- 不改「默认不勾选」这一状态。

## 7. 自检记录

环境：隔离实例（`--user-data-dir` 指向 `.tmp/confirm/userdata`，`APPDATA` / `LOCALAPPDATA` / `TEMP` / `TMP` 指向 `.tmp/confirm/` 下的假目录），CDP 9335。**真实回收站只在测试前被用户放入一个空文件夹，测试全程未清空。**

1. `npm run typecheck` 通过；`npm run build` 通过；构建产物 `out/main/index.js` 里能找到 `ReparsePoint` 与 `items.Count`，确认新脚本已打进包。
2. 递归统计离线验证（`.tmp/recycle-size-test` 假目录）：`root/a.bin` 5,120 + `root/sub/b.bin` 3,072，另放两个 junction（一个指回自身、一个指向外部 10,240 字节目录）→ 结果为 **8,192**，没有循环、没有跟进外部目录。
3. 真实回收站（1 个空文件夹）用同一段脚本读：输出 `1;0`——`exists=true`、`bytes=0`。
4. 隔离实例界面（`.tmp/probe-recycle-bin.mjs`）：
   - 初始：回收站行 `disabled=false`、大小「0 B」；其余 0 字节项（临时文件、崩溃转储、缩略图、两个管理员项）仍是「无」且不可选。
   - 勾选回收站 → 行变 on；第一次点「清理选中项」→ 按钮「确认清理」、提示「已选「回收站」，默认不勾选，删除后不能恢复……」；**没有执行删除**。
   - 取消勾选 → 提示清空、按钮回到「清理选中项」。
   - 测试后真实回收站条目数仍为 1，未被清空；没有点第二次。
5. 预览版已用新构建重启（`npm start` 重新构建后启动，主窗口标题「灵动岛」，日志无报错）。

**未验证**：

1. 带内容的文件夹在**真实回收站**里的端到端显示：不允许为测试往真实回收站放文件，递归逻辑只在假目录上验证过。
2. 打包版。

## 8. 验收记录

（待用户验收）
