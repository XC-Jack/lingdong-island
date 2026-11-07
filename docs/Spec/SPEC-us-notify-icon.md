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

### 用户实机验收反馈与二轮修复（2026-11-06 20:48–21:00，提交 644de18）

用户反馈两条：①标题乱码「新邮件来自 LottieFiles &lt;!hello@lottiefiles.com&gt;」②「没有弹出收回的效果」。

- 修复1 `parseToastXml` 加 `decodeEntities`：toast XML 的 text 内容是 XML 转义过的，不解码就原样显示。修后真实库验证：`新邮件来自 LottieFiles <hello@lottiefiles.com>` [实测]（.tmp/probe-decode.cjs 读 wpndatabase 逐条解码核对）。
- 修复2 展开期错过的横幅补弹：原实现渲染层展开态直接忽略横幅事件，而主进程此时已把该通知记入 bannerSent——用户在通知页看到「刚刚」的消息，收起后横幅永远不弹，正是用户遇到的。改为展开态把最新一条暂存 `pendingBanner`，收起瞬间补弹 [实测]（dev 版 CDP：展开态发真实 toast → 35s 横幅未弹 → Esc 收起 → 0ms 补弹成功）。
- 顺带验证：收起态发 toast → 19.3s 后横幅弹出（30s 轮询窗口内）→ 4.1s 后收回（5s 定时减采样误差），动画正常。
- 回归：e2e-notify-icon 8 项 / e2e-notify-clear 7 项 / e2e-wifi 5 项 / e2e-collapsed-todo 6 项全 PASS [实测]。
- 重新打包安装（app.asar 2026-11-06 20:58）→ 4 进程存活。
- **仍未验证**：安装版收起态等一条真实第三方通知看横幅（复现验证都在 dev 版做的，安装版链路相同但留用户日常观察）。

### 三轮修复：横幅渲染在窗口外不可见（2026-11-07，提交 faaa065）

用户安装版实测（QQ 真实消息 order 1641 已入库且应触发）两次反馈「还是没有弹出」。

- **根因（实锤）**：收起态窗口高仅 42px（`src/main/index.ts` COLLAPSED_HEIGHT），横幅 CSS `bottom:calc(100%+6px)` 渲染在窗口上沿之外 6px——窗口外内容屏幕上不可见。此前所有「复现成功」是假阳性：CDP 只验证了 .collapsed-banner 的 DOM 存在与出现/消失时间，没验证屏幕可见性（窗口 bounds）。教训：**窗口外定位元素必须验证窗口 bounds，DOM 存在≠可见**。
- **修复**：横幅显示期间主进程把窗口向上加高 BANNER_EXTRA=46（y 上移、胶囊位置不变），隐藏时反向还原；渲染层 showBanner/5s 收回时经新 IPC `island:set-banner-visible` 通知主进程；横幅 CSS 改 `top:6px` 贴加高后窗口顶。踩坑：还原方向第一版写反（dy/dh 用 next 条件取 0），窗口停在 91 高，已修——还原时 getBounds 已是加高后的，必须 +46/-46。
- 安装版 CDP 验证 [实测]（app.asar 10:33，端口 9322）：收起态发真实 toast → 3.3s 横幅出现，innerHeight 43→90，横幅 rect top=12 在窗口内（真实可见）→ 5.0s 收回 → 还原 44（42+2 边框误差）。补弹路径（展开→toast→35s 不弹→Esc 收起→补弹 34ms，补弹期 196→5s 后还原 38）✅。
- e2e-notify-icon 首跑 I2b 失败原因：lingdong-island 图标路径在 app.asar 内，普通 node 的 fs 读不了 asar（Electron 扩展只在 Electron 进程内生效）——e2e 改为跳过 asar 内路径检查，复跑 8/8 PASS；回归 wifi/collapsed-todo/schedule/todo-today 全 PASS [实测]。
- **未验证**：用户日常真实第三方通知的肉眼体验（本机验证用的也是真实 WinRT toast，但留用户实机确认）。

### 四轮修复：横幅期胶囊跟着窗口上移（2026-11-07 10:51–10:57，提交 b21659f）

用户第二轮实机（10:41 QQ 消息）反馈「没弹」+「岛消失几秒又出现」。

- 「岛消失又出现」实锤：三轮修复的向上加高方案里，胶囊渲染贴窗口顶（.app flex-start），窗口向上加高 46px 时**胶囊跟着窗口顶上移 46px**——用户看到的「胶囊消失」就是胶囊跳走，收回又还原。
- 修复：`.app` 改 `align-items:flex-end`——加高后窗口底=原窗口底（y-46, h+46），胶囊贴底位置纹丝不动；窗口顶 46px 成为横幅预留区。中途试过「向下加高」方案（胶囊不动但横幅仍在窗口外，实测横幅 rect top=-49 被裁），否决。
- **屏幕级验证**（Win32 GetWindowRect + CDP 双取证，[实测]）：静止窗口 T=6/H=46、屏幕胶囊 top=11.2；横幅期 T=-40/H=94、屏幕胶囊 top=12.4（1.2px 动画误差，不动）；横幅渲染 rect 屏幕坐标 -35.9~7.2，完整落在窗口内（窗口顶-40）且在胶囊上方；收回 T=6/H=48 完全还原。
- 安装版 10:56 打包安装，4 进程存活。回归：e2e-wifi / collapsed-todo / schedule / todo-today / notify-icon 8 项全 PASS [实测]。
- 排障教训沉淀：①CSS absolute 定位必须先确认包含块（横幅 bottom:48px 一版量出 top=-49 就是因为把它当窗口定位、实际包含块是 .island）②「DOM 存在≠屏幕可见」的验证要量窗口 bounds（Win32 GetWindowRect 最直接）③PowerShell 脚本文件中文内容必须 UTF-8 带 BOM，否则 PS5 按 ANSI 读乱码。
