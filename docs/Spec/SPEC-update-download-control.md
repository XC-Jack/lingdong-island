# SPEC-update-download-control：更新下载的入口、暂停与取消

- 建立日期：2026-11-19
- 对应基线提交：`6078168`（main）
- 任务分支：`update-download-control`
- 用户背景：软件内下载 0.1.16 很慢（截图停在 9%），用户要求：①通知页黄色「（有新版本）」可点击直达设置下载页；②更新行旁加版本安装包直链；③下载中可暂停、可取消，取消后不留残留。

## 一、目标

1. 通知页标题旁的黄色「（有新版本）」变成按钮，点击收起岛并打开设置「常规」（更新行所在页）。
2. 设置「更新」行提供「直接下载」入口：知道目标版本时打开该版本的 GitHub 安装包直链，让用户可以用浏览器/下载工具替代应用内下载。
3. 下载中可「暂停」、可「取消」；暂停后能继续，取消后回到「可下载」状态，并且本机不留半截安装包或临时文件。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `UpdateStage` 新增 `paused` |
| `src/main/updater.ts` | 下载改用 `CancellationToken`；新增暂停 / 取消逻辑；取消或暂停后清理 `%LOCALAPPDATA%\lingdong-island-updater\pending`；新增 `update:pause` / `update:cancel` / `update:open-download` |
| `src/preload/index.ts` | 新增 `updatePause` / `updateCancel` / `updateOpenDownload` |
| `src/renderer/src/settings/SettingsApp.tsx` | 下载中显示「暂停」「取消」；暂停态显示「继续下载」「取消」；有版本号时显示「直接下载」 |
| `src/renderer/src/App.tsx` | 通知页黄色提示改为按钮，点击收起岛并打开设置「常规」；`paused` 也算「有新版本」 |
| `src/renderer/src/styles.css` | `.shelf-update-hint` 改为按钮样式（可点击、悬停反馈） |
| `docs/facts/功能清单.md` | 同步更新下载控制行为 |
| `docs/Spec/SPEC-update-download-control.md` | 本 SPEC |

**不动**：检查时机、通知去重、安装流程（`quitAndInstall`）、GitHub Release 结构、安装包命名规则。

## 三、预期行为

1. **黄色提示**：通知页标题 `N 条通知（有新版本）` 中「（有新版本）」是按钮；点击后岛收起、打开设置「常规」，更新行就在该页。`available` / `downloading` / `paused` / `ready` 四种状态都显示该提示。
2. **直接下载**：`available` / `paused` / `downloading` / `ready` 且 `version` 有值时，更新行多一个「直接下载」按钮；点击用系统浏览器打开
   `https://github.com/XC-Jack/lingdong-island/releases/download/v<version>/Lingdong-Island-Setup-<version>.exe`。
   `error` 且没有版本号时仍保留原来的「发布页」按钮。
3. **暂停**：下载中点「暂停」，主进程取消本次下载（electron-updater 的 `CancellationToken`），删除 `pending` 目录里的临时文件，状态变 `paused` 并保留已下载百分比说明；点「继续下载」重新开始下载（electron-updater 不支持断点续传，从 0% 开始，文案要写清楚）。
4. **取消**：下载中或暂停中点「取消」，状态回到 `available`（版本号保留，可再点下载），`pending` 目录被清空；页面不显示任何半截进度。
5. **无残留**：暂停或取消后，`%LOCALAPPDATA%\lingdong-island-updater\pending` 目录为空（或不存在）；已完整下载的安装包缓存（`installer.exe`）不动。
6. **回归约束**：下载完成后的 `ready` →「重启并安装」流程不变；检查更新、提示去重、4 小时周期不变。

## 四、必要依赖

不新增 npm 依赖。`CancellationToken` 使用 `electron-updater` 已导出的类（其类型来自 `builder-util-runtime`），打包时随 electron-updater 一并带上。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 打包一个低于 0.1.16 的测试构建（仅本地，不发布、不装机、不占 `release/` 产物），在隔离 userData 下启动：
  - 检查到 0.1.16 后可下载；下载中出现进度；`update:pause` 后状态 `paused`，日志有暂停记录，`pending` 目录为空。
  - 暂停后继续能重新进入 `downloading`（从 0% 开始）。
  - 下载中 `update:cancel` 后状态 `available`、`pending` 目录为空。
- [ ] 直链 `curl -I` 返回 200（0.1.16 的 GitHub Release 资产）。
- [ ] 通知页 `paused` 状态也显示黄色提示；点击黄色提示打开设置「常规」（可在隔离实例里用 CDP 点击验证）。
- [ ] 安装版回归：已下载完成（`ready`）时「重启并安装」按钮仍可用（本轮不重复执行安装，避免覆盖当前装机版；以代码路径与既有 v0.1.12 实测记录为依据）。
- [ ] `node scripts/e2e-music.mjs` 与改动前一致（不受影响，跑一次确认无连带破坏）。

## 六、不做什么

- 不实现真正的断点续传（electron-updater 取消时会清掉临时文件）；「继续」是从头下载。
- 不把直链下载做成应用内第二套下载器：直链只负责唤起浏览器。
- 不改发布流程、不改资产命名。
- 不自动安装、不后台静默下载。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | `npm run typecheck`、`npm run build` | EXIT=0 | — |
| 2026-11-19 | 打包本地测试构建 0.1.15（输出 `.tmp/test-release`，不发布、不装机），隔离 `--user-data-dir` + `LOCALAPPDATA` 启动 | 检查到 0.1.16（`stage=available`）；下载出现进度并生成 `pending\temp-*.exe`；`update:pause` 后 `stage=paused`，日志 `update: download paused at 1%` / `pending download cleared`，pending 目录为空 | — |
| 2026-11-19 | 暂停后继续下载 | 日志 `update: download 0.1.16 (full, no cached installer)`，重新发起全量下载；期间 GitHub 返回 `net::ERR_CONNECTION_RESET`，未观察到进度增长 | 稳定网络下「继续」的实际进度（本机到 GitHub 当前间歇重置） |
| 2026-11-19 | 下载中取消 | `stage=available`（保留 0.1.16），`percent` 清空；日志 `download cancelled by user` / `pending download cleared`；pending 目录为空；网络错误路径同样清空 pending | — |
| 2026-11-19 | 复测取消时序（改成等旧任务收尾后再回 available，避免立刻再点下载撞上未清空的 `downloadPromise`） | 下载中取消 → available；下载 → 暂停 → 取消 → available；两次 pending 均为空 | — |
| 2026-11-19 | 设置页 DOM（隔离实例 + CDP）：开始下载后立即暂停 | 更新行提示「已暂停在 0%，继续会从头下载」，按钮 `继续下载\|取消\|直接下载`；点「取消」后状态回到 available，按钮 `下载 0.1.16\|直接下载`，pending 为空 | — |
| 2026-11-19 | 通知页黄色提示 | `.shelf-update-hint` 文本「（有新版本）」，点击后设置窗口出现、岛 `expanded=false` | — |
| 2026-11-19 | 直链 `curl -I -L` | `302` → `200`，`Content-Length: 124197239`（与 v0.1.16 发布资产一致） | — |
| 2026-11-19 | `E2E_CDP_PORT=9326 env -u ELECTRON_RUN_AS_NODE node scripts/e2e-music.mjs` | **PASS 48 过 / 0 败** | — |
| 2026-11-19 | 观察：`ready` →「重启并安装」流程 | 本轮未执行安装（避免覆盖当前装机 0.1.15），代码路径未改动（`install()` / `quitAndInstall` 原样） | 端到端安装流程（此前 v0.1.12 全链路实测可参考） |
| 2026-11-19 | 首轮 e2e 直接运行失败 | `TypeError: fetch failed`；本 shell 里 `ELECTRON_RUN_AS_NODE=1`，dev Electron 被当 Node 跑。`env -u ELECTRON_RUN_AS_NODE` 后通过 | — |
| 2026-11-19 | 开发版（隔离 userData + CDP）打开设置「常规」 | `.set-update-fallback` 文本「GitHub 连不上或更新加载失败？去仓库下载最新版」，链接文字正确，计算色 `rgb(251, 191, 36)` | 点击后浏览器实际打开（没有在测试里点，避免弹外部窗口；复用已在用的 `update:open-page`） |
| 2026-11-19 | 打包 0.1.19（含常驻链接） | 安装包 124,198,999 B / SHA256 `8F3E5A9B…3A9408B0`；asar 13,420,692 B / SHA256 `3820639B…89429CC8`；Release Latest、`latest.yml` 返回 0.1.19。本机不装机，留给 0.1.17 验证 | 装机后链接点击（待用户真机操作） |
| 2026-11-19 | 打包 0.1.17 并静默装机 | 安装包 124,198,851 B；装机 asar 13,419,957 B / SHA256 `21BE325A…83214F`，与 `release\win-unpacked` 逐字节一致；`灵动岛.exe` FileVersion 0.1.17；启动日志 `update: armed, version 0.1.17` | 0.1.17 发现下一版本的真机链路（需等下次发版） |

## 七·补、2026-11-19 补充：更新行下方常驻仓库链接

- **目标**：用户要求「更新下面配一条链接，GitHub 连不上或加载失败时可以直接去仓库下载最新版」。
- **修改范围**：`SettingsApp.tsx`（更新行下方新增常驻链接，复用 `updateOpenPage`）、`settings.css`（`.set-update-fallback` / `.set-link`）；错误态的「发布页」按钮被常驻链接取代。
- **预期行为**：设置「常规 → 更新」行下方始终显示「GitHub 连不上或更新加载失败？去仓库下载最新版」，点击用系统浏览器打开 `https://github.com/XC-Jack/lingdong-island/releases/latest`。与更新状态无关，无需先触发检查失败。
- **不做什么**：不做应用内第二下载器；不镜像仓库到国内地址（如整站不可达，浏览器同样打不开，文案已限定为更新器失败场景）。
- **验收**：设置页 DOM 出现该链接；点击可打开浏览器（手动确认）；`typecheck` / `build` EXIT=0。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
| 2026-11-19 | 用户授权「合并 + 打包 0.1.17 + 发 Release」 | `1ec7a43`（合并 `1b276f5`，版本 `431393a`，标签 `v0.1.17`） | 已合并 `main`、装机验证通过、GitHub Release 三件套发布为 Latest |
