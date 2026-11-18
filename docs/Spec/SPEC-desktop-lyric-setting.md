# SPEC-desktop-lyric-setting：设置里开关「点词第二下召唤桌面歌词」

- 日期：2026-11-18
- 分支：`island-ux-tweaks`（第二提交）
- 背景：用户 2026-11-18「在设置页里面加一个就是点词点第二下可以召唤桌面歌词的这个按钮」——把刚做的第二态做成可关，不想要的人点「词」仍只开合面板。

## 一、目标

设置页「常规」新增一个开关（默认开）：

- **开**：保持现状——「词」三态循环（面板 → 桌面歌词 → 关）。
- **关**：「词」只开合岛内歌词面板，不再调用网易云桌面歌词；即使网易云桌面歌词正开着，岛上这枚按钮也只表示面板状态。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/prefsStore.ts` | `PrefsShape.desktopLyricEnabled?: boolean`；load/applyPatch 按布尔值读写（缺失＝true） |
| `src/preload/index.ts` | `PrefsShape` 同步字段 |
| `src/renderer/src/App.tsx` | `App` 读 prefs 热更新并传给 `MusicPanel`；`MusicPanel` 的 `canDesktopLyric`/`desktopLyricOn` 都受该开关约束 |
| `src/renderer/src/settings/SettingsApp.tsx` | 常规分区「网易云后台控制」下方新增一行开关，复用 `Row` + `.set-switch` |

**不改**：三态逻辑本身、桌面歌词读取（轮询照旧，只影响按钮是否展示/使用）、e2e 的 `ISLAND_NO_DESKTOP_LYRIC`。

## 三、预期行为

1. 老 `prefs.json` 没有该字段 → 视为开，升级前后行为一致。
2. 设置页关掉后即时生效（`prefs:changed`），无需重启。
3. 关掉时点「词」：面板开/关两态；不发 `music:desktop-lyric`。
4. 关掉时若网易云桌面歌词正开着：岛不擅自关它，按钮也不因它高亮。
5. 重新打开开关后，三态循环恢复，且按网易云实际状态接着走。

## 四、必要依赖

无。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck`、`npm run build` EXIT=0 |
| A2 | 设置页开关默认开、`prefs.json` 无字段时行为与现在一致 |
| A3 | 关掉后连续点「词」：仅面板开→关，`musicGet().desktopLyric` 不变；按钮不再因网易云桌面歌词高亮 |
| A4 | 开关切换 `prefs.json` 立即落盘；重新打开后第二下恢复召唤 |
| A5 | `e2e-settings-shell`、`e2e-music` 仍 PASS |

## 六、不做什么

- 不做「关掉时顺手关闭已开着的桌面歌词」。
- 不为其他播放器提供同类开关。
- 不改第一态（面板）与第三态（关桌面歌词）的现有表现。

## 七、自检记录

自检日期 2026-11-18，分支 `island-ux-tweaks`，dev 构建 + 隔离 userData。

| 编号 | 结果 |
|---|---|
| A1 | **通过**：`typecheck` / `build` EXIT=0 |
| A2 | **通过**：`prefs.json` 无字段时开关显示为开；三态行为与上一轮一致（该轮已实测） |
| A3 | **通过**：关掉后点「词」两次：第一次 `lyric-open` 出现，第二次消失；`musicGet().desktopLyric` 保持 `false`，按钮不带 `on` |
| A4 | **通过**：设置页开关 `aria-checked` 反映 false；点击后 `prefsGet().desktopLyricEnabled` 变 `true`，`prefs.json` 落盘 |
| A5 | **settings 通过**：`e2e-settings-shell` **51 过 / 0 败**。**music 45 过 / 3 败**：M2l 音量、U4b/U4c 歌词高亮 3 条失败，已用 `git stash` 在**不含本改动**的 `9c92a7e` 上复跑，结果、数值完全一致（`canVolume=false / 显示=100%`、`expectIdx=31 vs activeIdx=30`），属当前机器播放环境（网易云停在 151 秒、音量会话对不上号）导致的既有波动，不是本改动引入 |

**未覆盖**：开关打开状态下第二态的真实桌面歌词切换在隔离探针里被 `ISLAND_NO_DESKTOP_LYRIC` 拦住，未重复验证；该路径在上一轮（加隔离口之前）已实测。
