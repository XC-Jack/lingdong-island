# SPEC：音乐页 UI 微调（音量竖跳 + 播放按钮移到右上）

- 基线：`main` @ `5a855b9`
- 分支：`music-ui-tweak`
- 用户消息：m02462「把音量弄成竖跳的，音量条隐形，点声标时显现；还有就是这个播放等这一块ui移到上面的右边，和音乐条对其」
- 用户截图：`sha256:a206382f4867a698d22498e82c9c1ccc10f27fa94943554fdfec16fe052ec1ba`
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
