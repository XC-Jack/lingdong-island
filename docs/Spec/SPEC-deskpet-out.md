# SPEC-deskpet-out：桌宠出岛（独立小窗口）

- 建立日期：2026-11-12 15:20
- 对应基线提交：`3ef84d4`（`main`，已含 `deskpet-photo` 与 `fix-e2e-close-race`）
- 任务分支：`deskpet-out`
- 关联用户故事：暂无编号（桌宠阶段 1，用户 2026-11-12 14:56 授权「开始讨论下一步」后确定先做出岛）
- 关联事实文档：`docs/facts/功能清单.md`、`docs/facts/技术方案.md`

## 一、目标

让桌宠能**离开灵动岛**，变成一个独立浮在桌面上的小窗口：可以拖到屏幕任意位置、关掉重开还记得在哪、能一键收回岛里。

这是桌宠「阶段 1」的第一步。先有「能出门」这个容器，后面「长大」才有地方展示大个子形象。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/pet.html` | 新增。宠物窗口的第三个 rollup 入口 |
| `src/renderer/src/petwin/main.tsx` | 新增。宠物窗口渲染入口 |
| `src/renderer/src/petwin/PetWindowApp.tsx` | 新增。宠物窗口界面：画桌宠 + 拖动 + 右键菜单 |
| `src/renderer/src/petwin/petwin.css` | 新增。宠物窗口样式（不带 `zoom`，与岛独立） |
| `src/main/petWindow.ts` | 新增。宠物窗口的创建/销毁/拖动/位置记忆 |
| `src/main/prefsStore.ts` | 新增 `petWindowPos` 字段与白名单校验；抽出 `applyPatch()` 供主进程内部复用；新增 `onPrefsWritten()` 监听与 `getPrefs()` / `patchPrefs()` 导出 |
| `src/main/index.ts` | 启动时按 `petMode` 决定是否开宠物窗口；订阅偏好变更同步开关；`quitApp()` 兜底关窗 |
| `src/preload/index.ts` | 新增宠物窗口 API：`petDragStart` / `petDragEnd` / `petShowMenu` |
| `src/shared/types.ts` | 新增 `PetWindowPos` 接口；`PET_MODES` 注释更新（`window` 已实现） |
| `src/renderer/src/settings/DeskPetSection.tsx` | 「独立小窗口」从禁用改为可选；文案更新 |
| `src/renderer/src/App.tsx` | 新增 `petMode` state；`window` 模式下岛上不再画桌宠（它出门了） |
| `electron.vite.config.ts` | renderer 增加第三个入口 `pet` |
| `scripts/e2e-deskpet-out.mjs` | 新增。覆盖模式切换、窗口出现/消失、岛上消失、位置记忆、拖动 |
| `docs/Spec/SPEC-deskpet-out.md` | 本文件 |

**不动**：岛窗口自身的尺寸/补间逻辑、`fullscreenWatch.ts`（全屏避让状态机，见第六节）、皮肤绘制代码、`petMode` 的 `free` 档。

## 三、预期行为

1. 设置窗口 →「桌宠」→「出现在哪里」，「独立小窗口」这一档**不再是灰色禁用**，可以点。
2. 点「独立小窗口」→ 立刻（不用重启）在屏幕右下角出现一只桌宠，浮动在所有窗口之上，任务栏看不到它。
3. 与此同时，岛里那只**消失**（它出门了）：收起态没有桌宠、展开态头部也没有。
4. 按住桌宠拖动 → 跟着鼠标走，松手停住；拖到屏幕边缘会被挡在工作区内，不会跑到屏幕外面找不回来。
5. 关掉应用再打开 → 桌宠回到上次拖到的位置。
6. 在桌宠上点右键 → 弹出菜单：「回到岛里」「退出灵动岛」。
7. 点「回到岛里」→ 桌宠窗口关闭、岛里那只回来，`prefs.json` 里 `petMode` 变回 `island`。
8. 切回「只在岛里」→ 同上（窗口关闭、岛里回来）。
9. 宠物窗口本身**不抢焦点**：它出现时不会把当前正在用的窗口切走。

## 四、必要依赖

无新增依赖。复用已有的 `electron`、React、`Pet` 组件与皮肤资源。

拖动不用 CSS `-webkit-app-region: drag`：那个属性会让整个区域吞掉鼠标事件，右键菜单和「拖动 vs 点击」就没法区分。改为渲染层 `pointerdown` → 主进程每 16ms 读一次光标位置移动窗口 → `pointerup` 停。这样拖动跟手、且不影响任何点击。

## 五、验收条件

- [ ] 1. 设置页「独立小窗口」按钮 `disabled` 属性为 `false`，点击后 `prefs.json` 落盘 `petMode: "window"`。
- [ ] 2. 选 `window` 后出现一个 URL 含 `pet.html` 的渲染进程；岛（`index.html`）仍在。
- [ ] 3. 该窗口 `skipTaskbar` 生效（任务栏看不到），`alwaysOnTop` 生效。
- [ ] 4. `window` 模式下岛上 `.collapsed-pet` 数量为 0；切回 `island` 后恢复为 1。
- [ ] 5. 宠物窗口内 `.pet-wrap` 的 `data-pet-size` 为 `full`，渲染宽度 > 100px。
- [ ] 6. 宠物窗口跟随 `petSkin` 偏好：切皮肤后窗口里形象同步换。
- [ ] 7. 拖动后窗口位置改变，且 `prefs.json` 的 `petWindowPos` 与新位置一致（±2px）。
- [ ] 8. 重启应用后宠物窗口出现在 `petWindowPos` 记录的位置（±2px）。
- [ ] 9. 位置超出工作区时被 clamp 回工作区内（不出现完全看不见的窗口）。
- [ ] 10. 点「回到岛里」→ `pet.html` 窗口消失、`petMode` 落盘 `island`、岛上 `.collapsed-pet` 回来。
- [ ] 11. 宠物窗口存在时关掉岛窗口，应用不退出（`window-all-closed` 不误触发）。
- [ ] 12. `npm run typecheck` EXIT=0、`npm run build` EXIT=0，产物含 `pet.html`。

## 六、不做什么

1. **不做「自由走动」**（`petMode: 'free'`）：那是另一档，要寻路 + 自动移动 + 走路动画，另开 SPEC。本轮 `free` 仍是禁用状态。
2. **不做全屏避让联动**：`fullscreenWatch.ts` 的状态机只服务岛窗口，它有 20 KB 的判定逻辑（cloak 检测、类名黑名单、防抖），硬塞第二个窗口进去风险大于收益。副作用是看全屏视频时桌宠会浮在上面，这是**已知限制**，记在这里，需要时另开 SPEC。
3. **不做宠物窗口的动画**：呼吸/眨眼沿用皮肤里已有的 CSS 动画，不新做走路、跳跃、拖拽反馈动画。
4. **不做情绪系统**：宠物窗口里 `mood` 固定 `idle`，不接岛上的 `happy`。
5. **不做多显示器记忆**：只记一个坐标，显示器拔了/分辨率变了靠 clamp 兜底，不记住「第几块屏」。
6. **不做长大版**：`photo` 皮肤现在只有正面，长大版要四视图（侧面/背面已抠好放在 `.tmp/`，还没进仓库）。本轮宠物窗口用现有皮肤。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-12 | `npm run typecheck` | EXIT=0 | — |
| 2026-11-12 | `npm run build` | EXIT=0；产物含 `out/renderer/pet.html 0.73 kB`、`assets/pet-*.css 2.90 kB`、`assets/pet-*.js 3.35 kB` | — |
| 2026-11-12 | `node scripts/e2e-deskpet-out.mjs`（新建，33 条断言覆盖验收条件 1–12） | PASS（33 过 / 0 败） | 见下方「未验证」 |
| 2026-11-12 | `node scripts/e2e-deskpet.mjs`（旧脚本，需同步更新） | PASS（33 过 / 0 败） | — |
| 2026-11-12 | `node scripts/e2e-m2.mjs` | PASS | — |
| 2026-11-12 | `node scripts/e2e-head-order.mjs` | PASS（14 过 / 0 败） | — |
| 2026-11-12 | `node scripts/e2e-collapse-order.mjs` | PASS（22 过 / 0 败） | — |
| 2026-11-12 | `node scripts/e2e-settings-shell.mjs` | PASS（51 过 / 0 败） | — |

### 7.1 实现过程中实测到的两个真 bug（已修）

**① 拖动松手被吞（`PetWindowApp.tsx`）**
首版用 `const [pressed, setPressed] = useState(false)` 同时管「视觉反馈」和「在不在拖」。
`setPressed(true)` 是异步的（React 18 自动批处理），pointerdown 和 pointerup 落在同一个事件循环里时，
`endDrag()` 读到的 `pressed` 还是 `false`，直接 return，`petDragEnd()` 从来没发出去——
主进程收不到 drag-end，窗口会一直粘在鼠标上。
**修法**：拆成 `dragging = useRef(false)`（同步，判断用）+ `pressed` state（只用来换光标）。
e2e 的 P9a 就是抓这个的：首跑报 `等「落盘 petWindowPos」超时（8000ms）`。

**② `setPointerCapture` 抛 NotFoundError**
合成事件（e2e 里用 `dispatchEvent(new PointerEvent(...))`）的 `pointerId` 没有对应的活动指针，
`setPointerCapture` 会抛 `NotFoundError`，把后面的逻辑整段打断。包了 try/catch，
捕获失败不影响拖动本身（主进程照样跟光标）。

### 7.2 e2e 脚本自身踩的坑（不是产品问题，但会假红）

**① `closeSettings()` 的窗口消失竞态**
`hasTarget('settings')` 查到窗口在、到真正发 `settingsEval` 之间有一个空档，窗口可能已经自己关了，
这时 `settingsEval` 会连重试 40 次都报 `no settings target`——目的已达成（窗口没了）却算失败。
改成 try/catch 把「已经关了」当成功，只等最终状态。
（同一类竞态在 `e2e-head-order.mjs` 里也修过，见 SPEC-fix-head-order-flake。）

**② CDP target 比 `webContents.getURL()` 早**
`waitForTarget('pet', true)` 返回时 target 已存在，但那时 `loadURL` 还没完成，
`webContents.getURL()` 是空串，按 URL 找窗口会返回 `{none:true}`。
改成轮询 `petBounds()` 直到能读到 bounds。

**③ CDP target 比窗口销毁晚**
反过来也一样：`w.close()` 之后 target 会残留一小会儿。拿 `hasTarget('island') === false`
当「窗口已关」会假红。改成查主进程的 `BrowserWindow.getAllWindows()` 数量。

**④ Electron 没有 `isSkipTaskbar()`**
想运行时验 `skipTaskbar` 时发现这个 getter 不存在（`typeof` 是 undefined，读到 `null`）。
只能退回源码断言：读 `src/main/petWindow.ts`，检查 `new BrowserWindow({...})` 的构造参数里有 `skipTaskbar: true`。
**这条不是「运行时已验证」，只是「配置确实写在那儿」**，记进未验证清单。

### 7.3 未验证部分（如实记录）

1. **`skipTaskbar` 的实际效果没在运行时验过**：只查了源码里的构造参数。真要看任务栏有没有图标，得人眼看。
2. **拖动的手感没验**：e2e 用 `dispatchEvent` 派发合成 PointerEvent 走通「松手会存位置」的链路，
   但真实鼠标按住拖动时窗口跟手的流畅度（主进程 16ms 一轮读光标）没法自动验。
3. **多显示器没验**：本机只有一块屏。`clampPetPos` 用 `getDisplayNearestPoint` 的逻辑是按 API 语义写的，
   没在双屏环境跑过。
4. **全屏避让没接**：看全屏视频时桌宠会浮在上面（SPEC 第六节已记为已知限制）。
5. **未在打包版上验证**：本轮只跑了开发版（`npm run dev` 与 e2e 直启 electron）。
   打包版路径 `join(__dirname, '../renderer/pet.html')` 与开发版 `ELECTRON_RENDERER_URL` 分支不同，
   需要 `npm run dist` 后人工确认一次（本轮用户说不急着打包）。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待批量验收 | — | — | — |
