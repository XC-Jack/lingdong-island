# SPEC：任务栏图标与 App 图标同步

## 目标

设置窗口出现在 Windows 任务栏时，图标是「灵动岛」自己的图标，而不是 Electron 默认的原子图标。

## 修改范围

- `src/main/settingsWindow.ts`：给设置窗口补 `icon`（设置窗口是唯一 `skipTaskbar: false` 的窗口）。
- `package.json` 的 `build.files`：把 `build/icon.ico` 打进安装包（现在只打了 `icon.png`，打包后窗口取 `.ico` 的路径不存在）。

不改：岛窗口（`skipTaskbar: true`，本就不进任务栏）、桌宠窗口、托盘图标、图标美术本身。

## 预期行为

- 开发版与安装版：设置窗口的任务栏按钮 / Alt+Tab 缩略图都是 App 图标。
- 安装包内 `resources/app.asar` 同时含 `build/icon.png` 与 `build/icon.ico`。
- 托盘图标保持现状（已经在用 `icon.png` 且正常）。

## 必要依赖

无新增依赖。`build/icon.ico`（7 个尺寸）与 `build/icon.png`（512×512）已有。

## 验收条件

1. `npm run typecheck`、`npm run build` 通过。
2. 开发版打开设置窗口后，用 `WM_GETICON` 取窗口图标并保存为 PNG，肉眼确认与 `build/icon.png` 一致（不是 Electron 原子）。
3. 打包后 asar 列表里能看到 `build/icon.ico`。
4. 安装版打开设置窗口，任务栏图标同样正确。

## 不做什么

- 不重新设计图标。
- 不改安装包文件名、版本号、AppUserModelID。
- 不处理「朋友下载旧 Release」的问题（版本号是否升到 0.1.1 由用户决定）。

## 验收结果（2026-11-17）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（node + web） |
| `npm run build` | EXIT=0 |
| `node scripts/e2e-settings-shell.mjs` | **PASS 51 过 / 0 败** |
| 开发版设置窗口 `WM_GETICON` | 40×40，保存为 PNG 后肉眼确认是 App 图标（深色圆角方块 + 紫色胶囊两点），不是 Electron 原子 |
| 安装包 asar | 含 `build/icon.ico` 与 `build/icon.png` |
| 安装版设置窗口 `WM_GETICON` | 40×40，同样是 App 图标 |

**真因（[已核验]）**：设置窗口是唯一 `skipTaskbar:false` 的窗口，之前没有给 `icon`；同时 `build.files` 只打了 `icon.png`，主进程引用的 `build/icon.ico` 在打包后不存在。两处一起补。

**未验证**：Windows 11 实际任务栏的像素级观感（只验证了窗口持有的 HICON 内容）；固定到任务栏后的图标（应取 exe 图标，安装版 exe 已确认是 App 图标）。
