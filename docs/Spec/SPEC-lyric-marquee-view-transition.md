# SPEC：歌词长句横向滚动 + 歌词页返回主界面动画

- 日期：2026-11-28
- 分支：`lyric-marquee-view-transition`
- 关联：SPEC-music-layout-2、SPEC-collapsed-lyric-bar、SPEC-island-widget-grid

## 1. 目标

1. **长歌词不再看不到**：歌词页（`词` 打开的右栏）和收起态歌词条里，一句太长会被裁掉。
   给超宽的那一句加「缓慢左右往返」的横向滚动，让整句都能读到；不超宽就保持静止。
2. **歌词页 → 主界面（组件网格）的过场不再变扭**：现在返回网格沿用的是「起点矩形 → 目标矩形」
   的非等比缩放（实测 `sx≈1.64 / sy≈0.91`），网格被横向拉宽、纵向压扁，还被窗口裁掉一大块。
   这条路径改成**等比缩放 + 淡入**，不再变形。

## 2. 修改范围

- `src/renderer/src/App.tsx`
  - 新增通用组件 `MarqueeText`（量溢出 → 设置位移/时长 → 往返动画）。
  - 歌词页每一行改用它（当前句自动滚；鼠标悬停某一行也滚；其余行右缘渐隐提示还有内容）。
  - 收起态歌词条 `.cl-text` 改用它（始终自动滚）。
  - `backToGrid` 记下「这次是从歌词面板展开状态返回」；缩放 effect 对该路径改用等比缩放。
- `src/renderer/src/styles.css`
  - 新增 `.mq` / `.mq-inner` / `@keyframes mq-scroll`。
  - 行内溢出但未播放时用右缘渐隐替代省略号。
- `docs/facts/功能清单.md`、`docs/facts/视觉设计规范.md`、`docs/状态.md` 同步行为。
- 不动歌词来源、缓存格式、滚动居中逻辑、其它页面的缩放动画。

## 3. 预期行为

### 歌词横向滚动

- 当前句宽度超过歌词栏 → 先停 0.8s 展示句首，再匀速左移露出句尾，停 0.8s 后原路返回，无限循环。
  速度约 26 布局 px/s，单程 5~18s（越长越慢也越久）。
- 非当前句：不自动滚；鼠标悬停该行时滚（能点的行本来就有悬停反馈）。
- 不超宽的行：完全静止，不产生动画。
- 切句、开合歌词栏、改窗口尺寸后重新测量；不再溢出就恢复静止。
- 收起态歌词条：当前句超宽时同样往返滚动；换句后从头开始。
- 动画只用 `transform`，不触发逐帧布局。

### 歌词页返回主界面

- 从歌词页（`词` 已展开）点返回 → 窗口/岛屿尺寸照旧立即同步（不新增等待），
  组件网格以**单一缩放系数**（`min(宽比, 高比)`，以源矩形中心对齐）从 0.9 左右放大到 1，
  透明度 0.25→1，320ms 缓出。
- 不再出现横向拉宽/纵向压扁的变形帧。
- 其它入口（普通功能页 → 网格、网格 → 功能页）保持原来的非等比缩放，不改手感。

## 4. 必要依赖

无新增依赖。用浏览器原生 ResizeObserver / Web Animations API / CSS animation。

## 5. 验收条件

1. 探针：长句（`scrollWidth - clientWidth > 2`）的当前行存在 `mq-overflow` 且 `--mq-shift` 为负值；
   短句行没有 `mq-overflow`。
2. 探针：收起态歌词条对长句同样带 `mq-overflow`。
3. 探针：从歌词页返回网格时，网格上的动画关键帧 transform 只含单参数 `scale(s)`（无 `scale(sx, sy)`）。
4. 手动：长句能完整看全；返回动画不变形；动画期间帧间隔无 >40ms 的卡顿（沿用现有帧探针）。
5. `npm run typecheck`、`npm run build` 通过；相关 e2e（音乐页、收起歌词条、页面切换）通过。

## 6. 不做什么

- 不改 `词` 开合时岛屿尺寸的瞬时变化（本次只处理返回网格的过场）。
- 不加纵向手动拖动歌词、不做卡拉 OK 逐字高亮。
- 不改歌词行点击跳转、滚动居中、缓存与抓取逻辑。
- 不把非歌词页面的缩放动画一并改掉。

## 7. 自检记录（2026-11-28）

- `npm run typecheck` EXIT=0；`npm run build` EXIT=0（120ms / 275ms 两次，均无告警）。
- `.tmp/probe-marquee.mjs`（隔离 userData + `ISLAND_FAKE_MUSIC` + 预置 v5 歌词缓存 + CDP screencast）：
  - 当前长句（`时间 24s`）`.mq-overflow`、`--mq-shift:-282px`、`--mq-dur:10.8s`、`animationName:mq-scroll`、`running`；
    1.6 秒内 `transform` 从 `matrix(1,0,0,1,-1.29,0)` 走到 `matrix(1,0,0,1,-31.74,0)`（确实在动）。
  - 短句行、未溢出行无 `.mq-overflow`，无动画。
  - 收起态歌词条 `.cl-text.mq.mq-overflow`、`--mq-shift:-162px`、`mq-scroll running`。
  - 歌词页返回网格的 WAAPI 关键帧：`translate(-1.33333px, 37.0833px) scale(0.730949)` → `none`，
    透明度 `0.25 → 1`，320ms；到位后网格 231×241.1，无形变。
  - 整段交互 screencast 无 >40ms 帧间隔（回网格阶段 33 帧零空档）；首启两个 >600ms 空档为本机冷启动，与本次改动无关。
- `scripts/e2e-collapsed-lyric.mjs` PASS 43/0（期间发现并修正 `.cl-text` 类名顺序：`className` 放前面，
  保持 e2e 的 `className.split(' ')[0]` 口径）。`scripts/e2e-music.mjs` PASS 50/0。
- `scripts/e2e-pages-custom.mjs` 5 过 / 2 败（P1a/P5a「收起态应有时钟 got no」）：测试无假音乐、沿用真实
  NetEase 的播放会话，收起胶囊显示歌词条而非时钟，属环境性失败，与本次改动无关（未改歌词条显隐条件）。
- **未验证**：真人观感与真实歌曲歌词、非网易云播放器、透明玻璃以外的主题、合并前未重跑全部 e2e。

## 8. 用户验收

- 待用户预览确认（「长句能看全 + 返回不变形」）。
