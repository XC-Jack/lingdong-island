# SPEC-music-ignore-jianying：音乐页不把剪映当成播放器

- 建立日期：2026-11-19
- 对应基线提交：`daf9011`（main，0.1.15）
- 任务分支：`music-ignore-jianying`
- 用户反馈（2026-11-19）：朋友同时用网易云和剪映，音乐页显示的是剪映，不是网易云。

## 一、目标

1. 桥接降级路径不再把剪映（`JianyingPro.exe`）当成音乐播放器，原则与 `SPEC-music-ignore-recorders` 处理 OBS 相同。
2. 剪映不再覆盖「上次播放器 / 上次歌曲」记忆（`last-player.txt`、`last-song.json`）。
3. 网易云暂停/最小化、剪映开着时，音乐页仍显示网易云（CDP 或记忆）或空态，不显示剪映。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/smtcScript.ts` | 降级跳过表 `$script:fbSkipExe` 增加 `jianyingpro`（剪映专业版）、`capcut`（剪映海外版 CapCut，同一产品家族） |
| `docs/Spec/SPEC-music-ignore-jianying.md` | 本 SPEC |

**不动**：跳过逻辑本身（沿用 OBS 那套 `IsSkipExe`，候选、记忆加载、记忆写入四处已覆盖）、SMTC 主路径、CDP、渲染层。

## 三、预期行为

1. 剪映运行时（无论是否在预览时间线），桥接 `poll` 不返回 `app=JianyingPro.exe`。
2. 网易云暂停 + 剪映运行 + CDP 可用：显示网易云暂停态。
3. 网易云收托盘 + CDP 不可用 + 剪映运行：显示 `last-song.json` 里的网易云歌曲；没有记忆时回到空态。
4. 被剪映写坏的两份记忆文件读取时忽略，网易云下次播放自动写回。
5. 其它播放器不受影响。

## 四、必要依赖

无新增依赖，不改行协议字段。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 跳过表含 `jianyingpro` / `capcut`（读 `out/main/index.js` 或运行中的 `userData/music/smtc-bridge.ps1` 确认）。
- [ ] 手工写 `last-player.txt=JianyingPro.exe` + 剪映版 `last-song.json` 后跑桥接 `poll`：`active=false`，两份记忆被忽略。
- [ ] 恢复网易云播放后 `last-player.txt` 写回 `cloudmusic.exe`。
- [ ] 请用户/朋友在真实「网易云 + 剪映」场景复测。

## 六、不做什么

- 不做通用「剪辑软件识别库」，只加剪映家族（`jianyingpro` / `capcut`）；以后遇到别的软件按同样方式另开记录。
- 不改 SMTC 主路径与「自动/半自动/关闭」设置逻辑。
- 不根据窗口标题做模糊拦截（容易误伤名字带 ` - ` 的真播放器）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | 本机确认剪映进程名：`%LOCALAPPDATA%\JianyingPro\User Data\Log` 里 `JianyingLauncher.cpp` 记录 `realExePath=d:\Users\honor\Desktop\Jianying_Pro\6.0.1.11779\JianyingPro.exe` | 进程名为 `JianyingPro.exe`，小写无扩展名即 `jianyingpro` | 朋友机器上的实际会话/标题；本机无剪映程序，只有残留数据目录 |
| 2026-11-19 | 改跳过表后 `npm run typecheck` / `npm run build` | EXIT=0 | — |
| 2026-11-19 | 用临时 `--user-data-dir` 启动开发版、CDP 调 `window.island.musicGet()` 触发懒启动，读生成的桥接脚本 | `fbSkipExe = @("obs", "obs32", "obs64", "jianyingpro", "capcut")` | — |
| 2026-11-19 | 在临时 userData 写 `last-player.txt=JianyingPro.exe` + 剪映版 `last-song.json` 后跑 `poll` | `active=false`、`app=""`。**注意**：用旧脚本对照同样返回 `false`（进程没在跑时记忆本就不生效），所以这一条只证明记忆路径无回归，**不能**单独证明跳过表生效 | 真实剪映进程挂着音频会话的候选路径 |
| 2026-11-19 | 尝试用带窗口标题与音频会话的 PowerShell 进程模拟候选 | 控制台窗口取不到主窗口标题，无法构造候选，模拟放弃（临时进程与目录已删） | 同上，需用户/朋友实机复测 |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
|  |  |  |  |
