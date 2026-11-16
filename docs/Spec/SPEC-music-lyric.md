# SPEC：音乐页歌词（联网查询 + 滚动高亮）

状态：进行中（2026-11-16）
分支：`music-lyric`（基线 `main@3a68dff`）
提出人：用户（m04986「我们现在来开发歌词吧，你有什么好的想法吗，可以直接读取当前软件播放时的歌词吗」）
授权：用户 m05013「可以按你的来」（同意联网把歌名+歌手发到 lrclib.net 查歌词）

## 一、目标

把音乐页右栏的「暂无歌词」占位换成**真的歌词**：按播放进度自动滚动、当前行高亮，播到哪句亮哪句。

## 二、修改范围

1. `src/main/lyricStore.ts`（新建）：歌词查询与缓存。
2. `src/main/index.ts`：注册 IPC。
3. `src/preload/index.ts`：暴露 `lyricGet`。
4. `src/shared/types.ts`：新增 `LyricLine` / `LyricResult` 类型。
5. `src/renderer/src/App.tsx`：歌词栏渲染 + 当前行高亮 + 自动滚动。
6. `src/renderer/src/styles.css`：歌词行样式。
7. `scripts/e2e-music.mjs`：改写 U4，新增歌词相关断言。
8. 文档：`docs/facts/功能清单.md`、`docs/facts/数据规则.md`、`docs/facts/技术方案.md`、`docs/状态.md`。

## 三、预期行为

1. 换歌后自动去 `lrclib.net` 查歌词，命中则右栏显示带时间轴的歌词，当前行高亮并居中滚动。
2. 播放进度推进时高亮行跟着走；暂停不动；拖动进度条后立刻跳到对应行。
3. 查过的歌按 `歌词文件` 落地缓存，同一首歌第二次直接读本地，秒出且断网可用。
4. 查不到 / 网络失败 ⇒ 右栏仍显示「暂无歌词」，并附一行更具体的说明（如「这首歌在歌词库里没找到」）。
5. **绝不编造歌词**；纯音乐（instrumental）直接显示「纯音乐，没有歌词」。

## 四、必要依赖

无新增 npm 依赖。歌词源为公开免费接口 `https://lrclib.net/api/`（不需要 key、不需要注册）。
联网只发生在换歌时，且只发送歌名、歌手、专辑名、时长四个字段。

## 五、验收条件

1. `npm run typecheck` / `npm run build` 通过。
2. e2e 断言：歌词面板在打开「词」栏后能出现若干行；当前行唯一且随时间推进而前进；无歌词时仍显示占位文案；不出现 `.music-lyrics` 之类伪造容器。
3. 断网时不崩、不卡（超时后回落占位）。
4. 缓存文件确实落盘（`userData/lyrics/*.json`），第二次打开不再发请求。

## 六、不做什么

1. 不逆向汽水音乐 / 网易云的私有接口，不读它的加密缓存。
2. 不做歌词翻译、不做双语对照、不做卡拉 OK 逐字。
3. 不做手动粘贴歌词的编辑界面（本轮不做，后续如需另开 SPEC）。
4. 不改音量、进度、控制行等既有交互。

## 七、实现记录与自检

### 7.1 实现（提交 `243304b`，2026-11-16 19:10）

1. 新增 `src/main/lyricStore.ts`：缓存键 = 歌名/歌手/专辑/时长 的 sha1；`userData/lyrics/<key>.json` 懒建；`/api/get` 精确查 → `/api/search` 打分（歌名 60/40、歌手 25/15、时长 20/12，差 >8 秒直接淘汰）→ 都失败就给具体原因。
2. 只认 `syncedLyrics`：没有时间轴的歌词一律当没有（滚不起来反而误导）。
3. `src/shared/types.ts` 加 `LyricLine` / `LyricResult` / `LyricQuery`；`src/preload/index.ts` 暴露 `lyricGet()`；`src/main/index.ts` 在 `setupMusicStore()` 后调 `setupLyricStore()`。
4. 渲染层只在「歌词栏打开 + 有歌名」时查，换歌按 key 去重；当前行 = `time <= live + 0.15` 的最后一行；滚动用 `scrollTo`（不用 `scrollIntoView`，会把整岛一起滚）。

### 7.2 第十五轮修正（2026-11-16 19:20，用户 m05419）

用户原话：「以我截图的区域为参考，这个范围都可以显示歌词，而且是像音乐软件那样，一条一条出来，不是txt这样揉成一团」。

改前实测：歌词滚动区只有 `84px`（视觉 63px）、行高 13.1、字号 12px，一屏 4 行且挤在一起。

改动：

1. `.music-lyric-scroll`：`max-height:84px` → `flex:1 1 auto; min-height:168px; max-height:none; gap:6px`。
2. `.music-lyric-row`：字号 `12px → 14px`、`line-height 1.45 → 1.5`、未选中色 `0.34 → 0.32`；`.active` `12.5px → 15px`。
3. `.music-panel.lyric-open .music-main` 加 `height:168px`（布局 px，视觉 126）——**必须给确定高度**，否则 `.music-main` 是 auto，右栏会被 39 行歌词撑到 786px，岛顶到 max-height 后整块被裁掉（实测 `ctlRow.y=853.2` 跑到岛外）。
4. 居中算法重写：原来的 `row.offsetTop - box.clientHeight/2 + row.clientHeight/2` 用的是旧 `clientHeight`，开栏瞬间/字号变化后实测偏移 −59.4 与 +54.9 px。改成按 `getBoundingClientRect` 求「行中心 − 框中心」的差值再补，循环两遍；另加一个 `[lyricOpen]` 的 effect，在 `rAF` / `260ms` / `700ms` 各对一次。

改后实测（`.tmp/lyric-measure.mjs`、`.tmp/lyric-center3.mjs`）：岛 `401.4×268.6`、`main/side/slot/scroll` 高均 126（视觉）、`rowCount 39`、`rowH 15.8`、`rowFS 14px`、`visibleRows 5`；当前行中心偏移 `NOW 1.2` / `SEEK90 1.4` / `SEEK150 -0.8` / `SEEK210 -0.8`。

### 7.3 自检

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | EXIT=0（node + web 两个 project） |
| 构建 | `npm run build` | EXIT=0 |
| 歌词 e2e | `node scripts/e2e-music.mjs` | PASS 48 过 / 0 败（U4/U4b/U4c 全绿） |
| 会话 e2e | `node scripts/e2e-music-session.mjs` | PASS 20 过 / 0 败 |
| 页头 | `node scripts/e2e-head-order.mjs` | PASS 14 过 / 0 败 |
| 美化 | `node scripts/e2e-beautify-04.mjs` | PASS 27 过 / 0 败 |

### 7.4 未核验

1. 真人观感（滚动动画是否顺滑、字号是否合适）——只有本机开发实例截图，等用户验收。
2. 安装版：本轮之后未重新打包装机，安装版里仍是只有「暂无歌词」占位的那版。
3. 长歌词（几百行）时的滚动性能与内存——本次样本 39 行，未做压测。