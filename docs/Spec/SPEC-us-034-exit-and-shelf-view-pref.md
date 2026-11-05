# SPEC-us-034-exit-and-shelf-view-pref

- 建立日期：2026-11-05
- 对应基线提交：`b7d2df5c9dce1958b492b72150d56656195d3e52`
- 任务分支：us-034-exit-and-shelf-view-pref
- 关联用户故事：US-034、US-035（见 ../facts/用户角色与用户故事.md 第 3.7 与 3.4 节）
- 关联事实文档：../facts/功能清单.md、../facts/数据规则.md、../facts/用户角色与用户故事.md

## 一、目标

补两个「用了就会碰上」的缺口：

1. **给用户一条真正的退出路**。当前窗口 `skipTaskbar: true`、无托盘、无关闭按钮，想关掉只能去任务管理器杀进程。本次加**岛内右键菜单**与**托盘图标菜单**，两处都能一键退出。
2. **记住置物架视图**。现在每次重启都回到「大图标」，用户选的「中/小/列表」不保留。本次把选择存下来，下次打开还是上次那个视图。

两件都属于「少一点别扭」，不改任何业务数据，不引入新依赖。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 引入 `Menu` / `Tray` / `nativeImage`；新增 `quitApp()`（先停两个轮询再 `app.quit()`）、`buildAppMenu()`、`createTray()`；注册 `app:quit` 与 `app:show-menu` 两个通道；`whenReady` 里建托盘 |
| `src/preload/index.ts` | 新增 `quitApp()`（send `app:quit`）与 `showAppMenu()`（send `app:show-menu`） |
| `src/renderer/src/App.tsx` | 岛根节点加 `onContextMenu` → `window.island.showAppMenu()`；`ShelfPanel` 的视图初值改为读偏好、切换时写偏好 |
| `src/renderer/src/styles.css` | 不需要改（复用现有样式） |
| `package.json` | `build.files` 增加 `build/icon.png`，让打包后的 asar 里有托盘图标 |
| `scripts/e2e-exit-and-shelf-view.mjs` | 新增：验证视图偏好能落盘并被重新读取、退出接口能真正结束进程 |
| `scripts/e2e-shelf-missing.mjs` | 开头显式切回「大图标」视图，避免受已保存偏好影响 |
| `docs/facts/功能清单.md` | 补退出入口与视图记忆两条 |
| `docs/facts/数据规则.md` | 补「界面偏好存在渲染层 localStorage」与「退出时停轮询」两条 |
| `docs/facts/用户角色与用户故事.md` | 登记 US-034 / US-035 并标记已实现 |
| `docs/状态.md` | 一句话状态与 P1/P2 表 |

明确**不动**：业务数据结构（`shelf.json` / `todos.json` / `schedule.json` 一个字段不加）；不做设置界面（用户 2026-11-05 已决定先不做）；不做「最小化到托盘后隐藏窗口」；不改岛的整体尺寸、动画、页面顺序。

## 三、预期行为

1. 在岛的任何位置（收起态或展开态）**点右键**，弹出系统原生菜单，菜单里有一项「退出灵动岛」。
2. 点「退出灵动岛」→ 进程真正结束（任务管理器里看不到），不是只隐藏窗口。
3. 屏幕右下角通知区域（可能收在 `^` 里）出现「灵动岛」托盘图标，鼠标悬停显示提示「灵动岛」，**右键**同样有「退出灵动岛」。
4. 托盘图标**左键单击** → 岛显示出来（多屏切换后万一找不到岛，这是找回路径）。
5. 置物架页选「中图标 / 小图标 / 列表」后，**重启应用**仍保持上次选的视图。
6. 首次安装（没有任何偏好记录）默认仍是「大图标」，与现在一致。
7. 偏好值损坏或不认识（比如手工改成 `xxx`）时回落到「大图标」，不报错、不白屏。
8. 退出时先停通知轮询与日程提醒两个定时器，再退出，避免退出瞬间弹出一条迟到提醒。

## 四、必要依赖

- Electron 自带的 `Menu` / `Tray` / `nativeImage`，均已随 `electron ^45.2.1` 提供，**不新增任何 npm 依赖**。
- 托盘图标复用现有 `build/icon.png`（512×512），运行时缩放到 32×32。
- 视图偏好用渲染层 `localStorage`（实际落在 `%APPDATA%\lingdong-island\Local Storage` 里），无需新 IPC、无需新建数据文件。

## 五、验收条件

- [ ] `npm run typecheck` 通过。
- [ ] `npm run build` 通过。
- [ ] 新增 e2e 通过：检查 `localStorage` 键 `island.shelfView` 被写入；重载渲染层后视图仍是所选；调用 `window.island.quitApp()` 后 electron 子进程真的退出。
- [ ] 回归 e2e 通过：`e2e-shelf-missing`、`e2e-schedules`（`e2e-schedule` / `e2e-schedule-day`）、`e2e-todo-today`、`e2e-collapsed-todo`、`e2e-m1`、`e2e-m2`、`e2e-m3`、`e2e-m4`、`e2e-m4-drop`、`e2e-notify`。
- [ ] 开发版真实启动：右键岛出现原生菜单（截图核对），菜单项文字为中文「退出灵动岛」。
- [ ] 开发版真实启动：托盘图标存在（截图核对通知区域）。
- [ ] `npm run dist` 成功；`/S` + `/D=D:\软件\灵动岛` 静默安装成功；`Get-Process 灵动岛` 有进程、主窗口标题为「灵动岛」。
- [ ] 安装版 asar 内能检索到新增中文字符串（「退出灵动岛」「灵动岛」托盘提示相关），确认装的是新代码。
- [ ] 安装版里托盘图标能取到（asar 内含 `build/icon.png`），无「缺图」报错。
- [ ] 用户数据零改动：`shelf.json` / `todos.json` / `schedule.json` 结构与改动前一致。

## 六、不做什么

- 不做设置界面（用户已决定先不做）。
- 不做「关闭窗口时最小化到托盘」这类开关。
- 不做托盘菜单里的「开机自启」开关（头部按钮已有，重复）。
- 不做全局快捷键退出。
- 不改置物架的其他行为（拖入、换位、失效提示）。
- 不合并回 `main`、不打 Git 标签（合并需用户单独授权）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 读 `src/main/index.ts`（249 行全文）、`src/preload/index.ts`（167 行全文）、`src/renderer/src/App.tsx` 相关段，确认「无托盘 / 无退出通道 / 视图状态不落盘」三处根因 | 已确认：`skipTaskbar: true`（`src/main/index.ts:99`）、import 无 `Tray`/`Menu`、`ipcMain` 无退出通道；`src/renderer/src/App.tsx:539` 的 `useState('lg')` 无持久化 | — |
| 2026-11-05 | `npm run typecheck` | 通过（`typecheck:node` 与 `typecheck:web` 均无输出，exit 0） | — |
| 2026-11-05 | `npm run build` | 通过，exit 0，生成 `out/main/index.js`、`out/preload/index.js`、`out/renderer` | — |
| 2026-11-05 | `node scripts/e2e-exit-and-shelf-view.mjs`（新脚本） | `E2E EXIT-AND-VIEW PASS`。A1 首次进入 `view=lg`、`stored=null`；A2 选「列表」后 `view=list`、`stored="list"`；A3 `Page.reload` 后仍 `list`；A4 改选「小图标」重载后 `sm`；A5 值改坏成 `'xxx'` 后重载回落 `lg` 且 `.island` 存活（不白屏）；A6 调 `window.island.quitApp()` 后子进程 8 秒内 `exit` 事件触发 | 只验证了接口层退出，没在真实鼠标点击菜单项下验证退出 |
| 2026-11-05 | 首次跑上述 e2e 失败：A2 报 `选择应写进 localStorage，实际 null` | 根因是**改完代码没 `npm run build`，e2e 跑的是旧 `out/renderer` 产物**。重新 build 后立即全过。教训：任何 e2e 前必须先 build | — |
| 2026-11-05 | 改 `scripts/e2e-shelf-missing.mjs`（新增开头显式切回「大图标」视图 + 结束时还原偏好），重跑 | `E2E SHELF-MISSING PASS` | — |
| 2026-11-05 | 回归 e2e：`e2e-schedule`、`e2e-schedule-day`、`e2e-todo-today`、`e2e-collapsed-todo`、`e2e-m1`、`e2e-m2`、`e2e-m3`、`e2e-m4`、`e2e-m4-drop`、`e2e-notify` | 全部 exit 0 且打印 PASS（依次为 `E2E SCHEDULE PASS` / `E2E SCHEDULE-DAY PASS` / `E2E TODO-TODAY PASS` / `E2E COLLAPSED-TODO PASS` / `E2E PASS` / `E2E M2 PASS` / `E2E PASS` / `E2E PASS` / `E2E DROP PASS` / `E2E NOTIFY PASS`） | `e2e-reorder`、`e2e-reorder-run` 未跑（需外部先起 9225 实例，本次未涉及排序改动） |
| 2026-11-05 | 右键菜单截图核对（开发版，CDP `Page.captureScreenshot`） | 直接调 `window.island.showAppMenu()` 后截图明确看到岛下方弹出系统原生菜单，唯一菜单项文字为「退出灵动岛」 | **合成右键事件（`dispatchEvent` / CDP `Input.dispatchMouseEvent`）页面能收到 `contextmenu`，但原生菜单不弹**——菜单由主进程在真实鼠标光标位置弹出。真实鼠标右键未验证 |
| 2026-11-05 | 托盘图标核对 | `HKCU:\Control Panel\NotifyIconSettings` 出现对应项：开发版 `Exe=...\node_modules\electron\dist\electron.exe`，安装版 `Exe=D:\软件\灵动岛\灵动岛.exe`；启动 stderr 无 `[tray]` 警告，说明 `build/icon.png` 被读到、`createTray()` 未走失败分支 | **截图看不到托盘图标**（任务栏右侧与 `^` 溢出区截图均无；UI Automation 枚举 `Shell_TrayWnd` 只有「运行中的应用程序」）。推断图标被折进了未展开的溢出弹层，用户实际能否点到未验证 |
| 2026-11-05 | `npm run dist`（带两个国内镜像环境变量） | exit 0 → `release\灵动岛 Setup 0.1.0.exe` 121988749 B、2026-11-05 17:57:42；`@electron/asar` 列出 `release/win-unpacked/resources/app.asar` 含 `\build\icon.png`，总条目 102 | — |
| 2026-11-05 | 卸载旧版 → `/S` + `/D=D:\软件\灵动岛` 静默安装 → 清理 `ELECTRON_RUN_AS_NODE` → 启动 | 安装 exit 0；`Get-Process 灵动岛` 4 个进程，主窗口标题「灵动岛」；注册表 `DisplayName = 灵动岛 0.1.0`、`UninstallString = "D:\软件\灵动岛\Uninstall 灵动岛.exe" /currentuser` | 卸载后 `resources\app.asar` 仍被锁删不掉（既有的未解问题，见 `docs/状态.md` 未验证清单） |
| 2026-11-05 | 安装版 asar 内字符串检索（`D:\软件\灵动岛\resources\app.asar`，9056705 B、17:57:40） | `退出灵动岛` / `island.shelfView` / `app:show-menu` / `托盘图标读取失败` 四个字符串全部命中 → 装的是新代码 | — |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 待填 | — | — | — | — |
