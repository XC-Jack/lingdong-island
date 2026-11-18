# SPEC：应用内自动更新（先问再下）

> 基线：`main` `62bc672`（0.1.10 已推送）。任务分支：`auto-update`。
> 用户 2026-11-18 决定：更新方式为「先问再下」——检查到新版本先提示，用户确认后才下载 120 MB 安装包。

## 一、目标

让已安装的灵动岛自己发现 GitHub 上的新版本，用户确认后下载并安装。解决「每次发新版都要把安装包拷到另一台电脑手动装」的麻烦。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `package.json` | 新增依赖 `electron-updater`；`build.publish` 指向 GitHub；`build.artifactName` 改为 ASCII（`Lingdong-Island-Setup-${version}.${ext}`），修掉 `latest.yml` 与实际文件名不一致 |
| `src/main/updater.ts`（新增） | 检查 / 下载 / 安装状态机，IPC 注册，状态广播，启动后定时检查 |
| `src/main/index.ts` | `whenReady` 里调用 `setupUpdater()` |
| `src/preload/index.ts`、`src/shared/types.ts` | 暴露 `updateCheck / updateDownload / updateInstall / updateGetState / onUpdateState / updateOpenPage` |
| `src/renderer/src/settings/SettingsApp.tsx`、`settings.css` | 常规页「版本」行改为更新区块 |
| `docs/facts/功能清单.md`、`docs/facts/技术方案.md`、`docs/facts/版本历史.md`、`docs/状态.md` | 同步事实与流程 |

## 三、预期行为

1. **自动检查**：打包版启动 60 秒后静默检查一次，此后每 4 小时一次。开发版（`app.isPackaged === false`）不发起任何网络请求。
2. **发现新版本**：设置页显示「0.1.12 可用」+「下载」按钮；同时发一条 Windows 系统通知，点击打开设置窗口的「常规」页。
3. **下载**：用户点「下载」才开始下载，期间显示百分比；下载完成后按钮变「重启并安装」。
4. **安装**：`quitAndInstall()` 静默覆盖安装到原目录（HKCU 安装，不弹 UAC），用户数据在 `%APPDATA%\lingdong-island\` 不受影响。
5. **失败降级**：检查失败不弹窗、不打扰；设置页显示原因 +「重试」+「打开发布页」。
6. **无更新**：显示「已是最新」与最近一次检查时间。

## 四、必要依赖

- `electron-updater`（与 electron-builder 26.18 配套的 6.x）。
- GitHub Release 必须同时上传 **exe + `.blockmap` + `latest.yml`** 三件套，且不能标为 Pre-release（`allowPrerelease = false`）。
- 现有无签名状态不变：更新器不校验签名，但要用真机跑通一次才敢说可用。

## 五、验收条件

- A1 打包版启动后 `startup.log` 或应用日志出现一次检查记录；开发版不出现。
- A2 设置页常规页显示当前版本、检查按钮与最近检查状态。
- A3 存在更高版本时显示版本号与「下载」按钮，并弹出系统通知。
- A4 点「下载」后进度百分比递增，完成后出现「重启并安装」。
- A5 点「重启并安装」后进程退出、新版本起来、`app.getVersion()` 变化，待办/日程/置物架数据保留。
- A6 网络失败时界面显示失败原因，应用其余功能不受影响。
- A7 未打包（`npm start`）时设置页显示「开发版不检查更新」，不报错。

## 六、不做什么

- 不做差分/增量更新（GitHub 只保留最新 Release，实际每次都是全量 120 MB）。
- 不做后台自动下载（用户已选「先问再下」）。
- 不做代码签名、不做 ARM64、不做多通道（beta/stable）。
- 不自动发布 Release：发版仍需用户单独点头。
- 不改 NSIS 安装模式（仍是 `oneClick:false`、`allowToChangeInstallationDirectory:true`、HKCU）。
- 不动岛内布局（更新提示不进岛，避免挤占头部空间）。

## 七、自检记录

（实现后填写：命令、结果、未验证范围）

## 八、验收记录

（独立验收后填写）
