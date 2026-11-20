# SPEC：设置「空间」页（第一阶段：清理灵动岛自己的缓存）

- 日期：2026-11-20
- 分支：`space-cleanup`
- 状态：实现中

## 1. 目标

设置窗口新增独立分区「空间」，把灵动岛自己产生的缓存、日志集中列出并显示占用大小，用户勾选后一次清理。第一阶段只处理本应用自己的文件，给第二阶段（系统垃圾、卸载残留）留出同一页面的位置。

## 2. 修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `SettingsSection` 增加 `space`；新增 `CleanupTargetId` / `CleanupItem` / `CleanupScanResult` / `CleanupRunResult` |
| `src/main/cleanupStore.ts` | 新增：扫描、清理、IPC 注册 |
| `src/main/updater.ts` | 新增导出 `getUpdateStage()`，供清理前判断是否正在下载 / 待安装 |
| `src/main/settingsWindow.ts` | `isValidSection` 接受 `space` |
| `src/main/index.ts` | `app.whenReady` 里调用 `setupCleanupStore()` |
| `src/preload/index.ts` | 新增 `cleanupScan()` / `cleanupRun(ids)` 及相关类型导出 |
| `src/renderer/src/settings/SpaceSection.tsx` | 新增：空间页组件 |
| `src/renderer/src/settings/SettingsApp.tsx` | 左侧导航新增「空间」；渲染该分区 |
| `src/renderer/src/settings/settings.css` | 空间页样式 |
| `docs/facts/功能清单.md` | 新增「设置·空间」条目 |

## 3. 预期行为

清理项（白名单固定，界面不可增删）：

1. **更新安装包缓存**：`%LOCALAPPDATA%\lingdong-island-updater` 整个目录。删了不影响已安装版本，下次更新重新全量下载。
2. **网页缓存**：`userData\Cache` + `userData\Code Cache`。用 Electron `session.clearCache()` / `clearCodeCaches()` 清理，不直接删运行中的文件。
3. **歌词缓存**：`userData\lyrics`。删了下次联网重查；断网时显示「暂无歌词」。
4. **诊断日志**：`userData\startup.log` + `userData\collapse-log.txt`。默认不勾选，说明写明「排错要用」。

交互：

1. 进入「空间」页自动扫描，异步计算，扫描期间显示「正在计算占用…」。
2. 每行显示名称、一句说明（这是什么、删了会怎样）、当前大小；大小为 0 的行置灰不可选。
3. 默认勾选安全项（更新缓存、网页缓存、歌词缓存），诊断日志默认不勾。
4. 底部显示「可清理 合计」与「已选 合计」，按钮「重新计算」「清理选中项」。
5. 清理完成后自动重算，显示「已释放 X」。部分失败或跳过时在同一行说明原因。
6. 清理中禁用全部操作，按钮显示「处理中…」。

保护规则：

1. 更新状态为 `downloading` / `paused` / `ready` 时，**跳过**更新缓存并给出说明，避免删掉正在下载或等待安装的文件。
2. 不提供自定义路径；渲染层传上来的 id 由主进程按白名单过滤。
3. 不触碰 `todos.json` / `schedule.json` / `shelf.json` / `prefs.json`。

## 4. 必要依赖

无新增依赖。使用 Electron 自带 `session`、Node `node:fs/promises`。

## 5. 验收条件

1. 设置左侧导航出现「空间」，点击后在右侧显示分区的标题、说明与四行清理项。
2. 首次进入能看到各项实际大小；网页缓存与更新缓存大小与磁盘实际占用一致（允许扫描期间的正常波动）。
3. 勾选/取消勾选有可见反馈；大小为 0 的行不可勾选。
4. 点「清理选中项」后，选中目录被删除 / 缓存被清空，界面重算后大小下降，并显示「已释放 X」。
5. 清理后 `todos.json`、`schedule.json`、`shelf.json`、`prefs.json` 内容不变。
6. 下载中或等待安装时，更新缓存行被跳过并给出说明，下载不被中断。
7. 自定义 / 未知 id 传给 `cleanup:run` 时被忽略，不会删除白名单以外的任何路径。

## 6. 不做什么

1. 不扫描系统盘，不清理系统临时文件、回收站、注册表。
2. 不删用户数据（待办 / 日程 / 置物架 / 偏好）。
3. 不提供自定义路径、不提供「一键清理 C 盘」。
4. 不做定时自动清理、不做后台常驻扫描。
5. 第一阶段不清理 `icon-cache`（体积仅约 88 KB，删除后通知图标会短暂失效，收益不值风险）。
6. 不改岛的任何界面；本功能只在设置窗口里。

## 7. 自检记录

环境：隔离数据目录 `--user-data-dir=.tmp/space-e2e/userdata`，并把 `LOCALAPPDATA` 指向 `.tmp/space-e2e/localappdata`，CDP 端口 9321；测试前在隔离目录里放了假安装包（3 MB + 1 MB pending）、假歌词（100 KB）、假 `startup.log`（10 KB）和一个 `decoy.txt`。

1. `npm run typecheck` — EXIT=0。
2. `npm run build` — EXIT=0。
3. 导航顺序为「常规 / 页面管理 / 空间 / 桌宠 / 专注·喝水 / 关于」，「空间」可选中并正常渲染。
4. 扫描显示四项：更新包缓存 4.0 MB、网页缓存 144 B、歌词缓存 100.0 KB、诊断日志 10.9 KB；诊断日志默认未勾选，其余默认勾选；合计与「已选」正确。
5. 点「清理选中项」后：更新包缓存与歌词缓存变为 0 并置灰；提示「已释放 3.3 MB。网页缓存会随使用重新生成，刚清完又出现少量是正常的。」（网页缓存清完被运行中的程序重新写入 800.5 KB，属预期）。
6. 勾选诊断日志再清理：`startup.log` 文件被删除，`freedBytes=11119`。
7. 白名单：传入 `['decoy.txt','../../evil']` 返回 `freed=0`，`decoy.txt` 仍在，未删除白名单外任何文件。
8. 隔离目录内没有待办 / 日程 / 置物架 / 偏好文件被创建或改动。

**未验证**：

1. 用户真实数据目录上的实际清理效果（238 MB 更新包、约 38 MB 网页缓存）——没有在真实 profile 上执行删除，避免擅自清掉本机正在用的安装包。
2. 更新处于 `downloading` / `paused` / `ready` 时的跳过分支——开发版 `stage` 恒为 `unsupported`，没有构造出该状态。
3. 打包版（`app.isPackaged=true`）里的表现。

## 8. 验收记录

（待独立验收）
