# SPEC：灵动岛三套视觉主题（A/B/C），默认亮色玻璃 B

- 建立日期：2026-11-24
- 前置：`visual-refresh` 分支（0.4.4 换皮第一步，用户已否决其「调浅黑」方向）
- 任务分支：`island-themes`
- 用户原话（2026-11-24）：「把 A/B/C，三种效果都保留，后续可以添加一个在设置里换主题的功能，先做 b 吧」

## 〇、背景与已确认事实

1. 2026-11-24 已出三个方向的效果图（`.tmp/mockups/directions.png`），用户选 B。
2. `visual-refresh` 中把纯黑调成 `#1a1b1f` 的做法被用户否决（原话「原本的黑色掉色了，更垃圾了」）。A 主题回到**纯黑**。
3. **技术前提（探针实测，2026-11-24）**：在 `transparent: true` 的置顶窗里，给元素加 `backdrop-filter: blur(34px)`，桌面内容仍然**清晰透出、没有被模糊**（证据：`.tmp/mockups/probe-backdrop.png`）。Chromium 的 backdrop-filter 只采样同一页面内绘制在下方的内容，采不到窗口背后的桌面像素。
   → B 的「真透视玻璃」需要抓屏回填，代价大且会持续捕获桌面内容；本 SPEC **不采用**。
   → B 实现为「**乳白磨砂玻璃**」：高不透明度乳白底 + 顶部受光 + 内高光 + 柔和阴影。看起来是磨砂材质，但不透出桌面细节。

## 一、目标

1. 建立**主题 token 体系**，同一份组件样式支持三套主题，默认 B。
2. 三套主题都保留在同一份代码里，为后续「设置页换主题」留接口（本轮不做切换 UI）。
3. 本轮交付默认亮色玻璃 B，装到用户机器上看效果。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/styles.css` | 建立语义 token（中性层用 `color-mix(in srgb, var(--ink-1) …)` 派生，做到一套规则两套明暗）；新增 `:root`（A）、`[data-theme='glass-light']`（B）、`[data-theme='mono']`（C）三段主题变量 |
| `src/renderer/src/App.tsx` | 读 `prefs.islandTheme`（默认 `glass-light`），写到 `document.documentElement.dataset.theme`；监听 `onPrefsChanged` 同步 |
| `src/renderer/src/pet/skinCapsule.tsx` | 岛仔配色跟随主题（A/C 蓝胶囊、B 同色）——用 CSS 变量驱动，不再写死 |
| `docs/facts/视觉设计规范.md` | 同步主题 token 与三套取值 |

**以下不动**：布局、组件结构、窗口尺寸、动效时长与曲线、交互逻辑、设置页（本轮不加 UI）。

## 三、预期行为

1. 默认主题 B：乳白磨砂亮色，深色文字；在深色壁纸、浅色壁纸、窗口截图上都可读。
2. A：纯黑玻璃，白字；C：纯黑极简，无描边，白字。
3. 三套主题下功能完全一致，只是颜色/明暗/描边不同。
4. 主题值非法或缺失 → 回落到 B，不报错、不白屏。
5. 切换主题（本轮只能通过改 `prefs.json` 验证）后立即生效，无需重启。

## 四、必要依赖

无新增依赖。`color-mix()` 需要 Chromium ≥ 111，本项目 Electron 45 / Chromium 138，满足。

## 五、验收条件

- V1 `npm run typecheck`、`npm run build` 通过。
- V2 三套主题 × 五个展开页 + 收起态各截一张图；逐页检查：文字对比度（正文 ≥ 4.5:1，次要 ≥ 3:1）、无「白底白字」、无不可见图标、无被主题破坏的语义色（红/绿/黄仍能区分）。
- V3 浮层类：置物架视图菜单、时间选择面板、音乐音源菜单、通知横幅、验证码横幅，在 B 下逐一打开截图确认可读。
- V4 回归：`e2e-head-order`、`e2e-collapse-order`、`e2e-todo-today`、`e2e-schedule-day`、`e2e-bell-notify`、`e2e-shelf-view-pref`、`e2e-banner-fit`、`e2e-code-hint`、`e2e-music`、`perf-click-latency`。
- V5 用户在自己机器上看过预览版并认可 B 的观感。

## 六、不做什么

- 不做设置页的主题切换 UI（用户说「后续可以添加」）；本轮只保证 `prefs.islandTheme` 能被读取和热更新。
- 不做抓屏回填的真透视玻璃。
- 不改布局与组件结构（头部仍是两行、七元素），组件化留到下一步。
- 不改窗口尺寸常量与主进程尺寸逻辑。
- 不做主题的自定义配色/导入导出。

## 七、风险与取舍

1. B 的"不透明感"：为了可读性，岛体不透明度会做到 ~0.94，桌面细节基本透不出来，观感是"乳白磨砂板"而不是"透视玻璃"。这是探针实测后的选择，不是偷懒。
2. 中性层用 `color-mix(in srgb, var(--ink-1) X%, transparent)` 派生：一处改动即可让所有卡片/描边/分隔线随主题翻转。风险是少数特殊场景（例如"实心按钮上的次要文字"）需要单独 token，逐页检查时兜底。
3. 语义色在亮色底上需要加深（绿/黄/红各一套），否则对比度不足。

## 八、自检记录

分支 `island-themes`，提交见本轮交付说明。

### 8.1 实现与偏离 SPEC 的地方

1. 主题键名定为 `glass-light` / `glass-dark` / `mono`，与 `data-theme` 取值一致，白名单写在 `src/shared/types.ts` 的 `ISLAND_THEMES`，主进程 `prefsStore` 用它校验。
2. **偏离**：默认主题写在 `:root` 而不是 `[data-theme='glass-light']`。原因：React 挂 `data-theme` 之前有一帧空窗，若 `:root` 是 A（黑），亮色用户会先闪一下黑。现在 `:root` = B，`glass-light` 不需要自己的块。
3. **偏离**：`skinCapsule.tsx` 没有改成主题驱动。岛仔是角色形象（蓝胶囊 + 白眼睛），不是界面层；跟着主题反色会变成一个陌生东西，和「用户升级不能突然换脸」的既有约束冲突。三套主题下它保持原样。
4. C（mono）的 `--surface-*` / `--line*` 用固定深灰（`#121214` 等）而不是 `color-mix` 叠加，否则和 A 看起来一样（都是黑底白字），失去区分。
5. 中性档 `--ink-2..5` 在 B 里比 A/C 重（82/62/52/26% vs 72/50/42/22%）：42% 的黑压在乳白底上只有 2.6:1，正文次要信息读不清。

### 8.2 跑过的命令与结果

- `npm run typecheck` 通过（node + web 两个 project）[实测]。
- `npm run build` 通过 [实测]。
- 三套主题 × 5 个展开页 + 收起态，共 18 张截图：`.tmp/island-themes/shots/<theme>/`。逐张看过：无「浅底浅字」、无不可见图标、红色铃铛点/绿色电量环在浅色主题下仍可辨 [实测]。
- B 下三个浮层：置物架视图菜单、日程时间选择面板、音乐音源菜单，均打开截图确认可读 [实测 `shots/glass-light-popovers/`]。
- `prefs.islandTheme` 真实链路：`mono` / `glass-dark` / `glass-light` / 非法值 `neon-pink` / 缺失，五次启动分别读回 `dataset.theme`，非法与缺失都回落 `glass-light` [实测 `.tmp/island-themes/check-prefs-theme.cjs`]。
- 回归脚本全部通过：`e2e-head-order`(14)、`e2e-collapse-order`(22)、`e2e-todo-today`、`e2e-schedule-day`、`e2e-bell-notify`(15)、`e2e-shelf-view-pref`、`e2e-banner-fit`(8)、`e2e-code-hint`(10)、`e2e-music`(17 过 / 3 跳过)、`perf-click-latency` [实测]。

### 8.3 没验证的

- 没有在用户真实桌面的多张壁纸上逐一目测 B 的观感；截图用的是注入的中性深色底 [未验证]。
- 通知横幅、验证码横幅没有在 B 下单独截图核对配色（`e2e-banner-fit` 只验证几何与交互，不检查颜色）[未验证]。
- 主题切换没有 UI，只能手改 `prefs.json`（本轮按 SPEC 不做设置页）[已知限制]。
- 高 DPI / 多显示器缩放下没有重跑截图 [未验证]。
