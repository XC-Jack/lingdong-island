# SPEC：通知点击直达来源应用（列表条目 + 到岛横幅）

## 一、目标

用户反馈（2026-11-07）：「弹出来的信息还有通知栏的信息，我一点就可以打开对应的软件界面」。

现状：列表条目点击走 `openSource()` 的静态映射表（只认 10 个常见应用名），映射不到就打开 Windows 通知设置页——用户感知为「点了没用/开错地方」；到岛横幅（新消息提示条）完全不可点。

本故事实现：
1. **通知列表条目**：点击打开该条通知的来源界面——优先用 toast 自带的 `launch` 深链（如 QQ 消息直达对应聊天窗、截屏通知直达截图工具），没有深链再退回应用名映射，最后才退到通知设置。
2. **到岛横幅**：点击横幅 = 打开该条消息的来源应用，并立即收回横幅。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/notifyStore.ts` | ①`NotifyItem` 加 `launch: string \| null`；②`readWpnDatabase()` 解析 toast XML 的 `launch="..."` 属性（decodeURIComponent）；③`openSource(app)` 改为 `openSource(app, launch)`：launch 可用 → `shell.openExternal(launch)`；否则旧 map；否则设置页。协议安全过滤见「预期行为」 |
| `src/preload/index.ts` | `NotifyItem` 类型加 `launch`；`notifyOpenSource` 签名改为 `(app: string, launch: string \| null)` |
| `src/renderer/src/App.tsx` | ①`openOne` 传 `it.launch`；②横幅 div 加 `onClick`（打开来源 + 立即收回横幅）与 `cursor:pointer`、`title` 提示 |
| `src/renderer/src/styles.css` | `.collapsed-banner` 加 `cursor: pointer` |
| `scripts/e2e-notify-open.mjs` | 新增：列表数据带 launch 字段、QQ 深链非空、协议处理器已注册（HKCR 查询）、点击后 IPC 收到 app+launch |
| `docs/Spec/SPEC-us-notify-open.md` | 本文件 |
| `docs/facts/功能清单.md`、`docs/状态.md` | 收尾时更新 |

不改动：横幅出现/收回时机、水位与已读逻辑、图标解析链、通知页布局（us-notify-compact 刚定稿）。

## 三、预期行为

1. **launch 解析**：`readWpnDatabase()` 对每条 toast 提取 `<toast launch="...">`，URL 解码后存 `launch`；无属性或空串 → `null`。
2. **点击列表条目**（展开态）：
   - `launch` 非空且通过协议过滤 → `shell.openExternal(launch)`，系统按协议分发（QQ 的 `ntqq-notification://` 已由 QQ 注册到 timwp.exe，[实测] HKCR 查证）。
   - `launch` 为 null → 退回现有 `openSource` 静态映射（Chrome/Edge/QQ/WeChat 等常见应用）。
   - 映射也没有 → 打开 `ms-settings:notifications`（现有兜底，保留）。
3. **点击横幅**（收起态）：同上打开来源，同时立即收回横幅（清 timer、`setBanner(null)`、`setBannerVisible(false)`）；不收起、不展开岛；不标记已读（用户可能还想看其它条目）。
4. **协议安全过滤**：launch 来自系统通知库（第三方应用写入），openExternal 前过滤——只放行 `^[a-z][a-z0-9+.-]*:` 形式的合法 URI，拒绝 `file:`、`javascript:`、`data:`、`vbscript:` 四类危险协议；不匹配 → 走静态映射兜底。
5. 点击行为与 Windows 通知中心一致：点击即交给系统，弹出什么界面由来源应用决定。

## 四、必要依赖

无新增依赖（`shell.openExternal` Electron 内置；协议注册查询用 node:sqlite/注册表仅限测试脚本）。

## 五、验收条件

1. typecheck、build 通过。
2. `e2e-notify-open.mjs` 断言全过：
   - O1 列表条目带 `launch` 字段（QQ 条目深链含 `ntqq-notification://`）；
   - O2 `notify:open-source` IPC 收到 `(app, launch)` 且 launch 原样透传；
   - O3 危险协议（`file:`）被过滤走兜底分支（单元级验证 openSource 返回 true 且不调用 openExternal——通过 mock 或逻辑复刻验证）；
   - O4 HKCR 存在 `ntqq-notification` 协议处理器（保证 openExternal 有接收方）。
3. 回归：`e2e-notify.mjs`、`e2e-notify-icon.mjs`、`e2e-notify-compact.mjs`、`e2e-collapsed-todo.mjs` 全过。
4. 打包安装到 `D:\软件\灵动岛\`，进程存活。
5. 用户实机验收：QQ 来消息 → 点横幅 → QQ 聊天窗被拉起；通知页点条目 → 对应界面打开。

## 六、不做什么

- 不做横幅多队列、不做横幅悬停暂停（保持 5 秒收回）。
- 不改通知中心式「点击已读」语义：点击条目仍调 `markRead()`（现有行为），横幅点击不动水位。
- 不解析 launch 里的参数做更细的跳转（如跳 QQ 具体群/好友由应用自己处理）。
- 不处理应用未运行时的拉起策略（交系统协议分发：QQ 已注册协议处理器会自行启动 timwp.exe）。
- 不改已读/清空/水位逻辑与通知页样式。

## 七、自检记录

（开发完成后回填）

## 八、未验证清单

（开发完成后回填；已知风险：`shell.openExternal` 对自定义协议的处理与 PowerShell `Start-Process` 等效性为 [推断]——Electron 走 ShellExecute，e2e 只验证到 IPC/协议注册层，真实拉起留用户实机验收。）
