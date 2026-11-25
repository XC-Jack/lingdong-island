# SPEC：纯黑玻璃改成真透明玻璃质感

- 建立日期：2026-11-25
- 基线：`main` `97b9963`
- 任务分支：`glass-dark-liquid`
- 背景：用户原话「我们现在来修改一下这个纯黑玻璃，之前一直没去改它，太丑了，完全看不出来是玻璃质感，请你参考苹果手机官网的玻璃，这次做一个透明玻璃质感的主题，也可以参考一下截图二」。截图二是深色界面里的半透明玻璃卡片：能看见背后的模糊内容、边缘一圈细亮高光、顶部有受光渐变。

## 一、目标

1. 「纯黑玻璃」从 0.97 的实心近黑，改成能透出背后桌面、有明显玻璃材质的透明玻璃。
2. 复用已有的「真透视」链路（主进程抓屏 → 渲染层模糊底图 → veil 压暗），深色玻璃主题也开启，不再只有亮色玻璃抓屏。
3. 增加玻璃细节：顶部受光渐变、冷暖极淡折射、边缘细亮描边 + 内高光 + 底部暗边。
4. 抓不到底图（远程桌面、抓屏失败）时自动退回更实的深色底，保证白字可读。
5. 设置页的主题预览卡片、名称与描述同步。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/styles.css` | `[data-theme='glass-dark']` 的 token 重做；重定义该主题的 `--island-veil`（加顶部受光层、折射色斑）；`.island:not(.has-backdrop)` 兜底；浮层/控件表面透明度适配 |
| `src/renderer/src/App.tsx` | 抓屏条件由「仅 glass-light」改为「玻璃主题（glass-light / glass-dark）」；`.island` 按是否有底图加 `has-backdrop` 类 |
| `src/renderer/src/settings/ThemeSection.tsx` | 名称/描述文案 |
| `src/renderer/src/settings/settings.css` | 主题预览卡的桌面底色与胶囊材质 |
| `docs/facts/视觉设计规范.md` | 同步主题规则 |

## 三、预期行为

1. 选中「纯黑玻璃」后，岛背后是模糊后的桌面，颜色随桌面色调变化；玻璃本体呈半透明深色，能看出层次。
2. 岛边缘有一圈细亮边，顶部有一道更亮的受光带，底部略暗，形成厚度感。
3. 白字在亮桌面上仍能读清（靠底图模糊 + 双层 veil + 兜底）。
4. 抓不到底图时不崩、不变透明，退回偏实的深色玻璃。
5. 另两套主题（亮色玻璃、纯黑极简）外观不变。
6. 设置页三张预览卡的「纯黑玻璃」与新材质一致。

## 四、必要依赖

无新增依赖；复用既有 `island:backdrop` IPC。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2 探针：glass-dark 下 `.island-backdrop` 存在（抓屏成功时）、`.island` 有 `has-backdrop`；抓屏失败时 `has-backdrop` 不存在且背景不透明度升高。
- A3 截图对比：亮桌面 / 暗桌面下收起态与展开态，文字可读、玻璃可辨。
- A4 回归：主题切换、收起/展开、`e2e-beautify-04`、`e2e-collapse-beautify` 等相关脚本。
- A5 用户在本机预览版确认。

## 六、不做什么

- 不改另两套主题的外观。
- 不改主进程抓屏算法、频率与 IPC 协议。
- 不引入 SVG 噪点/贴图资源；材质只用 CSS（渐变、描边、阴影）。
- 不合并 `main`、不打包、不发版。

## 七、自检记录（2026-11-25）

1. `npm run typecheck` EXIT=0、`npm run build` EXIT=0 [实测]。
2. CDP 探针 `.tmp/shot-glass-dark.mjs`（隔离 userData）[实测]：
   - `document.documentElement.dataset.theme = glass-dark`；
   - `.island` className 含 `has-backdrop`，`.island-backdrop` 存在（抓屏成功）；
   - `.island` 的 `background-image` 为新的受光带 + 三道折射 + 本体渐变；
   - 手动移除 `has-backdrop` 后背景解析为 `rgba(12,13,17,.92) → rgba(6,6,9,.95)` 兜底版本（A2 通过）。
3. 截图（`.tmp/glass-dark-collapsed.png`、`glass-dark-expanded.png`、`glass-dark-nofallback.png`、`gd-todo-daypop.png`、`theme-settings.png`）：桌面模糊后从玻璃下透出，展开页卡片不再发白，白字可读；兜底态接近原实心；设置页预览胶囊能透出背后预览底色。
4. 回归 [实测]：`e2e-collapse-beautify` **7 过 0 败**、`e2e-settings-shell` **57 过 0 败**（含 S13d/S13e/S13f 主题切换）。
5. `e2e-beautify-04` **26 过 1 败**，失败项 C2b（日历「今天」蓝底判定）[实测] **在 `main` 上用 `git stash` 对照跑同样失败**（`--accent` 现值 `#0a6cf0` 与脚本里写死的 (100,181,246) 阈值距离 > 9000），属既有问题、与本次改动无关；未在本轮顺手修，另开任务处理。
6. 未验证：深色桌面背景下的观感（本机桌面为浅色）、高 DPI 缩放、抓屏在远程桌面/多显示器切换时的表现；用户对新增每 1.5s 抓屏带来的功耗是否接受（与亮色玻璃同频）。
7. 一个改动过程中的坑：临时探针用 `isolate-userdata` 写入了 `islandTheme=glass-dark`，导致复用同一隔离目录的 e2e 在暗色主题下跑、C2b 假失败；恢复 `glass-light` 后复跑。以后主题类探针结束前要把隔离 prefs 还原。
