# SPEC：组件首页（iOS 组件网格 + 点开放大）

- 建立日期：2026-11-24
- 基线：`main` `a499fa6`（外观设置收口）
- 任务分支：`island-widget-grid`
- 背景：用户 2026-11-24 原话「我们现在把每一页做成像苹果手机组件一样，打开缩放」。经提问确认：①展开后先看组件网格，点组件放大成对应页面；②这一轮先做一页看效果，其余四页先进旧页面；③面板同宽、高度随内容；④视觉按 iOS 18 主屏小组件的通用规范做。

## 一、目标

1. 岛展开后，第一层不再是某个功能页，而是 **iOS 主屏风格的组件网格**：待办、置物架、通知、日程、音乐各一个组件，2×2 方格与 4×2 宽条混排，浅色卡面、彩色小图标、带信息预览。
2. 点任一组件 → 该组件区域以缩放动画展开成对应功能页（iOS 打开 App 的放大效果）；功能页左上角有返回键，回到网格。
3. 本轮把**待办页**改成组件卡片风（试水页）；其余四页暂用现有样式，但网格上都能点进去。
4. 三套主题（`glass-light` / `glass-dark` / `mono`）下都成立，颜色只走 token。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | 新增 `WidgetGrid` 组件与 `view: 'grid' \| number` 状态；展开默认进网格；点组件切页 + FLIP 缩放动画；功能页返回键；网格页头部与状态栏 |
| `src/renderer/src/styles.css` | `.widget-grid` / `.widget` 系列样式、缩放动画关键帧、待办页组件卡样式、三主题适配 |
| `scripts/e2e-*.mjs`（使用 `.island` 点击展开的 19 个） | 展开后补一步「点对应组件」，恢复原有断言路径 |
| `docs/facts/视觉设计规范.md` | 补「组件首页」一节的尺寸、圆角、卡面规则 |
| `docs/状态.md` | 本轮交付记录 |

## 三、预期行为

1. 收起胶囊点击展开 → 显示组件网格，窗口尺寸与网格内容匹配；不再直接落在待办页。
2. 网格上 5 个组件按用户「页面管理」的显隐与顺序呈现（被裁掉的页面不出现组件）。
3. 点「待办」组件 → 组件矩形放大成待办页（约 320ms，曲线沿用项目统一缓动）；内容在卡片落定后淡入。
4. 待办页左上角出现返回键（`‹`），点它缩回网格；Esc 仍整体收起岛。
5. 网格页的自动收起时长与待办页一致（`AUTO_COLLAPSE_MS`），鼠标移开仍收起。
6. 功能页保留现有底部翻页器：进入后仍可左右翻页；翻页时头部标题与徽章同步，返回键始终回网格。
7. 三套主题下卡面与文字对比度达标（正文 ≥4.5:1，次要 ≥3:1）。
8. 通知铃铛、拖文件进岛等既有入口仍直接打开对应功能页，不经过网格。

## 四、必要依赖

无新增依赖。动画用 CSS transform / Web Animations API，FLIP 的矩形测量用 `getBoundingClientRect`。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2 展开后截图确认：网格页在 `glass-light` / `glass-dark` / `mono` 三套主题下均可读、组件排列正确。
- A3 点待办组件 → 进入待办页；点返回 → 回网格；动画无窗口裁切、无白屏闪烁（录屏或逐帧截图）。
- A4 网格与待办页之间切换时窗口尺寸不跳（两者共用同尺寸）；切到其余四页仍走既有尺寸同步逻辑。
- A5 回归脚本：`e2e-todo-today`、`e2e-head-order`、`e2e-collapse-order`、`e2e-pages-custom`、`e2e-schedule-day`、`e2e-notify-compact` 通过（同步改过入口的脚本以改后为准）。
- A6 用户在本机预览版看过并认可（审美最终由用户判定）。

## 六、不做什么

- 不改收起胶囊的外观与行为。
- 不改设置窗口。
- 不把其余四页内部改成组件风（下一轮铺开）。
- 不做全局面板统一固定尺寸（用户选「同宽、高度随内容」）。
- 不打包、不升版本号、不合并 `main`（等用户确认效果）。

## 七、自检记录

### 7.1 实际改了什么（[实测]，2026-11-24）

| 类别 | 改动 |
| --- | --- |
| 视图层 | `App.tsx` 新增 `view: 'grid' \| number`；收起时重置为 `grid`；翻页、铃铛、拖文件入口同步 `setView` |
| 网格 | `.widget-grid`：308 布局 px 宽，2 列方格 + 音乐宽卡；卡面 `--surface-1`，图标色由 accent/warn/danger/ok/music-play 派生 |
| 动画 | 点组件记下矩形，`view` 变化后的 `useLayoutEffect` 用 WAAPI 做 340ms FLIP 缩放（zoom 0.75 已折算位移） |
| 返回 | 功能页头部左侧新增 `.panel-back`，回网格并反向缩放 |
| 待办页 | 列表行圆角 10→16、行距 6→8、内边距加大；输入框与加号改胶囊/圆形；时间按钮在待办页改圆形 |
| e2e | 19 个脚本（20 处）在展开后补点 `.widget[data-page="0"]`；`e2e-head-order` 的 `expand()` 与 `e2e-pages-custom` 的两处 `dispatchEvent` 单独补点组件 |

### 7.2 跑了什么（[实测]）

- `npm run typecheck`：node + web 均通过。
- `npm run build`：electron-vite 构建成功。
- 截图（`.tmp/widget-grid/`）：网格页 `glass-light` / `glass-dark` / `mono` 三套、待办页、音乐旧页；网格在 258×248 视觉，待办页 255×190 视觉。
- 动画实测：进页面时 `.page-fade` 上存在 2 个 WAAPI 动画，起始 `scale(0.69, 0.94)`；返回时 `.widget-grid` 起始 `scale(0.99, 0.48)`；结束后均回到 `none / opacity 1`。
- 回归：
  - `e2e-todo-today` PASS
  - `e2e-head-order` 14 过 / 0 败
  - `e2e-collapse-order` 22 过 / 0 败
  - `e2e-pages-custom` 6 项 PASS
  - `e2e-schedule-day` PASS
  - `e2e-collapsed-todo` PASS
  - `e2e-shelf-view-pref` PASS
  - `e2e-notify` PASS
  - `e2e-m2` PASS
  - `e2e-schedule-crossmonth` 8 过 / 0 败
  - `e2e-exit-and-shelf-view` PASS
  - `e2e-notify-compact` C1/C2 通过（收尾 `taskkill` 128 是脚本既有问题）
- `perf-click-latency`：P2 启动 684 ms 通过；P3 最后一项 P95 62–85 ms **未通过，但在 `main` 基线上同样为 81 ms**，样本结构一致（最后一次离群），判为既有环境抖动，不是本轮引入。

### 7.3 没验证的

- 未录屏逐帧核对缩放动画的中间帧（CDP 截图抓不到 340ms 内的帧）；只验证了动画对象与首尾状态。
- 用 `main` 基线的 `perf-click-latency` 对照只跑了一次。
- 批量改过的其余 9 个 e2e 脚本（`e2e-m4`、`e2e-m4-drop`、`e2e-reorder`、`e2e-schedule-edit`、`e2e-schedule-scroll`、`e2e-schedule`、`e2e-notify-group`、`e2e-notify-live`、`e2e-shelf-missing`）未逐一跑。
- 真实鼠标操作下的缩放观感、触屏/高 DPI 未测。

### 7.4 已知取舍

- 网格页（258×248 视觉）比待办页（255×190）高：两者切换时窗口高度会跳一次，主进程 `applyBoundsNow` 立即改窗口，实测无裁切；但「岛突然变高/变矮」的观感要等用户判断。
- 返回动画的目标是整块网格，而不是点击前的那个组件矩形；视觉上是从页面缩成整页网格。
- 其余四页内部仍是旧样式，只是从网格能点进去。

## 八、验收记录

- 用户验收（2026-11-24）：用户回「没什么问题，继续往下吧」——组件网格、点开放大、返回、待办页卡片化均通过，方向确认。
- 补充修复（2026-11-24，`55ffbc1`）：网格头部去掉重复日期与待办数字，品牌与时钟锁单行。
- 未做独立验收：按工程规则第三节第 5 条留待批量验收。
- 合并授权：用户 2026-11-24「ok，先合并吧」。

## 2026-11-28 补充：减弱动态效果下不播切页缩放（分支 `collapsed-lyric-bar`）

**现象 [实测]**：用户反馈音乐页「展开的动画，收缩和缩放，太卡了」。逐帧采样（`.tmp/probe-music-anim.mjs`）显示 renderer 没有 >33ms 的帧间隔、岛也没有越出窗口；本机 `prefers-reduced-motion: reduce` 为 true，CSS 过渡已被压到 1ms，唯独这里的 WAAPI 340ms 缩放不受 CSS 媒体查询约束，仍在整页缩放。

**改动**：`App.tsx` 的切页缩放 `useLayoutEffect` 在创建动画前检查 `matchMedia('(prefers-reduced-motion: reduce)')`，命中就不播缩放，切页直接到位（页面淡入仍走 CSS，已在 1ms）。非 reduce 环境保持 340ms FLIP 缩放不变。

**自检 [实测]**：`npm run build` EXIT=0；探针 `.tmp/probe-zoom.mjs`（临时）在 reduce=true 下点组件进音乐页，`.page-fade` 上只有 1ms 淡入动画、没有 340ms 缩放；`e2e-music` PASS（47 过 / 0 败 / 1 跳过）。

**未验证**：真人观感；非 reduce 机器的 340ms 缩放本轮未改动、未重测。
