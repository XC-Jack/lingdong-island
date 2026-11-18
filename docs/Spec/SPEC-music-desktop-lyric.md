# SPEC-music-desktop-lyric：「词」按钮三态——面板 / 桌面歌词 / 关

- 日期：2026-11-18
- 分支：`island-ux-tweaks`
- 背景：用户 2026-11-18「点第一次词，是显示歌词面板，点第二次是召唤音乐软件字幕在桌面上（截图：网易云桌面歌词条）」。用户确认采用三态循环。

## 一、目标

「词」按钮按一下走一步，循环：

1. 关 → **岛内歌词面板**（现状）
2. 面板 → **关闭面板 + 打开网易云桌面歌词**（等价于网易云 Ctrl+D）
3. 桌面歌词开着 → **关闭桌面歌词**（回到 1 的状态机起点）

按钮高亮（`.on`）表示「当前有歌词显示」（面板开或桌面歌词开）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/neteaseCdp.ts` | `NeteaseCdpState.desktopLyric`；`STATE_EXPR` 顺带读桌面歌词开关（`span.cmd-icon-lyric_on/off`，取可见的那个）；`setNeteaseDesktopLyric(on)`：读当前值 → 需要时点 `button.lyric-icon` → 复读 |
| `src/main/musicStore.ts` | `MusicState.desktopLyric` 合并/比较；`ipcMain.handle('music:desktop-lyric')` |
| `src/shared/types.ts` | `MusicState.desktopLyric: boolean \| null` |
| `src/preload/index.ts` | `musicDesktopLyric(on)` |
| `src/renderer/src/App.tsx` | 「词」按钮三态循环；桌面歌词状态来自 `music.desktopLyric`；无 CDP 时降级为「只开合面板」 |

**不改**：歌词面板本身、`lyricOpen` 的 × 关闭、网易云 UI 的其它按钮。

## 三、预期行为

1. 有 CDP：三态循环如目标所述；切到桌面歌词时面板关闭；关闭桌面歌词后按钮不高亮。
2. 桌面歌词开关以**网易云页面实际状态**为准：用户手动 Ctrl+D 后，岛上按钮下一次轮询（≤1 秒）跟上。
3. 无 CDP（网易云没跑/端口没开/档位关闭）：点「词」只开合面板，不发桌面歌词请求；按钮 `title` 说明需要先开启后台控制。
4. 切到别的页再回来：桌面歌词状态仍准确（来自轮询，不依赖本地记忆）。

## 四、必要依赖

网易云 3.1.41.205564 的页面结构（已实测 `span.cmd-icon-lyric_on[title="桌面歌词（Ctrl + D）"]`，外层按钮 `.lyric-icon`）。属 CDP 既有能力，无新依赖。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck`、`npm run build` EXIT=0 |
| A2 | 有 CDP 时点「词」：面板开 → 面板关且网易云桌面歌词出现 → 桌面歌词关闭 |
| A3 | 三态切换后按钮 `.on` 状态与「面板开 / 桌面歌词开」一致 |
| A4 | 桌面歌词状态在网易云侧手动切换后 ≤2 秒同步到 `musicGet().desktopLyric` |
| A5 | 无 CDP 时点「词」只开合面板，无报错、无 CDP 异常日志刷屏 |

## 六、不做什么

- 不改网易云桌面歌词的样式/字体/位置。
- 不为其他播放器实现桌面歌词。
- 不在岛内自绘桌面歌词。

## 七、自检记录

自检日期 2026-11-18，分支 `island-ux-tweaks`，dev 构建 + 隔离 userData + 真实网易云 3.1.41.205564（9222）。

| 编号 | 结果 |
|---|---|
| A1 | **通过**：`typecheck` / `build` EXIT=0 |
| A2 | **通过**：点「词」第一下面板开；第二下 `.music-panel` 去掉 `lyric-open` 且 `musicGet().desktopLyric` 从 `false` 变 `true`（网易云图标类名 `cmd-icon-lyric` → `cmd-icon-lyric_on`）；第三下变回 `false` |
| A3 | **通过**：第二态 `.music-word` 带 `on`，第三态去掉 `on` |
| A4 | **部分**：开关状态由同一份 `STATE_EXPR` 每秒轮询带回，与手动 Ctrl+D 读的是同一个图标类名；但「用户在网易云里手动切」这条没有单独点一遍。**推断** ≤1 秒同步，未实测 |
| A5 | **通过**：无 CDP 时 `music:desktop-lyric` 返回 `null`，渲染层只开合面板；`e2e-music` 在此路径下 **48 过 / 0 败** |

**隔离口**：`ISLAND_NO_DESKTOP_LYRIC=1`（`scripts/isolate-userdata.mjs` 默认设置）让 IPC 直接返回 `null`，e2e 不会真去开用户网易云的桌面歌词。A2 的三态实测在本变量加入**之前**完成（否则测不了），测试结束已确认桌面歌词回到关闭。

**已知风险**：选择器绑定网易云 `data-testid=tid_playbar_lyric_btn` 与图标类名后缀；对方改版后读不到状态会让按钮退回纯面板开合（不报错）。
