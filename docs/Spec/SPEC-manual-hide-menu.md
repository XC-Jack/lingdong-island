# SPEC：右键 / 托盘菜单「暂时隐藏」没有任何反应

- **建立日期**：2026-11-25
- **基线提交**：`e66f787`（分支 `fix-avoid-self-foreground`，v0.5.1 发版后）
- **任务分支**：`fix-avoid-self-foreground`（与「点岛后全屏避让失效」同一轮用户反馈，同分支提交）
- **关联**：`../facts/功能清单.md` 第 14 条（US-041 全屏自动避让）、`SPEC-avoid-self-foreground.md`

## 一、目标

用户 2026-11-25 原话：「这三个选项全是失效的……还有这个暂时隐藏也没有任何反应」。
三档策略经真实设置页点击复验是生效的（见 `SPEC-avoid-self-foreground.md` 交付记录）；「暂时隐藏」是**真 bug**，本 SPEC 只修它。

**真因（三条，均本机实测）**：

1. **死链路**：菜单项只做两件无效果的事——给渲染层发 `island:avoid-do-hide`（渲染层从来没有监听这个频道），主进程同名频道也只把 `manualHide` 置 `true`，从不调用隐藏。
   同一条链路的另一半「显示灵动岛」是空实现占位：`click` 只置标志，不 `show`、也不让状态机回到 `normal`。
2. **托盘菜单是一份过期快照**：`createTray()` 里 `tray.setContextMenu(buildAppMenu())` 只在启动时构建一次。`manualHide` 变成 `true` 之后菜单不重建，托盘右键仍然是「暂时隐藏灵动岛」；用户点它只会再隐藏一次，**岛从此没有任何菜单入口能叫回来**（左键托盘图标可以，但用户不知道）。
3. **主进程另存的手动标志会与状态机分叉，恢复通知还发错了地方**（2026-11-25 第二次实测发现，用户截图显示最大化窗口上岛一直不躲）：
   - 主进程 `index.ts` 自己有一个 `manualHide` 布尔值，横幅把岛叫亮时（`banner-on` → `apply(false)` → 状态回调 `hidden=false`）它被清成 `false`，而状态机仍是 `state='manual'`；
   - 恢复路径 `restoreIsland()` 见 `manualHide===false` 就**不发** `island:manual-restore`，而且它用的是 `webContents.send`（发给渲染层）——该频道只有主进程 `ipcMain.on` 在听、渲染层没有监听者，**从来就是死频道**；
   - 结果：窗口被 `showInactive()` 亮起来，状态机永远停在 `manual`，避让判定整个停摆，岛压在最上层不躲。
   证据：`startup.log` 里 `hide reason=banner-off judge=Z … visible=true temp=false banner=false`——撤下时前台是最大化、岛却可见，且 `temp=false`（不是摸边唤回）；正常避让态下这种可见会被 150ms 自愈收掉，只剩 `manual` 一种解释。探针 `.tmp/probe-manual-stuck.mjs` 在修复前 E/F 步稳定复现（恢复后 2.5 秒岛仍可见）。

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
| `src/main/fullscreenWatch.ts` | 新增模块级 `manualHideImpl` / `manualRestoreImpl`，导出 `hideIslandManually()`、`restoreIslandFromManual()`、`isIslandManuallyHidden()`（唯一真源 = `state === 'manual'`）；`init` 里把恢复逻辑抽成 `doRestore()`：退出 manual → `apply(false,'manual-restore')` → 给一次「摸边唤回」同口径的 `tempVisible` → 重算期望；`commit()` 的隐藏分支在 `tempVisible` 时先不落地（菜单弹出瞬间判定常是 N，真正的 Z 稍后才到）；`stopFullscreenWatch()` 里置 `null` 防悬挂 |
| `src/main/index.ts` | 删除主进程自己的 `manualHide` 布尔值（改问 `isIslandManuallyHidden()`）；`restoreIsland()` 直接调 `restoreIslandFromManual()` 再 `showInactive()`（不再走 `webContents.send` 死频道）；新增 `refreshTrayMenu()`，在隐藏、恢复、`island:manual-hide`、状态落地时重建托盘菜单；托盘左键与菜单「显示灵动岛」共用 `restoreIsland()`；删除死链路 `ipcMain.on('island:avoid-do-hide')` |
| `docs/facts/功能清单.md` | 第 14 条补这一轮的规则 |
| `docs/状态.md` | 一句话状态 + 本轮段落 |

**明确不改**：
- 三档策略与避让判定（`SPEC-avoid-self-foreground` 已单独提交）；
- 手动隐藏时的状态机语义（`state='manual'` 期间不判定、摸边不唤回）：与修复前设计一致，只是现在真的会执行；
- 托盘菜单里「让桌宠出岛… / 让桌宠回到岛里」的文案过期问题（同一快照缺陷，但用户本轮没报，另记，不在本 SPEC 内修）。

## 三、预期行为

1. 岛右键或托盘右键 → 「暂时隐藏灵动岛」→ 岛隐藏；`startup.log` 记 `hide reason=manual-hide`。
2. 隐藏后托盘右键，第 4 项变成「显示灵动岛」。
3. 点「显示灵动岛」或左键托盘图标 → 岛回来，状态机回到 `normal`（或按判定进入 `avoided` + 临时现身），之后自动避让与摸边唤回照常工作。
4. 恢复时若前台是最大化/全屏：岛按「摸边唤回」同一口径临时现身——光标在岛上就留着，移开后回隐；不会只闪一下，也不会赖着不走。
5. 自动避让（全屏/最大化导致的隐藏）**不**改变手动隐藏状态，不会把菜单项换成「显示灵动岛」；横幅把岛叫亮同样不会。
6. 隐藏期间进度、待办、音乐等业务不受影响（只是窗口不显示）。

## 四、必要依赖

无新增依赖、无新 IPC 频道、无新窗口。`refreshTrayMenu()` 只在状态翻转时调用（不是每 150ms 一次），成本可忽略。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| V1 | 岛右键菜单第 4 项点击后岛隐藏 | `.tmp/menu-hide-test.ps1`：`BEFORE_VIS=1` → `AFTER_VIS=0`，日志 `hide reason=manual-hide` |
| V2 | 进程不退出（隐藏 ≠ 退出） | 同一脚本 `PROC=4`（Electron 主/渲染/GPU/utility 常驻） |
| V3 | 隐藏后托盘菜单项变为「显示灵动岛」 | UIA 枚举顶层菜单 `MenuItem`，存在名称「显示灵动岛」 |
| V4 | 点该菜单项后岛恢复，且状态机真的退出 manual | `.tmp/probe-manual-stuck.mjs` 日志出现 `show reason=manual-restore`（旧验收只看窗口可见数，漏掉了「窗口亮着但状态机没退」） |
| V5 | 托盘左键仍能恢复 | `.tmp/probe-manual-stuck.mjs` E 步：UIA 点托盘菜单第 4 项后可见数 0 → 1 |
| V6 | 横幅叫亮不会清掉手动状态 | 探针 C/D 步：`banner-on` 可见、`banner-off` 回隐，期间日志无 `judge:` 动作（仍处 manual） |
| V7 | 恢复后前台仍最大化时：岛按摸边口径临时现身，移开回隐 | 探针 E1 光标在岛上 → 可见 true；F 光标移开 → false，日志 `hide reason=cursor-left judge=Z` |
| V8 | 三套避让回归不回退 | `e2e-fullscreen-avoid` 9/0、`e2e-avoid-mode` 15/0、`e2e-fullscreen-misjudge` 7/0 |
| V9 | 类型检查与构建通过 | `npm run typecheck`、`npm run build` EXIT=0 |

## 六、不做什么

- 不改摸边唤回口径（用户若觉得「全屏时还能摸出岛」意外，需要单独决策，见 `SPEC-avoid-self-foreground` 的未决项）。
- 不修托盘菜单「桌宠出岛 / 收回」的文案过期（同一根因，另开）。
- 不处理「位置偏移 / 显示不全」。
- 不新增托盘气泡/通知式反馈（隐藏后没有任何提示是现状设计，本次不加）。
