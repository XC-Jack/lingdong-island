# SPEC：合并「卸载残留」与「软件残留」，备份与撤销统一

- 创建：2026-11-20
- 分支：`space-merge-junk`
- 前置：`SPEC-space-residue`（卸载残留）、`SPEC-space-software-residue`（只读检测）、`SPEC-space-residue-cleanup`（软件残留清理）

## 1. 目标

空间页只留一个「残留」小节，里面两段列表：卸载残留、软件残留。清理产生的东西统一进同一块「清理备份与撤销」：两类备份都按批次列出，都能逐批撤销、都能二次确认后删除。解决两个问题：

1. 软件残留目前只能撤销「最近一次」，备份在界面上看不到也删不掉；
2. 两节各有一套备份区，用户看到两个入口，分不清哪些能恢复。

## 2. 修改范围

- `src/main/softwareResidueCleanup.ts`：备份清单（多批）、按批次撤销、删除备份；`manifest.json` 增加 `restored`；撤销成功但目录保留。
- `src/main/softwareResidueStore.ts`：IPC 改为 `software-residue:undo`（带批次 id），新增 `software-residue:backups`、`software-residue:discard`。
- `src/shared/types.ts`：`ResidueCleanupBackup`、`ResidueDiscardBackupResult`；`ResidueUndoResult` 增加批次号与备份列表。
- `src/preload/index.ts`：对应三个方法。
- `src/renderer/src/settings/SpaceSection.tsx` + `settings.css`：合并小节、共享备份块、撤销后刷新列表。
- 文档：本 SPEC 自检记录、`功能清单.md` 第 16 节、`状态.md`。

## 3. 预期行为

### 3.1 合并后的结构

「系统」卡里依次是：系统垃圾 → 残留（卸载残留列表 / 软件残留列表 / 清理备份与撤销）。不再有独立的「软件残留」卡片。

### 3.2 备份清单

- 只读 `%APPDATA%\lingdong-island\residue-backup\residue-*\manifest.json`；目录名必须匹配 `residue-<时间戳>-<随机>`，防止被伪造路径带偏。
- 每批显示：时间、类型（卸载残留 / 软件残留）、项数、是否已撤销。
- 读不到清单的批次不显示，也不删除。

### 3.3 撤销

- 按批次 id 撤销，不再固定「最近一次」。
- 撤销成功后把 `restored` 写回 `manifest.json`，备份目录保留，供用户确认；按钮置灰。
- 取消 UAC 时什么都不改，`restored` 不写。
- 撤销后触发对应列表重新扫描：卸载残留立即重扫；软件残留重扫一次（约十几秒，属预期）。

### 3.4 删除备份

- 删除批次目录，不可恢复；沿用卸载残留的二次点击确认（第一下变「确认删除」）。
- 只删本项目备份根目录下的 `residue-*` 目录，路径不对直接拒绝。

### 3.5 安全边界不变

- 渲染层只传批次 id；主进程校验格式并在清单里存在才处理。
- 软件残留清理的校验、备份、提权脚本规则完全沿用 `SPEC-space-residue-cleanup`。

## 4. 必要依赖

无新增依赖。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 隔离实例中清理软件残留两次，备份块出现两批；撤销较早一批成功，恢复项对应正确。
3. 取消 UAC 时备份的 `restored` 不变。
4. 删除备份后目录消失，列表少一批。
5. 卸载残留原有行为不变：清理、撤销、删除备份都正常，且与新备份块共享同一区域。
6. 伪造批次 id（不存在的、带路径分隔符的）被拒绝。

## 6. 不做什么

1. 不合并两套扫描逻辑，不统一数据模型。
2. 不改卸载残留的备份位置与恢复方式。
3. 不做自动清理定时任务，不加「全部撤销」。

## 7. 自检记录（2026-11-20）

- `npm run typecheck`、`npm run build` EXIT=0。[实测]
- 隔离实例（CDP 9341，`--user-data-dir` 在 `.tmp/residue-merge/userdata`）自造两批软件残留备份（一批已标记 `restored`）和一批卸载残留备份：[实测]
  - 标题顺序：灵动岛 / 系统 / 系统垃圾 / 残留 / 卸载残留 / 软件残留 / 清理备份。
  - 备份按时间倒序：`卸载残留 · 1 项`、`软件残留 · 3 项（测试服务乙、测试任务丙、测试目录丁）`、`软件残留 · 1 项（测试服务甲） · 已撤销`；已撤销那批的「撤销」按钮置灰。
  - `softwareResidueUndo('../../evil')` → 「备份编号无效。」（未提权）；不存在的批次号 → 「备份清单读不到，无法撤销。」；已撤销批次 → 「这批备份已经撤销过了。」
  - 「删除备份」两下确认后目录消失、列表少一行、提示「备份已删除。」
- 发现并记录：`--user-data-dir` 会覆盖 `app.getPath('userData')`，备份根目录因此落在该目录下；写测试夹具时按这个路径放。[实测]

**未验证**：软件残留的真实撤销（要 UAC，本次没点）；撤销后软件清单自动重扫的实际效果（信号已接，未在真实撤销下跑）；打包版。
