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

## 八、读后反馈追加（2026-11-25）

用户原话「我发现灵动岛有阴影，我觉得不需要，说是要玻璃只是要那个质感罢了；如果换一个白色的应用整个灵动岛直接透得发白了，我觉得可以参考一下苹果官网的思路」。

1. **去掉外投影**：`--shadow-island` 删掉 `0 18px 44px rgba(0,0,0,.42)`，只保留玻璃自身的受光边、内描边与底部暗边。
2. **亮度自适应（参考 Apple 液态玻璃）**：
   - 渲染层每拿到一张新底图，把它画到 8×8 的 canvas 上算亮度，取 **75 分位**（不是平均值——半白半黑时平均值判不出问题）；
   - 0.30 以下为暗背景（`--island-lit` = 0），0.75 以上满档（= 1），中间线性；
   - `--island-lit` 写到 `.island` 的 inline style，CSS 用它放大 veil 的 alpha：本体顶部 `0.42 + lit×0.42`、底部 `0.50 + lit×0.38`，受光带与 `--island-hi` 同步减弱；
   - 用 `@property --island-lit` 注册成 `<number>` 并加 600ms 过渡，避免每 1.5s 抓屏时背景跳变。
3. 效果 [实测]：纯白底图 + lit=1 时胶囊/展开态呈深灰，白字可读；深色底图 + lit=0 时保持半透明深玻璃，仍透出桌面明暗。
4. 验证 [实测]：`typecheck` EXIT=0、`build` EXIT=0；`e2e-collapse-beautify` 7/0、`e2e-todo-today` PASS；探针确认真实底图算出的亮度（本机当前岛后场景 0.09）会落到 lit=0，纯白底图落到 lit=1。
5. 未验证：多数真实场景里 `--island-lit` 的跳档是否会被用户感知（600ms 过渡只是减小跳变）；亮色玻璃主题仍有外投影（本次只按用户所指改了暗色玻璃）。

## 九、合并回 main 时的冲突处理（2026-11-27）

本分支建于 2026-11-25 14:41，而用户在**同一天 18:06** 的 v0.6.1 里明确要求「把顶部的打光都不要了」，`main` 上四套主题的 `--island-hi` 已全部改成 `transparent`、`--shadow-island` 改成 `none`。分支把受光带、内高光又加了回来，两边语义冲突。按**更晚的用户决定**处理：

1. **保留**分支的真透视链路（`glass-dark` 也抓屏、`has-backdrop` 类）、亮度自适应（`--island-lit`）、`--island-cool` / `--island-warm` 两块环境色斑、26% 白描边、`--bg-pop`。
2. **去掉**分支加的顶部打光：`--island-hi: transparent`；`--island-veil` 里删掉顶部受光带 `linear-gradient(180deg, rgba(255,255,255,…) 0%, …30%)` 和 `radial-gradient(130% 110% at 8% -10%, var(--island-hi) …)` 两层；`--shadow-island` 回到 `none`；无底图兜底块里的「一道顶部受光」也一并删掉。
3. 设置页预览卡同步：`.theme-prev[data-t='glass-dark'] .theme-prev-island` 的 `box-shadow` 改为 `none`（保留 `backdrop-filter` 模糊与 26% 描边，那是「透 + 模糊」的表达，不是打光）。

## 十、合并时查出的真 bug：亮度自适应一直没生效

**现象 [实测]**：合并后跑探针，把 `.island` 的内联 `--island-lit` 依次设成 `0` / `0.5` / `1`，`--island-veil` 的本体渐变**恒为** `rgba(15,17,23,0.42) → rgba(7,8,12,0.5)`，完全没跟着变。

**根因 [实测]**：`--island-lit` 写在 `.island` 的内联样式上，而 `--island-top` / `--island-bottom` / `--island-veil` 声明在 `html` 的 `[data-theme='glass-dark']` 块里。自定义属性在**声明它的那个元素**上就完成 `var()` 替换——根节点上 `--island-lit` 永远是 `@property` 的初始值 0，`.island` 上的值传不进去。分支原实现如此，说明第八节记录的「纯白底图 + lit=1 时呈深灰」那一轮验证要么是看的内联 `--island-lit` 数值、要么是别的路径，没有真正核对到 CSS 计算值。

**修法 [实测]**：把这三个变量从 `[data-theme='glass-dark']` 挪到 `[data-theme='glass-dark'] .island`，让声明点与 `--island-lit` 的写入点落在同一个元素上；`.island-veil` 是 `.island` 的子元素，继承后两边仍然同源。`[data-theme='glass-dark']` 根块只留 `--island-hi` / `--island-cool` / `--island-warm` / `--border-island` 等不依赖 `--island-lit` 的 token。

**复验 [实测]**：`lit=0` → `rgba(15,17,23,0.42)`；`lit=0.5` → `0.63`；`lit=1` → `0.66`（带 600ms 过渡，读数取过渡后）；`.island-veil` 子层的 `background-image` 同步变化。自然抓屏下本机当前场景落在 `lit≈0.58`。

## 十一、合并自检与回归（2026-11-27）

1. `npm run typecheck` EXIT=0、`npm run build` EXIT=0 [实测]。
2. `e2e-settings-shell` **59 过 0 败**（新增 S13a2 校验四张卡显示名；S13a/S13d 的文案随「纯黑玻璃 → 暗色玻璃」改名同步）[实测]。
3. `e2e-collapse-beautify` **7 过 0 败** [实测]。
4. 四套主题探针（`.tmp/probe-merge-themes.mjs`，隔离 userData）[实测]：`glass-light` / `glass-dark` / `glass-clear` 都有 `.island-backdrop` 与 `has-backdrop`，`mono` 两者都没有；四套 `--island-hi` 均为 `transparent`；`glass-light` / `glass-dark` / `mono` 的 `box-shadow` 计算值均为 `none`（`glass-clear` 保留 1px 内描边 `inset 0 0 0 1px rgba(255,255,255,.03)`，属既有的透明玻璃设计，不是打光）；暗色玻璃去掉 `has-backdrop` 后本体退回 `rgba(12,13,17,.92) → rgba(6,6,9,.95)`。
5. 截图核对：`.tmp/merge-*.png`、`.tmp/lit-0-expanded.png` / `.tmp/lit-1-expanded.png`（两档亮度字节数 84920 / 79418，确实有视觉差异）。
6. **未验证**：用户对合并后暗色玻璃的观感；深色/高 DPI/多显示器场景；`e2e-beautify-04` 的 C2b 既有失败仍未修（见第七节第 5 条）。
