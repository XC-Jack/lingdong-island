# SPEC：音乐页按参考图重排为两栏布局

- 分支：`music-layout-2`（从 `main@f336149` 新建）
- 用户需求：m03172 发参考图（张学友《吻别》播放页），m03174 原话「根据截图，把音乐页面的布局先做，宽幅不过可以拉长，」

## 一、目标

把音乐页封面行从「封面 + 曲名/歌手 + 右侧一小块歌词位」改造成参考图的两栏结构：**左栏封面 + 曲名/歌手，中间一条竖向分隔线，右栏歌词位**。宽度允许放宽（用户明确说「宽幅可以拉长」）。

## 二、修改范围

1. `src/renderer/src/App.tsx` 的 `MusicPanel()` 返回的 `.music-main` 段：
   - 新增左栏容器 `<div className="music-side">`，把原 `.music-cover` 与 `.music-meta` 包进去；
   - 新增 `<span className="music-divider" aria-hidden="true" />`；
   - `.music-lyric-slot` 从 `.music-main` 的直接 flex 子项改为右栏（结构不变，只是语义位置变了）。
2. `src/renderer/src/styles.css` 音乐段：
   - `.music-main` 改 `align-items:stretch; gap:14px`；
   - 新增 `.music-side`、`.music-divider`；
   - `.music-lyric-slot` 改 `flex:1 1 auto`、去掉 `text-align:right`、`min-width` 提到 160；
   - 各部件按参考图比例放大：封面 44→60、圆角 12→16、内部 svg 22→28；曲名 14px/600→15px/700；歌手 12→12.5px；普通按钮 32→36；主按钮 38→44；进度条 3→5px；时间 11px/0.38→12px/0.42；`.music-meta` 的 `max-width` 200→260。
3. 文档：本 SPEC、`docs/facts/功能清单.md` 音乐节、`docs/状态.md`。

## 三、预期行为

1. 有播放会话时：左栏显示封面 + 曲名（超长出省略号，`title` 悬停可见全文）+ 歌手；中间竖分隔线；右栏显示歌词位。
2. 无播放会话时：封面回粉色音符占位，曲名「未知曲目」，歌手回落为应用名，右栏仍是「暂无歌词」。
3. 岛展开态宽度随之变宽（本次实测从 285 视觉 px 变到 428.4），但仍在 `.island.expanded` 的 `max-width:720px`（视觉 540）上限内，任何部件都不越出岛边缘。
4. 控制行、进度条、音量浮层行为完全不变。

## 四、必要依赖

无新增依赖。全部基于既有 React + CSS。

## 五、验收条件

1. `npm run typecheck` EXIT=0、`npm run build` EXIT=0。
2. `node scripts/e2e-music.mjs` 全 PASS（38 项），**尤其是**：
   - U1 播放按钮在进度条下方控制行、相对整岛居中；
   - U2 音量竖条平时隐形；
   - U3 点喇叭后竖条显现且完整落在岛内；
   - U3b 音量滑块可点命中 ≥20px；
   - U4 封面行右侧只有诚实占位「暂无歌词」，且 `.music-lyric-line / [data-lyric] / .music-lyrics` 数量为 0；
   - U5 进度行右端是负数剩余时间 `-mm:ss`。
3. CDP 实测：`.music-side`、`.music-divider`、`.music-lyric-slot` 三块各自 `getBoundingClientRect()` 都在岛矩形内，`.music-ctl` 中心与岛中心偏差 ≤6px。
4. 截图与参考图对照，两栏结构与竖分隔线可见。

## 六、不做什么

1. **不做歌词功能**。用户 m02341 已实测否决（「歌词完全对不上」），本次右栏仍只放诚实占位「暂无歌词」，不接任何联网/本地歌词源，类名也不使用 `.music-lyric-line`（那是 `e2e-music.mjs` U4 里探测「有没有偷偷接联网歌词」的选择器）。
2. 不动参考图里那些本产品没有的控件：「词」字按钮、「岛上歌词」胶囊按钮、信号格图标、日期显示。
3. 不改控制行的三按钮语义（随机/循环已在 m01006 删除，不复活）。
4. 不改主进程、SMTC 桥接、音量读写逻辑。
5. 不改其它页面的布局与尺寸。

## 七、实现记录与自检

### 7.0 修正（2026-11-16 15:30，用户 m03368「两边分开，你现在还是播放进度条横穿整个页面」）

**第一版做错了**：只把「封面 + 曲名/歌手」与「歌词位」分成两栏，进度条仍留在 `.music-main` 之外的同级位置，所以它横穿整页（从岛左内边距一直到右内边距 390.8 宽），与参考图不符。参考图里进度条只占**左栏**宽度（宽度＝封面+曲名那一块的宽度），右栏是与它并排的整块歌词区。

**改法**：
1. `src/renderer/src/App.tsx`：把 `.music-progress`（含 `.music-seek`、`.music-bar`、`.music-times`）整段移进 `.music-side`，排在 `.music-id` 之后；左侧封面+文字再包一层 `.music-id`。
2. `src/renderer/src/styles.css`：`.music-side` 由 `flex-direction:row` 改 `column`（`justify-content:center; gap:8px`）；新增 `.music-id{display:flex; align-items:center; gap:12px; min-width:0}`。
3. 结构变为：`.music-main` → [`.music-side`( `.music-id` + `.music-progress` ) | `.music-divider` | `.music-lyric-slot` ]。

**改后实测**：`side.w=249`、`progress.w=249`（**两者同宽，进度条不再横穿整页**）、`progress.x=19.8`（左对齐岛内边距）、`divider.x=279.3`、`lyric.x=290.6 w=120`、岛 `428.4×219.1`。改前 `progress.w=390.8`（横穿整行）。

**自检**：`npm run typecheck` EXIT=0、`npm run build` EXIT=0、`node scripts/e2e-music.mjs` **PASS 38/0**（M2a 进度条仍在、M2j 拖拽热区仍在、U1 控制行仍居中）。

### 7.1 尺寸演进（CDP 实测，dev electron 9321 + 假 SMTC 会话）

| 版本 | 封面 | `.music-meta` 上限 | 歌词栏 min | 岛视觉宽 | 问题 |
|---|---|---|---|---|---|
| v1 | 44 | 200 | 120 | 285 | 歌名只剩 46.8 宽，结构与参考图差太远 |
| v2 | 60 | 260 | 160 | 353.4 | 两栏成立，但歌名区仍偏窄 |
| v3（最终） | 60 | 260 | 160 | **428.4** | 歌名区 195、歌词栏 120，两栏比例接近参考图 |

最终实测 `GEOM`：
```
{"island":{"w":428.4,"h":220.6},"layout":"571.133px","main":{"w":390.8,"h":45},
 "side":{"x":19.8,"w":249,"h":45},"cover":{"w":45,"h":45},
 "meta":{"x":73.8,"w":195,"h":29.4},"title":{"w":195,"scrollW":614},
 "divider":{"x":279.3,"w":0.8,"h":45},
 "lyric":{"x":290.6,"w":120,"h":45},
 "progress":{"w":390.8,"h":25.5},"ctl":{"x":161.2,"w":108,"h":34.5},"vol":{"x":389.6,"w":21,"h":21}}
```

### 7.2 自检

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | EXIT=0 |
| 构建 | `npm run build` | EXIT=0（`✓ built in 119ms`） |
| 音乐页 e2e | `node scripts/e2e-music.mjs` | **PASS 38 过 / 0 败** |
| 布局实测 | `.tmp/ml2/probe.mjs` | 三块都在岛内，`ctl` 居中 |
| 截图 | `.tmp/ml2/shot-music-layout.png` | 两栏 + 竖分隔线可见，538×278 |

### 7.3 踩坑

1. **造 SMTC 假会话不能直接跑旧的 `.tmp/osdrag-scene.ps1`**（报 `使用"1"个参数调用"Wait"时发生异常`）。正确姿势：`node .tmp/ml2/extract.mjs` 从 `scripts/e2e-music-session.mjs` 抽出 `SCENE_PS1` 正文、写 UTF-8 BOM 到 `.tmp/ml2/scene.ps1`，再 `$env:E2E_TMP=...` + `Start-Process ... -RedirectStandardOutput`。
2. **`Copy-Item a,b,dest` 静默不复制**：多源拷贝到目录要写成 `Copy-Item -LiteralPath a -Destination dir` 分开写。本轮误把两份源文件拷到了仓库根（`App.tsx`、`styles.css`），已挪到 `.tmp/stray-copies/`，未进提交。
3. 探针里翻页仍不能用 `.dot` 索引，要循环点各 dot 直到 `.panel-title` 是「音乐」，且每次都要重新派发 click 保持展开（自动收起 700ms）。

### 7.4 未核验

- [未核验] 真机（安装版）上的观感与高分屏 DPI 下的实际比例。
- [未核验] 用户对 428.4 这个宽度的接受度（比之前所有页面都宽，用户说「宽幅可以拉长」，但没说上限）。
- [未核验] 真实播放器带专辑封面时，60px 封面会不会因为图片本身比例不同而变形（`.music-cover-img` 用的是既有 `object-fit`，本次未改）。

### 7.5 第三轮修正（2026-11-16 15:45，用户 m03435）

**用户原话**：「如截图，左边的歌名蝙蝠有点宽，可以压缩一点，尽量和右边对称，喇叭移到下一首的右边，所以播放和切换要位于歌名的正下方中心位置，我描述的你理解了没」。

四条要求逐条落地：

1. **左边压缩**：`.music-meta` 的 `max-width` `260px → 140px`（布局 px，视觉约 105）。改前实测歌名块 195 宽、把左栏顶到 249；改后左栏 159（视觉 159）。
2. **左右对称**：`.music-side` 与 `.music-lyric-slot` 都定宽 `212px`（布局 px），分隔线正好落在正中间。实测 `sideVsLyric={"sideW":159,"lyricW":159,"delta":0}`。
3. **喇叭移到下一首右边**：`.music-extra` 由行尾 flex item 改为 `position:absolute; left:calc(100% + 8px)`，相对 `.music-ctl-buttons`（三按钮那一组）定位；按钮 JSX 外包一层 `.music-ctl-buttons` 作定位参考系。
4. **播放/切换位于歌名正下方**：`.music-control-row` 改为与 `.music-main` 同一套分栏 `grid-template-columns: 212px 1px 212px; column-gap:14px`，`.music-ctl` 占左列、`width:100%`，三按钮在列内居中 ⇒ 中心与封面+歌名那块的中心重合。

**关键实测数据** [已核验]：

| 指标 | 改前 | 改后 |
|---|---|---|
| 岛 | 377.4×219.1 | 377.4×219.1（未变宽） |
| `.music-side` 宽 | 249 | **159** |
| `.music-lyric-slot` 宽 | 120 | **159** |
| 两栏宽度差 | 129 | **0** |
| `.music-ctl` 中心 X | 189.6（＝整岛中心） | **99.2（＝左栏中心）** |
| 喇叭左缘 / 下一首右缘 | 吊在整岛最右端 | `volToggle.x=159.2`、`nextBtn.right=153.2`，**间距 6** |

**中途走错一步并已修正** [已核验]：第一版把喇叭 `absolute` 但 `.music-ctl` 仍是整岛宽的 flex 居中，结果 `ctlCX=179.1`、组中心偏了 `-10.5`；第二版只让 `.music-ctl` 等宽左栏、三按钮居中，`ctlCX=99.2` 对齐，但喇叭 `left:100%` 仍在左栏右缘外 6px 处（`volToggle.x=159.2`，视觉上贴到分隔线附近）——这一版即为最终版。**教训：`.music-ctl` 的宽度基准必须是左栏（212 布局 px），不是整岛宽；否则居中算的是整岛中心。**

**e2e 断言的连带修正**（`scripts/e2e-music.mjs`）：U1 原断言「`.music-ctl` 中心与整岛中心差 ≤6」已不成立（基准变了），改为「三按钮组的中心与 `.music-side` 中心差 ≤6」；新增 U1b 断言「喇叭左缘与下一首右缘间距 0~24，且喇叭右缘 < 岛右缘 - 20」（防止它重新吊回最右端）。改后 `E2E MUSIC: PASS 39 过 / 0 败`。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` PASS 39/0（含新 U1b）、`e2e-music-session` PASS 20/0、`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0。

**仍未核验**：

- [未核验] 真机观感（安装版）与高分屏 DPI。
- [未核验] 用户对「歌名块 105 宽」是否够看（长标题仍要省略号，与 m02666 的诉求一致）。
- [未核验] 左栏 159 / 右栏 159 的对称在真实歌词（如果有）长文本下会不会被撑破——当前右栏只有「暂无歌词」四字。

### 7.6 第四轮修正（2026-11-16 15:55，用户 m03577）

**用户原话**：

> 再喇叭右边加一个"词"这样的ui，所有播放和切歌整体要向左移；

**两条要求与做法**：

1. **喇叭右边加「词」按钮** —— `src/renderer/src/App.tsx` 在 `.music-ctl-buttons` 末尾新增 `<button type="button" className="music-word" aria-label="歌词">词</button>`；`src/renderer/src/styles.css` 新增 `.music-word{28×28 · border-radius:10px · rgba(255,255,255,.08) · 13px/700 · cursor:default}`（与 `.music-btn` 同风格，只是换成圆角方块）。⚠ 歌词功能已被用户 m02341 否决，这枚按钮**点下去不做事**，只照参考图占位；类名刻意不叫 `.music-lyric-*`，避免撞 e2e U4 的「不许偷偷接歌词」探测。
2. **播放/切歌整体左移** —— 喇叭由 `position:absolute; left:calc(100% + 8px)` 改回正常 flex item（`position:static; margin-left:-2px`），「词」再跟在它右边；`.music-ctl-buttons` 的 `gap` 由 `14px` 收到 `10px`。整组宽度从 108 变为 157.5，仍在左栏（159）内居中，于是三按钮组的几何中心从 `99.2`（＝左栏中心）左移到 `71.5`。

**关键实测数据** [已核验]：

| 指标 | 第三轮（m03435） | 第四轮（m03577） |
|---|---|---|
| 岛 | 377.4×219.1 | 377.4×219.1（未变宽） |
| `.music-ctl-buttons` 盒 | 108 宽（三按钮） | **157.5 宽**（三按钮 + 喇叭 + 词） |
| 三按钮组中心 X | 99.2（＝左栏中心） | **71.5**（左移 27.7） |
| 左栏中心 X | 99.2 | 99.2（未变） |
| 喇叭 x / 下一首右缘 | 159.2 / 153.2（间距 6） | **128.5 / 122.5（间距 6）** |
| 「词」x / 宽 | — | **157 / 21**（离喇叭右缘 7.5，右缘 178 ≤ 左栏右缘 178.7） |
| 整组是否越出左栏 | 否 | 否（`boxRight 175.7 → 178`，左栏右缘 178.7） |

**e2e 断言的连带修正**（`scripts/e2e-music.mjs`）：

- U1 从「三按钮组中心与左栏中心差 ≤6」改为「**三按钮组中心 < 左栏中心 - 10**（证明真的左移了）且整组盒不越出左栏」。理由：用户明确要求「整体向左移」，若继续断言「居中」会与需求冲突。
- 新增 **U1c**「喇叭右边有「词」按钮且完全在岛内」（`text==='词'`、与喇叭间距 0~24、右缘 ≤ 岛右缘）。
- 新增 **U1d**「点「词」不拉歌词、不编造歌词」（点完 `.music-lyric-slot` 仍是「暂无歌词」、`.music-lyric-line/[data-lyric]/.music-lyrics` 数量仍为 0）。这条锁住「不许偷偷接联网歌词」的既有红线。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` **PASS 41 过 / 0 败**（U1/U1b/U1c/U1d 全绿）、`e2e-music-session` PASS 20/0、`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0。截图 `.tmp/word/shot-music-word.png`（474×275）。

**仍未核验**：

- [未核验] 用户是否满意左移幅度（当前三按钮组中心 71.5，比左栏中心偏左 27.7；觉得不够就继续收 `gap` 或把「词」做宽）。
- [未核验] 真机观感与高分屏 DPI。
- [未核验] 「词」按钮没有功能这件事，用户接受与否（它只照参考图占位，点下去无反应）。

### 7.7 第五轮修正（2026-11-16 16:05，用户 m03716 点「词」弹出歌词页）

**用户原话**：

> 现在接着下一步，当我点击歌词这个ui的时候，就会跳出右边的歌词页，不然则消失，不显示

**含义拆解**：①点「词」→ 右侧弹出歌词面板；②不点时默认不显示（`visibility:hidden`）；③再点一次收起。歌词正文仍不做（用户 m02341 已实测否决），面板内只放诚实占位，不联网、不编造。

**做法**：

1. `src/renderer/src/App.tsx`：`MusicPanel` 新增 `const [lyricOpen, setLyricOpen] = useState(false)`；`.music-ctl-buttons` 里的「词」按钮改为 `className={`music-word ${lyricOpen ? 'on' : ''}`}`、`title={lyricOpen ? '收起歌词页' : '展开歌词页'}`、`aria-expanded={lyricOpen}`、`onClick={() => setLyricOpen((v) => !v)}`。
2. `src/renderer/src/App.tsx`：`.music-control-row` 内、`.music-ctl` **之前**新增面板 —— `.music-lyric-pop`（`role="dialog"`、`aria-label="歌词"`、`aria-hidden={!lyricOpen}`）→ `.music-lyric-pop-head`（标题「歌词」+ `×` 关闭按钮，`onClick={() => setLyricOpen(false)}`）→ `.music-lyric-pop-body`（`暂无歌词` + `歌词功能已按你的决定去掉`）。
3. `src/renderer/src/styles.css`：`.music-lyric-pop{position:absolute; right:0; bottom:calc(100% + 8px); width:212px; max-height:82px; padding:8px 10px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:rgba(28,26,34,.98); box-shadow:0 10px 28px rgba(0,0,0,.45); visibility:hidden; opacity:0; pointer-events:none; transform:translateY(4px); transition:opacity 140ms ease, transform 140ms ease; z-index:5}`，`.music-lyric-pop.open{visibility:visible;opacity:1;pointer-events:auto;transform:translateY(0)}`；`.music-word.on{background:rgba(255,143,163,.22); color:#ff8fa3}`；`@media (prefers-reduced-motion: reduce)` 关过渡。定位参考系是 `.music-control-row` 的 `position:relative`（第四轮就加了）。
4. 类名刻意不用 `.music-lyric-line` / `[data-lyric]` / `.music-lyrics`，避免撞既有 e2e U4 的「不许偷偷接联网歌词」探测。

**实测** [已核验，`.tmp/word/lyric.mjs` + dev electron 9321 + 假 SMTC 会话]：

| 状态 | visibility | opacity | pointer-events | 面板盒（视觉 px） | 是否在岛内 |
|---|---|---|---|---|---|
| 默认（未点） | hidden | 0 | none | x200.5 y81.8 w159 h58.5 | 是 |
| 点「词」后 | visible | 1 | auto | x200.5 **y76.4** w159 **h60.9** | 是（岛 377.4×219.1） |
| 再点一次 | hidden | 0 | none | 同上 | — |
| 点面板 `×` | hidden | 0 | none | 同上 | — |

「词」按钮 `aria-expanded` 同步 `false→true→false`，`.music-word` 类名同步加/去 `on`；`.music-lyric-line/[data-lyric]/.music-lyrics` 全程 `0`。

**面板尺寸调了三轮（教训）**：`max-height:200px` 时面板高 89.8、顶部顶到状态区（电量环/时钟/铃铛）；收到 `78px` 又把长提示文案裁掉并逼出滚动条；最终 `82px` + 提示文案缩到 12 个字 + `.music-lyric-pop-empty/.hint` 各加 `flex:0 0 auto` + body 改 `overflow:hidden`，才落到 60.9 高、无滚动条、不压状态区。**绝对定位的浮层高度必须实测，不能只看 CSS 声明值。**

**e2e 连带修正**（`scripts/e2e-music.mjs`）—— 原 U1d「点「词」不拉歌词」拆成三条：

- **U1d** 歌词页平时不显示（`visibility==='hidden'`）——对应用户 m03716「不然则消失，不显示」。
- **U1e** 点「词」弹出歌词页、整块落在岛内、`aria-expanded==='true'`、且 `div.music-lyric-line/[data-lyric]/.music-lyrics` 数量仍为 0。
- **U1f** 再点一次「词」收起（`visibility==='hidden'`、`aria-expanded==='false'`）。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` **PASS 43 过 / 0 败**（U1d/U1e/U1f 全绿）、`e2e-music-session` PASS 20/0。截图 `.tmp/word/shot-lyric-open.png`（474×275）。

**踩坑**：`e2e-music.mjs` 首跑出现 `✗ M3a` / `✗ M3c`（播放态翻转失败），清空 `.tmp/e2e-userdata` 后重跑 **PASS 43/0** —— 与本次改动无关，是残留数据；**跑 e2e 前必须先删 `.tmp/e2e-userdata`**。

**仍未核验**：

- [未核验] 用户是否接受「歌词页里只有占位、没有真歌词」这件事（此前 m02341 已否决歌词，本轮只做开合外壳）。
- [未核验] 面板弹出/收起的 140ms 过渡在真机上的手感。
- [未核验] 岛在不同 DPI 下 82px 布局高的上限是否仍够放两行占位文字。

### 7.8 第六轮修正（2026-11-16 16:15，用户 m03837 指出 7.7 理解错了）

**用户原话**：

> 你理解错我的意思了，我指的是整个右边隐藏了，变回之前让你添加歌词面板的那个界面，按了歌词，就会把ui挤到左边，然后竖线隔开出现歌词，我想要的是是这个意思；

**错在哪**：7.7 做的是「浮在内容上方的小面板」（`position:absolute` 盖住右栏区域），用户要的是「右栏整块默认不存在，点「词」才长出来并把内容挤到左边」。

**做法**：

1. 删掉 7.7 的 `.music-lyric-pop` 浮层（`App.tsx` 里整段 JSX + `styles.css` 里 20 条样式全删）。
2. `src/renderer/src/App.tsx` 根节点类名改为 `todo-panel music-panel ${lyricOpen ? 'lyric-open' : ''}`，由这个类驱动开合。
3. `src/renderer/src/styles.css`：
   - `.music-divider, .music-lyric-slot { display: none; }` —— 默认整块不占位。
   - `.music-panel.lyric-open .music-divider { display: block; }`、`.music-panel.lyric-open .music-lyric-slot { display: flex; }`。
   - `.music-control-row` 由写死三栏改为**默认单栏** `grid-template-columns:212px` + `justify-content:start`；`.music-panel.lyric-open .music-control-row{grid-template-columns:212px 1px 260px; justify-content:center}`。
   - `.music-lyric-slot` 的 `flex` 由 `0 0 212px` 改 **`0 0 260px`**（用户 m03840「宽一点看看」：歌词栏比左栏宽一档）。
4. 「词」按钮保留 `aria-expanded` 与 `.on` 高亮，改成驱动 `lyricOpen`。

**实测** [已核验，`.tmp/word/push.mjs` + dev electron 9321 + 假 SMTC 会话]：

| 指标 | 收起（默认） | 点「词」后 | 再点一次 |
|---|---|---|---|
| 岛视觉宽 / 布局宽 | **285 / 380px** | **413.4 / 551.1px** | 285 / 380px（回到原值） |
| `.music-divider` | `display:none`（0×0） | `display:block`，x **189.2**、高 76.5 | `none` |
| `.music-lyric-slot` | `display:none`（0×0） | `display:flex`，x **200.5**、宽 **195**（布局 260） | `none` |
| `.music-side` | x19.5 宽 159 | x19.7 宽 159 | x19.5 宽 159 |
| `.music-control-row` | `212px` | `212px 1px 260px` | `212px` |
| `.music-ctl` | x19.5 | x19.7 | x19.5 |

⇒ 竖线正好落在左栏右缘（左栏 19.7+159=178.7，竖线 189.2 在列间隙之后）、歌词栏在竖线右侧且完整在岛内；岛宽 285→413.4（+128.4），收起后精确回到 285。

**单栏时的一个坑**：`.music-control-row` 原来 `justify-content:center`，单栏下会把 212 的列推到容器正中，控制行与上方左栏错开 17 布局 px（实测 `ctl x63.7` vs `side x19.5`）。改为单栏 `justify-content:start`、开栏时才 `center`，两者对齐。

**e2e 连带重写**（`scripts/e2e-music.mjs`）—— 三条全部按新语义重写：

- **U1d** 歌词栏默认整块隐藏（`.music-lyric-slot`/`.music-divider` 都是 `display:none`）、岛是窄态、且仍无联网歌词。
- **U1e** 点「词」后：`slot=flex`、`divider=block`、岛宽比之前 **+80 以上**、**歌词栏比左栏宽**、竖线在左栏右侧、歌词栏在竖线右侧、整块在岛内、`aria-expanded=true`、联网歌词选择器仍为 0。
- **U1f** 再点一次：`slot/divider` 回到 `none`、**岛宽精确回到原值**、`aria-expanded=false`。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` **PASS 43 过 / 0 败**（U1d/U1e/U1f 全绿）、`e2e-music-session` PASS 20/0、`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0。截图 `.tmp/word/shot-lyric-closed.png`（358×275）、`.tmp/word/shot-lyric-open.png`（519×275）。

**仍未核验**：

- [未核验] 「右栏 260 / 左栏 212」这个比例你看着合不合适（再宽就是改 `.music-lyric-slot` 的 `flex-basis` 与 `.music-panel.lyric-open .music-control-row` 的第二段列宽，两处要同步）。
- [未核验] 岛从 285 长到 413 的宽度过渡（`.island` 的 220ms width 过渡）在真机的手感。
- [未核验] 歌词栏里只放「暂无歌词」占位、没有真歌词，是否可接受（歌词已在 m02341 否决）。

### 7.9 第七轮修正（2026-11-16 16:22，用户 m03950「右边这一块空出来干嘛，去掉，让他们直接位于中心」）

**用户原话**：

> 你右边这一块空出来干嘛，去掉，让他们直接位于中心即可

**问题**：7.8 只把右栏设成 `display:none`，但 `.music-main` 与 `.music-control-row` 仍是 `justify-content:flex-start`（7.8 为了开栏对齐改的）⇒ 收起态左栏被顶在左边、右边空出 88 视觉 px 的空白。

**做法**（只改 `src/renderer/src/styles.css` 两处）：

1. `.music-main` 加 `justify-content:center`；`.music-panel.lyric-open .music-main{justify-content:flex-start}`。
2. `.music-control-row` 单栏的 `justify-content` 由 `start` 改回 `center`；`.music-panel.lyric-open .music-control-row` 由 `center` 改 `flex-start`。

即「默认居中、开栏才贴左」——两个容器始终同侧，不会互相错位。

**实测** [已核验，`.tmp/word/push.mjs`]：

| 指标 | 收起（默认） | 点「词」后 |
|---|---|---|
| 岛 | 285×219.1 | 413.4×219.1 |
| `.music-side` | **x63.7**、宽 159 | x19.7、宽 159 |
| `.music-ctl` | **x63.7** | x19.7 |
| 左右留白 | 左 63.7 / 右 63.7（居中对称） | 左 19.7 / 右 19.7 |
| `.music-divider` / `.music-lyric-slot` | `none` / `none` | `block`（x189.2）/ `flex`（x200.5、宽 195） |

⇒ 收起态左右留白完全对称（各 63.7），内容真居中；开栏后两个容器一起贴左，竖线与歌词栏接在后面。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；`e2e-music` **PASS 43 过 / 0 败**、`e2e-music-session` PASS 20/0、`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0。截图 `.tmp/word/shot-lyric-closed.png`（358×275）、`.tmp/word/shot-lyric-open.png`（519×275）。

**仍未核验**：

- [未核验] 居中后你是否满意（左栏整块现在离岛左缘 63.7 视觉 px）。
- [未核验] 岛从 285 撑到 413 时内容整体左移 + 岛变宽的混合动画手感。

### 7.10 第八轮修正（2026-11-16 16:35，用户 m03988「两边有点多余，去除掉」）

**用户原话**：

> 两边有点多余，去除掉

**问题**：7.9 做到了左右对称居中，但两侧留白各 63.7 视觉 px 是「岛最小宽 380 布局 px」撑出来的，不是内容真需要。用户看到的就是这两块空黑边。

**分档实测**（`.tmp/word/alltiers.mjs`：注入 `.island.expanded{min-width:N !important}`，逐页量岛宽与「标题右缘 → 状态区左缘」的 gap，负数表示标题被压到状态区）：

| min-width（布局） | 待办 | 置物架 | 音乐 | 通知 | 日程 |
|---|---|---|---|---|---|
| 380（默认） | 285 / gap20.1 | 285 / **gap8.1** | 285 / gap20.1 | 285 / gap20.1 | 393.2 / gap74.2 |
| 340 | 255 / 5.1 | 255 / **−6.9** | 255 / 5.1 | 262.6 / 8.9 | 393.2 / 74.2 |
| 320 | 240 / −2.4 | 240 / **−14.4** | 240 / −2.4 | 262.6 / 8.9 | 393.2 / 74.2 |
| 300 | 225.2 / −9.8 | 225 / **−21.9** | 225 / −9.9 | 262.6 / 8.9 | 393.2 / 74.2 |
| 280 | 225.2 / −9.8 | 213 / **−27.9** | 210 / −17.4 | 262.6 / 8.9 | 393.2 / 74.2 |

⇒ 直接砍最小宽会在 340 就把置物架三字标题压进状态区。**左右内边距也是空白的另一半**：把 `24px` 收到 `16px`，内容区反而变宽 16 布局 px，等于把空白换成内容。

**最终做法**（`src/renderer/src/styles.css` 两处 + `src/main/index.ts` 一处）：

1. `.island.expanded` 的 `min-width` `380px → 340px`（注释补第八轮理由与实测余量）。
2. `.island.expanded` 的 `padding` `20px 24px → 20px 16px`。
3. `src/main/index.ts` 的 `EXPANDED_MIN` `{width:285} → {width:255}`（= 340 × 0.75，两边必须同步改）。

**实测** [已核验，`.tmp/word/verify-tight.mjs`，dev electron 9321 + 真实 SMTC 会话]：

| 页面 | 岛（视觉 px） | 布局 | 内边距 | 标题→状态区余量 |
|---|---|---|---|---|
| 待办 | 255×170.3 | 340px | 16px | 20.5 |
| 置物架 | 255×195.7 | 340px | 16px | **8.5**（最紧） |
| 音乐 | 255×219.1 | 340px | 16px | 20.5 |
| 通知 | 255×214.6 | 340px | 16px | 20.5 |
| 日程 | 381.2×255.8 | 508.3px | 16px | 83.6 |

⇒ 视觉岛宽 285→**255**（每侧少 11 视觉 px，岛整体窄了 30），五页全部无重叠，音乐页右内边距收成 64→48。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0（`✓ built in 168ms`）；`e2e-music` **PASS 44 过 / 0 败**、`e2e-head-order` PASS 14/0、`e2e-beautify-04` PASS 27/0、`e2e-music-session` PASS 20/0、`e2e-banner-fit` PASS 8/0、`e2e-pages-custom` PASS 6 项、`e2e-shelf-view-pref` PASS。截图 `.tmp/word/shot-tight.png`（320×275）。

**踩坑**：`e2e-music` 首跑曾报 39 过 / 4 败（M3b、M4a–M4c 全 null，形如「没有播放会话」），紧接重跑 PASS 44/0 —— 是脚本自带的假 SMTC 会话还没建立就断言，与本次改动无关；跑前必须 `Remove-Item -Recurse -Force .tmp\e2e-userdata` 并先杀掉已占 9321 的实例。

**仍未核验**：

- [未核验] 255 这个宽度你看着是否已经够紧；再窄就要动头部状态区（把绝对定位改成流内，实测最小只能到 199 左右且会挤成两行）。
- [未核验] 装机版观感（安装版仍是旧横向音量那版，未重新打包）。
### 7.11 第九轮修正（2026-11-16 17:00，用户 m04117）

用户原话：「可以把封面等ui分开一点布局，这样子可以填满这个界面，这样两边的黑边就不会很多余，还有就是歌词ui放切上一首的旁边，这样好看一点」

四条要求 → 四处改动：

| 要求 | 改法 | 改前 → 改后 |
|---|---|---|
| 封面等 UI 铺满整行 | `.music-side` 由定宽改吃满 | `flex:0 0 212px` → `flex:1 1 auto`；开歌词栏时 `.music-panel.lyric-open .music-side{flex:0 0 212px}` 回到定宽 |
| 歌名区跟着变宽 | `.music-meta` 上限按「岛最小宽 − 内边距 − 封面 − 间距」重算 | `max-width:140px` → `236px`；开栏时 `140px` |
| 控制行不留黑边 | `.music-control-row` 单栏由固定列宽改 `1fr` | `grid-template-columns:212px` → `1fr`；`justify-content:center` → `stretch` |
| 喇叭与「词」分居两端 | `.music-ctl-buttons` 改 `space-between`，喇叭 `margin-left:auto` | 喇叭 `margin-left:-2px` → `auto` |
| 「词」挪到「上一首」左边 | 「词」从喇叭右侧移进 `.music-ctl-mid`（三按钮组）首项 | 「词」x 157（喇叭右）→ x 48.5（「上一首」左） |

实测 [已核验，`.tmp/word/fill.mjs`，dev electron 9321 + 假 SMTC 会话]：

`{"island":{"w":255,"h":219.1,"layout":"340px"},"main":{"x":13.3,"w":229.4,"right":242.7},"side":{"w":229.4},"cover":{"x":13.3,"w":45},"meta":{"x":67.3,"w":175.4},"progress":{"w":229.4},"row":{"w":229.4},"ctl":{"x":13.3,"w":229.4},"btns":{"w":229.4},"mid":{"x":13.3,"w":200.9},"word":{"x":48.5,"w":21,"right":69.5},"prev":{"x":77,"w":27,"right":104},"vol":{"x":221.7,"w":21,"right":242.7},"btnsCenter":128,"midCenter":113.8}`

⇒ 左栏 / 进度条 / 控制行全部 **229.4** 宽（与岛内容区等宽，两侧黑边消失）；喇叭右缘 242.7 ＝ 内容右缘；「词」与「上一首」间距 7.5。

**走错一步并修正** [已核验]：第一版把「词」放在 `.music-ctl-buttons` 里、三按钮放进 `.music-ctl-mid`，`space-between` 把「词」顶到行首没错，但「词」与「上一首」隔了 35.2（被 `.music-ctl-mid` 的居中拉开）——用户要的是「放在切上一首的旁边」，不是「贴行首」。最终把「词」移进 `.music-ctl-mid` 当首项，间距收到 7.5。

e2e 连带改写（`scripts/e2e-music.mjs`）：

- **U1**「控制行与左栏同宽、铺满整行不留黑边」：由「三按钮组中心 < 左栏中心 −10」改为「`|ctlW − sideW| ≤ 1` 且整组盒在左栏内」。原断言与「铺满」直接冲突（铺满后按钮组居中）。
- **U1b**「喇叭贴在控制行最右端」：由「喇叭到「下一首」右缘 0~24」改为「喇叭右缘与 `.music-ctl-buttons` 右缘差 ≤2 且 < 岛右缘 −8」。
- **U1c**「「词」紧挨「上一首」左边、不再吊在喇叭右侧」：断言 `gapToPrev` 0~24 且 `leftGap ≥ -1`（在行内，不再钉死行首）。
- U1d/U1e/U1f（歌词栏开合三条）未动。

**自检** [已核验]：`npm run typecheck` EXIT=0、`npm run build` EXIT=0（`✓ built in 115ms`）；`node scripts/e2e-music.mjs` **PASS 44 过 / 0 败**（U1/U1b/U1c/U1d/U1e/U1f 全绿）。截图 `.tmp/word/shot-fill.png`（320×273）。

**踩坑**：改完 `App.tsx` 后第一次跑 e2e 仍报旧的 `leftGap 35.2` —— 因为 `e2e-music.mjs` 自己 spawn 的实例读的是 `out/` 构建产物，**必须先 `npm run build` 再跑**，否则测的还是上一份 bundle。

**仍未核验**：

- [未核验] 用户对「词」改到左端后的观感是否满意（他要的是「切上一首旁边」，我按「三按钮组居中 + 词在组首」实现，若想更靠左可改成整组贴左）。
- [未核验] 装机版观感（安装版仍是旧横向音量那版，未重新打包）。
### 7.12 第十轮修正（2026-11-16 17:08，用户 m04310）

用户原话：「喇叭还是贴着下一首比较好一点」

第七轮（7.11）为了让控制行「撑满整行、两边不留黑边」，把 `.music-ctl-buttons` 改成 `space-between`、给喇叭加 `margin-left:auto` 推到行尾。本轮按用户回补的口径改回来：

| 位置 | 改前（7.11） | 改后（7.12） |
|---|---|---|
| `.music-ctl-buttons` | `justify-content: space-between` | `justify-content: center` |
| `.music-ctl-mid`（「词」+ 三按钮） | `flex: 1 1 auto`（吃掉剩余宽度） | `flex: 0 0 auto`（自然宽） |
| `.music-extra`（喇叭） | `margin-left: auto`（顶到行尾） | 去掉，紧跟「下一首」 |

「铺满整行」的效果由左栏负责（封面 / 歌名 / 进度条仍是 229.4 宽），控制行不再强行撑满 —— 这两件事本来就可以分开，上一轮把它们捆在一起了。

实测 [已核验，`.tmp/word/fill.mjs`]：

`{"island":{"w":255,"h":219.1,"layout":"340px"},"main":{"w":229.4},"side":{"w":229.4},"cover":{"w":45},"meta":{"w":175.4},"progress":{"w":229.4},"ctl":{"w":229.4},"btns":{"w":229.4},"mid":{"x":48.5,"w":130.5,"right":179},"word":{"x":48.5,"w":21},"prev":{"x":77,"w":27,"right":104},"next":{"right":153.2},"extra":{"x":186.5,"w":21,"right":207.5},"vol":{"x":186.5,"w":21,"right":207.5}}`

⇒ 喇叭左缘 186.5 − 「下一首」右缘 153.2 = **净间距 33.3 视觉 px（44.4 布局 px，其中含 `.music-ctl-buttons` 的 gap 10 与按钮间 gap 10 的叠加）**；整组「词 + 三按钮 + 喇叭」在控制行内居中（组宽 159，控制行 229.4）；「词」仍紧挨「上一首」左边。

e2e 连带改写（`scripts/e2e-music.mjs`）：U1b 由「喇叭右缘贴控制行右缘（差 ≤2）」改回「喇叭到「下一首」右缘 0~24 且不越岛右缘 8 以内」——标题「U1b 喇叭紧贴「下一首」右侧、不再吊到控制行两端（用户 m04310）」。U1/U1c/U1d/U1e/U1f 未动。

**自检** [已核验]：`npm run build` EXIT=0（`✓ built in 120ms`）、`node scripts/e2e-music.mjs` **PASS 44 过 / 0 败**（U1/U1b/U1c/U1d/U1e/U1f 全绿）。截图 `.tmp/word/shot-fill.png`（320×273）。

**未核验**：

- [未核验] 用户对「喇叭贴回下一首右侧」后的位置是否满意（当前净间距 33.3 视觉 px，比 m03435 那轮的 6 宽，因为多了「词」按钮让整组变宽、又回到居中；若要更贴可把 gap 收到 6）。
- [未核验] 装机版观感（安装版仍是旧横向音量那版，未重新打包）。
### 7.13 第十一轮修正（2026-11-16 17:15，用户 m04356）

**用户原话**：「就是喇叭这个拉条，我想我点别的地方它也可以隐藏，而不是每次都要去点那个喇叭」（附截图 m04354：竖直音量条展开、20%、下方喇叭按钮）。

**问题**：音量条只能靠再点一次喇叭收起。用户拖完音量为腾地方、或想接着点别的按钮时，必须精确点到那枚 28×28 的喇叭才关得掉。

**做法**（`src/renderer/src/App.tsx`）：
1. 新增 `const volBoxRef = useRef<HTMLDivElement>(null)`，挂到 `.music-volume` 容器上（喇叭 + 浮层都在里面）。
2. 新增 `useEffect`，依赖 `[volOpen]`：只在展开时给 `document` 挂 `pointerdown` **捕获阶段**监听；落点 `box.contains(e.target)` 为真就放过（点条内/拖滑块不收起），否则 `setVolOpen(false)`。收起即卸载监听。

**选型理由**：
- 用 `pointerdown` 而非 `click`：按下即收，不必等一次完整点击（拖到一半松手也不会漏）。
- 用捕获阶段：目标元素自己 `stopPropagation` 也照收，不依赖各按钮的实现细节。
- 判断容器而不是判断「是不是喇叭」：拖滑块的第一下 `pointerdown` 就在条内，按「非喇叭即收起」会当场把它关掉。

**自检**（`scripts/e2e-music.mjs` 新增两条）：
- U3c 音量条开着时在 `.panel-title` 上按下 → `.music-vol-pop` 由 `visible` 变 `hidden`、`aria-expanded` 变 `false`。
- U3d 在音量 `input[type=range]` 上按下 → 前后都还是 `visible`（拖滑块不会误收）。

**实测**：`e2e-music` PASS 46 过 / 0 败（U3c、U3d 全绿）；`.tmp/word/volout.mjs` 手工复核 `OPEN=visible` → 点标题 → `AFTER_OUTSIDE=hidden`；截图 `.tmp/word/shot-vol-open.png`、`.tmp/word/shot-vol-closed.png`。

**未核验**：①真机触屏/触摸板上的手感（只用 CDP 合成 `PointerEvent` 验过）；②点岛外区域（窗口失焦）时是否也收起 —— 窗口 blur 已由主进程收整岛，未单独验音量条这一层。

---

### 7.14 第十二轮修正（2026-11-16 17:40，用户 m04432「现在直接拖动不了」）

**用户原话**：「现在直接拖动不了」。上一轮（7.13）刚加了「点别处收起」，所以先按回归查，
但实测证明根因不是收起逻辑，而是**热区太窄 + 原生竖直滑条命中不稳**。

**取证方法与结论**（全部 [已核验]，dev 实例 + 真实「汽水音乐」SMTC 会话）：

| 探针 | 量到什么 | 结论 |
| --- | --- | --- |
| `.tmp/word/hitmap.mjs` | 逐点 `elementFromPoint` 扫出 `input {w:21,h:63}`、`pop {w:34.6,h:91.5}`，命中图每行 `m...###########....m` | 可点宽度只有 ≈21 视觉 px，两侧是浮层背景（不接拖动） |
| `.tmp/word/dragmiss.mjs` | `off=0` 成功（0.17→0.79）；`off=8/12/16` 全失败；`off≥20` 落到 `.music-seek`、条被收起 | **往旁边偏 8px 就拖不动**，与用户手感一致 |
| `.tmp/word/trace3.mjs` | 四轮里 R2/R3 `imm=0.08` 但 `late=0.94`，`__calls` 空、`__states` 只有 0.08→0.94 两条 | 拖动过程中的 `input` 事件没有稳定走到 `sendVolume`，写入靠防抖兜底 |

**改法**（`src/renderer/src/App.tsx` + `src/renderer/src/styles.css`）：

1. 浮层里新增透明热区层 `.music-vol-drag`（`position:absolute; inset:0; cursor:pointer; touch-action:none`），
   盖住整条滑块；按下/移动/松开都走 React 的 `onPointerDown/Move/Up/Cancel`，不再依赖原生 `input[type=range]` 的竖直拖动。
2. `volFromY(clientY)`：按 `input` 的矩形把 Y 换算成 `0..1`（竖直条是 `writing-mode:vertical-lr` + `direction:rtl` ⇒ 顶=1、底=0），
   四舍五入到 0.01 后 `setVolLocal` + `sendVolume`，与原生拖动走同一条写入路径（120ms 防抖不变）。
3. `setPointerCapture` 放在取值之后并包 `try/catch`：合成指针下可能抛 `NotFoundError`，不能因为捕获失败就把这次取值丢掉。
4. `.music-vol-pop input[type='range']` 的盒子 `28px → 34px`（轨道仍 3px 视觉不变），热区再加一层保险。
5. **走错的一步（务必记住）**：中途试过「浮层整块 `onPointerDown` + `preventDefault()`，input 一律不让原生处理」，
   结果**正对轨道也拖不动**（`off=0/-6/6/10` 全部 `before==after`）——`preventDefault` 把原生 `mousedown` 链路一起摁死了。
   正确做法是让透明热区**盖在 input 上面**截获指针，input 保留但不再参与拖动手势。

**实测（改后，OS 级真鼠标 `mouse_event`，不是 CDP 合成）**：

| 落点（相对滑块中心） | 命中元素 | 结果 |
| --- | --- | --- |
| 0（正中） | `.music-vol-drag` | 0.87 → 0.10 ✔ |
| −10 / −14 | `.music-vol-drag` | 0.10 → 0.91 ✔ |
| +10 / +14 | `.music-vol-drag` | 0.91 → 0.10 ✔ |

交替方向连做五轮全部生效且 `vis=visible`（没有被误收），主进程回读 `musicGet().volume` 与滑块一致。

**自检**：`npm run typecheck` EXIT=0、`npm run build` EXIT=0；
`node scripts/e2e-music.mjs` **PASS 46 过 / 0 败**（U3b 已改写为「可拖命中 ≥20px 且热区盖住滑块」）、
`node scripts/e2e-music-session.mjs` PASS 20/0、`node scripts/e2e-head-order.mjs` PASS 14/0、
`node scripts/e2e-beautify-04.mjs` PASS 27/0。

**未核验**：①真机触摸/触摸板手势（只用 OS 鼠标 `mouse_event` 与 CDP 合成验过）；
②其它播放器（网易云 / QQ 音乐）下的落地点手感是否一致；③高分屏不同 DPI 缩放下的换算误差。

### 7.15 第十三轮修正（2026-11-16 17:50，用户 m04736）

**用户原话**：「现在的喇叭颜色太浅，然后拖动音量没有变化」。

#### 根因（不是上一轮热区的锅）

现场读到的快照是 `musicGet()` = `{active:true, app:"汽水音乐", title:"体面（Cover 于文文）",
canVolume:false, volume:0}`。`canVolume:false` 会让滑块 `disabled`、数字显示 `--`、
容器加 `.music-volume.off`（`opacity:0.4`）——**看起来同时像「喇叭太浅」和「拖了没反应」，其实是同一个原因**。
直接调 `musicControl({cmd:"volume", value:0.3})` 返回 `ok:true` 且 `canVolume` 随即自愈为 true，
随后连采 40 次全是 `canVolume:true`，说明**桥接能写能读，只是「找会话」这一步会间歇性对不上号**。

为什么对不上号：`AppVol.Find(smtc)` 原来的两条路是「按名字匹配会话」与「全场只有一个 active 会话时用它」。
汽水音乐的 SMTC id 是「汽水音乐」，但进程名 / ProductName / FileDescription 全叫 `SodaMusic`，
5 个进程的 MainWindowTitle 全空（`EnumWindows` 也找不到它的顶层窗口），**名字这条路对它天然不成立**，
实际长期只靠「全场唯一 active 会话」。音频会话会随播放器子进程出现 / 消失，这条路就时真时假。

#### 改动（4 处，`src/main/smtcScript.ts`）

1. `AppVol` 加 `static int LastPid = -1` / `static string LastName = ""` / `static string LastSmtc = ""`。
2. 新增 `FindByPid(int pid)`：进程还在就枚举音频会话按 pid 找回 `ISimpleAudioVolume`，不在了就清缓存。
3. `Find(smtc)` 先看缓存——**且缓存必须跟 SMTC 应用绑定**（`LastSmtc` 与当前 smtc 相等才用），
   否则换了播放器会把上一位的会话当成当前这位，控制错应用比抖动更糟；没命中再走原来的两层。
4. `FindOnce` 三个返回点都调 `Remember(pid, smtc)`；`Candidates()` 把记住的真实进程名并进候选集，
   这样即使以后 Tier3 不再唯一，也能靠 `SodaMusic` 这个名字直接认回来。

#### 喇叭提亮（`src/renderer/src/styles.css`）

| 属性 | 改前 | 改后 |
| --- | --- | --- |
| `.music-vol-toggle` 图标色 | `rgba(242,243,245,0.75)` | `#ffffff` |
| `.music-vol-toggle` 底色 | `rgba(255,255,255,0.07)` | `rgba(255,255,255,0.14)` |
| `.music-vol-toggle svg` 尺寸 | `15px` | `17px` |
| `.music-volume.off` 禁用态 | `opacity: 0.4` | `opacity: 0.62` |

最后一条的理由：`canVolume:false` 本来是「暂时找不到这个应用的音量」，压到 0.4 会让人以为功能坏了。

#### 自检

- `npm run typecheck` EXIT=0、`npm run build` EXIT=0。
- `node scripts/e2e-music.mjs` **PASS 46 过 / 0 败**。
- `node .tmp/probe-prod-bridge-volume.mjs`（抽生产桥接 C# 真跑）**PASS 5/0**，
  `Q3 canVolume=true`、真实会话 `app="汽水音乐" title="幻听" volume=0.74`。
- CDP 实测：`.music-vol-toggle` 计算样式 `color rgb(255,255,255)` / `background rgba(255,255,255,0.14)` / `svg 17px`；
  连做三轮拖动 `during=["0.19"…"0.79"]`、`after=0.79`、主进程回读 `real=0.79`。

#### 未核验

①只在本机汽水音乐上验过，网易云 / QQ 音乐是否也受益于 pid 缓存未验证；
②缓存是进程内静态变量，应用重启后第一次仍需靠 Tier3 认一次；
③车主日（多播放器同时出声）下缓存仍可能指错应用，本轮没有构造这种场景。

## 2026-11-28 第四轮：点「词」开合不再裁切，切页缩放在减弱动态效果下不再播放（分支 `collapsed-lyric-bar`）

**现象 [实测]**：音乐页点「词」展开歌词面板时，`.island.expanded.page-4:has(.music-panel.lyric-open)` 的宽度从固定值改成 `max-content`，px→max-content 不可过渡，岛一帧内从 255×219 跳到 402×269；窗口要等 ResizeObserver 的 80ms 防抖才上报，右边被裁 147px、底部被裁 50px，持续约 90ms。用户原话「就是现在岛在音乐界面的展开的动画，收缩和缩放，太卡了」。

**改动**：

1. `MusicPanel.onWordClick` 同步调用 `onLyricOpenChange`（不再只靠下面的 effect）；App 新增 `lyricPanelOpen` state。
2. App 新增 `useLayoutEffect([lyricPanelOpen])`（只对展开态音乐页生效）：开合那一帧关掉尺寸过渡、按 `getBoundingClientRect` 量最终尺寸、`reportExpandedSize` 立即上报（主进程 `applyBoundsNow`），窗口跟上前的 1~2 帧用 `clampIslandToWindow` 把岛钳在窗口内。
3. 切页缩放动画（WAAPI 340ms）尊重系统「减弱动态效果」：本机实测 `prefers-reduced-motion: reduce` 为 true，CSS 过渡早已压到 1ms，但 Web Animations 不受 CSS 媒体查询约束，340ms 的整页缩放照旧在跑。现在 reduce 时不播缩放，切页直接到位。

**自检 [实测]**：

- `npm run build` EXIT=0。
- 逐帧探针 `.tmp/probe-music-anim.mjs`（临时）：词面板展开改前右/下溢 147×50px → 改后 `overW=0 / overH=0 / badMs=0`；打开音乐页、词面板开合均无 >33ms 的帧间隔。回到网格仍有 1 帧 `overH=53`（约 3~4ms），属收缩过渡一帧的瞬时裁切，未处理。
- `node scripts/e2e-music.mjs`：**PASS（47 过 / 0 败 / 1 跳过）**，新增 U1g（点「词」后逐帧采样不溢出）、U1h（收起后回到窄态）。
- `node scripts/e2e-collapsed-lyric.mjs`：**PASS（43 过 / 0 败）**。
- 探针 `.tmp/probe-zoom.mjs`（临时）：reduce=true 时点组件进音乐页，`.page-fade` 上只有 1ms 的淡入动画，没有 340ms 缩放。

**未验证**：

- 真人观感（尤其窗口 `setBounds` 那 1~2 帧的钳制/释放）只有用户能看到。
- 非 reduce-motion 的机器上，340ms 缩放是否仍有裁切未测——本机 reduce=true，探针跑不到那条分支。
