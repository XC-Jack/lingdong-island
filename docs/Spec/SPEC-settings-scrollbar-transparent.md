# SPEC：设置窗口滚动条改成透明

- 创建：2026-11-20
- 分支：`scrollbar-transparent`（从 `residue-cleanup-fix` 拉出，随 0.4.1 一起发）

## 1. 目标

用户截图指出设置窗口右侧那条滚动条：浅白底色、顶端还有系统三角按钮，在深色面板上很扎眼。要求「把这个滚条变透明」。

## 2. 现状

- `.set-content`（右内容区）只设了 `::-webkit-scrollbar` 宽度和滑块颜色，**没设轨道**，Chromium 用系统默认的浅色轨道，还带两个上下三角按钮。
- `.swr-list`（残留清单，`max-height: 460px`，自己就是滚动区）**完全没写滚动条样式**，同样走系统默认。

## 3. 修改范围

- `src/renderer/src/settings/settings.css`：把两个滚动区的滚动条统一成「轨道透明 + 隐藏系统按钮 + 半透明滑块」，写成一份共用规则（`.set-content` 与 `.swr-list` 并列选择器）。

## 4. 预期行为

- 滚动条位置不再有白色/浅色条带，深色面板直接透出来；上下两个三角按钮消失。
- 滑块保留极淡的白色（悬停时略亮），仍能看出「还有多少没滚」和拖拽位置。
- 滚动本身不变：`.set-content` 与 `.swr-list` 的滚动、勾选排序时的位置还原（`keepScroll`）都不受影响。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 预览版里打开设置（内容超出一屏时），截图确认：滚动条所在竖条与面板同底色，无三角按钮；滑块可见。
3. 残留清单内部滚动条同样生效。

## 6. 自检记录（2026-11-20）

- `npm run typecheck`、`npm run build` 均 EXIT=0。[实测]
- 预览版（CDP 9350）打开设置「空间」，内容区滚到中段（`scrollTop=508`，确实可滚）后读计算样式 [实测：`.tmp/probe-scrollbar.mjs`]：
  - `.set-content` 的 `::-webkit-scrollbar-track` 与 `::-webkit-scrollbar` 背景都是 `rgba(0, 0, 0, 0)`；
  - `::-webkit-scrollbar-button` 的 `display` 为 `none`（系统三角按钮不再占位）；
  - `::-webkit-scrollbar-thumb` 为 `rgba(255, 255, 255, 0.16)`，滑块仍在；
  - `.swr-list` 的轨道同样是 `rgba(0, 0, 0, 0)`。
- 截图核对：滚动条所在竖条与面板同为深色，无浅色带、无三角按钮；整窗截图其余排版未变。[实测：`.tmp/scrollbar.png`、`.tmp/settings-full.png`]

**未验证**：打包版（打包后无 CDP，样式与源码构建同源，预期一致）[推断]。

## 7. 不做什么

- 不改岛（主窗口）里各列表的滚动条，那些本来就是隐藏的。
- 不做「滚动时才显示、静止时淡出」的自定义滚动条逻辑（需要 JS 监听滚动，超出这次范围）；如果用户要滑块也完全不可见，改一行颜色即可。
- 不改滚动速度、滚动容器结构。
