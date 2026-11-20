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
| 系统错误报告 | `%ProgramData%\Microsoft\Windows\WER` 的 `ReportArchive` / `ReportQueue` / `Temp` | 普通权限读不到 → 显示「无法统计」 |
| 传递优化缓存 | 由系统 `Delete-DeliveryOptimizationCache` 管理 | 看不到目录结构 → 显示「无法统计」（清理时改由系统接口统计释放量，见 3.2） |

- 全部**默认勾选**（这一组没有「删了会丢东西」的项；被占用的文件会自动跳过）。
- 读不到大小的项显示「无法统计」，不显示 0，避免让人以为没东西可清。

### 3.2 清理（提权一次）

- 点「清理选中项」→ 主进程按白名单生成一份固定的 PowerShell 脚本 → 以 UTF-16LE + Base64 放进 `-EncodedCommand`，用 `Start-Process -Verb RunAs -Wait -PassThru` 提权执行 → 等它结束 → 读回结果 JSON。
- 脚本内容只由主进程按 id 拼接，**不含任何来自渲染层的路径或文本**；**不落成 `.ps1` 文件**（原因见 3.3）。
- 每项前后各统计一次大小，`freed = max(0, before - after)`；清理后还剩的部分（被占用）写进提示。
- **Windows 更新缓存**：先停 `wuauserv`，删完**无论成败都重新启动**（`finally`），期间 Windows 更新暂停几秒；`bits` 同样处理。
- **传递优化缓存**：执行 `Delete-DeliveryOptimizationCache -Force`。缓存放在 `C:\Windows\ServiceProfiles\NetworkService\...\DeliveryOptimization`（普通权限列不出来），所以**不按目录统计**，改用系统接口 `Get-DeliveryOptimizationPerfSnap` 的 `CacheSizeBytes` 在清理前后各读一次，`before/after` 照常回传；接口读失败时两项都记 -1，界面按「没统计到」处理，不影响清理本身。
- 结果 JSON 里每项带 `before/after`，主进程据此算出**逐项释放量**（`AdminCleanupRunItem`），界面只对「没统计到」的那几项补一句说明。
- 用户拒绝 UAC：整次操作取消，提示「已取消管理员授权，没有删除任何东西」，不留下脚本或结果文件。
- 清理完重新扫描一次并刷新列表。

### 3.3 安全约束

- 路径与命令全部写死在主进程白名单，渲染层只传 id。
- **提权脚本不落盘**：早先写法是把 `.ps1` 写进 `userData/admin-cleanup/` 再让管理员执行，UAC 等待期间同用户进程可以替换该文件，导致「用户同意的内容」与「实际执行的内容」可能不一致（TOCTOU）。现在用 `-EncodedCommand` 把脚本固定在命令行里；四个管理员项全选时编码后 13,016 字符，低于 Windows 命令行 32,767 字符上限。
- 唯一落盘产物是结果 JSON：文件名随机（`result-<16 位十六进制>.json`），读取前确认是普通文件而非符号链接，读完即删。
- 不删除目录本身，只删目录里的内容；被占用的文件跳过并计数。

## 4. 必要依赖

无新增 npm 依赖。用系统自带 PowerShell 与 `Delete-DeliveryOptimizationCache`（Windows 10+ 自带）；UAC 由 `Start-Process -Verb RunAs` 触发。

## 5. 验收条件

1. 空间页出现第四组「系统清理（需要管理员）」，四项都显示大小或「无法统计」，默认全勾选。
2. 不点清理时**不弹** UAC；浏览、扫描都正常。
3. 点清理弹一次 UAC；拒绝后界面提示已取消，任何东西都没删。
4. 同意后：Windows 更新缓存与系统临时目录变小，`wuauserv` 服务在结束后恢复原来的启动状态；系统错误报告被清掉；传递优化缓存执行成功，并报出释放量（系统接口读得到大小时）。
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
- 传递优化缓存的目录普通权限列不出来，所以**扫描阶段仍显示「无法统计」**；清理阶段改用系统接口 `Get-DeliveryOptimizationPerfSnap` 前后各读一次（本机实测单次约 0.7 秒），接口失败就退回「没统计到」。
- 用 `CacheSizeBytes` 统计的前提是系统的传递优化服务（`DoSvc`）可用；服务停掉时读不到大小，但清理本身不受影响。
- 若清理时正好有 Windows 更新在下载，停服务会打断这次下载，更新会重新开始。

## 8. 自检记录

环境：隔离实例（`--user-data-dir` 指向 `.tmp/admin-e2e`），`WINDIR` / `ProgramData` 用本机真实路径但**只读扫描**，CDP 9324。

1. `npm run typecheck` — EXIT=0；`npm run build` — EXIT=0。
2. 空间页出现 4 组，第四组「系统清理（需要管理员）」四项：Windows 更新缓存 26.9 KB、系统临时文件 1.10 GB、系统错误报告与传递优化缓存显示「无法统计」（当时文案是「需管理员」，第 7 条改了）；四项默认勾选。扫描期间没有生成 `admin-cleanup` 目录，也没有出现 `consent.exe`（UAC）——浏览与扫描不提权。
3. 判定「无法统计」用的是递归可读性：`%ProgramData%\Microsoft\Windows\WER` 顶层能列、子目录读不到，因此按「大小不完整」显示为无法统计，而不是给出偏小的数字。
4. 提权脚本生成（`adminScript.ts` 单独用 `tsc` 编译后调用）：四项全选生成的脚本交给 PowerShell `Parser::ParseFile` → `PARSE_OK`（含停/启 `wuauserv`、`bits` 的块与 `Delete-DeliveryOptimizationCache` 块）。
5. 脚本语义：把 `WINDIR` / `ProgramData` 指向 `.tmp/admin-script-e2e` 假目录，非提权执行 `win-temp` + `wer-system` 块——结果 JSON 为数组，`before/after` 分别是 6144/0、1024/0；临时文件与 WER 报告被删、目录本身保留、`outside.txt` 未动；只选一项时结果仍是数组。
6. 伪造 id：`adminCleanupRun(['nope','../evil','win-temp;rm -rf /'])` → `ok=false`、`warnings=['没有选中任何项目。']`，不写脚本、不提权。

7. 文案修正后的复查（2026-11-20，用户点过一次提权清理之后）：
   - 用户在开发版里点过一次「清理选中项」并通过了 UAC；之后复测 `C:\Windows\Temp` 为 353.5 KB（扫描前显示 1.10 GB），`SoftwareDistribution\Download` 为 0——**提权删除确实生效**。
   - 隔离实例刷新第四组：Windows 更新缓存「无」、系统临时文件 353.5 KB、系统错误报告「无」、传递优化缓存「无法统计」，合计「已选 4 项 · 可计算占用 353.5 KB」。
   - `sc.exe qc`：`wuauserv` AUTO_START、`bits` DEMAND_START，当前都是 Stopped——与 Windows 11 空闲时的正常状态一致（`wuauserv` 为触发启动类服务）。
   - 用户原话「怎么点了，还需要管理员」的成因是文案，不是功能：「需管理员」本意是「大小要管理员才读得到」，却被读成「这个操作还需要管理员」。改为「无法统计」；传递优化缓存的说明改成「由系统自己的接口清理，清理前后都不统计大小」；清理完成的提示会追加「传递优化缓存交给系统接口清理，不统计大小。」，避免「没有释放量」被理解成没清。

8. 传递优化缓存的释放量统计（2026-11-20，用户要求补上）：
   - 本机实测 `Get-DeliveryOptimizationPerfSnap` 的返回字段里有 `CacheSizeBytes`，单次约 742 ms，当前值为 0（缓存已空），普通权限即可读取。
   - 生成的脚本解析：四项全选 `Parser::ParseFile` → 0 个语法错误；只选传递优化缓存同样 0 个。
   - 语义（用同名桩函数替换 `Get-DeliveryOptimizationPerfSnap` / `Delete-DeliveryOptimizationCache`，**没有碰真实缓存**）：正常路径两次读数分别 5242880 → 0，结果 JSON `before/after` 正确、warnings 为空；接口抛错路径 `before/after` 都是 -1，warnings 里有「清除失败：delete failed」，说明「没统计到」不会被算成 0 释放。
   - 隔离实例刷新：传递优化缓存仍显示「无法统计」，说明文案改成「清理前不显示大小，清完会报释放了多少」。
9. `npm run typecheck` / `npm run build` 在本次改动后重跑，均通过。

10. 提权脚本改为 `-EncodedCommand`（2026-11-20）：
   - 长度：四项全选、结果路径 76 字符时，脚本 4,881 字符，Base64 后 **13,016 字符**；路径加长到约 100 字符时为 13,472 字符，均在 32,767 上限内。
   - 直接执行编码内容（不提升权限，`WINDIR` / `ProgramData` 指向 `.tmp/enc-test-*` 假目录，只选 `win-temp` + `wer-system`）：退出码 0；`win-temp` 的 `before/after = 12288/0`，与假目录里 4,096 + 8,192 字节一致；两个假 WER 目录内容清空、目录本身保留；结果 JSON 为数组。
   - 与生产同形的 `Start-Process` 参数（去掉 `-Verb RunAs`，payload 只写一个标记文件）：退出码 0，标记文件生成，说明 `-ArgumentList` 的数组传参与 Base64 内容没有被引号破坏。
   - 整个测试目录里没有出现任何 `.ps1` 文件；构建产物 `out/main/index.js` 里已无 `clean-*.ps1` 写入逻辑。
   - 同用户进程替换文件的窗口：编码内容在 `Start-Process` 发起时已固定在命令行中，执行阶段不存在可替换的文件。

**未验证**：

1. **提权清理的细节回执**：删除确实发生了（见第 7 条），但脚本回传的 `before/after` JSON、各项 warning 文案、服务停止/恢复的中间状态没有在真实提权那一次里被逐项读取确认。
2. **拒绝 UAC 的取消分支**：代码按 stderr 里的「取消 / 1223」判断，但没有制造过真实的拒绝操作。
3. **新增的清理后提示**：「已释放 X」与「…这次没统计到大小」只在代码里拼好并通过类型检查与构建，没有再触发一次提权清理看实际显示（避免重复弹 UAC）。
4. **真实缓存非空时的释放量**：本机缓存已被清空（`CacheSizeBytes = 0`），没有在非空状态下验证读数与删除后的差值。
5. 打包版。

## 9. 验收记录

（待用户验收）
