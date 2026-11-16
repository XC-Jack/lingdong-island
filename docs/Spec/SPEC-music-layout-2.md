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
