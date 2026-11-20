# SPEC：空间页「系统清理（需要管理员）」

- 创建：2026-11-20
- 分支：`space-admin-cleanup`（从 `main` `e6e6a84` 拉出）
- 前置：`SPEC-space-cleanup`、`SPEC-space-system-junk`、`SPEC-space-residue`

## 1. 目标

补上「不需要管理员」版本清不到的那部分系统垃圾：Windows 更新缓存、系统临时目录、系统错误报告、传递优化缓存。这一组必须提权，所以单独成组、单独提示，**点清理才弹一次 UAC**，浏览和扫描不弹。

## 2. 修改范围

- 新增 `src/main/adminCleanupStore.ts`：扫描、生成提权脚本、调用 UAC、读回结果。
- 新增 `src/main/fsUtil.ts`：把 `cleanupStore` 里的 `pathSize` / `sumPaths` / `removeChildren` / `existsConservative` 抽出来共用（`residueStore` 的 `existsConservative` 改为复用）。
- `src/shared/types.ts`：`AdminCleanupId`、`AdminCleanupItem`、`AdminCleanupScanResult`、`AdminCleanupRunResult`。
- `src/preload/index.ts`：`adminCleanupScan` / `adminCleanupRun`。
- `SpaceSection.tsx`：第四组面板（带 UAC 说明）。
- `settings.css`：需要时补少量样式。
- `src/main/index.ts`：注册 IPC。
- 文档：`docs/facts/功能清单.md` 第 16 节、`docs/状态.md`。

## 3. 预期行为

### 3.1 扫描（不提权）

| 项目 | 位置 | 扫描大小 |
|---|---|---|
| Windows 更新缓存 | `%WINDIR%\SoftwareDistribution\Download` 下的内容 | 普通权限能读；读不到记 0 |
| 系统临时文件 | `%WINDIR%\Temp` 下的内容 | 能读；被占用的文件清理时跳过 |
| 系统错误报告 | `%ProgramData%\Microsoft\Windows\WER` 的 `ReportArchive` / `ReportQueue` / `Temp` | 普通权限读不到 → 显示「需要管理员」 |
| 传递优化缓存 | 由系统 `Delete-DeliveryOptimizationCache` 管理 | 看不到目录结构 → 显示「需要管理员」 |

- 全部**默认勾选**（这一组没有「删了会丢东西」的项；被占用的文件会自动跳过）。
- 读不到大小的项显示「需要管理员」，不显示 0，避免让人以为没东西可清。

### 3.2 清理（提权一次）

- 点「清理选中项」→ 主进程按白名单生成一份固定的 PowerShell 脚本 → 用 `Start-Process -Verb RunAs -Wait -PassThru` 提权执行 → 等它结束 → 读回结果 JSON。
- 脚本内容只由主进程按 id 拼接，**不含任何来自渲染层的路径或文本**。
- 每项前后各统计一次大小，`freed = max(0, before - after)`；清理后还剩的部分（被占用）写进提示。
- **Windows 更新缓存**：先停 `wuauserv`，删完**无论成败都重新启动**（`finally`），期间 Windows 更新暂停几秒；`bits` 同样处理。
- **传递优化缓存**：执行 `Delete-DeliveryOptimizationCache -Force`，大小无法统计，只报「已清理」。
- 用户拒绝 UAC：整次操作取消，提示「已取消管理员授权，没有删除任何东西」，不留下脚本或结果文件。
- 清理完重新扫描一次并刷新列表。

### 3.3 安全约束

- 路径与命令全部写死在主进程白名单，渲染层只传 id。
- 提权脚本写在 `userData/admin-cleanup/`，执行完连同结果文件一起删除。
- 不删除目录本身，只删目录里的内容；被占用的文件跳过并计数。

## 4. 必要依赖

无新增 npm 依赖。用系统自带 PowerShell 与 `Delete-DeliveryOptimizationCache`（Windows 10+ 自带）；UAC 由 `Start-Process -Verb RunAs` 触发。

## 5. 验收条件

1. 空间页出现第四组「系统清理（需要管理员）」，四项都显示大小或「需要管理员」，默认全勾选。
2. 不点清理时**不弹** UAC；浏览、扫描都正常。
3. 点清理弹一次 UAC；拒绝后界面提示已取消，任何东西都没删。
4. 同意后：Windows 更新缓存与系统临时目录变小，`wuauserv` 服务在结束后恢复原来的启动状态；系统错误报告被清掉；传递优化缓存执行成功。
5. 被占用的文件不导致整组失败，提示里说明还剩多少。
6. 渲染层传伪造 id / 路径一律无效，不生成任何脚本内容、不删任何东西。
7. 前三组（灵动岛缓存、系统垃圾、卸载残留）行为不变。

## 6. 不做什么

1. **不做 `Windows.old`**：正确删法要走系统自己的「存储感知 / 清理建议」，自己删要改所有权，出错代价高；交付文案里指路。
2. 不做需要重启的组件清理（`DISM /StartComponentCleanup`、WinSxS），原因同上是系统维护动作。
3. 不删除系统还原点、不关系统保护、不碰 `C:\Windows\Installer`（删了会影响卸载与修复）。
4. 不结束进程、不强制解锁文件；只跳过被占用的。
5. 不做服务/驱动残留清理（那是卸载残留的方向，另开 SPEC 评估）。
6. 不常驻管理员权限：应用本身仍以普通用户运行，只在这一次操作提权。

## 7. 已知限制

- UAC 每次清理弹一次，无法在普通用户权限下静默提权（这是 Windows 的设计）。
- 传递优化缓存的大小无法在不提权时查看，提权脚本也不统计（由系统接口直接清理）。
- 若清理时正好有 Windows 更新在下载，停服务会打断这次下载，更新会重新开始。

## 8. 自检记录

（实现后补充）

## 9. 验收记录

（待用户验收）
