# SPEC：右键 / 托盘菜单「暂时隐藏」没有任何反应

- **建立日期**：2026-11-25
- **基线提交**：`e66f787`（分支 `fix-avoid-self-foreground`，v0.5.1 发版后）
- **任务分支**：`fix-avoid-self-foreground`（与「点岛后全屏避让失效」同一轮用户反馈，同分支提交）
- **关联**：`../facts/功能清单.md` 第 14 条（US-041 全屏自动避让）、`SPEC-avoid-self-foreground.md`

## 一、目标

用户 2026-11-25 原话：「这三个选项全是失效的……还有这个暂时隐藏也没有任何反应」。
三档策略经真实设置页点击复验是生效的（见 `SPEC-avoid-self-foreground.md` 交付记录）；「暂时隐藏」是**真 bug**，本 SPEC 只修它。

**真因（两条，均本机实测）**：

1. **死链路**：菜单项只做两件无效果的事——给渲染层发 `island:avoid-do-hide`（渲染层从来没有监听这个频道），主进程同名频道也只把 `manualHide` 置 `true`，从不调用隐藏。
   同一条链路的另一半「显示灵动岛」是空实现占位：`click` 只置标志，不 `show`、也不让状态机回到 `normal`。
2. **托盘菜单是一份过期快照**：`createTray()` 里 `tray.setContextMenu(buildAppMenu())` 只在启动时构建一次。`manualHide` 变成 `true` 之后菜单不重建，托盘右键仍然是「暂时隐藏灵动岛」；用户点它只会再隐藏一次，**岛从此没有任何菜单入口能叫回来**（左键托盘图标可以，但用户不知道）。

复现与证据：

| 步骤 | 现象 | 证据 |
|---|---|---|
| 右键岛 → 「暂时隐藏灵动岛」 | 修复前：无任何反应；修复后：岛隐藏 | `startup.log` 出现 `[avoid] hide reason=manual-hide`；`EnumWindows` 统计岛窗口可见数 1 → 0 |
| 隐藏后托盘右键 | 修复前：菜单仍写「暂时隐藏灵动岛」 | UIA 枚举菜单项（修复前）：设置… / 页面管理… / 让桌宠出岛… / **暂时隐藏灵动岛** / 退出灵动岛 |
| 隐藏后从托盘菜单选择该项 | 修复前：又隐藏一次，岛不回来（日志出现第二条 `reason=manual-hide`） | `startup.log` 02:37:12 与 02:37:16 两条连续 hide |
| 同上 | 修复后：菜单写「显示灵动岛」，点击后岛恢复 | UIA 枚举菜单项（修复后）第 4 项为「显示灵动岛」；点击后岛可见数 0 → 1 |

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/fullscreenWatch.ts` | 新增模块级 `manualHideImpl` 与导出 `hideIslandManually()`；`init` 里把它接到 `state='manual'` + `apply(true,'manual-hide')`（复用既有手动隐藏状态机）；`ipcMain.on('island:manual-hide')` 改为调它；`stopFullscreenWatch()` 里置 `null` 防悬挂 |
| `src/main/index.ts` | 新增 `restoreIsland()`：清 `manualHide` → 通知渲染层 `island:manual-restore`（状态机已有监听，`apply(false,'manual-restore')`）→ `showInactive()`；新增 `refreshTrayMenu()`，在隐藏、恢复、`island:manual-hide`、状态机落地 `hidden=false` 时重建托盘菜单；托盘左键与菜单「显示灵动岛」共用 `restoreIsland()`；删除死链路 `ipcMain.on('island:avoid-do-hide')` |
| `docs/facts/功能清单.md` | 第 14 条补这一轮的规则 |
| `docs/状态.md` | 一句话状态 + 本轮段落 |

**明确不改**：
- 三档策略与避让判定（`SPEC-avoid-self-foreground` 已单独提交）；
- 手动隐藏时的状态机语义（`state='manual'` 期间不判定、摸边不唤回）：与修复前设计一致，只是现在真的会执行；
- 托盘菜单里「让桌宠出岛… / 让桌宠回到岛里」的文案过期问题（同一快照缺陷，但用户本轮没报，另记，不在本 SPEC 内修）。

## 三、预期行为

1. 岛右键或托盘右键 → 「暂时隐藏灵动岛」→ 岛隐藏；`startup.log` 记 `hide reason=manual-hide`。
2. 隐藏后托盘右键，第 4 项变成「显示灵动岛」。
3. 点「显示灵动岛」或左键托盘图标 → 岛回来，状态机回到 `normal`，之后自动避让与摸边唤回照常工作。
4. 自动避让（全屏/最大化导致的隐藏）**不**改变 `manualHide`，不会把菜单项换成「显示灵动岛」。
5. 隐藏期间进度、待办、音乐等业务不受影响（只是窗口不显示）。

## 四、必要依赖

无新增依赖、无新 IPC 频道、无新窗口。`refreshTrayMenu()` 只在状态翻转时调用（不是每 150ms 一次），成本可忽略。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| V1 | 岛右键菜单第 4 项点击后岛隐藏 | `.tmp/menu-hide-test.ps1`：`BEFORE_VIS=1` → `AFTER_VIS=0`，日志 `hide reason=manual-hide` |
| V2 | 进程不退出（隐藏 ≠ 退出） | 同一脚本 `PROC=4`（Electron 主/渲染/GPU/utility 常驻） |
| V3 | 隐藏后托盘菜单项变为「显示灵动岛」 | UIA 枚举顶层菜单 `MenuItem`，存在名称「显示灵动岛」 |
| V4 | 点该菜单项后岛恢复 | `.tmp/roundtrip3.ps1`：`START_VIS=0` → `SHOWN_VIS=1` |
| V5 | 托盘左键仍能恢复 | `.tmp/tray-restore.ps1`：`BEFORE_VIS=0` → `AFTER_VIS=1` |
| V6 | 自动避让不误改手动标志 | 代码静态核对：状态回调只在 `!hidden && manualHide` 时清标志、且只有清标志才重建菜单（**未单独实测**：本轮没造「自动避让隐藏→自动恢复」同时观察托盘文案的场景） |
| V7 | 类型检查与构建通过 | `npm run typecheck`、`npm run build` EXIT=0 |

## 六、不做什么

- 不改摸边唤回口径（用户若觉得「全屏时还能摸出岛」意外，需要单独决策，见 `SPEC-avoid-self-foreground` 的未决项）。
- 不修托盘菜单「桌宠出岛 / 收回」的文案过期（同一根因，另开）。
- 不处理「位置偏移 / 显示不全」。
- 不新增托盘气泡/通知式反馈（隐藏后没有任何提示是现状设计，本次不加）。
