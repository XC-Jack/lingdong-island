# SPEC US-041 全屏自动避让（摸边唤回 + 手动隐藏）

## 一、目标

用户在浏览器最大化/应用全屏页面操作时，岛不再挡住顶部内容：岛自动隐藏；鼠标摸屏幕顶部边缘时岛临时现身（类似 QQ 桌面端悬停弹出）；不想用了可手动点击隐藏。正常（非全屏）使用时岛照常常驻，行为不变。

## 二、修改范围

- `src/main/fullscreenWatch.ts`（新建）：全屏检测轮询 + 隐藏/唤回状态机 + 边缘感应区（隐形窗口）。
- `src/main/index.ts`：挂载 fullscreenWatch；`buildAppMenu()` 加「暂时隐藏」项；注册 `island:manual-hide` IPC。
- `src/renderer/src/App.tsx`：渲染层临时隐藏状态（`island:avoid-changed` 接收：隐藏时收起面板、显示时恢复），横幅/验证码弹出时请求主进程临时显示。
- `src/preload/index.ts`：`onAvoidChanged(cb)`、`manualHide()`、`requestTempShow()` 三桥。
- `scripts/e2e-fullscreen-avoid.mjs`（新建）：e2e 断言。
- `docs/Spec/SPEC-us-041-fullscreen-avoid.md`：本文件。
- 不改：notifyStore/clipboardStore/shelf 等数据层；托盘逻辑；computeBounds。

## 三、预期行为

1. **自动避让**：主进程每 1s 查前台窗口矩形，完全覆盖屏幕（1536x960 判据：L≤0、T≤0、R≥W、B≥H）视为全屏/最大化 → 岛 `hide()`（窗口隐藏，进程与托盘常驻）。全屏退出且非手动隐藏态 → 岛恢复 `showInactive()`，还原之前展开/收起状态。
2. **摸边唤回**：隐藏期间屏幕顶部 4px 隐形感应窗（frameless、transparent、不可聚焦 skipTaskbar），鼠标进入 → 岛临时现身（恢复原状态）；鼠标离开岛区域 → 若仍全屏则再次隐藏。退出全屏后永久恢复。
3. **手动隐藏**：右键/托盘菜单「暂时隐藏灵动岛」→ 同 hide，但**摸边不再唤回**；托盘左键点击 → 立即恢复（清手动标志）。菜单项文案随状态切换（隐藏后显示「显示灵动岛」）。
4. **横幅优先**：通知横幅/验证码横幅触发时，主进程 `tempShow()`（若正隐藏且非手动）→ 岛临时显示让横幅可见，横幅结束回调后按当前全屏状态决定回隐或常驻。
5. **边缘细节**：隐藏前若岛处于展开态，先收起再 hide，恢复时回到收起态（简化，不做展开态记忆）；避让期间 e2e 断言窗口 `isVisible()===false`；恢复延迟用 300ms 去抖防抖动（全屏判定抖动会闪烁）。

## 四、必要依赖

无新依赖。全部用已有：Electron BrowserWindow/screen、Node 内置模块。Windows API 通过 Electron 的 `screen.getPrimaryDisplay()` + 前台窗口 rect（需新加 user32 P/Invoke？**不需要**：Electron 无前台窗口 rect API——改用 PowerShell 探针成本高；**方案定稿：用 `screen.getCursorScreenPoint()` + 感应窗命中即可，全屏判定改用前台 rect 通过新增的 user32 FFI**——Electron 主进程可直接 `require('koffi')`？不引入。**最终方案：PowerShell 单实例常驻脚本输出前台 rect？也不引入。采用：Node `ffi` 不装，改用 Electron 自带 `screen` + 简化判据：监听 `screen` 事件不可行——保留 user32 GetForegroundWindow 探针，通过每 1s spawn 一次 pwsh 的成本评估后否决；**定稿：主进程用 Node 原生 `child_process` 一次性长驻 PowerShell 进程，脚本内 1s 循环输出 `fullscreen|normal` 单行到 stdout，主进程按行读取**。）

依赖修订（定稿）：无 npm 新依赖；一个长驻 PowerShell 子进程（fullscreen-watch.ps1 逻辑内嵌字符串，同 statusStore 模式）。

## 五、验收条件

- [实测] e2e-fullscreen-avoid.mjs：A1 正常时岛可见；A2 造全屏窗口（Electron 自己开一个 fullscreen BrowserWindow 或用 Start-Process 最大化记事本并置前）→ 2s 内岛隐藏；A3 退出全屏 → 2s 内岛恢复；A4 隐藏时鼠标摸顶边（SetCursorPos 到 y=0）→ 岛现身；A5 移开鼠标且仍全屏 → 岛再隐；A6 手动隐藏后摸边不唤回、托盘点击唤回；A7 全屏时发通知 → 横幅期岛临时可见、结束后回隐。
- [实测] 回归：collapsed-todo / wifi / notify-live / code-hint 全 PASS（避让不误伤常态）。
- [实测] 打包安装后 4 进程存活；typecheck/build PASS。
- [人工] 用户实机：浏览器最大化时岛让路、摸顶边唤回、右键手动隐藏、看视频时消息横幅照常弹出。

## 六、不做什么

- 不做「白名单应用」（如「全屏但显示岛」的应用清单）。
- 不做展开态记忆（避让时展开则收起，恢复后回收起态）。
- 不做 macOS/Linux 适配（本项目仅 Windows）。
- 不做多显示器精修（只判主屏；感应窗只放主屏顶部）。
- 不动通知数据层与横幅样式。
