# SPEC：软件残留检测（服务 / 驱动 / 计划任务 / 进程 / 目录）

- 创建：2026-11-20
- 分支：`space-merge-junk`
- 前置：`SPEC-space-residue`、`SPEC-space-system-junk`
- 第一版范围：**只读扫描与展示，不停止、不删除任何东西**

## 1. 目标

把「软件删了、服务/驱动/计划任务还在」这类残留找出来，并给出判断依据：

1. 服务/计划任务/驱动指向的程序文件已经不存在。
2. 有第三方驱动或服务仍在运行，但找不到对应的已安装软件。
3. `Program Files` / `ProgramData` / `AppData` 下没有被任何已安装软件、服务、任务、快捷方式引用的目录候选。

每条都标「确定 / 很可能 / 需确认」，默认不改动任何东西；用户看完清单再决定下一步。

## 2. 修改范围

- 新增 `src/main/softwareResidueStore.ts`：一次 PowerShell 采集 + TypeScript 分类。
- `src/shared/types.ts`：`SoftwareResidueItem`、`SoftwareResidueScanResult` 等。
- `src/preload/index.ts`：`softwareResidueScan()`。
- `src/main/index.ts`：注册 `software-residue:scan`。
- `src/renderer/src/settings/SpaceSection.tsx` + `settings.css`：新增只读卡片「软件残留」。
- 文档：`docs/facts/功能清单.md` 第 16 节、`docs/状态.md`。

不改现有的「卸载残留」判定与清理流程；不做停止进程、删除服务、删除文件。

## 3. 预期行为

### 3.1 采集来源

| 来源 | 用途 |
|---|---|
| HKLM / HKCU 卸载登记（x64 + WOW6432Node） | 已安装软件清单、安装目录、图标目录 |
| `Get-AppxPackage` | 商店应用清单（WindowsApps 不算残留） |
| `Win32_Service` | 全部服务：程序路径、状态、启动方式 |
| `Win32_SystemDriver` | 全部驱动：路径（去掉 `\??\` 前缀）、状态、公司名 |
| `Get-ScheduledTask` | 计划任务动作里的程序路径 |
| `Win32_Process` | 运行中进程、路径、文件属性里的公司与产品名 |
| 桌面 + 用户开始菜单的 `.lnk` | 快捷方式目标（用于判断目录是否被引用） |
| `Win32_LogicalDisk`（`DriveType=3`） | 本地盘符，用于把盘根的残留目录也纳入 |

每段采集各自 `try/catch`，单段失败不影响整次扫描；最后写出的 JSON 即使伴随非 0 退出码也照常使用（2026-11-20 实现修订，实测采集脚本偶发非 0 退出但输出完整）。

### 3.2 分类规则

1. **确定**
   - 服务的程序文件不存在；若同公司软件仍安装在别处（升级留下的旧路径），降为「很可能」；
   - 计划任务的程序文件不存在；
   - 驱动的文件不存在；
   - 目录是真正的空目录（0 个条目）且没有任何引用。
2. **很可能**
   - 服务的程序文件不存在，但同公司/同产品的软件仍安装在别处。
3. **需确认**
   - 运行中但没有软件认领的服务或进程（公司、路径都查不到归属）；
   - 第三方驱动（`System32\drivers` 下、公司不是系统/OEM 厂商、有公司名但找不到同公司软件）：驱动归属只能靠公司名推断，Windows 自带和 OEM 驱动大量查不到公司，因此**一律标「需确认」**，不给「很可能」的结论；
   - 非空的无主目录：安装登记不一定写全路径（不少安装器 `InstallLocation` 为空），不能被当作「确定残留」；
   - 共享驱动（如 `wintun`）——多个软件共用，不能直接判死。

**目录候选的范围（2026-11-20 实现修订）**：

- `Program Files`、`Program Files (x86)`、`ProgramData` 的顶层目录：空目录与非空目录都列（分别「确定 / 需确认」）；
- `AppData\Local`、`AppData\Roaming` 的顶层目录：**只列空目录**——本机实测这两个目录下 205 个顶层目录里有 163 个对不上任何安装登记，全列会埋掉真正的残留；
- 非系统盘的盘根：**只列空目录**（`D:\kingsoft` 这类），避免把用户自己的照片、表格目录当成垃圾列出来。

### 3.3 白名单（硬编码，永不列为候选）

系统目录：`C:\Windows`、`Program Files\WindowsApps`、`Common Files`、`Microsoft*`、`Windows*`、`regid.*`、`ProgramData\Microsoft`、`Package Cache`、`WindowsPowerShell`、`SoftwareDistribution`、`DeliveryOptimization`、`WUDownloadCache`、`Uninstall Information`、`OEM Links`、`ssh`、`Comms`、`VirtualStore`、`PeerDistRepub`、`USOPrivate`/`USOShared`、`$Recycle.Bin`、`System Volume Information`、`MSBuild` 等。
OEM 目录：`Intel`、`HONOR`、`Hihonornote`、`NVIDIA`、`AMD`、`Realtek`、`Nahimic`、`A-Volute`、`Goodix`、`ArcSoft`。
开发/本机目录：用户目录下的 `.vscode`、`.cache`、`AppData\*\Microsoft`，以及本应用自己的安装/开发目录。
上述目录里的文件仍可被「死服务/死驱动」引用判断命中，但目录本身不进「无主目录」候选；硬件/OEM 目录下的服务和进程（如 `Program Files\Intel\SUR`）同样跳过。

### 3.4 界面

1. 空间页新增一张只读卡片「软件残留（仅检测）」。
2. 每条显示：等级徽标、类型、名称、证据、路径、大小（目录才统计）、「运行中」「需要管理员」标记。服务/驱动额外写明启动方式和公司名（2026-11-20 用户反馈「怎么这么多红色」后补充）。
3. 顶部写明「这是线索清单，不是待删清单：徽标只表示证据强弱，不代表删掉安全」；底部「共 N 项 · 仅检测，不会改动系统」。**等级配色不用红色**——红色会被读成「危险/待删」，而「确定」恰恰包含驱动这类不能乱删的项；「确定」改用中性蓝灰（2026-11-20 修订）。
4. **首次不自动扫描**：扫描要读服务、驱动和各个盘符，十几秒起步，进页面自动跑会白耗 CPU；默认显示「还没检测过，点右下角『开始检测』」，点按钮才开始，扫描中按钮显示「扫描中…」。
5. 结果为空时显示「没有发现软件残留」。
6. 提供「复制清单」按钮，把当前结果以纯文本放进剪贴板，便于排查。

## 4. 必要依赖

无新增 npm 依赖。用系统自带 PowerShell 5.1、`Get-AppxPackage`、`Get-ScheduledTask`。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 隔离实例扫描完成且**不修改任何系统状态**（服务、驱动、文件、注册表不变）。
3. 本机能检出 `BAPIDRV`（360.cn 签名、正在运行、无 360 软件登记），归为「需确认」（驱动归属只能靠公司名推断，不给更高等级）。
4. 本机能检出已知的死服务/死计划任务（如 `AndrowsSvr`、`AliUpdater`），并给出路径证据。
5. Intel、HONOR、商店应用、VS Code 扩展、本应用自身进程不出现在候选里。
6. 界面没有删除/停止按钮，只有「重新扫描」「复制清单」。

## 6. 不做什么

1. 不停止服务、不结束进程、不删除驱动、不删文件、不改注册表。
2. 不绕过任何安全软件的自保护；360 这类只报告。
3. 不做全盘逐文件来源追溯；只扫白名单外的高层目录。
4. 不把商店应用、OEM 工具、开发工具、共享驱动列为「确定残留」。
5. 不改现有「卸载残留」一组的行为。
6. 不做自动清理与备份（留给后续 SPEC）。

## 7. 自检记录（2026-11-20）

自检命令与结果：

- `npm run typecheck`（node + web）EXIT=0，无报错。[实测]
- `npm run build` EXIT=0。[实测]
- 隔离实例（`--user-data-dir` + 假 `APPDATA`/`LOCALAPPDATA`/`TEMP`/`TMP`，CDP 端口 9337）：调用 `window.island.softwareResidueScan()` 返回 48 项，耗时 7.4 s；警告为空。[实测]
- 同一隔离实例打开「设置 → 空间」：点击「开始检测」后按钮变「扫描中…」再变「重新扫描」，卡片渲染 48 行；徽标统计「确定 11 / 需确认 37」，类型统计「服务 7 / 计划任务 2 / 目录 30 / 驱动 9」；页面没有停止、删除类按钮。[实测]
- 检出项包括 `BAPIDRV`（360.cn，Running）、`AndrowsSvr`、`DouyinElevationService`、`Edrservice`、`MarvisSvr`、`StreamingService`、`SunloginService`（程序已不存在）、`AliUpdater`、`LaunchDouyinGuard`（计划任务程序已不存在）、`C:\KDubaSoftDownloads`、`C:\ProgramData\kingsoft`、`C:\DiskGenius_WinPE` 等目录。[实测]
- 白名单生效：Intel SUR 的服务与 `esrv.exe` 进程、`SoftwareDistribution`、`ssh`、`Uninstall Information`、`Microsoft Office 15`、`MSBuild`、`Hihonornote`、商店应用目录均未出现；`nodejs` 由安装登记名「Node.js」认领后不再出现。[实测]
- 只读性：整个过程只调用 `Get-*` 类 cmdlet 与文件读操作，未执行停止/删除/写注册表命令；没有停止或删除任何服务、驱动、文件。[实测，依据为本文件与 `softwareResidueStore.ts` 的实现]

未验证：

- 真实用户的 `AppData` 顶层目录（隔离实例里 `APPDATA`/`LOCALAPPDATA` 指向假目录，只验证了「只报空目录」这条分支的逻辑，没有在真实 AppData 上跑）。
- 多盘符机器上的耗时；本机扫描 7.4 s，目录很大的机器可能更慢。
- 未测断电/权限受限目录（`pathSize` 走的是带时间预算的 `sizeWithin`，超时只影响显示的大小）。

## 8. 追加修订（2026-11-20，用户反馈「怎么这么多红色」）

用户看到 11 条「确定」全是红色，担心这些是不是能直接删。事实是：等级只表示证据强弱，不代表删除安全，而「确定」里恰好包含驱动这种不能乱删的项。

改动：

- 「确定」徽标与行底色从红色改为中性蓝灰（`#9db4ff` / `rgba(140,170,255,…)`），不引导「危险/待删」的联想。
- 卡片开头补一句「这是线索清单，不是待删清单：徽标只表示证据强弱，不代表删掉安全（驱动和非空目录尤其不要直接删）」。
- 服务、驱动的证据文字补上启动方式（自动/手动/系统/已禁用）和公司名；计划任务写成完整路径（`\DouyinUser\DouyinGuard\LaunchDouyinGuard`），原来只显示一个 `\`。

自检 [实测]：`npm run typecheck`、`npm run build` EXIT=0；隔离实例重扫 48 项、7.3 s、无警告；`BAPIDRV` 显示「第三方驱动（Running，系统启动），公司：360.cn」，`AliUpdater` 显示「计划任务「\AliUpdater」的动作程序已不存在」。界面配色未单独截图验证。
