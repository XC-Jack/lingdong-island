# SPEC：设置窗口支持最小化、最大化 / 还原与拉伸

- 创建：2026-11-20
- 分支：`space-merge-junk`
- 前置：`SPEC-settings-shell`（独立设置窗口，`frame:false` 自绘标题栏）

## 1. 目标

设置窗口原来固定 880×580、不可缩放。现在允许：

1. 标题栏加「最小化」和「最大化 / 还原」两个按钮（关闭按钮已有）；
2. 窗口可以拖动边缘拉伸，也可以最大化 / 还原；
3. 设一个下限尺寸，避免内容挤坏。

## 2. 修改范围

- `src/main/settingsWindow.ts`：`resizable: true`、`maximizable: true`、`minWidth/minHeight`；新增 `settings:minimize`、`settings:toggle-maximize`、`settings:is-maximized` 三个 IPC；窗口 `maximize` / `unmaximize` 时推 `settings:maximized` 给渲染层。
- `src/preload/index.ts`：`minimizeSettings()`、`toggleMaximizeSettings()`、`settingsMaximized()`、`onSettingsMaximized(cb)`。
- `src/renderer/src/settings/SettingsApp.tsx`：标题栏左侧标题，右侧三个按钮（最小化 / 最大化·还原 / 关闭）；最大化图标随主进程事件切换。
- `src/renderer/src/settings/settings.css`：`.set-winbtns`、`.set-winbtn`（复用 `.set-close` 的尺寸与配色）。

## 3. 预期行为

1. 标题栏按钮顺序：最小化、最大化（最大化后变「还原」）、关闭。
2. 点最大化：窗口铺满当前屏幕工作区；再点还原回 880×580。
3. 最小化后从岛或任务栏再打开设置，窗口恢复（沿用原有的 `isMinimized()` → `restore()`）。
4. 拖动窗口边缘可拉伸；最小尺寸 760×520。页面缩放仍然锁在 1（沿用原有处理）。
5. 标题栏仍是拖动区，按钮区域 `no-drag`。

## 4. 必要依赖

无。

## 5. 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 隔离实例中三个按钮都存在；点最大化后窗口尺寸变大、按钮变成「还原」；再点回到原尺寸、按钮变回「最大化」。
3. 点最小化后页面处于隐藏状态；从岛打开设置能恢复窗口。
4. 拉伸到小于 760×520 时被下限挡住。

## 6. 不做什么

1. 不加全屏（`fullscreenable: false` 保持不变）。
2. 不改页面内部按 880 宽做的排版，只是允许窗口变大后留白。
3. 不记忆窗口尺寸与位置（每次打开仍是 880×580）。

## 7. 自检记录（2026-11-20）

- `npm run typecheck`、`npm run build` EXIT=0。[实测]
- 隔离实例（CDP 9350）：标题栏三个按钮的 `aria-label` 为「最小化 / 最大化窗口 / 关闭设置」；点最大化后 `settingsMaximized()` 为 true、视口从 882×582 变 1536×912、按钮变「还原窗口」；再点回 false、视口 882×582、按钮变「最大化窗口」；点最小化后 `document.visibilityState` 为 hidden。[实测]
- 最小化后从岛调 `openSettings` 恢复窗口：CDP 里页面仍报 hidden（岛是置顶窗口，Chromium 的遮挡判定会把它算作不可见），没能用这个指标确认；恢复走的是原有 `isMinimized() → restore()` 分支，本次未改动。[未验证]

**未验证**：边缘拖拽拉伸的实际手感与最小尺寸拦截（CDP 无法模拟拖拽）；打包版。
