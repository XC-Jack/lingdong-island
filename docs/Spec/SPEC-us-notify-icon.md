# SPEC：通知应用图标 + 新消息到岛提示横幅

- 日期：2026-11-06
- 分支：us-notify-icon（基于 main `6ca9c2a`）
- 来源：用户口头需求（对话 2026-11-06 19:23）：「信息前带应用图标（参考手机锁屏：每条通知左边带应用图标小方块）」+「消息来时岛有反应吗，参考苹果设计（到岛提示横幅）」

## 1. 目标

1. **通知页每条通知左侧显示来源应用图标**（小方块，参考手机锁屏样式）。
2. **新消息到达时收起态弹提示横幅**（参考苹果灵动岛）：岛顶弹出一小条「应用图标 + 应用名 + 标题」的横幅，几秒后自动收回；展开态不弹（用户正在看通知页）。

## 2. 修改范围

| 文件 | 改动 |
|---|---|
| `src/main/notifyStore.ts` | ① 新增图标解析 `appIcon(appShortName)`：按 AUMID 短名解析应用图标 PNG 绝对路径（UWP 走包目录 PNG；Win32 走 App Paths 注册表/开始菜单 lnk 定位 exe 再 SHGetFileInfo 提图标；自家用项目图标；失败返回 null）；② 结果缓存到 `userData/icon-cache/notify-<短名>.png` + 内存 Set 记失败短名（避免反复重试）；③ NotifyItem 加 `icon: string \| null` 字段（返回列表时逐条填充）；④ 新增横幅事件：轮询 refresh() 发现「order>lastOrder 且 order>hiddenUntil 的新通知」时 `mainWindow.webContents.send('island:notify-arrived', item)` |
| `src/preload/index.ts` | NotifyItem 加 icon 字段；新增 `onNotifyArrived(cb)` 事件监听 |
| `src/renderer/src/App.tsx` | ① NotifyPanel 每条 notify-item 左侧加图标 `<img>`（icon 为 null 时退回现 notify-app 文字徽标）；② App 根组件注册 onNotifyArrived：收起态时显示横幅（图标+应用名+标题），5 秒后收回；展开态忽略 |
| `src/renderer/src/styles.css` | `.notify-icon`（列表条目图标）、`.collapsed-banner`（横幅容器与进出场动画） |
| `scripts/e2e-notify-icon.mjs`（新增） | 图标解析/横幅事件的自动化验证 |
| `docs/facts/功能清单.md` | 新增小节说明两个能力 |

## 3. 预期行为

1. **图标解析链**（主进程，按 AUMID 短名，全部带缓存）：
   - `lingdong-island` → 项目自带图标（build/icon.ico 同目录的 PNG；无则 null）。
   - UWP（`Get-AppxPackage` 方式太重，改用直接扫描 `C:\Program Files\WindowsApps\<pkg前缀*>` 找 AppxManifest.xml → VisualElements.Square44x44Logo → 优先 `targetsize-48.png`，其次任意变体）→ 读 PNG 文件缓存。
   - Win32：App Paths 注册表查 `<短名>.exe` → 开始菜单 `.lnk` 扫描兜底 → SHGetFileInfo 提 32px 图标 → PNG 缓存。
   - 都失败 → `icon: null`（渲染层退回文字徽标），记入失败 Set 不再重试。
   - 已验证：WindowsApps 图标文件普通用户态可读；SHGetFileInfo 按 exe 提 32px 图标本机 4 个样本（Chrome/Edge/QQ/灵动岛）全成功。
2. **通知列表**：每条左侧显示应用图标（约 18-20px 圆角小方块）；解析失败显示原「应用名」文字徽标，布局不塌。
3. **横幅**：岛收起时新通知到达 → 顶部弹出横幅（应用图标+应用名+标题，超长截断），5 秒后自动收回；期间到达多条只显示最新一条（后到覆盖）；展开态/横幅期间用户点岛展开 → 横幅立即消失。横幅不影响未读红点逻辑（红点照常）。
4. **防重复**：横幅触发水位用 `lastOrder`（与已读共用：点过「已读」后旧通知不再弹横幅；「清空」后的旧通知也不弹）。轮询首次拉取（应用刚启动那一次）不弹横幅，避免开机时把历史通知全弹一遍。

## 4. 必要依赖

无新增依赖。图标提取用 PowerShell 内置（Add-Type System.Drawing + SHGetFileInfo，与置物架 shelfStore.ts 同款机制）；UWP 包目录直接读文件。

## 5. 验收条件

- [ ] e2e：① icon 解析（ScreenSketch 等本机应用拿到 PNG 路径）；② icon=null 时列表不塌；③ 横幅事件触发（模拟新通知水位推进）；④ 展开态不弹横幅。
- [ ] 回归：e2e-notify-clear / e2e-wifi / e2e-collapsed-todo / e2e-schedule / e2e-todo-today / e2e-export / e2e-pages-custom 全过。
- [ ] typecheck / build 通过。
- [ ] 重新打包安装 `D:\软件\灵动岛\`，进程存活。
- [ ] 用户实机验收：通知页每条带图标；收起时来新通知弹横幅几秒收回。

## 6. 不做什么

- 不做 48px 高清图标（通知面板显示尺寸 18-20px，32px 足够；48px 需 SHGetImageList 本机验证失败 0x80004002，不值得继续投入）。
- 不做横幅点击交互（首版只展示不响应点击；点击打开来源用通知页）。
- 不做横幅队列（多条同时到达只显示最新一条）。
- 不改通知页布局结构（只加图标列）。
- 不做图标按主题色/暗色变体（altform-unplated 等变体不做挑选逻辑，固定 targetsize-48）。
- 不穷举所有 AUMID 图标（解析链覆盖不了的退回文字徽标）。

## 7. 自检记录

2026-11-06 全部跑完 [实测]：

- `npm run typecheck`：PASS（node + web 两个工程）。
- `npm run build`：PASS。
- `node scripts/e2e-notify-icon.mjs`：8/8 PASS——I1 列表带 icon 字段（3 条全有图标）/ I2 ScreenSketch 图标解析成功（notify-ScreenSketch_8wekyb3d8bbwe.png，48px，read_image 目视核对是截图工具图标）/ I2b 所有 icon 文件存在 / I2c 缓存落盘 / I3 渲染 3 图标 0 文字徽标 / I4 首轮拉取不弹横幅 / I5 展开态无横幅 / I6 onNotifyArrived 已注册。
- 回归：e2e-wifi 5 项 / e2e-collapsed-todo 6 项 / e2e-schedule 5 项 / e2e-todo-today 10 项 / e2e-notify-clear 7 项 / e2e-pages-custom 6 项，全 PASS。（e2e-notify-clear 首跑 N1 失败是跑前没清 hiddenUntil 水位的环境状态问题，非代码回归；清水位复跑 7/7 PASS。）
- 开发中修复的两个解析 bug：① e2e 脚本 USER_DATA 用了 homedir()（DSH 宿主返回 D:\Users\honor），Electron 实际 userData 在 %APPDATA%＝C 盘，改用 process.env.APPDATA；② AppxManifest 的 Square44x44Logo 带子目录（Assets\xxx.png）时 pickUwpVariant 拼出 Assets\Assets\ 双层路径，改只取文件名段。
- 打包：`npm run dist` 成功 → 静默安装 `D:\软件\灵动岛\`（app.asar 2026-11-06 20:06）→ 启动 4 进程存活。
- **未验证**：真实新通知到达时横幅弹出与收回（需等一条真实系统通知，留实机验收）；e2e-export 未跑（本次改动不触及导出链路）。
