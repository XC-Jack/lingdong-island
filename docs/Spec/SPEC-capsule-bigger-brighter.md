# SPEC：岛收起态胶囊与展开态头部放大、字重加粗、亮度微提

## 一、目标

用户 m01634 发了收起态胶囊截图（电量环 97 + 岛仔 + 13:33 + Wi-Fi），要求：

> 我觉得这个截图的ui可以大一点，字体粗一点，然后提高一点亮度，效果不要太过，只提高一点，我先看看效果

三件事：**尺寸大一点**、**字重粗一点**、**亮度提一点**；明确「不要太过」，所以每一项都控制在一档（约 +10% 或字重 +100）。

## 二、修改范围

改：

- `src/renderer/src/styles.css`：`.island.collapsed`（高/圆角/内边距/间距）、`.collapsed-clock`、`.collapsed-todo` 与 `.collapsed-todo-num`、`.collapsed-battery`、`.collapsed-bell`、`.collapsed-wifi` 与 `svg`、`.collapsed-pet`、`.head-battery-ring` 与 `.ring-bg`/`.ring-fg`/`.ring-num`、`.collapsed-banner` 的 `top`。
- `src/main/index.ts`：`COLLAPSED_WIN_HEIGHT`、`COLLAPSED_MIN_W`、`COLLAPSED_MAX_W`、`collapsedWidth` 初值，以及上方那段解释注释。
- `docs/facts/功能清单.md` 5. 收起态状态栏条目补尺寸说明。

不改：

- 展开态头部（`.head-info` 那一套覆盖值原样保留：展开态岛仔仍 16px、时钟仍 12.5px），用户这次截图指的是**收起态胶囊**。
- 横幅（`.collapsed-banner`）的样式本身，只有 `top` 因胶囊变高而下移 4px。
- 电量三态配色逻辑（充电绿 / 低电红 / 其余白），只调透明度，不改色相与阈值。
- 岛仔动画、眨眼节奏。
- 展开态尺寸自适应与列表 3 条那套（上一轮 `773cc62` 的结论）不动。

## 三、预期行为

1. 收起态胶囊高 46 布局 px（视觉 34.5），比原来 42（视觉 31.5）高一档；圆角、内边距、间距同比放大。
2. 时钟更大更粗更白；电量环更大且环内数字更粗；Wi-Fi 图标、岛仔、待办剩余数字同比放大。
3. 亮度整体提一档：时钟纯白、电量弧 0.85→0.98、环底 0.16→0.2、Wi-Fi 0.82→0.94、铃铛 0.92→0.98、待办绿 0.9→0.98、电量文字 0.55→0.72。
4. 收起态窗口随之变高（66→72）变宽上限（240→260），横幅仍完整落在窗口内、不越界。
5. 观感变化克制，不是「换了个风格」。

## 四、必要依赖

无新增依赖。

## 五、验收条件

- [x] 收起态胶囊几何：`height` 46 布局 px / `border-radius` 23px / `padding` 0 17px / `gap` 11px（CDP `getComputedStyle`）。
- [x] 时钟 `font-size:16.5px`、`font-weight:700`、`color:rgb(255,255,255)`。
- [x] 电量环视觉宽度 18（原 16.5），环内数字 `9.5px/700`。
- [x] Wi-Fi 图标视觉 12.8、岛仔视觉 18（原 16.5）。
- [x] 主进程窗口 `innerHeight=72`、`innerWidth=136`（收内容自动撑）。
- [x] 横幅不越界：`e2e-banner-fit` PASS 8/0，`overLeft=-2.25`、`overRight=-2.25`、`overBottom=-3.27`、`w=151.5 > winW*0.6`。
- [x] `npm run typecheck`、`npm run build` 通过。
- [x] 收起态相关 e2e 无回归：`e2e-code-hint` 10/0、`e2e-collapse-order` 22/0、`e2e-collapse-beautify` 7/0、`e2e-beautify-04` 27/0、`e2e-head-order` 14/0。
- [ ] 用户肉眼看截图确认「提的这一点」够不够/过不过（本轮已给截图，等反馈）。

## 六、不做什么

1. 不动展开态头部的字号与图标尺寸。
2. 不改电量三态的颜色与 20% 阈值。
3. 不加缩放系数、不引入 `--island-scale` 这类 CSS 变量（当前只有一处胶囊，直接写值更清楚）。
4. 不动 `zoom:0.75`（整岛迷你化是 2026-11-11 的另一项决定，与本轮无关）。
5. 不顺手改字体家族。

## 七、第二轮调整（用户 m01634 追加「里面的要和外面的统一一下，还可以再大一点，字体粗一点」）

第一版只调了收起态，用户看后要求：**展开态里面（头部状态行）与收起态外面统一**，而且**再大一档**。于是：

1. 删掉 `.head-info` 那套「略小一圈」的覆盖值（时钟 12.5px、电量环 20px、数字 8px、Wi-Fi/铃铛 14px），改成与收起态同值再放大：时钟 17.5px/800、电量环 27px、环内数字 10.5px/700、Wi-Fi 与铃铛 18px。
2. 展开态岛仔 `.head-status .collapsed-pet` 16px→28px；`.panel-head` 加 `min-height:58px`，因为 `.head-status` 是绝对定位不占文档流，不撑高会压到下方内容。
3. 收起态再放大一档：胶囊高 46→52、圆角 23→26、内边距 17→19、间距 11→12；时钟 16.5→17.5 且字重 700→800；电量环 24→27、数字 9.5→10.5；Wi-Fi 17→18；岛仔 24→28；待办数字 13.5→14.5/800；电量文字 13→14。
4. 铃铛补尺寸：`.collapsed-bell svg` 原来没写宽高，靠 svg 属性默认定，实测视觉只有 11.3px，比同一行 Wi-Fi（13.5）小一圈，与展开态（18px）也不统一，补上 18px。
5. 主进程同步：`COLLAPSED_WIN_HEIGHT` 72→76、宽度上下限 122~260 → 134~290、`collapsedWidth` 154→168，横幅 `top` 48→56px。
6. **展开态宽度下限 300→340 布局 px**（主进程 `EXPANDED_MIN.width` 225→255）：头部状态区放大后横向吃掉约 132 布局 px，居中后左缘压到标题右缘，`e2e-head-order` 的 H5a 报 `overlapTitle=true`，这是真问题不是断言问题，所以放宽下限给两侧各留约 17 布局 px。

第二轮自检：

1. `npm run typecheck` EXIT=0、`npm run build` EXIT=0（`✓ built in 126ms`）。
2. 收起态实测：`island{w:170.5,h:39,layoutH:52px,radius:26px,pad:0px 19px,gap:12px}`、`innerH:76/innerW:172`、`clock{fs:17.5px,fw:800}`、`ring{w:20.3,numFs:10.5px}`、`pet{w:21}`、`wifi{w:13.5}`、`bell{w:13.5}`。
3. 展开态实测：`island{w:255,h:170.3}`、`head{minH:58px,h:43.5}`、`status{w:99.1,h:42.8}`、`pet{w:21}`、`clock{fs:17.5px,fw:800}`、`ring{w:20.3,numFs:10.5px}`、`wifi{w:13.5}`、`bell{w:13.5}` —— **两态字体、字重、图标、电量环完全一致**。
4. `e2e-head-order` PASS 14/0（H5a 转绿）、`e2e-banner-fit` PASS 8/0、`e2e-code-hint` 10/0、`e2e-collapse-order` PASS 22/0、`e2e-collapse-beautify` 7/0、`e2e-beautify-04` 27/0、`e2e-settings-shell` PASS 51/0、`e2e-pages-custom` 6 项、`e2e-bell-notify` 15/0、`e2e-todo-today` PASS、`e2e-notify-compact` 2/0、`e2e-schedule-day` PASS、`e2e-music` PASS 38/0。

## 八、实现记录

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `.island.collapsed` 高 / 圆角 / 内边距 / 间距 | 42px / 21px / 0 16px / 10px | 46px / 23px / 0 17px / 11px |
| `.collapsed-clock` | 15px / 600 | 16.5px / 700 / `#fff` |
| `.collapsed-todo-num` | 12.5px / 600 | 13.5px / 700 |
| `.collapsed-todo` 绿 | `rgba(125,216,125,0.9)` | `rgba(125,216,125,0.98)` |
| `.collapsed-battery` | 12px / 0.55 | 13px / 0.72 |
| `.collapsed-bell` | 0.92 | 0.98 |
| `.collapsed-wifi` / svg | 0.82 / 15px | 0.94 / 17px |
| `.collapsed-pet` | 22px | 24px |
| `.head-battery-ring` / svg | 22px | 24px |
| `.head-battery-ring .ring-bg` | 0.16 | 0.2 |
| `.head-battery-ring .ring-fg` | 0.85 | 0.98 |
| `.ring-num` | 8.5px / 600 / 0.92 | 9.5px / 700 / 0.98 |
| `.collapsed-banner` top | 44px | 48px |
| `COLLAPSED_WIN_HEIGHT` | 66 | 72 |
| `COLLAPSED_MIN_W` / `MAX_W` | 113 / 240 | 122 / 260 |
| `collapsedWidth` 初值 | 143 | 154 |

自检：

1. `npm run typecheck` EXIT=0。
2. `npm run build` EXIT=0（`✓ built in 152ms`）。
3. CDP 探针 `.tmp/probe-capsule-size.mjs` → `{"collapsed":true,"island":{"w":134.7,"h":34.5,"layoutH":"46px","radius":"23px","pad":"0px 17px","gap":"11px"},"innerH":72,"innerW":136,"clock":{"fs":"16.5px","fw":"700","color":"rgb(255, 255, 255)","w":34},"ring":{"w":18,"numFs":"9.5px","numFw":"700"},"wifi":{"w":12.8},"pet":{"w":18}}`。
4. 截图 `.tmp/shot-capsule-after.png`（170×90，整窗）确认观感。
5. `node scripts/e2e-banner-fit.mjs` → PASS 8/0，`B2 收起窗口尺寸合理 {"w":156,"h":72}`。
6. `node scripts/e2e-code-hint.mjs` → 10 过 / 0 败（C7 断言 `innerHeight <= 90`，72 仍满足）。
7. `node scripts/e2e-collapse-order.mjs` → PASS 22/0。
8. `node scripts/e2e-collapse-beautify.mjs` → 7 过 / 0 败。
9. `node scripts/e2e-beautify-04.mjs` → PASS 27/0。
10. `node scripts/e2e-head-order.mjs` → PASS 14/0。

[未核验]

1. 用户对「提一点」的幅度是否满意——本轮只是第一版，等用户看截图/预览后反馈。
2. 装机版观感（未打包装机，需单独授权）。
3. 高分屏缩放（125%/150% DPI）下的实际观感——本轮只在当前 1.25 DPI 环境截图。
