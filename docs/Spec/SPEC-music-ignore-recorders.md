# SPEC-music-ignore-recorders：音乐页不把 OBS 等录屏软件当成播放器

- 建立日期：2026-11-19
- 对应基线提交：`0e2cb08`（main）
- 任务分支：`music-ignore-obs`
- 用户反馈（2026-11-19，附截图）：OBS 录制时音乐页显示「OBS 33.0.1 / 配置文件: 未命名 - 场景: 未命名」，而不是网易云当前歌曲；用户补充「设置里当时是自动，并非半自动」。

## 一、目标

1. 桥接降级路径不再把 `obs64.exe` 等录屏/推流程序当作音乐播放器。
2. OBS 不再覆盖「上次播放器 / 上次歌曲」记忆（`last-player.txt`、`last-song.json`）。
3. 网易云暂停时，即使 OBS 在跑，音乐页仍显示网易云（CDP 或记忆），不显示 OBS。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/smtcScript.ts` | 降级路径增加「非播放器进程」跳过表（`obs.exe` / `obs32.exe` / `obs64.exe`）；候选、记忆加载、记忆写入四处都跳过；已污染的旧记忆文件在读取时忽略 |
| `docs/Spec/SPEC-music-ignore-recorders.md` | 本 SPEC |

**不动**：SMTC 主路径、CDP 控制、播放/暂停/进度/音量/歌词、渲染层。

## 三、预期行为

1. OBS 运行时（无论是否录制），桥接 `poll` 不返回 `app=obs64.exe`，音乐页不出现 OBS。
2. 网易云暂停 + OBS 运行 + CDP 可用：显示网易云暂停态（CDP 赢在 `bridgeState.playing=false`）。
3. 网易云暂停 + 收托盘 + CDP 不可用 + OBS 运行：仍显示 `last-song.json` 里的网易云歌曲；没有记忆时回到空态。
4. 其它播放器（汽水等）不受影响：仍按原有「在播 > 标题像歌名 > 上次认过」打分。
5. 现有被 OBS 污染的 `last-player.txt` / `last-song.json` 不再生效，网易云下次播放时自动写回正确值。

## 四、必要依赖

无新增依赖，不改行协议字段。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] OBS 运行时跑桥接 `poll`：不再返回 `app=obs64.exe`（修前已复现返回该值）。
- [ ] 网易云暂停、OBS 运行时：音乐页/桥接返回网易云或空态，不出现 OBS。
- [ ] 恢复网易云播放：正常显示歌曲，`last-player.txt` 写回 `cloudmusic.exe`。
- [ ] `node scripts/e2e-music.mjs` PASS。

## 六、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | 复现：OBS 33.0.1 运行、网易云暂停，旧桥接 `poll` | 返回 `active=true / title=OBS 33.0.1 / artist=配置文件: 未命名 - 场景: 未命名 / app=obs64.exe`，与用户截图一致 | — |
| 2026-11-19 | `npm run typecheck` / `npm run build` | EXIT=0 | — |
| 2026-11-19 | 修补后同场景跑桥接 `poll` | `active=false`，不再返回 OBS | 网易云在播时未复测（避免打断用户播放） |
| 2026-11-19 | 手工写入 `last-player.txt=obs64.exe` + OBS 版 `last-song.json` 再跑 `poll` | 仍 `active=false`，污染记忆被忽略 | — |
| 2026-11-19 | `node scripts/e2e-music.mjs` | 46 过 / 2 败（M2l、U4c）；同一脚本在**未改动的 `main` 源码**上同样 46/2，失败与本次改动无关（当前网易云停着，音量/seek 用例受环境影响） | M2l/U4c 的环境稳定性 |
| 2026-11-19 | 对照复现细节 | OBS 的音频会话 `state=1`、无 SMTC 会话、窗口标题含 ` - ` ⇒ 命中降级打分 100+50，且会覆盖 `last-player.txt` / `last-song.json`（本机实际被写成 obs64） | OBS 其它版本/分支进程名 |

## 七、不做什么

- 不做通用「录音/录屏软件识别库」，只处理已复现的 OBS 家族。
- 不改 SMTC 主路径的会话选择。
- 不改「自动/半自动/关闭」三档逻辑。
