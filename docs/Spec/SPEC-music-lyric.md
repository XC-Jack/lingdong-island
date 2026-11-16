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
### 7.5 第十六轮修正（2026-11-16 19:45，用户 m05562）

用户原话：「歌词播放没有中心感，在上面播放，完全看不到，而且喝唱的对不齐，」

三条症状分别落到两处真问题：

1. **没有中心感 / 在上面播放**：歌词滚动区没有上方留白，歌开头几句根本滚不上去，`scrollTop` 顶在 0，
   当前行只能贴在框顶，再被上方 14px 的渐隐吃掉一半。实测 `offset` 只有 −34.3（本应 ≈0）。
   修法：滚动区上下各垫「（框高 − 行高）/ 2」的空白，写成 CSS 变量 `--lyric-pad`，由渲染层按实测行高写进
   `.music-lyric-scroll` 的 `padding-top/bottom`。实测改后歌首第一句 `offset` 从 −34.3 变 1.1，全程在 1~2 px 内。
2. **唱的对不齐**：两层原因叠加 ——
   ① 桥接层把 `TimelineProperties.Position` 直接当当前位置，但那个值只是「`LastUpdatedTime` 那一刻」的位置，
   播放器并不每秒刷新它（实测假会话 6.6 秒才跳一次，汽水音乐暂停时 `lastUpdAge` 甚至到 159 秒）。
   修法：`src/main/smtcScript.ts` 的 poll 块里，播放中按「`Position` + (现在 − `LastUpdatedTime`)」补上真实流逝，
   夹在 `0..EndTime`；暂停不动。
   ② 渲染层原来用 `setInterval(1000)` 每秒给 `live + 1`，与快照节奏无关，误差会累积。
   修法：`liveBaseRef` 记「快照位置 + 收到它的 `performance.now()`」，每 250ms 按真实流逝时间外推，
   每次新快照重设基准（误差不累积），外推最多超前 0.9 秒。
3. e2e 的 U4b 跟着放宽：允许高亮行落在「快照对应行」到「快照 + 1.6 秒对应行」之间（渲染层外推是故意的）。

改后实测（`.tmp/lyric-align2.mjs`，假会话「听海/张惠妹/318s」连采样 8 次）：`snap` 与高亮行时间轴同步前进
（`258→250.16`、`260→258.88`、`267.1→265.57`、`269.1→269.17`），当前行居中偏差 1.1~2.5 px，
`--lyric-pad` = `75px`。

自检：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` **PASS 48 / 0**、`e2e-music-session` PASS 20/0、
`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0。

未核验：①真人观感（是否真的「唱到哪句亮哪句」）；②真实汽水音乐播放时 `LastUpdatedTime` 的刷新粒度（假会话已验，
真播放器未单独采样）；③安装版未重新打包。
### 7.6 第十七轮修正（2026-11-16 20:25，用户 m05794）

用户原话：「我记得我电脑上是由rea工具的，你看看能不能使用，我换了一个软件网易云，歌词进度条封面都直接卡住了，还有就是有一些哥的歌词直接就是乱码，解决一下」

两个独立问题，都已定位到根因并有实测证据。

1. **部分歌词乱码＝逐字时间轴没剥干净**。lrclib 有一部分歌返回的是 Enhanced LRC（word-level / A2 格式），
   原始行长这样（`/api/search?q=美人鱼 林俊杰` 实测，id `34215590`）：
   `"[00:00.00]<00:00.000>美<00:00.352>人<00:00.704>鱼<00:01.056> <00:01.408>-..."`。
   `parseLrc` 原来只用 `timeRe` 剥 `[...]`，`lastEnd` 停在最后一个方括号末尾，后面整串 `<mm:ss.xxx>` 被当成歌词正文。
   修法：`src/main/lyricStore.ts` 新增 `const wordRe = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g`，
   `const text = line.slice(lastEnd).replace(wordRe, '').trim()`——**删标记保留文字**，不能丢整行（同行 `<...>` 之间夹着真字）。
   同时新增 `const CACHE_VERSION = 2`：`readCache` 认 `raw?.version !== CACHE_VERSION` 就当没有，`writeCache` 写版本号。
   理由：陈年乱码已经写进 `%APPDATA%\lingdong-island\lyrics\*.json`，只改解析不失效缓存等于没修。
   独立验证（`.tmp/lyric/test-parse.mjs`，用改后同款逻辑跑样本）：5 行全部正确，`BAD=0`（无 `<`/`>` 残留）。

2. **网易云进度条/歌词「卡住」＝它根本不往系统写时间轴**。用 `.tmp/lyric/ne-long.ps1`（`Windows.Media.Control` 直读）
   每 2 秒采一次、连采 30 次：`app=cloudmusic.exe status=Playing title=[晚安] pos=0 end=0 start=0
   lastUpd=08:00:00.000 canSeek=False thumb=True`——`lastUpd` 是 `DateTimeOffset` 默认值（1601-01-01），
   60 秒内纹丝不动。汽水音乐同一支脚本会正常报 `pos/end`。也就是说网易云只写 歌名/歌手/封面，永远不写进度。
   于是 `duration` 恒为 0 ⇒ `pct` 恒 0、两端显示 `0:00 / -0:00`，看着就是「卡住」。
   修法：`src/renderer/src/App.tsx` 加 `const noTimeline = music?.active === true && music.duration <= 0`，
   该状态下两端 `.music-time` 都显示 `--:--`、各自带 `title="这个播放器没向系统报告播放进度"`；
   外推 effect 加早退 `if (music.duration <= 0) return`。**如实降级，不假装在走**。
   e2e 的 U5 断言「右端是 -mm:ss」，所以只有降级态才换文案，正常播放器不受影响。

试过但走不通的路（记录下来，别重试）：
- 网易云本地端口 `127.0.0.1:20017`（唯一监听）既不是 HTTP API 也不是 CDP：`GET /` → 404 空 body、`POST /api` → 405、
  其余 15+ 路径全部 1500~2000ms `AbortError`、`ws://` 连不上。
- UIA：`OrpheusBrowserHost` 窗口 `Name=[Rolling in the Deep - Adele]`，但 `TreeScope.Descendants` 只有 4 个元素，
  唯一具名的是 `Chrome_RenderWidgetHostHWND [Chrome Legacy Window]` ⇒ CEF 内容不可达。
- 本地数据：`localdata` 是加密乱码、`Library\webdb.dat` 被进程占用，`webdata\file\playingList` 是明文 JSON
  但只有播放列表（无实时位置），`configCenter` 里搜 `smtc/mediaKey/systemMedia/timeline` 无命中。
- 未装 BetterNCM（安装目录无 `plugins`），启动参数无 `--remote-debugging-port`，无 `DevToolsActivePort`。

改后实测（预览版 + 真实网易云，`.tmp/word/ne-verify2.mjs`）：
`STATE={"t":"Love Song","ar":"方大同","app":"cloudmusic.exe","pos":0,"dur":0,"pl":true}`，
`TIMES=[{"txt":"--:--","title":"这个播放器没向系统报告播放进度"},{"txt":"--:--",...}]`，`BAR=matrix(0,0,0,1,0,0)`；
同一状态下 `musicGet()` 的封面仍是合法 JPEG（2581 字节，头 `FF D8 FF E0`），歌名/歌手正常刷新。
歌词侧 `lyricGet({title:'美人鱼',artist:'林俊杰',album:'',duration:254})` → `{ok:true, source:'lrclib', n:63, bad:0}`。

自检：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` **PASS 46 / 0 / 1 跳过**（U5 绿色，说明降级分支没影响正常播放器；
U4b/U4c 因本次会话没查到带时间轴的歌词而跳过）、`e2e-music-session` PASS 20/0、`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0。

未核验：①网易云若某天开始写时间轴，降级态会自动消失（未到那天，无法验证）；②真人观感（`--:--` 是否比 `0:00` 更好懂）；
③安装版未重新打包；④REA 已确认可用（`rea-agents 6.8.0` + Ghidra 12.1.4 + JDK 21 全 ok），但需要具体目标文件路径才能开工，本轮未使用。
---

## 八、第十八轮（2026-11-16 20:45）歌词源换网易云 + 进度自己算（用户 m06116）

用户原话：「> --:-- 你用这个我怎么看播放时间，我不知道你用这个干嘛；然后音乐字幕不会自己跟着音乐滚动，我都不知道你干了什么，问题一个没解决；而且我现在播的都是官方歌曲，根本不是翻唱，你去找的歌词对不上，要不然就没有，一堆问题 你说可以用rea，那就直接用；需不需要新开对话试验」

四条逐条对应，全部改在 `music-lyric` 分支上：

1. **歌词对不上 / 找不到 ⇒ 换歌词源**。lrclib 是国外社区库，中文歌大量只有翻唱版或干脆没有；
   实测 `?track_name=就忘了吧&artist_name=刘大拿` → 0 条。改用**网易云自己的公开接口**：
   - 搜索 `https://music.163.com/api/search/get/web?s=<歌名 歌手>&type=1&limit=10&offset=0`，
     必须带 `Referer: https://music.163.com/`（缺了会被拒）。
   - 歌词 `https://music.163.com/api/song/lyric?id=<id>&lv=1&kv=1&tv=-1` → `lrc.lyric`，标准 `[mm:ss.xxx]`。
   - 8 个实测用例命中 6 个且全是官方原词（含 `눈, 코, 입/TAEYANG` 的**原版韩语**，lrclib 给的是罗马音）；
     另外 2 个（`就忘了吧`、`带刺伤人的蔷薇`）是库里本身就只有 DJ 版/别首歌，属内容缺失而非匹配失败。
   - 顺序：缓存 → 网易云 → lrclib（备用）→ 诚实占位。`CACHE_VERSION` 3→4→5（换源、加 duration、补署名前缀各一次）。

2. **`--:--` 是逃避 ⇒ 进度自己算**。网易云不报时间轴（第七节实测 30 次 `pos=0 end=0`），
   于是从歌词库拿**总时长**（`LyricResult.duration`），再自己按真实流逝时间累加：
   `ownBaseRef = {title, at, start}` + `setInterval(250)` 外推，`shownPos = playerNoTimeline ? ownPos : live`。
   只有在「播放器没给时间轴 **且** 歌词库也没有时长」这种双缺失下才退回 `--:--`。

3. **歌词不跟着滚 ⇒ 高亮判定改用 shownPos**。原来 `lyricActive` 判 `lines[i].time <= live + 0.15`，
   而网易云场景 `live` 恒为 0 ⇒ 永远只亮第一行。改判 `<= shownPos + 0.15` 后才会一句句往下走。

4. **REA**：已确认本机可用（`rea-agents 6.8.0`、Ghidra 12.1.4、JDK 21.0.13），
   但本轮没用到——问题根源是「取数源选错」和「进度没算」，不是二进制里有什么秘密，
   动反编译工具属于杀鸡用牛刀。REA 留给真正需要（比如将来要扒某个播放器的私有接口）时再上。

顺带修掉的署名行问题：网易云 LRC 开头是 `[00:15.638]出品：网易飓风` `[00:15.638]营销：网易飓风`
`[00:15.638]OP：唯迹文化` 这类署名，时间戳都是 15.638（不是 0 秒）。
旧过滤规则是「前 15 秒内 + 特定前缀」，正好卡在窗口外全部漏掉，于是歌词第一行显示「出品：网易飓风」。
现在：**特异前缀（出品/营销/OP/编曲…）不限时间**，**单字前缀（词/曲）只限前 20 秒**，避免误删正文。

### 8.1 自检与实测

- `npm run typecheck` EXIT=0、`npm run build` EXIT=0。
- `node scripts\e2e-music.mjs` **PASS 44 过 / 0 败 / 2 跳过**（U4c 因当前播放器不支持 seek 跳过、M4a–M4c 因总时长未知跳过）。
- `node scripts\e2e-music-session.mjs` PASS 20/0、`node scripts\e2e-head-order.mjs` PASS 14/0、`node scripts\e2e-beautify-04.mjs` PASS 27/0。
- 歌词逐曲实测（预览版 9321，`window.island.lyricGet` 直调）：
  `红/罗言` → `{ok:true, src:'netease', n:32, dur:161.6, first:'爱上了一个人眼睛不说谎'}`；
  `눈, 코, 입/TAEYANG` → `{n:62, dur:230, first:'미안해 미안해 하지마'}`；
  `Love Song/方大同` → `{n:67, dur:269.3, first:'我写了这首歌'}`；
  `美人鱼/林俊杰` → `{n:54, dur:254, first:'美人鱼'}`；
  `Rolling in the Deep/Adele` → `{n:53, dur:228.1, first:"There's a fire starting in my heart"}`；
  `晚安/颜人中` → `{n:43, dur:289.2, first:'窗挡住月色 贪恋的交集'}`。

### 8.2 e2e 断言修正（本轮暴露的两处错断言）

1. **U4 死要求 `actives === 1`**：前奏还没开始唱时不该有任何一行亮着。改为三分支判定——
   没词（占位+原因）/ 有词且唯一高亮 / 有词但位置还没到第一句（`actives === 0` 合法）。
2. **U4b 死要求 `expectIdx >= 0`**：同理，`pos` 早于第一句时 `expectIdx` 天然是 -1。
   新增 `beforeFirstLine = pos + 1.6 < times[0]`，该分支下要求 `activeIdx === -1`。

这两条以前能过，是因为碰巧用的歌第一句都在 0~2 秒；换成网易云的正常歌（第一句 15.6 秒）就暴露了。

### 8.3 未核验

1. 网易云对超新歌/纯音乐仍可能 0 条，此时会走 lrclib 再占位，覆盖率没有统计口径。
2. 自己算的进度是「从 0 开始按墙钟累加」，用户中途拖播放器进度条时无法感知（网易云不报位置）；只能靠换歌重置。
3. 安装版未重新打包（仍在跑 `3a68dff` 那版，不含歌词功能）。
## 九、第十九轮修正（2026-11-16 21:05，用户 m06418「歌词依旧没反应」）

### 9.1 先说结论：不是没反应，是前奏期本来就一句都不该亮

用户截图停在《戒烟》第 14 秒，右栏一片灰、没一行亮。连采 12 次（每 1.5 秒一次）实测：
`times` 从 `0:01` 正常累加、`rows:51`，但 `act:0` 全程为 0，`firstT:"20.97"`。
等过 21 秒再采 6 次：`act:1`，`actTxt` 依次 `你给过我的伤害` → `是没有一句责怪` → `戒了烟 染上悲伤`
⇒ **高亮与滚动其实是正常工作的**，只是这首歌第一句在 20.97 秒。

网易云原始 LRC（id `518686034`，`dur=293875`，62 行）首四行是
`[00:00.00] 作词 : 李荣浩` / `[00:01.00] 作曲` / `[00:02.00] 编曲` / `[00:03.00] 制作人`，
第五行才是 `[00:20.97]已经为了变的更好去掉锋芒` —— 署名已正确过滤，**前 21 秒本来没有词可唱**。

### 9.2 改动（两条，都只解决「看着像坏了」）

1. 前奏期把第一句提亮一档：新样式 `.music-lyric-row.next`（`color: rgba(242,243,245,.66)`、`font-weight:600`），`className` 里加 `${preludeLeft > 0 && i === 0 ? ' next' : ''}`。
2. 歌词栏底部加一行倒计时：`<span className="music-lyric-tip music-lyric-prelude">前奏中 · 还有 {Math.ceil(preludeLeft)} 秒开唱</span>`，只在 `preludeLeft > 0` 时渲染。`preludeLeft = lyricLines.length > 0 && lyricActive === -1 ? Math.max(0, lyricLines[0].time - shownPos) : 0`。

`preludeLeft` 必须定义在 `lyricActive` **之后**（它依赖 `lyricActive === -1`）——第一次插在前面触发 `TS2448: Block-scoped variable 'lyricActive' used before its declaration`，已调到后面。

### 9.3 实测（预览版 + 真实网易云《海屿你》/马也_Crabbit，第一句 13.47 秒）

| 采样 | rows | act | next | prelude | 进度两端 |
|---|---|---|---|---|---|
| P0 | 74 | 0 | 1（`从不主动示弱`，`rgba(242,243,245,0.66)`） | 前奏中 · 还有 10 秒开唱 | 0:03 / -4:52 |
| P1 | 74 | 0 | 1 | 前奏中 · 还有 8 秒开唱 | 0:06 / -4:49 |
| P2 | 74 | 0 | 1 | 前奏中 · 还有 5 秒开唱 | 0:08 / -4:47 |
| P3 | 74 | 0 | 1 | 前奏中 · 还有 3 秒开唱 | 0:11 / -4:44 |
| P4 | 74 | **1**（`从不主动示弱`） | 0 | null | 0:13 / -4:42 |

⇒ 倒计时逐秒递减、到点自动切成正常高亮、`next` 标记同步消失。

### 9.4 自检

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（node + web） |
| `npm run build` | EXIT=0（`✓ built in 125ms`，`index-B_FFMuB9.js` 123.88 kB） |
| `node scripts/e2e-music.mjs` | **PASS 44 过 / 0 败 / 2 跳过** |
| `node scripts/e2e-music-session.mjs` | PASS 20 过 / 0 败 |
| `node scripts/e2e-head-order.mjs` | PASS 14 过 / 0 败 |
| `node scripts/e2e-beautify-04.mjs` | PASS 27 过 / 0 败 |

### 9.5 未核验

1. 前奏特别长的歌（>30 秒）倒计时读起来是否烦人，没批量试。
2. 安装版未重新打包（仍跑 `3a68dff` 那版，不含歌词功能）。
3. 真机上用户拖动播放器进度条时，「自己算的进度」无法感知（网易云不报位置），这条从第十八轮起一直未解。
## 十、第二十轮修正（2026-11-16 21:45，用户 m06607）

用户原话：「现在的问题我很你说一下，音乐已经播了一半了，然后我每次点到歌曲页面，进度条都会重新开始，字幕也是，而且进度条我也点不了」。

### 10.1 三条症状的真因（均已实测确认）

1. **切页归零**：`src/renderer/src/App.tsx` 的页面是条件渲染（`page === 0 ? <TodoPanel/> : ... : <MusicPanel/>`），切走时 MusicPanel **整块卸载**，`live`/`ownPos` 等组件内 state 与 `ownBaseRef` 全部丢失；切回来重新挂载，自算进度从 0 重新开始。
2. **字幕跟着回到第一句**：`lyricActive` 用 `shownPos` 判定（`lyricLines[i].time <= shownPos + 0.15`），shownPos 归零后高亮自然回第一句。
3. **进度条点不了**：`onSeekPointerDown` 原门槛是 `if (!music?.canSeek || music.duration <= 0 || busy) return`，`seekable` 类也要求 `music?.canSeek && duration > 0`。网易云实测 `canSeek=false`、`duration=0`，两个条件全假 ⇒ 永远不可点。

### 10.2 改动

1. **模块级进度钟**（`src/renderer/src/App.tsx` 顶层，`MusicPanel` 之外）：`progressClock`（`key / startAt / startPos / playing`）+ `clockKeyOf()` + `clockNow()` + `clockSync()` + `ensureClockWatcher()`。`clockSync` 的规则：未激活清空；播放器报 `duration > 0` 时以播放器 `position` 为基准整体重设；换歌（title|artist 变）从头算；播放/暂停切换时先冻结 `clockNow()` 再从冻结值继续。`ensureClockWatcher()` 幂等，内部 `musicGet()` 一次 + `onMusicState` 常驻订阅——**所以人不在音乐页也能记准暂停与继续**。
2. **替换组件内自算进度**：删 `ownPos` / `ownBaseRef` 及其两个 effect，改 `const [, setClockTick] = useState(0)` + 250ms `setInterval` 触发重渲染；`shownPos = playerNoTimeline ? clockNow() : live`——切页回来直接读模块级钟。
3. **让进度条可点**：新增 `const canSeekNow = totalDur > 0 && !busy`；`secAt()` 改用 `totalDur`（原来用 `music.duration`，网易云恒 0 时永远返回 0）；`onSeekPointerDown` 门槛改 `if (!canSeekNow) return`；`onSeekPointerUp` 在 `playerNoTimeline` 时先把钟挪到目标秒（`progressClock.startPos = sec` 等）再 `ctl({ cmd:'seek', ... })`，否则界面会弹回原位置；`seekable` 类改 `totalDur > 0`。

### 10.3 实测（预览版 CDP + 真实网易云会话）

| 场景 | 结果 |
|---|---|
| 停在音乐页 4 秒 | 时间 `0:04 → 0:08`，`seekCls="music-seek seekable"` |
| 切到待办页 6 秒后再切回 | 时间 `0:20`（**没归零**），高亮 `act:2` 指向「为何总沉默寡言」（**没回第一句**） |
| 点进度条 75% 处 | `SEEK` 命中 `music-bar`、`seekable` 生效；点击后 `E {"act":26,"actTxt":"子母画面分割上演谍对谍","times":["3:22","-1:06"]}`，2.5 秒后 `F {"act":26,"times":["3:24","-1:04"]}` ⇒ **界面立刻跳过去并继续走** |

### 10.4 自检

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（node + web） |
| `npm run build` | EXIT=0（`✓ built in 138ms`，`out/renderer/assets/index-hRw8z8Jc.js` 125.88 kB） |
| `node scripts/e2e-music.mjs` | **PASS 44 过 / 0 败 / 2 跳过** |
| `node scripts/e2e-music-session.mjs` | PASS 20 / 0 |
| `node scripts/e2e-head-order.mjs` | PASS 14 / 0 |
| `node scripts/e2e-beautify-04.mjs` | PASS 27 / 0 |

### 10.5 未核验 / 已知限制

1. **网易云不响应 SMTC seek**：`musicControl({cmd:'seek'})` 返回 `ACK=true`（桥接层 `TryChangePlaybackPositionAsync` 真的返回 true），但连采 45 秒 `position` 恒为 0、歌名未变 ⇒ SMTC 层谎报成功。所以点进度条后**只有我们自己的钟跳过去**，播放器本身不会真跳。这是网易云自身缺陷，不是本轮改动能修的。
2. 汽水音乐等正常报时间轴的播放器本轮未复测切页场景（其 position 由播放器提供，理论上不受模块钟影响）。
3. 安装版仍未重新打包，用户机器上跑的是 `3a68dff` 那版（不含任何歌词功能）。

### 10.6 第二十轮补记（2026-11-16 22:05，e2e 断言口径修正）

`scripts/e2e-music.mjs` 的 U4b 原来拿主进程快照 `musicGet().position` 当对齐基准。网易云**从不向系统上报进度**（`position` 恒 0），界面上显示的是我们自己按墙钟算的秒数，于是「界面高亮在第 34 行、快照说还在 0 秒」被误判成错位（实测输出 `{"pos":0,"expectIdx":-1,"activeIdx":0,"beforeFirstLine":true}`）。

改成以**界面显示的 `.music-time` 左端**为基准（新增 `shownSec`，取不到才回退快照），并把上面那段「快照外推」的过时注释改准。改后 `e2e-music` PASS 44 过 / 0 败 / 2 跳过。

## 十一、第二十一轮修正（2026-11-16 22:30，用户 m06991）

用户原话：「你自己看吧，我说音乐播放没对齐，还没解决吗，我点击 音乐条音乐不会跟着音乐条同步，现在知识字幕同步了而已」。

### 11.1 我上一轮做错了什么

`c01c8fa` 里为了「进度条点得动」，在 `onSeekPointerUp` 里加了一段：点击后先把模块级进度钟 `progressClock` 挪到目标秒。结果界面立刻跳过去了、歌词也跟着跳，**但音乐本身一动不动**——这就是用户抓到的「只是字幕同步了而已」。这是假同步，必须撤掉。

### 11.2 决定性证据

| 探针 | 输出 | 结论 |
|---|---|---|
| `.tmp\word\ne-seek-proof.ps1`（目标设成 9999 秒，远超曲末） | `SEEK_9999 ret=True`，随后 5 次采样全部 `status=Paused pos=0 end=0` | 网易云连「夹到结尾」都不做，seek 被彻底忽略，返回值是谎报的 true |
| `.tmp\word\seek-direct.ps1`（直连 SMTC 遍历所有会话） | `S0 app=cloudmusic.exe posWritable=False` / `SEEK target=40 ret=True pos_after=0 moved=False`；`S1 app=汽水音乐 posWritable=True` / `SEEK target=102.5 ret=True pos_after=102.5 moved=True` | 桥接层 `canSeek` 读的 `IsPlaybackPositionEnabled` 是准的：网易云 false、汽水音乐 true |
| `musicGet()` 网易云态 | `{"pos":0,"dur":0,"cs":false}` | 位置、时长、可跳三项全为假，只有歌名/歌手/封面是真的 |

### 11.3 改了哪几处

1. `src/renderer/src/App.tsx` 的 `canSeekNow` 由 `totalDur > 0 && !busy` 改回 **`!playerNoTimeline && totalDur > 0 && !busy`**：播放器不接受跳转时，进度条不给 `seekable`、悬停不变手型。注释里写全了上面那份实测证据。
2. 删掉 `onSeekPointerUp` 里「把 `progressClock` 挪到目标秒」那段（原 `:2335-2341`），只保留 `seekGuardRef` + `ctl({cmd:'seek'})`。
3. `.music-seek` 的 `className` 改用 `canSeekNow`，并新增 `title` 说明三种情况：能跳「点任意位置跳到那里」、不能跳「网易云这类播放器不接受系统的跳转指令，只能听它自己播」、时长未知「总时长未知，暂时不能跳」。
4. `src/main/smtcScript.ts` 的 `PickIndex`：原来只看「谁在 Playing」，多个播放器同时放时先扫到谁就用谁 —— 用户截图里网易云在前台播《天使的翅膀》，岛上却显示后台汽水音乐的《Take Me Hand》。改成：单个在播就用它；多个在播时，优先**有可见顶层窗口**（`MainWindowHandle != 0`，摆用户眼前的那个），都没有可见窗口再退回第一个。新增 `VisibleApps()` 带 3 秒缓存（poll 每秒一次，扫全进程不免费但也不能让窗口切换几分钟才生效）。

### 11.4 实测

| 场景 | 结果 |
|---|---|
| 汽水音乐在播（`canSeek=true`） | `SEEKBAR={"cls":"music-seek seekable ","cursor":"pointer","title":"点任意位置跳到那里","times":["0:53","-2:21"]}`；点 70% 处 → `["2:18","-0:57"]`，`musicGet().pos=137.3` 同步，`dur=195.3` |
| 网易云在播（`canSeek=false`） | `SEEKBAR={"cls":"music-seek  ","cursor":"default","title":"网易云这类播放器不接受系统的跳转指令，只能听它自己播","times":["0:01","-4:01"]}`；点 70% 处 → `["0:02","-4:00"]`（只是自然往前走 1 秒，**没有被伪装跳转**） |
| 两个播放器同时 Playing | 网易云有可见窗口时岛选网易云（`app=cloudmusic.exe`、`寂寞寂寞不好/曹格`）；改前会选到后台的汽水音乐 |

### 11.5 自检

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（node + web） |
| `npm run build` | EXIT=0（`✓ built in 127ms`） |
| `node scripts/e2e-music.mjs` | **PASS 44 过 / 0 败 / 2 跳过**（U4c 因 `canSeek=false` 走 skip，符合预期） |
| `node scripts/e2e-music-session.mjs` | PASS 20 / 0 |
| `node scripts/e2e-head-order.mjs` | PASS 14 / 0 |
| `node scripts/e2e-beautify-04.mjs` | PASS 27 / 0 |

### 11.6 未核验 / 已知限制

1. **网易云就是不让跳**：这是它自身不实现 SMTC 定位，我们无法修好。现在的行为是如实标明「不能跳」，不再演假跳转。用户若要「点了就真跳」，只能换播放器（汽水音乐可以）。
2. **网易云的播放位置我们看不见**：只能靠歌词库的总时长 + 自己按墙钟累加。用户如果在网易云里手动拖进度、或切歌后我们又拿到旧快照，界面会短暂不准，需要等下一次歌词查询/换歌才对上。
3. 首次跑 e2e-music 出现过 `M3a/M3c` 两败（点主按钮播放状态没翻转）。原因是本机**两个真实播放器同时在放**，`toggle` 落到了另一个会话上；把两个播放器都暂停后重跑 PASS 44/0。这属于测试环境干扰，但也说明多播放器并存确实会让「控制」指向别人——第 11.3 条第 4 点的可见窗口优选就是为它加的。