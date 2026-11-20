# SPEC：空间页「卸载残留」

- 创建：2026-11-20
- 分支：`space-residue`（从 `main` `28662c2` 拉出）
- 前置：`SPEC-space-cleanup`（第一阶段）、`SPEC-space-system-junk`（第二阶段第一版）

## 1. 目标

补上用户最初提的核心痛点：软件卸载后仍留下注册表项、快捷方式、空的开始菜单文件夹，「系统自带工具和杀软清不干净」。在设置「空间」页新增第三组「卸载残留」，扫出这些痕迹，逐项确认后清理，**清理一律先进备份区、可一键撤销**。

## 2. 修改范围

- 新增 `src/main/residueStore.ts`：扫描、备份、清理、撤销、备份列表。
- `src/shared/types.ts`：`ResidueItem`、`ResidueScanResult`、`ResidueCleanResult`、`ResidueBackup`。
- `src/preload/index.ts`：`residueScan` / `residueClean` / `residueBackups` / `residueUndo` / `residueDiscardBackup`。
- `src/renderer/src/settings/SpaceSection.tsx`：第三组面板（扫描、勾选、清理、备份与撤销）。
- `src/renderer/src/settings/settings.css`：备份区样式（复用现有 `.clean-*`）。
- `src/main/index.ts`：注册 IPC。
- 文档：`docs/facts/功能清单.md` 第 16 节、`docs/状态.md`。

## 3. 预期行为

「空间」页在「灵动岛的缓存」「系统垃圾」下面新增第三组「卸载残留」，与两组互相独立。

### 3.1 扫描（只读，不需要管理员）

1. **失效卸载项**：枚举 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall` 的每个子键，读 `DisplayName`、`UninstallString`、`InstallLocation`。
   - 判为失效：有 `DisplayName`，`UninstallString` 能解析出**绝对路径的 exe**且该文件不存在，并且 `InstallLocation` 为空或同样不存在。
   - `UninstallString` 不是绝对 exe 路径的一律不判（`msiexec /X{GUID}`、`winget uninstall ...` 等：命令本身不带程序位置，本机实测 winget 登记项的包目录已不在、但 ffmpeg 仍装在别处可用，靠它判断会误伤）。
2. **失效快捷方式**：用户桌面 + 用户开始菜单 `Programs`（递归）下的 `.lnk`，用 WScript.Shell 解析目标路径；`TargetPath` 非空且目标不存在 → 死链。`TargetPath` 为空的（MSI 通告式快捷方式、URL 快捷方式）跳过。
3. **空的开始菜单文件夹**：用户开始菜单 `Programs` 下的目录，若递归后**所有** `.lnk` 都是死链、且没有其它文件，则整个目录折叠成一项；它下面的死链不再单列（避免同一软件列十几行）。

每项显示：类别、名称（`DisplayName` / 文件名 / 文件夹名）、判定依据（「卸载程序 `C:\...\unins000.exe` 已不存在」/「目标 `C:\...\x.exe` 已不存在」）、文件与目录显示占用。**全部默认不勾选。**

### 3.2 清理

- 文件/目录：**移入**备份区 `userData/cleanup-backup/<YYYYMMDD-HHmmss>/files/<序号>/<原名>`，并在该批次的 `manifest.json` 记下原路径。
- 注册表项：先 `reg export <键> <批次>/reg/<序号>.reg /y`，**导出成功才** `reg delete <键> /f`；导出失败就跳过并汇报。
- 清理后重扫，提示「已清理 N 项，占用 X。可撤销。」单项失败（被占用、备份失败）只进提示，不让整组失败。

### 3.3 备份与撤销

- 备份区列表（时间倒序）：时间、项数、占用，每批两个操作：「撤销」「删除备份」。
- 撤销：文件移回原路径（原路径已被占用则跳过并汇报），注册表 `reg import` 导回。
- 删除备份：永久删除该批次目录，点击后先弹确认（写明不可恢复）。

### 3.4 范围

全部**当前用户级**（HKCU + 用户目录），不需要管理员权限、不弹 UAC。

## 4. 必要依赖

无新增 npm 依赖。用系统自带的 `reg.exe`（export/delete/import）与 PowerShell 的 `WScript.Shell`（解析 `.lnk`）。PowerShell 调用沿用现有模式：`[Console]::OutputEncoding` 设 UTF-8、`ConvertTo-Json -Compress` 回传。

## 5. 验收条件

1. 扫描出三类结果，且抽查路径/注册表键在清理前确实存在、判定依据属实。
2. 默认全不勾选；不勾选时点「清理选中项」不产生任何删除，也不产生备份批次。
3. 清理后：文件从原位置消失并出现在备份区；注册表键消失且备份里有对应 `.reg`。
4. 撤销后：文件回到原路径、注册表键恢复；备份批次标记为已撤销。
5. 部分失败（文件被占用、`reg export` 失败）时其余项照常完成，提示逐项说明。
6. 「删除备份」有不可恢复的确认，取消则不删。
7. 渲染层只传 id：伪造的 id、跨类别 id、`../evil` 一律无效，不产生删除或备份。
8. 现有两组（灵动岛缓存、系统垃圾）的扫描、勾选、清理、提示行为不变。
9. 空结果时显示明确的空态文案，不残留上一次的列表。

## 6. 不做什么

1. **不碰 HKLM、ProgramData、公共桌面 / 公共开始菜单**——删除需要管理员权限，v1 不做。
2. **不做服务、驱动、虚拟网卡、计划任务**：需要管理员，误删会导致系统异常；本机卸载 Radmin VPN 的真实残留（虚拟网卡、`RvNetMP60` 驱动、`RvControlSvc` 服务）见 `docs/facts/本机约束与踩坑.md`，留作后续单独评估。
3. **不扫描 `HKCU\Software` 下的普通应用键**：与已安装程序做名字匹配容易误伤仍在使用的配置，v1 只在用户明确选择时手工处理（本期不做），避免「一键清痕迹」变成误删。
4. 不调用软件自带的卸载程序（本期只清残留，不负责卸载动作本身）。
5. 不提供「永久删除」选项：清理一律先进备份区，释放空间要用户自己「删除备份」。
6. 不做定时扫描、不做后台扫描、不做注册表全局搜索。

## 7. 已知限制

- 只读 64 位注册表视图；32 位进程写入的 HKCU 卸载项若被 WOW64 重定向到别处，本版扫不到。
- 只覆盖当前用户；同一软件的全局安装（HKLM）和公共快捷方式不在本版范围。
- 判定依据是「文件是否存在」，对便携版软件、绿色版、卸载程序被改名的情况会漏判（漏判只影响召回率，不会误删）。

## 8. 自检记录

环境：隔离实例，`--user-data-dir` 与 `APPDATA`/`LOCALAPPDATA`/`TEMP`/`TMP` 全部指向 `.tmp/residue-e2e` 假目录，CDP 9323。假数据：开始菜单 `DeadApp/`（2 个死链）、`Mixed/Dead.lnk`（死）+ `Mixed/Live.lnk`（活）、`LiveApp.lnk`（活）、`apps/live.exe`（活目标）。桌面是真实桌面（只读参与扫描）。另在真实 HKCU 建两条临时卸载项：`LingDongResidueE2E`（卸载程序指向不存在路径）、`LingDongResidueLiveE2E`（指向存在的 exe），**测完已删除**。

1. `npm run typecheck` — EXIT=0；`npm run build` — EXIT=0。
2. 扫描结果：`残留测试程序`（注册表，「卸载程序 …\Uninstall Test.exe 已不存在」）、`DeadApp`（文件夹，「2 个快捷方式全部失效」）、`Dead.lnk`（快捷方式）；活项 `LiveApp.lnk`、`Mixed/Live.lnk`、`正常测试程序` 均未出现。全部默认未勾选，未选时「清理选中项」禁用。本机 winget 登记项（FFmpeg，命令不是绝对 exe 路径）未被误报。
3. 选 3 项 → 「已选 3 项 · 合计 2.3 KB」；清理后：文件夹与死链从原位消失、`Mixed/Live.lnk` 与 `apps/live.exe` 保留、`LingDongResidueE2E` 键消失，`LingDongResidueLiveE2E` 未动；提示「已清理 3 项，腾出 2.3 KB；可以撤销」。备份批次 `20261120-122920` 内 `manifest.json`、`reg/1.reg`、`files/2/DeadApp`、`files/3/Dead.lnk` 齐全。
4. 撤销：文件夹与快捷方式回到原位、注册表键导回，该批次按钮变灰并标「已撤销」。
5. 删除备份：第一下只把按钮换成「确认删除」、目录仍在；第二下才删除，目录消失。
6. 越界：`residueClean(['nope','../evil','update-cache'])` → `removed=0`、`backupId=null`、不新建批次、不删除任何东西。
7. 一项都没清成时（全部被跳过）不留下空备份批次（代码路径，未单独构造全失败用例）。

**未验证**：

1. 真实软件卸载后留下的注册表项与开始菜单文件夹：本机没有可安全清理的真实残留，测试用的是自建临时项与假快捷方式；桌面上真实死链（`Marvis.lnk`、`欧路词典.lnk`）只被扫描出来，没有清理。
2. 无权限路径（`EPERM`/`EACCES`）按「存在」处理的分支：本机 WindowsApps 对 `fs.stat` 返回的是 `ENOENT`（旧版本目录确实不在），没有触发到权限分支。
3. 打包版表现。

## 9. 验收记录

（待用户验收）
