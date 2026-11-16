# SPEC：音乐页 UI 微调（音量竖跳 + 播放按钮移到右上）

> **重大修订（2026-11-15 20:50）**：用户 m02652「参考这个截图，做这个样子的」＋选「整页照图重排」，
> 已在**同一分支** `music-ui-tweak` 上按参考图把整页重排，**推翻了下面第一~七节的 m02462 旧目标**
> （播放按钮右上、音量竖直弹出）。当时目标、范围、自检见**第九节**；第一~八节保留作历史留痕。
>
> **最新修订（2026-11-15 22:00，见第十节）**：用户 m02917「音量调节用不了，还有就是我要竖线调节，不要横线」。
> 第九节中「音量由竖直改横向」这一条被**明确推翻**——诊断证实写入链路没坏、「用不了」是方向错配，
> 音量已改回**竖直向上弹出**。第九节其余结论（播放按钮居中、诚实歌词占位、负数剩余、控制行三列）继续有效。
>
> **再修订（2026-11-16 10:20，见第十一节）**：用户 m03141「解决音量建无法拖动的问题」。
> 第十节的「方向错配」判定**只对了一半**：写入链路确实没坏，但真因是**命中热区只有 11px**——
> 3px 可见轨道两侧各只剩约 4px 余量，真人横向偏一点就按在浮层背景上，表现为拖不动。
> 已把 input 盒子加宽到 28px（轨道仍 3px、视觉不变，两侧为透明热区）+ `touch-action:none`，并加 `U3b` 回归护栏。
> **当前代码以第十一节为准**：第十节的 `width:14px` 已被 `width:28px` 取代。

- 基线：`main` @ `5a855b9`
- 分支：`music-ui-tweak`
- 用户消息：m02462「把音量弄成竖跳的，音量条隐形，点声标时显现；还有就是这个播放等这一块ui移到上面的右边，和音乐条对其」；m02652「参考这个截图，做这个样子的」＋选「整页照图重排」；m02676「继续」；m02917「音量调节用不了，还有就是我要竖线调节，不要横线；」
- 用户截图：m02462 `sha256:a206382f4867a698d22498e82c9c1ccc10f27fa94943554fdfec16fe052ec1ba`；m02652 参考图 `sha256:86cf24a60186c2a898371c509598e4a6d7cd8b33add2cc7b7a166a3f33973bae`
- 关联：SPEC-music-controls.md（第 1 批控制）、SPEC-music-cover.md（第 2 批封面）

## 一、目标

1. 音量控件改造成「竖直滑块」：平时只显示一个喇叭按钮、音量条隐形；点喇叭竖直弹出音量条，再点收起。
2. 三个播放控制按钮（上一首 / 播放暂停 / 下一首）从独立的中间一行，移到最上面「封面 + 歌名/歌手」那一行的右侧，与之水平对齐。
3. 纯 UI 调整，不改数据源、不改控制逻辑、不改 `MusicState` / 桥接脚本 / 主进程。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `docs/Spec/SPEC-music-ui-tweak.md` | 本 SPEC（新建） |
| `src/renderer/src/App.tsx` | `MusicPanel()` 新增 `volOpen` state；`.music-ctl` 移进 `.music-main`；音量块把 `<IcoVolume />` 换成可点按钮 `<button class="music-vol-toggle">`，input 与百分比包进 `.music-vol-pop` |
| `src/renderer/src/styles.css` | `.music-ctl` 改为靠右、不占满宽；音量段重写为竖直滑块 + 隐形/弹出样式 |
| `scripts/e2e-music.mjs` | 新增 U1–U3 断言（播放按钮在 `.music-main` 内靠右 / 音量条默认隐形 / 点喇叭后显现且不越出岛边界） |
| `.tmp/probe-music-controls-render.mjs` | 一次性探针同步补 U1–U3（不进交付提交） |
| `docs/状态.md` | 顶部一句话状态 |

不改：`src/main/*`、`src/shared/types.ts`、`src/preload/*`、`src/renderer/index.html`、`src/main/smtcScript.ts`、`scripts/e2e-music-session.mjs`、`scripts/e2e-collapse-order.mjs`、设置页、`prefsStore.ts`。

## 三、预期行为

1. 音乐页正常态第一行：左封面 44px、中歌名/歌手（长名 ellipsis）、右三个播放按钮，三者同一行、垂直居中对齐。
2. 进度条单独一行、时间文本两端对齐，位置与比例不变。
3. 音量：平时只见喇叭按钮（`.music-vol-toggle`），竖直音量条与百分比隐藏（`visibility:hidden`）；点喇叭切换 `.open`，竖直滑块向上弹出（带轻微位移/淡入），再点收起。
4. 竖直滑块 `writing-mode: vertical-lr; direction: rtl`（上大下小），点击坐标准确，不用 `rotate`。
5. 弹出的音量条浮层完全落在岛（`.island`）矩形内，不撑动上方布局、不被 `overflow:hidden` 裁掉。
6. `canVolume === false` 时整块置灰、滑块 `disabled`，显示 `--`，与第 1 批行为一致。
7. 空态（无会话）不渲染任何控制按钮 / 音量控件，与现状一致。

## 四、必要依赖

- 无新增依赖。`writing-mode: vertical-lr` 作用于 `<input type="range">` 依赖 Chromium 121+（Electron 45 内 Chromium 约 134，满足）；自检用几何断言验证滑块确实竖直、浮层在岛内。
- 既有 e2e 选择器必须全部保住：`.music-ctl .music-btn`（===3）、`.music-btn-main`、`.music-volume input[type="range"]`（===1）、`.music-volume-num`、`aria-pressed`、`musicControl('toggle')`。故 `.music-ctl` 容器与 `.music-volume input` 常驻 DOM，只挪位置 / 改 CSS 可见性，**绝不条件渲染删除**。

## 五、验收条件

1. `npm run typecheck`（node + web 两个 tsc）通过。
2. `npm run build` 通过。
3. `node scripts/e2e-music.mjs` 通过（含新增 U1–U3，M2b/M2g/M3 等旧断言不回归）。
4. `node scripts/e2e-music-session.mjs` 通过（协议未动，不回归）。
5. `node .tmp/probe-music-controls-render.mjs` 通过（有真实会话分支，含 U1–U3 与 D1–D5 拖动回归）。
6. 预览版肉眼看：三个播放按钮在封面行右侧对齐；音量平时只有喇叭、点后竖直弹出且不越界。

## 六、不做什么

1. 不做逐字歌词 / 联网歌词（m02341 已否决、不再排期）。
2. 不改音量数据源（仍按应用音频会话，绝不碰系统主音量、不回退）。
3. 不新增设置项、不改 `COLLAPSED_KEYS` / `order` 六组件链路、不动 `prefs.json` 结构。
4. 不加随机 / 循环按钮（m01006 已删）。
5. 不合并回 `main`、不打包、不装机（均需用户单独授权）。
6. 不改第 5 页以外的任何页面。

## 七、设计取舍（写给自己，避免返工）

1. 「音乐条」按截图理解为「封面 + 歌名/歌手那一行」（`.music-main`）；若用户本意是「进度条那一行」，看预览版后再调（已在交付说明里讲清）。
2. 播放按钮不上移就单独处理：只把 `.music-ctl` 从独立一行塞进 `.music-main` 尾部，靠 `margin`/flex 推到右侧；选择器不变。
3. 音量浮层**向上**弹出（`bottom: calc(100% + 8px)`）：音乐页内容靠上，向上仍有空间且落在岛内；向下会顶到页脚分页器 / 岛底被裁。用绝对定位浮层，不改变文档流高度，避免撑动布局。
4. 竖条高度控制在 ~72–84px，弹出层整体不越过岛顶（几何断言验证）。
5. `.music-vol-pop` 用 `visibility/opacity/pointer-events` 切换而非 `display:none`：默认仍可被 `getBoundingClientRect()` 量到，便于 e2e 验证「不越界」；input/num 常驻 DOM 保住 M2i/M2l。

## 八、自检记录（2026-11-15）

1. [已核验] `npm run typecheck`（node + web 两个 tsc）无输出通过，`TYPECHECK_EXIT=0`。
2. [已核验] `npm run build` 通过，`BUILD_EXIT=0`：`out/main/index.js 146.79 kB`、`out/preload/index.js 12.71 kB`、`index-D9y_Pbp3.css 63.01 kB`、`index-DVTqnznN.js 107.68 kB`。
3. [已核验] `node scripts/e2e-music.mjs` → `E2E MUSIC: PASS（36 过 / 0 败）`：新增 U1（播放按钮在 `.music-main` 内且右缘 ≥ `.music-meta` 右缘）、U2（`.music-vol-pop` 默认 `visibility:hidden`）、U3（点 `.music-vol-toggle` 后 `visibility:visible` 且浮层矩形完全在 `.island` 内）；旧 M2b（`.music-ctl .music-btn`===3）、M2i/M2l、M3 全部不回归。
4. [已核验] `node scripts/e2e-music-session.mjs` → `E2E MUSIC SESSION: PASS（20 过 / 0 败）`（`PLAYING_IDX=1`，协议未动、S1–S19 不回归）。
5. [已核验] `node .tmp/probe-music-controls-render.mjs` → `PROBE MUSIC CONTROLS RENDER: PASS（21 过 / 0 败）`：P0–P14、U1–U3、D1–D5（拖动不回缩）全绿。
6. [已核验] 实现期修掉一个真隐患：`.music-ctl` 一度存在两份（新插入的封面行 + 旧的独立行），会令 M2b 变成 6 个按钮而挂掉；用「progress 收尾 + 旧 `.music-ctl` + `.music-extra`」整段锚点删掉旧块，grep 复查 `music-ctl` 只剩 1 处 JSX。
7. [已核验] `App.tsx` 音量块：`<IcoVolume />` 换成 `<button class="music-vol-toggle" aria-expanded>`，input 与 `.music-volume-num` 包进 `.music-vol-pop`（input 常驻 DOM、不条件渲染），`volOpen` state 控制 `.open` 类；`canVolume===false` 时 `off` 类 + `disabled` + `--` 保持。
8. [已核验] `styles.css`：`.music-ctl` 去 `width:100%`、改 `justify-content:flex-end` + `margin-left:auto` + `flex:0 0 auto` + gap 8px；音量段重写为「喇叭圆钮 + 绝对定位向上弹出的竖直浮层」，`input` 用 `writing-mode:vertical-lr; direction:rtl; width:14px; height:84px`，浮层用 `visibility/opacity/pointer-events` 切换、带 `@media (prefers-reduced-motion: reduce)` 关动画。
9. [未核验] 真人预览版肉眼看：三个播放按钮在封面行右侧对齐的观感、「音乐条」是否指进度条那一行、竖条弹出不越界的实际手感、不同分辨率/`zoom` 下浮层是否始终落在岛内。上述均为只有真人能验的项，待用户试预览版确认。
10. 边界 [已核验]：本批只在 `music-ui-tweak` 分支，未合并 `main`、未打包、未装机；安装版仍是第 1+2 批产物。合并与打包各需用户单独授权。

## 九、整页照参考图重排（2026-11-15 20:50，取代第一~八节目标）

### 缘起与决议

1. 用户 m02652 发参考图 `sha256:86cf24a60186c2a898371c509598e4a6d7cd8b33add2cc7b7a166a3f33973bae`：状态行 / 封面行（左圆角封面 + 中歌名歌手 + 右一行歌词）/ 进度行（左已播 `01:00` + 中条 + 右负数剩余 `-04:03`）/ 控制行（左「词」+ 中居中三个白色播放按钮 + 右喇叭与「岛上歌词」）。
2. 该图与 m02462 刚交付的「按钮右上 + 竖直音量」冲突，且右上一行歌词已被 m02341 实测否决。按全局规则一.4 停下来问了一个问题 `ui_target`，用户选「**整页照图重排**」，m02676「继续」放行。
3. 执行口径：①播放按钮移回进度条下方、相对整岛居中；②封面行右侧只留**诚实「暂无歌词」占位**（不编词、不拉数据，守住 m02341 否决）；③进度右端改负数剩余 `-mm:ss`；④音量由竖直改**横向向左弹出**、保留 m02462「平时隐形、点喇叭显现」；⑤配色/布局尽量贴近参考图但不引入任何新数据源。

### 修改范围（同一分支增量）

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | 加 `remain = Math.max(0, duration - live)`；`.music-main` 里嵌的 `.music-ctl` 换成 `.music-lyric-slot`（「暂无歌词」）；进度右端 `-{fmtDuration(remain)}`；新增 `.music-control-row`（左 `.music-ctl-spacer` + 中 `.music-ctl` 三按钮 + 右 `.music-extra` 音量）；注释由「竖直」改「横向」 |
| `src/renderer/src/styles.css` | 新增 `.music-control-row { display:grid; grid-template-columns:1fr auto 1fr }`、`.music-ctl-spacer`、`.music-lyric-slot`（max-width 34% / 右对齐 / ellipsis）；`.music-ctl` 改回 `justify-content:center; width:100%`；`.music-extra` 改 `justify-content:flex-end`；`.music-vol-pop` 由向上竖直浮层改向左横向（`right:calc(100% + 8px); top:50%; translateY(-50%); flex-direction:row`）；`input[type=range]` 回水平（`width:92px; height:14px`、track `height:3px`、thumb `margin-top:-3.5px`），删 `writing-mode`/`direction`/`margin-left`；`.music-volume-num` 改 `text-align:right` |
| `scripts/e2e-music.mjs` | M2d 正则放宽 `/^-?\d+:\d{2}(:\d{2})?$/`；U1 改「控制行居中、不在封面行」、U3 由 `h>40` 改 `w>60`；新增 U4（歌词占位「暂无歌词」、无联网歌词元素）、U5（负数剩余）。旧 M2b/M2g/M2i/M2l/M3 一行未动 |
| `.tmp/probe-music-controls-render.mjs` | 同步 U1/U3/U4/U5，保住 U2 与 D1–D5（一次性，不进提交） |
| `docs/状态.md` | 顶部新增 20:50 一句话状态，19:55 条标历史 |

### 预期行为与验收

1. 播放按钮组中心与岛中心 X 差 ≤6px，且不再嵌在 `.music-main` 内。
2. 音量横条平时 `visibility:hidden`，点喇叭后显现、`w>60` 且浮层矩形完全在岛内，再点收起。
3. 封面行右侧只有「暂无歌词」文本，不存在任何联网歌词 DOM。
4. 进度行右端为 `-mm:ss`（正则 `^-\d+:\d{2}(:\d{2})?$`），左端仍为已播时间。
5. `canVolume===false` 仍置灰 + `disabled` + `--`（第 1 批行为不回归）。
6. 三个播放按钮仍恰好 3、音量 `input[type=range]` 恰好 1、进度热区恰好 1（旧 e2e 选择器不破）。

### 自检记录（本轮重排，全部 [已核验]）

1. `npm run typecheck`（node + web 两个 tsc）无输出通过。
2. `npm run build` EXIT=0：`out/main/index.js 146.79 kB`、`out/preload/index.js 12.71 kB`、`index-DeUSFRyH.css 63.74 kB`、`index-uujRuk7E.js 108.22 kB`。
3. `node scripts/e2e-music.mjs` → **PASS（38 过 / 0 败）**：U1 控制行居中 / U2 横条隐形 / U3 点喇叭显现且不越界 / U4 诚实歌词占位 / U5 负数剩余全绿，M2b/M2i/M2l/M3 全不回归。
4. `node scripts/e2e-music-session.mjs` → **PASS（20 过 / 0 败）**：协议未动、S1–S19 不回归。
5. `node .tmp/probe-music-controls-render.mjs` → **PASS（23 过 / 0 败）**：P0–P14、U1–U5、D1–D5（拖动不回缩）全绿。
6. 实施期修掉一个真隐患：`.music-ctl` 一度既嵌在封面行又独立存在（两份，共 6 个按钮，M2b 必挂）；用整段锚点删掉旧块，grep 复查 `music-ctl` 仅 1 处 JSX。`.tmp/check-jsx.mjs` 自写正则首版把 `=>` 的 `>` 误当标签报 9 处假错，改整段 `s` 标志匹配 + 人工 read 核对结构配对。
7. [未核验] 真人预览版观感：与参考图的相似度、横向音量条向左弹出的手感与不越界、负数剩余时间读数是否合意、不同分辨率/`zoom` 下浮层是否始终在岛内。只有真人能验，待用户试预览版确认。
8. 边界 [已核验]：仍只在 `music-ui-tweak` 分支，未合并 `main`、未打包、未装机；安装版仍是第 1+2 批产物。合并与打包各需用户单独授权。

## 十、音量竖直回归 + 「用不了」诊断（2026-11-15 22:00，取代第九节第 2、4 条横向表述）

### 缘起与结论

1. 用户 m02917 追加两项纠正：「音量调节用不了」「我要竖线调节，不要横线」。m02462 最早就是「竖跳」，第九节照参考图重排时我把音量改成了横向，**是改错方向**，本次改回。
2. [已核验] 写入链路没坏：`.tmp/diagnose-volume.mjs` 端到端回读三条路径，真实应用音量都跟着变——直接 IPC `musicControl({cmd:'volume',value:0.37})` 后 `1→0.37`、UI 事件 `→0.62`、真鼠标拖 `→0.27`；浮层可见、`elementFromPoint` 命中 `input` 本身、未被遮挡。
3. [推断] 「用不了」最可能是方向错配：用户按竖直上下拖去操作只有约 11px 高的横条，竖直方向无有效热区 ⇒ 表现为拖不动。与「我要竖线」是同一件事；无法 100% 还原当时那一下操作，但修复方向一致且明确。
4. 决议：音量浮层由「向左横向弹出」改回「**向上竖直弹出**」，滑块 `writing-mode: vertical-lr; direction: rtl` 竖直、平时隐形/点喇叭显现的交互保留；播放按钮居中、诚实歌词占位、负数剩余、控制行三列等第九节其余结论不变。

### 修改范围（同一分支增量）

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | 仅三处注释「横向」→「竖直」（:1775-1776 `:2021` `:2032`）；DOM 结构不变，`input` 仍常驻 `.music-vol-pop`（保住 M2i/M2l） |
| `src/renderer/src/styles.css` | `.music-vol-pop` 由向左（`right:calc(100%+8px); top:50%; translateY(-50%); flex-direction:row`）改回向上（`bottom:calc(100%+8px); left:50%; translateX(-50%); flex-direction:column; align-items:center; gap:6px; padding:8px 6px`）；`input[type=range]` 由 `width:92px; height:14px` 改回 `width:14px; height:84px; writing-mode:vertical-lr; direction:rtl`；track `width:3px`（删 height）、thumb `margin-left:-3.5px`（删 margin-top）；`.music-volume-num` `text-align:center`。`visibility/opacity/pointer-events` 切换、`.open`、`.off`、`:disabled`、`reduced-motion` 全保留 |
| `scripts/e2e-music.mjs` | U2/U3 标签「横条」→「竖条」；U3 判定由 `w > 60` 改 `h > 60 && w < 60`（竖直口径）+ 保留 `inside`；:289 注释同步。旧 M2b/M2g/M2i/M2l/M3 一行未动 |
| `.tmp/probe-music-controls-render.mjs` | 同步 U2/U3 标签与 `h > 60 && w < 60`，保住 U1/U4/U5 与 D1–D5（一次性，不进提交） |
| `docs/状态.md` | 顶部新增一句话状态，20:50 条标历史 |

### 预期行为与验收

1. 音量竖条平时 `visibility:hidden`，点喇叭后显现、`h>60 && w<60` 且浮层矩形完全在岛内，再点收起。
2. 竖条 `writing-mode: vertical-lr`、`direction: rtl`，高 > 宽 ×2，浮层向上弹出（`bottom <= toggle.top`）。
3. 真鼠标沿 Y 轴上下拖动，真实应用音量跟着变（端到端回读，不是只看 DOM）。
4. `canVolume===false` 仍置灰 + `disabled` + `--`（第 1 批行为不回归）。
5. 三个播放按钮仍恰好 3、音量 `input[type=range]` 恰好 1、进度热区恰好 1（旧 e2e 选择器不破）。
6. 第九节其余结论（U1 控制行居中、U4 诚实歌词占位、U5 负数剩余）不回归。

### 自检记录（本轮竖直回归）

1. [已核验] `npm run typecheck`（node + web 两个 tsc）无输出通过。
2. [已核验] `npm run build` EXIT=0：`index-PZJEvrUM.css 63.78 kB`、`index-CJV2HPIw.js 108.22 kB`。
3. [已核验] `node scripts/e2e-music.mjs` → **PASS（38 过 / 0 败）**：U1–U5 全绿，U3 现按竖直口径 `h>60 && w<60` 判定通过；M2b/M2i/M2l/M3/M4/M5 全不回归。
4. [已核验] `node scripts/e2e-music-session.mjs` → **PASS（20 过 / 0 败）**：协议未动、S1–S19 不回归。
5. [已核验] `node .tmp/probe-music-controls-render.mjs` → **PASS（23 过 / 0 败）**：P0–P14、U1–U5、D1–D5（拖动不回缩）全绿。
6. [已核验] `.tmp/capture-vertical-volume.mjs` 真实画面自证：`SESSION={"active":true,"app":"汽水音乐","canVolume":true,"volume":1}`；`GEOM={"vertical":true,"writingMode":"vertical-lr","input":{"x":319,"y":33,"w":11,"h":63},"popAboveToggle":true,"popInside":true,"vis":"visible","pe":"auto","disabled":false,"hitIsInput":true,"num":"100%"}`；真鼠标沿 Y 轴上下拖 `DRAG={"before":1,"volume":0.91,"num":"91%","inp":"0.91","changed":true}`；截图 `.tmp/music-ui-vertical.png`（20096 B）。
7. [已核验] `vision_describe` 看展开态真实画面：喇叭在下方靠右、上方弹出竖直滑块浮层、竖条完整可见未被裁掉一截、未超出面板；三个播放按钮居中成行。浮层与上方内容「轻微重叠」是弹出层盖在内容之上的正常表现（点开才显现、收起即恢复），几何 `popInside=true` 已确认不越界。
8. [未核验] 真人预览版观感：竖直拖动手感、浮层向上弹出的位置是否合意、真实播放器下的整体相似度。只有真人能验，待用户试预览版确认。
9. 边界 [已核验]：仍只在 `music-ui-tweak` 分支，未合并 `main`、未打包、未装机；安装版仍是第 1+2 批产物。合并与打包各需用户单独授权。

## 十一、音量滑块「拖不动」根因定位与热区修复（2026-11-16，用户 m03141「解决音量建无法拖动的问题」）

### 缘起与结论

1. 用户 m03141 报「音量建无法拖动」。上一轮第十节把音量改竖直后，当时判定「写入链路没坏、是方向错配」，**该判定不完整**：竖直方向确实能拖，但要求鼠标落在极窄的一条上。
2. 排查方法：全部用**真 OS 鼠标**（`SetCursorPos` + `mouse_event`），而不是 CDP 注入，避免注入路径掩盖命中问题。造真实 SMTC 会话用 `scripts/e2e-music-session.mjs` 的 `SCENE_PS1` 那段 PowerShell（`Windows.Media.Playback.MediaPlayer` 放静音 wav）。
3. [已核验] **安装版（`d04b4e5` 产物，横向旧条）真鼠标能拖且落地**：`GEOM` 里 `input 69×11`、中心左右 ±20px 全部 `elementFromPoint` 命中 `INPUT`；右→左 `1→0.06`、左→右 `0.06→0.92`，DOM 值 / 百分比文本 / 主进程 poll 快照三者一致。⇒ 「物理拖不动」在安装版不成立。
4. [已核验] **分支竖直条真鼠标也能拖且落地**：`probe-drag3.mjs` 三组拖动 `DOWN_TO_UP 0.91→1`、`UP_TO_DOWN 1→0.01`、`MID_TO_UP 0.01→1`，同样三者一致；`probe-slowdrag.mjs` 跨 3 次 1s poll 的 3.6 秒慢拖 `backJumpCount:0`、`inputEventCount:57`，**「松手被 poll 快照弹回」这条被排除**。
5. [已核验] **真根因是命中宽度只有 11px**：`.tmp/probe-hitdrag.mjs` 沿输入框中心 X 轴逐像素 `elementFromPoint` 扫描，得到
   `GEOM={"input":{"x":319,"y":33,"w":11,"h":63},"hitOffsets":[-5,5,11],"scan":[..."-6:DIV.music-vol-pop","-5:INPUT"..."5:INPUT","6:DIV.music-vol-pop"...]}`
   ⇒ 可点宽度 = 11px（`-5..+5`）；`.app` 上还有 `zoom:.75`，视觉上 3px 轨道两侧各只剩约 4px 余量。随后真 OS 鼠标四次拖动：中心 `dx=0` 命中，**`dx=+10`、`dx=-10`、`dx=+18` 全部 `changed:false` 且 `active="DIV"`（焦点没落到 input）**。这与用户手感完全吻合：人眼瞄 3px 细线，横向偏一点就按在浮层背景上，看起来就是「拖不动」。
6. [已核验] **不需要自己写 pointer capture**：`.tmp/probe-drift.mjs` 斜向拖动，X 方向同时漂 +30px（远超输入框宽度），`DRIFT={"eventCount":41,"first":"0.01","last":"1","after":{"dom":"1","num":"100%","poll":1}}` ⇒ Chromium 原生 range 一旦在 input 上按下会隐式捕获指针，横向漂出也不中断。所以**只需扩大命中宽度**。

### 修改范围（同一分支增量）

| 文件 | 改动 |
|---|---|
| `src/renderer/src/styles.css` | `.music-vol-pop input[type='range']`：`width:14px` → `width:28px`（盒子加宽，轨道仍 3px、视觉不变，两侧多出的是透明热区）；新增 `touch-action:none`；`::-webkit-slider-thumb` 由 `10×10 / margin-left:-3.5px` 改为 `12×12 / margin-left:-4.5px`（视觉中心不变）。加中文注释说明根因与「透明热区」取舍 |
| `scripts/e2e-music.mjs` | 新增 `U3b` 回归护栏：用 `elementFromPoint` 在输入框水平中线沿 `dx=-30..+30` 逐像素统计命中，断言 `hitPx >= 20` |
| `docs/Spec/SPEC-music-ui-tweak.md` | 本节 |
| `docs/状态.md` | 顶部新增一句话状态 |

### 预期行为与验收

1. 音量竖条可见宽度不变（轨道仍 3px、浮层宽度仍 < 60px），但真人在轨道左右偏 10px 内按下都能命中滑块。
2. 命中宽度 ≥ 20px（`U3b` 护栏）；`U3` 的 `h>60 && w<60 && inside` 不回归。
3. 拖动仍端到端落地：DOM 值、百分比文本、主进程 poll 三者一致，跨 poll 不回弹。
4. `canVolume===false` 仍置灰 + `disabled` + `--`（第 1 批行为不回归）。
5. `U1/U4/U5`、`M2i/M2l/M3/M4/M5`、会话版 `S1–S19` 全不回归。

### 自检记录（本轮热区修复，2026-11-16）

1. [已核验] 修复前基线（重启预览后）`.tmp/probe-hitdrag.mjs`：`GEOM={"input":{"x":319,...,"w":11,...,"hitOffsets":[-5,5,11]}`；`DRAGS` 中 `PLUS10/MINUS10/PLUS18` 均 `changed:false`、`active:"DIV"`。
2. [已核验] `npm run typecheck` 两段（node/web tsc）无输出通过。
3. [已核验] `npm run build` EXIT=0（`✓ built in 147ms`；`out/renderer/assets/index-B4yi3lAK.css 64.26 kB`、`index-DWeI-30V.js 108.22 kB`、`vendor-DeLoXG_s.js 564.37 kB`）。
4. [已核验] 修复后重启预览（`Get-Process electron | Stop-Process -Force` 再起 `node_modules\electron\dist\electron.exe . --remote-debugging-port=9321`，否则跑的是旧内存样式），再跑 `.tmp/probe-hitdrag.mjs`：
   `GEOM={"input":{"x":314,...,"w":21,...,"hitOffsets":[-11,10,22],"scan":[... "-12:DIV.music-vol-pop","-11:INPUT" ... "10:INPUT","11:DIV.music-vol-pop" ...]}` ⇒ **命中点数 11 → 22（约 21~22px）**；
   `DRAGS`：`PLUS10 {after dom:"1",num:"100%",poll:1,active:"INPUT",changed:true}`、`MINUS10 {同上,changed:true}`、`PLUS18 {changed:false,active:"DIV"}` ⇒ 原先按不到的 ±10px 现在都能拖到顶，±18px 仍在外侧（预期边界）。
5. [已核验] `node scripts/e2e-music.mjs` → **PASS（38 过 / 0 败）**，含新增 `U3b 音量滑块的透明热区够宽（可点命中 ≥20px…）`，`U3` 及 `M1–M5` 全不回归。
6. [已核验] `node scripts/e2e-music-session.mjs` → **PASS（20 过 / 0 败）**。首跑曾 FAIL 1 条（`S2 PLAYING_IDX=0`），原因是上一轮遗留的假会话场景进程还在（同时存在 4 个会话，播放中那个恰好排在索引 0），杀掉残留 PowerShell 后重跑即 PASS；**不是产品回归**。
7. [未核验] 真人对修复后的手感：需要用真实播放器（汽水音乐）在预览版或装机版上亲手拖一次，确认「偏一点也能拖」符合预期。
8. 边界 [已核验]：仍只在 `music-ui-tweak` 分支，未合并 `main`、未打包、未装机。
