# SPEC-netease-cdp-mode：网易云后台控制三档（自动 / 半自动 / 关闭）

- 日期：2026-11-18
- 分支：`netease-cdp-mode`
- 背景：`SPEC-netease-auto-cdp` 的自动开启是**无条件**的——只要 `cloudmusic.exe` 在跑、9222 没有页面就自动重启一次。用户 2026-11-18 体验审计后要求：设置里除开关外还要能选「自动 / 半自动」。

## 一、目标

把「网易云没开调试端口时怎么办」变成用户可选的三档，默认仍是现有行为：

- **自动**（默认）：自动重启网易云开启调试端口（现状）。
- **半自动**：不自动重启，只在音乐页显示「点此开启后台精确控制（重启一次）」，用户点了才重启。
- **关闭**：不自动重启，也不显示入口；岛完全不碰网易云。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `NeteaseCdpMode = 'auto' \| 'manual' \| 'off'`；`MusicState` 增加 `neteaseCdpMode` 字段 |
| `src/main/prefsStore.ts` | `PrefsShape` 增加 `neteaseCdpMode?: NeteaseCdpMode`；load / applyPatch 校验白名单（缺失 = auto） |
| `src/preload/index.ts` | `PrefsShape` 同步该字段 |
| `src/main/musicStore.ts` | 启动时读 prefs 并订阅 `onPrefsWritten` 热更新；`pollCdp()` 仅在 `auto` 时触发自动重启，`manual/off` 清零计时；状态里带出当前档位 |
| `src/renderer/src/App.tsx` | 音乐页「开启入口」仅在档位不是 `off` 时显示 |
| `src/renderer/src/settings/SettingsApp.tsx` | 常规分区新增「网易云后台控制」三档卡片，复用现有 `.pet-set-mode` 样式 |

**不改**：端口 9222、重启与续播逻辑、手动入口的文案与行为、e2e 的 `ISLAND_NO_NETEASE_AUTO` 开关。

## 三、预期行为

1. **默认**：`prefs.json` 没有 `neteaseCdpMode` 时按 `auto`，老用户行为与升级前完全一致。
2. **自动**：保持不变——条件持续 1.5 秒 → 自动重启；60 秒硬间隔、连续失败 3 次停止、成功后不循环。
3. **半自动**：不自动重启；音乐页仍显示现有入口「网易云：点此开启后台精确控制（重启一次…）」，点击后走同一条 `enableCdp()` 链路（含续播）。
4. **关闭**：不自动重启，也不显示入口；自动重启的计时状态清零，避免从「关闭」切回「自动」时立刻触发一次。
5. **即时生效**：设置窗口切换档位后无需重启应用——主进程经 `onPrefsWritten` 热更新。
6. **e2e**：`ISLAND_NO_NETEASE_AUTO=1` 时任何档位都不自动重启（测试不碰真实网易云）。

## 四、必要依赖

无新增依赖。复用 `prefsStore.getPrefs/onPrefsWritten`、现有 `enableCdp()` 与设置页样式。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck`、`npm run build` 均 EXIT=0 |
| A2 | 默认（无字段）与 `auto`：普通方式打开网易云 → 约 4 秒内被自动重启并开启端口（回归） |
| A3 | `manual`：普通方式打开网易云 → 10 秒内**不**重启、`startup.log` 无自动开启记录；音乐页显示「点此开启后台精确控制」，点击后能开启 |
| A4 | `off`：普通方式打开网易云 → 不重启、音乐页**不显示**开启入口；切回 `auto` 后无需重启应用即可生效 |
| A5 | 设置页常规分区出现三档，点击切换后 `prefs.json` 立即落盘 |
| A6 | `e2e-settings-shell` 仍 PASS（新增行不破坏既有断言） |

## 六、不做什么

- 不改默认值（保持自动）。
- 不为其他播放器加类似档位。
- 不在半自动下加系统通知/弹窗提醒（只沿用音乐页现有入口）。
- 不改 `ISLAND_NO_NETEASE_AUTO` 环境变量的含义。

## 七、自检记录

自检日期 2026-11-18，分支 `netease-cdp-mode`，开发预览版（`out/` 构建 + 真实网易云 3.1.41.205564）。

| 编号 | 结果 |
|---|---|
| A1 | **通过**：`npm run typecheck` / `npm run build` 均 EXIT=0 |
| A2 | **通过**：`auto` 档下打开网易云 → 自动重启开启端口（`musicGet()` 返回 `cdp=true`、`playing=true`、歌名《少一点天分》续播）；受 60 秒硬间隔约束，刚切换档位后需等冷却结束 |
| A3 | **通过**：`manual` 档杀进程后普通方式重开 → 8 秒内 9222 仍无页面（未自动重启）、`startup.log` 无新自动记录；音乐页出现入口「网易云：点此开启后台精确控制（重启一次，之后最小化也能拖进度）」 |
| A4 | **通过**：切到 `off` 档 1.2 秒内入口从 DOM 消失、不重启；切回 `auto` 后无需重启应用即生效（热更新经 `onPrefsWritten`） |
| A5 | **通过**：`prefsSet({neteaseCdpMode:'manual'})` 后 `prefs.json` 立即写入 `"neteaseCdpMode": "manual"`；设置页常规分区出现三档卡片（`data-cdp-mode`） |
| A6 | **通过**：`node scripts/e2e-settings-shell.mjs` → **PASS（51 过 / 0 败）** |

**踩坑记录**：第一次跑档位测试时把「入口是否显示」的判断放在网易云被杀之后 8 秒，此时岛已自动收起（`.island collapsed`），DOM 里没有音乐页自然查不到入口——是探针没保持展开，不是功能问题。第二次先展开岛并切到音乐页再判断，`manual` 有入口、`off` 无入口，结果符合预期。

**未验证**：

1. 装机版（本轮只在预览版验证）。
2. 真实鼠标在设置页里点击三档（本轮用 IPC `prefsSet` + DOM 检查，未做物理点击；设置页本身的渲染已由 `e2e-settings-shell` 覆盖）。
