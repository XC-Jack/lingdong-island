# SPEC-music-source-strategy：音乐页识别策略（自动选源 / 记住播放器 / 锁定）

- 建立日期：2026-11-19
- 对应基线提交：`d5a6cd1`（main，0.1.15 本地构建）
- 任务分支：`music-source`
- 用户背景：朋友「网易云 + 剪映」误显示剪映（已用黑名单临时修掉）；用户随后提出「媒体选择 / 锁定播放器」，并要求连识别策略一起做（2026-11-19：「识别策略可以做，锁定播放页也做，然后媒体选择也做」）。

## 一、目标

1. 自动模式不再让「陌生应用」抢走播放器：OBS、剪映这类只挂音频会话的软件永远不会被自动选中（黑名单）；其余陌生应用在已知播放器还活着时也不许顶替。
2. **软白名单**：内置常见播放器表；用户在音源选择器里点选过的应用自动加入「已知播放器」并持久化，下次它单独在播时自动显示。
3. 多个**已知播放器**并存时，优先正在出声的那个；都暂停时保持「上次认过的那个」，不来回跳。
4. 提供锁定基础：记住用户手动选的音源（`prefs.musicSourcePin`），锁定期间只显示它。
5. 为选择器提供数据：桥接每次状态回包里带上当前所有候选音源（exe、显示名、是否在播）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/smtcScript.ts` | ①新增已知播放器表（内置 + `known` 命令同步来的学习项）与候选缓存 `GetCandidates()`；②`GetFallback` 增加门禁：陌生应用只在「没有任何已知播放器进程存活 + 自己正在出声」时才可被选中；③状态回包增加 `sources` 与 `pinAlive`；④新增 `{"cmd":"known","value":[...]}` 与 `{"cmd":"focus","value":"<exe>\|"}`（空值回自动）；⑤`PickIndex` 在锁定期间只挑该进程的 SMTC 会话 |
| `src/main/musicStore.ts` | `MusicState` 增加 `sources` / `pinnedExe` / `pinnedMissing`；`recompute()` 处理锁定优先级（锁网易云时 CDP 恒优先，不再看 `playing`；锁别的播放器时不用 CDP）；锁定的应用不在运行时返回空态而不是回落自动；启动/重连时把 `known` / `focus` 同步给桥接；新增 IPC `music:set-source` |
| `src/main/prefsStore.ts` | 新增 `musicSourcePin?: string`（小写 exe 名，空/缺省＝自动）与 `musicKnownPlayers?: string[]`（选择器学到的已知播放器，去重、上限 40），带校验 |
| `src/preload/index.ts` | 暴露 `musicSetSource(exe \| null)`（走 IPC `music:set-source`） |
| `src/shared/types.ts` | 新增 `MusicSource`，`MusicState` 增加三个字段 |
| `docs/Spec/SPEC-music-source-strategy.md` | 本 SPEC |

**不动**：SMTC 主路径选会话的规则（除锁定过滤）、网易云 CDP 的开启逻辑、渲染层 UI（选择器另立 `SPEC-music-source-picker`）。

## 三、预期行为

1. **黑名单优先**：`obs*`、`jianyingpro`、`capcut` 不进候选、不进选择器、不写记忆，也永远不会被学成已知播放器。
2. **已知播放器**＝内置表（`cloudmusic`、`qqmusic`、`kugou`、`kuwo`、`spotify`、`potplayermini64`、`potplayermini`、`sodamusic`）＋选择器点选学习到的。多个并存时优先 `state=1`（正在出声）；都在暂停则保留上次认过的；进程退出后回到空态或其它在播播放器。
   - 汽水音乐 [2026-11-19 用户截图实测]：进程 `SodaMusic.exe`，SMTC 的 AUMID 是中文「汽水音乐」；两者按显示名合并成一行，锁定匹配也同时认进程名与中文应用名，避免选择器里出现两个「在播」。
3. **陌生应用（软门禁）**：
   - 只要有任何已知播放器进程存活（含暂停、收托盘），陌生应用**不会**被自动选中，只出现在 `sources` 里供选择；
   - 一个已知播放器都没跑时，陌生应用若正在出声（`state=1`）可以自动显示——第一次用冷门播放器不至于空白；
   - 在列表里点选一次后它就成为「已知播放器」，此后按第 2 条参与自动选源。
4. **锁定**：用户选定某 exe 后，无论其它应用在播与否，只显示它：
   - 锁网易云：CDP 可用就用 CDP（暂停也显示暂停态）；CDP 不可用则用桥接记忆/窗口标题。
   - 锁其它播放器：桥接 `focus` 到该 exe，标题、进度条、音量都只读它；SMTC 选会话也只挑它。
   - 锁定应用退出：`active=false` + `pinnedExe` 保留 + `pinnedMissing=true`，**不自动切到别的应用**；选择器里提供「自动」解锁。
5. **自动**：`musicSourcePin` 清空后立即回到第 2、3 条规则。
6. 设置不跨机器同步，只存本机 `prefs.json`。

## 四、必要依赖

无新增依赖；沿用桥接行协议，新增字段属于向后兼容扩展（旧渲染层忽略即可）。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 桥接 `poll` 回包含 `sources`，且 `sources` 列出当前有音频会话的应用（黑名单除外）。
- [ ] 复现脚本：起一个非白名单、标题带 ` - ` 的音频会话进程，同时让白名单播放器保持「进程在、暂停」：自动模式下当前音源仍是白名单播放器。
- [ ] 只开非白名单播放器（无其它播放器）：自动模式下它可以显示，并出现在选择器里。
- [ ] 在选择器里点选该陌生应用后，`prefs.musicKnownPlayers` 出现它；重启岛后它按已知播放器参与自动选源。
- [ ] `music:set-source` 锁到非网易云播放器后，上一首/播放/下一首命令作用在该 exe（桥接 ack 的 `exe` 与锁定值一致）。
- [ ] 锁定的 exe 退出后：`active=false`、`pinnedMissing=true`，不会切到其它正在播的应用。
- [ ] 清空锁定后恢复正常自动选源。
- [ ] `node scripts/e2e-music.mjs` 与改动前基线一致（记录失败项，不掩盖）。

## 六、不做什么

- 不做「所有播放器的通用识别」：内置表不是穷举，未收录的靠陌生应用门禁 + 用户点选学习。
- 不改按窗口标题的模糊判断：标题只用于候选打分，不做黑名单/白名单匹配，避免误伤。
- 不改网易云 CDP 自动开启、桌面歌词、音量控制通道。
- 不改渲染层（选择器 UI 在另一份 SPEC）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | `npm run typecheck`、`npm run build` | EXIT=0 | — |
| 2026-11-19 | 从 `smtcScript.ts` 提取模板串写成 `.tmp/smtc-check.ps1`，用 `[Parser]::ParseFile` 做语法检查 | 首次抓出 `if ([string]$c.title).Contains(...)` 少一层括号，修正后 `PARSE_OK` | — |
| 2026-11-19 | 单独运行桥接脚本，依次发 `known(["foo"])`、`poll`、`focus(cloudmusic)`、`poll`、`focus("")`、`poll` | 回包含 `sources` / `pinAlive`；`focus=cloudmusic` 时 sources 只含网易云且 `pinAlive=true`；清空 focus 后恢复 | 真实第二播放器、陌生应用门禁（本机只有网易云） |
| 2026-11-19 | 预览版（临时 userData + CDP）调 `window.island.musicSetSource(...)` | `pin=cloudmusic.exe` → `pinnedExe=cloudmusic`、暂停态仍 `active=true` 且 `neteaseCdp=true`、`pinnedMissing=false`；`pin=foo` → `active=false`、`pinnedMissing=true`；解锁后恢复自动 | 锁到非网易云播放器后的控制命令路由 |
| 2026-11-19 | `node scripts/e2e-music.mjs` | 首轮 48/0；之后两轮 47/1，失败项均为 U4c（本机网易云暂停在 151s，测试 seek 到 150s，歌词行号不变；与本次改动无关的环境性失败） | — |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
|  |  |  |  |
