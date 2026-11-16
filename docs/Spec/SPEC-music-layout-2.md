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
