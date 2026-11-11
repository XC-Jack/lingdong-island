# SPEC-settings-shell 带左导航的完整设置页

- 建立日期：2026-11-11
- 对应基线提交：`f83b682`（main HEAD）
- 任务分支：`settings-shell`
- 关联用户故事：US-032 页面自定义（已有能力，本轮把它搬进设置页）；无新增 US 编号
- 关联事实文档：[`../facts/功能清单.md`](../facts/功能清单.md) 第 11 节「页面自定义」与第 132-149 行「需求清单（视频逐帧还原）」、[`../facts/里程碑.md`](../facts/里程碑.md) 「尚未排期」一节

## 一、目标

把原来挤在灵动岛第 5 页的「页面管理」面板，升级成一个**独立设置窗口**：左边一列导航（常规 / 页面管理 / 专注·喝水），右边是选中分区的设定内容。

现状差距（[实测] 读代码）：
- 现在没有设置窗口，`src/main/index.ts` 只创建 `mainWindow` 一个窗口。
- 「页面管理」是岛里的第 5 页（`src/renderer/src/App.tsx:2617` 的 `page === 4` 分支），入口只能用右键/托盘菜单 `页面管理…`，岛最大 720×420，一行只放得下两组勾选，再想加「常规」「专注·喝水」就没地方了。
- 设置类的东西散落在岛体上：开机自启是岛头部的一个小胶囊按钮（`src/renderer/src/App.tsx:2580-2591`），版本号、数据目录在界面上看不到。

用户 2026-11-11 确认走独立窗口方案（原话：「先做做导航的设置页吧，两外两个不做」，形态选择「独立设置窗口」）。

## 二、修改范围

### 新增文件

| 文件 | 内容 |
|---|---|
| `src/renderer/settings.html` | 设置窗口的 HTML 入口（与 `index.html` 同 CSP，`<div id="root">` + `/src/settings/main.tsx`） |
| `src/renderer/src/settings/main.tsx` | 设置窗口渲染入口：`createRoot(...).render(<SettingsApp />)`，`import './settings.css'` |
| `src/renderer/src/settings/SettingsApp.tsx` | 左导航 + 右侧内容区；三个分区 `general` / `pages` / `focus` |
| `src/renderer/src/settings/settings.css` | 设置窗口独立样式基线（整窗不透明深色卡片，不复用岛的透明基线） |
| `src/renderer/src/settings/PageManagerSection.tsx` | 从 `App.tsx` 原样搬出的页面管理逻辑（页面显隐/排序 + 收起态组件显隐/排序），**类名与 `data-*` 保持不变**（四个关键函数 `togglePage`/`toggleCollapsed`/`reorderTo`/`reorderCollapsed` 与 `dropEdge` 判据与基线字符级相同；界面细节有两处不同：行首多一枚 `.pm-dot` 状态圆点、`PAGE_META` 不带 icon 字段） |
| `src/main/settingsWindow.ts` | 设置窗口的创建/唤出/关闭 + `settings:*` IPC |
| `scripts/e2e-settings-shell.mjs` | 新建：设置窗口 e2e（见第五节） |

### 修改文件

| 文件 | 改什么 |
|---|---|
| `electron.vite.config.ts` | `renderer.build.rollupOptions.input` 增加 `settings: resolve('src/renderer/settings.html')`（现有 `index` 一并显式写出） |
| `src/main/index.ts` | 菜单：`页面管理…` 改为打开设置窗口并落在「页面管理」分区；新增 `设置…`（落在「常规」）。删除 `openPageManager()` 的 `island:manage-pages` 发送 |
| `src/main/settingsWindow.ts`（新建） | 见下 |
| `src/main/prefsStore.ts` | `prefs:set` 落盘后向所有窗口广播 `prefs:changed`，让岛和设置窗口互相同步 |
| `src/preload/index.ts` | 新增 `openSettings` / `closeSettings` / `onSettingsSection` / `onPrefsChanged` / `appInfo` / `openUserData`；删除 `onManagePages` |
| `src/shared/types.ts` | 新增 `SettingsSection = 'general' \| 'pages' \| 'focus'` 与 `AppInfo { version; userData }` |
| `src/renderer/src/App.tsx` | **删掉第 5 页整段**：`PageManagerPanel` 组件（`:1735-1905`）、`page === 4` 的所有分支、`onManagePages` 监听；新增 `onPrefsChanged` 监听把设置窗口的改动同步回岛 |
| `scripts/e2e-collapse-order.mjs` | 打开面板的方式改为 `window.island.openSettings('pages')` + 连设置窗口的 CDP target；`closePanel()` 改为关闭设置窗口 |
| `scripts/e2e-head-order.mjs` | 同上 |
| `docs/facts/功能清单.md` | 第 11 节补一句「页面管理已搬进独立设置窗口」；第 148 行「仍未排期」删掉设置页外壳一项 |
| `docs/facts/里程碑.md` | 同上，删掉「原视频那种带左导航的完整设置页外壳」这一条未排期项 |
| `docs/状态.md` | 一句话状态 + 下次开工 |

### 不动的部分

- 岛窗口本身的尺寸、位置、透明、动画、避让状态机（`fullscreenLoop.ts` / `fullscreenWatch.ts`）。
- 收起态渲染逻辑、各页内容组件（待办/置物架/通知/日程）。
- `prefs.json` 的数据结构与字段名（只加广播，不改 schema）。
- 打包配置 `package.json` 的 `build.files`（`out/**` 已覆盖新入口产物）。

## 三、预期行为

### 1. 打开设置窗口

- 岛内右键 → 菜单第一项变成 `设置…` → 弹出设置窗口，默认停在「常规」。
- 菜单里保留 `页面管理…` → 打开同一个窗口，直接停在「页面管理」。
- 窗口形态：880×580 固定大小，屏幕居中，深色圆角卡片，顶部一条自己画的标题栏（左边「设置」标题，右边 × 关闭），标题栏可拖动窗口。
- 点 × 关闭 = 只关这个窗口，岛和主进程继续跑。再次打开是新窗口。

### 2. 左导航三个分区

| 分区 | 内容 |
|---|---|
| 常规 | 开机自启开关（与岛头部那个胶囊共用同一份 IPC，两边状态一致）；版本号；「打开数据文件夹」按钮 → 资源管理器打开 `%APPDATA%\lingdong-island\` |
| 页面管理 | 上半「页面」：4 行勾选（待办/置物架/通知/日程），勾着可拖动换位，最后一个不能再取消（显示「至少保留一个」）；下半「收起态组件」：6 行勾选（岛仔/时钟/电量圈/网络图标/待办数字/通知铃铛），勾着与否都能拖，落点在上半插到前面、下半插到后面；底部「重置为默认」 |
| 专注·喝水 | 占位：一句「这一项还没开始做」，说明这里以后放什么 |

- 任何勾选/拖动**立即生效并落盘**（`prefs.json`），不需要点保存。
- 设置窗口改完，岛当场跟着变（组件显隐/顺序/页面数量立刻反映），不用重启。

### 3. 岛里的变化

- 岛只剩 4 个可轮播页（待办/置物架/通知/日程），原来那个第 5 页「页面管理」连同它的圆点一起消失。
- 翻页圆点只有 4 个。

## 四、必要依赖

无新增 npm 依赖。复用现有的 `prefsStore`（IPC + `prefs.json`）与 `autostart:get/set`。

## 五、验收条件

- [ ] 岛内右键菜单有 `设置…` 和 `页面管理…` 两项，点击都能弹出设置窗口。
- [ ] `设置…` 落在「常规」，`页面管理…` 落在「页面管理」。
- [ ] 设置窗口 880×580、屏幕居中、深色圆角、标题栏能拖动窗口、× 能关掉且不影响岛。
- [ ] 左导航 3 项（常规/页面管理/专注·喝水），点击切换右侧内容，当前项有高亮态。
- [ ] 「常规」里开机自启开关能真的改系统自启（与岛头部胶囊状态一致），版本号显示 `package.json` 的 version，点「打开数据文件夹」会打开 `%APPDATA%\lingdong-island\`。
- [ ] 「页面管理」里页面区 4 行、收起态组件区 6 行，勾选立即写进 `prefs.json`。
- [ ] 页面区最后一个页面不能取消（勾选框显示锁定态并显示「至少保留一个」；实现上靠 `togglePage` 早退拦截，**不加 `disabled` 属性**——与基线 `PageManagerPanel` 一致，避免改了既有交互）
- [ ] 收起态组件拖动是**插入**语义：落在目标行上半插到它前面、下半插到它后面，整条 order 数组随之顺移。
- [ ] 在设置窗口取消勾选「通知铃铛」→ 岛收起态铃铛立刻消失；勾回 → 立刻回来。
- [ ] 岛里不再有「页面管理」页：翻页圆点只有 4 个。
- [ ] `npm run typecheck` 与 `npm run build` 均通过。
- [ ] `docs/facts/功能清单.md`、`docs/facts/里程碑.md`、`docs/状态.md` 已同步。

## 六、不做什么

- **不做「音乐与歌词」分区**：US-031 已被用户明确否决（2026-11-05），不把它当待办重新挂出来。
- **不做「专注·喝水」的实际功能**：本轮只放占位说明，计时/提醒另开 SPEC。
- 不把数据导出/导入搬进设置页：导出仍走右键菜单「导出数据…」，导入仍未实现（用户明确不做）。
- 不做 App 图标角标（用户明确不做）。
- 不做 `docs/交接-美化进度.md` 里那 4 项 UI 美化（通知页排版、完成进度圆环、日历升级、进度条）。
- 不改 `prefs.json` 的字段名或结构，不动置物架视图记忆（`shelfView`）的交互。
- 不给设置窗口做最小化/最大化按钮、不做多语言、不做主题切换。
- 不顺手重构 `App.tsx` 里与本次无关的代码。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-11 | `npm run typecheck`（node + web 两段） | **通过**，EXIT=0，无报错 | — |
| 2026-11-11 | `npm run build` | **通过**，EXIT=0。新增产物 `out/renderer/settings.html 0.58 kB`、`out/renderer/assets/settings-Dq-DNDfL.css 8.80 kB`、`out/renderer/assets/settings-BcNQoWTX.js 20.45 kB`；岛侧 `out/renderer/index.html 0.57 kB`、`index-ZD9_PFK2.css 46.23 kB`、`index-DRoL8j_T.js 92.59 kB`、`jsx-runtime-Bscai5M3.js 565.45 kB` | — |
| 2026-11-11 | `node scripts/e2e-settings-shell.mjs`（新建，23 项断言） | **PASS（23 过 / 0 败）** | 真人眼观感（深色层次、圆角、滚动条）、真实鼠标拖拽手感 |
| 2026-11-11 | 回归 `node scripts/e2e-collapse-order.mjs`（面板从第 5 页搬到设置窗口后改造） | **PASS（22 过 / 0 败）** | — |
| 2026-11-11 | 回归 `node scripts/e2e-head-order.mjs`（同步改造） | **PASS（14 过 / 0 败）** | — |
| 2026-11-11 | 回归 `node scripts/e2e-pages-custom.mjs`（验证岛本身页数/顺序未被搬移破坏） | **PASS（6 项通过）** | — |
| 2026-11-11 | `git grep` 复核 `onManagePages` 残留（限 `src` 与 `scripts`，文档里的历史记录不算） | 代码侧零命中 | — |
| 2026-11-11 | **独立验收第一轮（`2472e95`）不通过，修 2 条阻断后重跑** | 见下「阻断项订正」 | 见第八节 |
| 2026-11-11 | 订正后 `npm run typecheck` / `npm run build` | **均 EXIT=0**；产物 `settings-2BSFDnCE.js 20.55 kB`、`index-CHAvylTO.js 92.71 kB`（均含自启广播代码） | — |
| 2026-11-11 | 订正后 `node scripts/e2e-settings-shell.mjs`（新增 S9a–S9e 五条自启同步断言） | **PASS（28 过 / 0 败）** | 真实开机自启是否生效仍未测（见下） |
| 2026-11-11 | 订正后三条回归重跑 | `e2e-collapse-order` **22 过 / 0 败**、`e2e-head-order` **14 过 / 0 败**、`e2e-pages-custom` **6 项通过** | — |

**独立验收第一轮阻断项订正（针对 `2472e95`，报告 `.tmp/独立验收-2472e95.md`）**：

- **B1 `docs/状态.md` 不在固定提交里** → 已连同本轮所有订正一起提交，后续以订正后的新哈希为固定提交。
- **B2 自启状态在岛与设置窗口之间无同步通道**（SPEC 三.2 与验收条件 #5 要求「两边状态一致」，实际两边都只在挂载时读一次）→ 已修：`src/main/index.ts` 的 `autostart:set` 落盘后取**真实值**广播 `autostart:changed` 给所有窗口（用真实值而非入参，系统拒绝写入时两边都看到实际结果）；`src/preload/index.ts` 新增 `onAutostartChanged(cb): () => void`（沿用返回取消订阅的既有写法）；`src/renderer/src/App.tsx` 与 `src/renderer/src/settings/SettingsApp.tsx` 各加一处订阅。**新增 e2e S9a–S9e 覆盖双向同步**（含反向：从岛侧改，设置窗口的开关跟着变），并记录/恢复注册表原值，避免测试污染用户自启设置。
- **顺带修掉验收方指出的时序运气问题**：`src/main/settingsWindow.ts` 的 `openSettings()` 原来是「先建窗、后赋 `pendingSection`」，靠 loadFile 异步才不出错；改为「先赋 `pendingSection`、再建窗」。
- **不阻断项已订正的两处文档偏差**：SPEC 第五节实际是 12 条 checkbox（此前写成「13 条」）；自检表原写「`git grep` 全仓库零命中 `onManagePages`」不可复现（文档里有 5 处历史记录），已改为限定 `src` 与 `scripts` 的准确表述。

| 2026-11-11 | 把 S9 的注册表恢复从块内移到 `finally`（第二轮验收不阻断项 N5：原写法异常/强杀会漏恢复，污染用户自启设置）后重跑 | **PASS（28 过 / 0 败）** | — |

**独立验收第一轮阻断项订正（针对 `2472e95`，报告 `.tmp/独立验收-2472e95.md`）**：

- **B1 `docs/状态.md` 不在固定提交里** → 已连同本轮所有订正一起提交，后续以订正后的新哈希为固定提交。
- **B2 自启状态在岛与设置窗口之间无同步通道**（SPEC 三.2 与验收条件 #5 要求「两边状态一致」，实际两边都只在挂载时读一次）→ 已修：`src/main/index.ts` 的 `autostart:set` 落盘后取**真实值**广播 `autostart:changed` 给所有窗口（用真实值而非入参，系统拒绝写入时两边都看到实际结果）；`src/preload/index.ts` 新增 `onAutostartChanged(cb): () => void`（沿用返回取消订阅的既有写法）；`src/renderer/src/App.tsx` 与 `src/renderer/src/settings/SettingsApp.tsx` 各加一处订阅。**新增 e2e S9a–S9e 覆盖双向同步**（含反向：从岛侧改，设置窗口的开关跟着变），并记录/恢复注册表原值，避免测试污染用户自启设置。
- **顺带修掉验收方指出的时序运气问题**：`src/main/settingsWindow.ts` 的 `openSettings()` 原来是「先建窗、后赋 `pendingSection`」，靠 loadFile 异步才不出错；改为「先赋 `pendingSection`、再建窗」。
- **不阻断项已订正的两处文档偏差**：SPEC 第五节实际是 12 条 checkbox（此前写成「13 条」）；自检表原写「`git grep` 全仓库零命中 `onManagePages`」不可复现（文档里有 5 处历史记录），已改为限定 `src` 与 `scripts` 的准确表述。

**独立验收第二轮不阻断项已处理的**：N5 注册表恢复移进 `finally`（见上表最后一行）；N1 `docs/状态.md` 内容补齐到本轮（28 过、`autostart:changed`、B2 订正记录）；N6 本节「独立验收尚未进行」一句作废，改为已验收（见第八节）。**未处理的**：N4 `isLoading()→pendingSection` 分支仍无确定性测试锁定（顺序已修对，但没有断言防回归）；验收条件里「原生菜单两项、窗口 880×580/居中/圆角/标题栏拖动、导航高亮类、版本号精确比对、末页锁定」六项仍只有代码推理、无运行断言。

**未验证（自检阶段明确的空白）**：
- 真机人眼观感：设置窗口的深色层次、圆角裁切、滚动条样式、标题栏拖动是否顺手，全程只看 DOM 与类名，没有截图比对。
- 真实鼠标拖拽：e2e 用 `dispatchEvent` 合成 drag 事件验证了插入语义与提示线类名，但真实光标拖动的手感、拖拽时的残影未测。
- 开机自启的**真实开机链路**：e2e 的 S9 已经真的读写注册表并验证了岛与设置窗口双向同步，但「重启电脑后是否真的自动拉起」未测（需要重启机器）。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-11 | `verifier-settings`（fresh context，未参与实现） | `2472e95` | 12 条验收条件：✅6 / ⚠️4 / ❌2。阻断项 2 条：**B1** `docs/状态.md` 不在固定提交内；**B2** 自启状态在岛与设置窗口之间无同步通道（SPEC 三.2、验收条件 #5 未满足）。报告 `.tmp/独立验收-2472e95.md` | **不通过** |
| 2026-11-11 | `verifier-settings`（同一会话第二轮复验） | `8413391` | 12 条验收条件：✅6 / ⚠️6 / ❌0。B1 已关闭（`git show 8413391:docs/状态.md` 命中 `settings-shell` 2 处）；B2 已关闭（四处改动逐行核对落地，S9b+S9c 证设置窗口→岛、S9d+S9e 证岛→设置窗口 `aria-checked`，广播取 `getLoginItemSettings` 真实值）。四项实跑复现一致：typecheck EXIT=0、build EXIT=0、新 e2e 28 过/0 败、三条回归 22/14/6 全过。报告 `.tmp/独立验收-8413391.md` | **有条件通过（阻断项 0 条）** |
