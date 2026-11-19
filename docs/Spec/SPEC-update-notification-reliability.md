# SPEC-update-notification-reliability：更新检查可靠性与提示

- 建立日期：2026-11-19
- 对应基线提交：`95f6ed3`（main）
- 任务分支：`update-notify`
- 用户背景：朋友长期停在 0.1.13，反馈「基本没有弹过更新」（2026-11-19）。用户已定：检查频率「每 4 小时 + 唤醒补查」，提示方式「系统通知 + 岛内横幅」。

## 一、目标

1. 长期不重启的岛也能发现新版本：启动后仍检查一次，另加每 4 小时周期检查；系统从睡眠唤醒后 30 秒补查一次。
2. 一次网络抖动不再让整轮检查作废：检查失败后 10 分钟、30 分钟各重试一次；成功则清零，之后回到 4 小时周期。
3. 提示不再只依赖一条可能被错过/被系统拦掉的 toast：同一版本每天最多提示一次（系统通知 + 岛内 5 秒横幅），第二天若仍未更新会再提示。
4. 设置页「更新」行始终显示最近一次检查时间，失败时显示原因与时间，方便远程排查。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/updater.ts` | 恢复 4 小时周期检查；新增 `powerMonitor` 唤醒补查、失败重试（10/30 分钟）；`update-notified.json` 从「版本」改为「版本 + 日期」，同一版本按天去重；发现新版本时向所有窗口广播 `update:announce`；`fail()` 记录 `checkedAt` |
| `src/preload/index.ts` | 新增 `onUpdateAnnounce(cb)`（订阅 `update:announce`） |
| `src/renderer/src/App.tsx` | 收起态新增「更新」横幅（5 秒收回，点击打开设置「常规」；展开态忽略，与验证码横幅同规则） |
| `src/renderer/src/styles.css` | `.update-banner` / `.banner-update-badge`（蓝色徽章，复用 `.collapsed-banner` 布局） |
| `src/renderer/src/settings/SettingsApp.tsx` | 「新版本可用」「检查失败」两种状态也显示 `HH:mm 检查`；空闲提示改为「每 4 小时自动检查」 |
| `docs/facts/功能清单.md` | 同步自动更新行为 |
| `docs/Spec/SPEC-update-notification-reliability.md` | 本 SPEC |

**不动**：下载 / 安装流程（`downloadUpdate`、`quitAndInstall`）、GitHub provider 配置、通知去重文件位置、开发者模式行为。

## 三、预期行为

1. **检查时机**：安装版启动 60 秒后查一次；之后每 4 小时一次；`powerMonitor` 的 `resume` 事件后 30 秒补查一次。开发版仍完全不查。
2. **失败重试**：单次检查抛错（网络重置、超时、404 等）后 10 分钟重试，再失败 30 分钟重试；两次都失败就等下一个 4 小时周期。离线（`net.isOnline()===false`）不重试，等周期。
3. **提示去重**：`update-notified.json` 记录 `{ "version": "0.1.15", "date": "2026-11-19" }`。同一天同一版本只提示一次；跨天仍未更新会再提示。旧格式（只有 `version`）视为当天未提示，升级后最多多弹一次。
4. **提示形式**：去重通过后同时做两件事：①发系统通知（`Notification.isSupported()` 为真时）；②广播 `update:announce`，岛收起态弹横幅「灵动岛 X 可更新」，5 秒收回，点击打开设置窗口「常规」。展开态不弹不补弹。
5. **状态可见**：设置页「更新」行在 `available` / `error` / `none` 状态下都显示最近检查时间；`error` 同时显示归类后的原因。

## 四、必要依赖

无新增依赖；`powerMonitor` 来自 electron 内置模块。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 安装版（或临时把 `app.isPackaged` 判断旁路的探针）日志出现启动检查、4 小时周期定时器、唤醒补查的登记；本机不实际等 4 小时的，以代码路径 + 定时器登记日志为准并写明未验证。
- [ ] 断网（或伪造 GitHub 不可达）触发检查：`state.stage=error` 且 `checkedAt` 非空，设置页显示「原因 · HH:mm 检查」。
- [ ] 失败后日志出现 `update: retry in 10 min`，重试失败后出现 `update: retry in 30 min`，之后不再排重试。
- [ ] 发现新版本时：`update-notified.json` 写入 `{version, date}`；岛收起态出现更新横幅，5 秒后消失；点击横幅打开设置「常规」。
- [ ] 同一天再次发现同一版本：不再弹通知/横幅（日志 `already notified ... skip`）。
- [ ] 手动「检查更新」不受去重影响，状态与提示逻辑一致。
- [ ] `node scripts/e2e-music.mjs` 与改动前基线一致（等改动路径不受影响，跑一次确认没连带破坏）。

## 六、不做什么

- 不改下载与安装流程，不做后台自动下载。
- 不改成「每次检查都弹」——避免每 4 小时打扰一次。
- 不加岛内常驻红点（用户本次选了横幅方案）。
- 不改 GitHub Release 结构，也不改国内网络访问方式。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | `npm run typecheck`、`npm run build` | EXIT=0 | — |
| 2026-11-19 | 预览版临时探针（`ISLAND_UPDATE_TEST`，验完删除）模拟发现 9.9.9 | 300ms 内出现 `collapsed-banner update-banner`，文本「更新 灵动岛 9.9.9可更新，点击查看」，6 秒后消失；`update-notified.json` 写入 `{"version":"9.9.9","date":"2026-11-19"}`；同日再次触发日志 `already notified 9.9.9 today, skip` | 点击横幅打开设置（悬停/点击手感） |
| 2026-11-19 | 预览版展开到通知页（第 3 页） | 标题显示「8 条通知（有新版本）」，`.shelf-update-hint` 计算色 `rgb(251, 191, 36)` | — |
| 2026-11-19 | 预览版临时探针模拟检查失败 | `stage=error`、`checkedAt` 有值、message「连不上 GitHub，检查网络后重试」，日志 `update: retry in 10 min`；设置页显示「连不上 GitHub，检查网络后重试 · 18:45 检查」 | 第二次 30 分钟重试（只登记了第一次） |
| 2026-11-19 | 删除探针后正常启动 | `stage=unsupported`，无横幅，日志 `update: dev mode, checks disabled` | — |
| 2026-11-19 | 观察：系统通知会被通知轮询镜像成一条「新消息」横幅 | 实测出现 `lingdong-island / 灵动岛 9.9.9 可以更新` 通知横幅，优先级高于更新横幅 | 系统通知被专注助手拦截时更新横幅的兜底表现 |
| 2026-11-19 | `node scripts/e2e-music.mjs`（改用 `E2E_CDP_PORT=9326`：本机 9321 被一个已消失进程的残留监听占用，DevTools 绑定失败） | **PASS 48 过 / 0 败** | — |
| 2026-11-19 | 打包 0.1.15（不升版本）静默装机并启动 | 装机 asar 与 win-unpacked 同 SHA `CA2C8D88…`；`packaged=true`，日志 `update: armed, version 0.1.15` / `update: periodic check every 4 h`；启动 60 秒后真实请求 GitHub，`update: none (latest 0.1.15)` | 4 小时周期与唤醒补查未等满；真实新版本触发的横幅未验（当前已是最新） |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
|  |  |  |  |
