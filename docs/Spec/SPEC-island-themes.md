# SPEC：灵动岛三套视觉主题（A/B/C），默认亮色玻璃 B

- 建立日期：2026-11-24
- 前置：`visual-refresh` 分支（0.4.4 换皮第一步，用户已否决其「调浅黑」方向）
- 任务分支：`island-themes`
- 用户原话（2026-11-24）：「把 A/B/C，三种效果都保留，后续可以添加一个在设置里换主题的功能，先做 b 吧」

## 〇、背景与已确认事实

1. 2026-11-24 已出三个方向的效果图（`.tmp/mockups/directions.png`），用户选 B。
2. `visual-refresh` 中把纯黑调成 `#1a1b1f` 的做法被用户否决（原话「原本的黑色掉色了，更垃圾了」）。A 主题回到**纯黑**。
3. **技术前提（探针实测，2026-11-24）**：在 `transparent: true` 的置顶窗里，给元素加 `backdrop-filter: blur(34px)`，桌面内容仍然**清晰透出、没有被模糊**（证据：`.tmp/mockups/probe-backdrop.png`）。Chromium 的 backdrop-filter 只采样同一页面内绘制在下方的内容，采不到窗口背后的桌面像素。
   → 第一轮据此把 B 实现为「**乳白磨砂玻璃**」：乳白底 + 顶部受光 + 内高光 + 柔和阴影，不透出桌面细节。
4. **第二轮修订（2026-11-24，用户否决第一轮效果）**：用户原话「和你发的那个图片对比相差太大了吧……你这个简直就是纯白呀」。第一轮只做了「乳白磨砂」，没有做真实模糊，手机上看着像白卡片。用户明确选择「真透视（抓屏 + 模糊）」。
   → 改为：主进程抓岛背后那块屏幕 → 渲染层当背景 → CSS 模糊 → 上面盖同一份乳白 veil。详见第九节。
   → 第 3 条仍然成立（`backdrop-filter` 不可用），抓屏是唯一可行路径。

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
- ~~不做抓屏回填的真透视玻璃。~~（第二轮按用户要求改为做，见第九节。）
- 不改布局与组件结构（头部仍是两行、七元素），组件化留到下一步。
- 不改窗口尺寸常量与主进程尺寸逻辑。
- 不做主题的自定义配色/导入导出。

## 七、风险与取舍

1. B 的"不透明感"：第一轮做到了 ~0.94，桌面细节基本透不出来，观感像"乳白磨砂板"——被用户否决。第二轮降到 0.62 并接上真透视底图，可读性靠 veil + 文字色重档保证（第九节有实测）。
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

## 九、第二轮：真透视底图（抓屏 + 模糊，2026-11-24）

### 9.1 机制

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 主进程 `ipcMain.handle('island:backdrop')` | `src/main/index.ts` | `desktopCapturer.getSources({types:['screen'], thumbnailSize: 全屏物理像素 × 0.35})` 抓屏 → 按 `display_id` 选屏 → 岛窗口 bounds 换算成缩略图坐标 → 裁一圈（岛 + 四边同宽 pad）→ **把岛占的矩形用左右两侧桌面像素横向插值填掉** → 返回 data URL |
| preload `islandBackdrop()` | `src/preload/index.ts` | IPC 桥 |
| 渲染层抓取循环 | `src/renderer/src/App.tsx` | 只在 `islandTheme === 'glass-light'` 且岛没被全屏避让时跑；收起 5s / 展开 1.5s 一次；拿不到就 900ms 后重试（启动初期窗口还没 show 会返回 null） |
| `.island-backdrop` | `styles.css` | 截图当 `background-image`，`inset:-32px` 外扩后 `blur(22px) saturate(1.28)` |
| `.island-veil` | `styles.css` | 与岛体同款的 `--island-veil` 乳白渐变，压在截图上保文字对比度 |

三层用 `z-index:-1` + `.island { isolation: isolate }` 落在「岛体背景之上、内容之下」，不需要给几百个子元素逐个排层级。

### 9.2 三条硬约束

1. **不能用「抓屏期间开关 `setContentProtection`」来躲开岛自己**。第一版就是这么做的（抓前 true、`finally` 关），结果被用户当场发现「老是闪，突然消失突然出现」：录屏逐帧实测，每次抓屏那 4~5 帧里岛显示的是**一张旧的缓存画面**（启动时的收起态小胶囊，亮度 140 vs 正常 205），每隔 1.5s 一次，就是 DWM 在切换 `WDA_EXCLUDEFROMCAPTURE` 时换了缓存 surface。
   → 现方案：**照常抓**（岛会在图里），再在 `toBitmap()` 的原始像素上把岛那块矩形填掉——每行取左右紧贴的桌面列，`smoothstep` 横向插值。反正最后要 `blur(22px)`，低频色块和真桌面看不出区别。pad 必须四边同宽（取能放下的最大值），否则 crop 中心偏离岛中心、cover 之后底图整体错位。
2. **图只在内存里**：data URL 只给渲染层当 CSS 背景，不落盘、不写日志、不上传。
3. **主进程不自己起定时器**：岛隐藏（全屏避让）时渲染层不拉，就没有任何抓屏开销。

### 9.3 实测数据

- 单次抓取（渲染层视角，含 IPC 往返）：不插图时 116–183 ms；插图版 164–204 ms（多出的是 `toBitmap`/`createFromBitmap` 的往返）[实测 `.tmp/island-themes/backdrop-shot.cjs`]。
- CPU（Electron 全部进程，12 秒墙钟）：收起 亮色 0.39s vs 纯黑 0.16s（差 0.23s）；展开 亮色 0.97s vs 纯黑 0.22s（差 0.75s ≈ 单核 6%）[实测 `.tmp/island-themes/measure-backdrop-cpu.cjs`]。展开时抓得勤（1.5s 一次），代价集中在这里；收起态基本无感。
- **闪烁修复的前后对照**：录屏 14 秒（25fps）逐帧算岛中心平均亮度。修复前 `max 204.7 / min 140.6`，每 37 帧（1.5s）出现连续 4~5 帧的低值，抽帧看就是「缩成启动时的收起态小胶囊」；修复后 `max = min = 198.4`，一条直线 [实测 `.tmp/island-themes/record-flicker.cjs`，`shots/flicker/before|after2`]。
- 裁切对齐：把假桌面做成「左半白 / 右半黑」硬边，岛内过渡带的中点落在 316~322px，岛外硬边在 322px（同一张 640px 宽上下文截图）→ 偏差 ≤ 6px，在模糊半径内，无错位 [实测 `shots/backdrop/split1-ctx.png` 逐行采样]。
- 与参考图的色值（同一张黄昏壁纸、同位置）：岛中心 220/190/174，参考图 `mockup-b-640.png` 220/187/170；右上冷区 214/213/224 vs 198/203/223；底部暖区 217/182/165 vs 205/167/155 [实测，`.tmp/island-themes/shots/backdrop/mock3.png`]。第一轮同位置是 247/250 级的中性白——这就是用户说的「纯白」。

### 9.4 开关链路

`prefs.islandTheme` 运行时切换（glass-light → glass-dark → mono → glass-light）：只有 glass-light 下存在 `.island-backdrop` / `.island-veil`，另外两套不抓屏 [实测 `.tmp/island-themes/check-backdrop-gating.cjs`，4 项全过]。

### 9.5 已知取舍

1. **岛背后的颜色是「插值」出来的，不是真拍到的**：岛占的那块在抓屏里是玻璃自己，只能拿左右两侧推断。桌面在岛背后有强竖直边界（比如窗口边正好藏在岛下面）时，模糊后的过渡位置会和真实桌面略有出入；因为最终 `blur(22px)` + 62% veil，肉眼不可辨。
2. **抓屏失败静默回退**：远程桌面、显卡驱动异常时 `getSources` 可能返回空/抛错，此时底图不出现，岛退回第一轮的静态乳白 veil，不会报错也不会白屏。
3. **多显示器 DPI**：按 `display.scaleFactor` 和缩略图实际尺寸反推比例，理论上支持混合 DPI，但只在单屏 1.25 缩放下实测过 [未验证]。
4. 底图是**整屏抓取再裁**，缩略图越小边缘越糊；35% 是可读性与耗时的折中。
