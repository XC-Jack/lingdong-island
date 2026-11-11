# SPEC-settings-refine

## 抬头

| 项 | 内容 |
|---|---|
| 建立日期 | 2026-11-11 |
| 对应基线提交 | `e32aa3e`（分支 `settings-shell` 的最新代码提交） |
| 任务分支 | `settings-refine`（从 `settings-shell` 拉出，因为本任务改的是设置窗口里新加的代码） |
| 关联用户故事 | 无新 US 编号；属 US-032（页面自定义）+ US-029（数据导出）的交互修正 |
| 关联事实文档 | `docs/facts/功能清单.md`、`docs/facts/里程碑.md` |

## 一、目标

用户 2026-11-11 看过装机版设置窗口后提了两条修正：

1. **页面区拖拽改成「中间插入」**。现在页面区是「互换」语义（拖 A 到 B 的位置，A、B 对调，其余不动），收起态组件区早就改成「插入」语义（拖 A 落在 B 的上半就插到 B 前面，下半插到 B 后面，其余顺移）。同一个面板里两种手感不一致，用户要求页面区也照组件区的来。
2. **导出数据搬进设置窗口**，右键/托盘菜单里的「导出数据…」一项去掉。

## 二、修改范围

- `src/renderer/src/settings/PageManagerSection.tsx`
  - `reorderTo(targetPageId)` 重写为插入语义，与 `reorderCollapsed` 同构：先把被拖页从列表里抽掉，再按落点前/后插入。
  - 页面行补上拖拽位置提示线：新增 `dropHint` 状态（与组件区共用一套），`onDragOver`/`onDragLeave`/`onDrop`/`onDragEnd` 四个处理器照组件区写法补齐，复用 `.pm-drop-before` / `.pm-drop-after` 两个既有样式类。
  - 页面行的拖动范围从「只有已勾选的页」放宽到「已勾选的页可拖、未勾选的页只能当落点之外的静态项」——维持原有门槛：未勾选页不参与排序（不进入 `pages`），拖到它上面不生效。
- `src/renderer/src/settings/SettingsApp.tsx`
  - 常规分区新增一行「导出数据」，说明文字写清导出内容（待办 + 日程），右侧按钮「导出…」，点击调 `window.island.exportData()`，按返回值给一行内联反馈（成功显示文件路径、取消不提示、失败显示原因）。导出结果仍由主进程发系统通知，两处不冲突。
- `src/main/index.ts`
  - 菜单里删掉 `{ label: '导出数据…', ... }` 一项。
  - 删掉只服务于该菜单项的 `exportData()` 函数（以及因此变成未使用的 import，如有）。
- `src/main/exportStore.ts`
  - `app:export-data` 的 handler 改为接收 `event`，用 `BrowserWindow.fromWebContents(event.sender)` 取「发起调用的那个窗口」挂模态；取不到再退回第一个窗口。原因：从设置窗口点导出时，原来固定用 `getAllWindows()[0]` 会挂到岛窗口上，模态对话框出现在一个不相关的窗口前面。
- `scripts/e2e-settings-shell.mjs`
  - 新增 S10 一组断言：页面区拖动是**插入**不是互换（落上半插前、落下半插后，断言整条 `pages` 数组，并反证结果不等于互换结果）。
  - 新增 S11 一组断言：常规分区有「导出数据」行与按钮，点击后 `app:export-data` 通道存活（用取消结果判定，不落盘）。
- `docs/facts/功能清单.md`：导出入口描述改为「设置窗口 → 常规 → 导出数据…」，菜单项一句删掉。
- `docs/状态.md`：一句话状态追加本轮。

## 三、预期行为

1. 设置窗口 → 页面管理：把「通知」拖到「待办」的上半，结果是「通知」插到「待办」前面，原本在「通知」后面的页顺移一位；不是两者对调。落在下半则插到目标行后面。拖动过程中目标行上/下边缘出现绿色 2px 提示线，与收起态组件区完全一致。
2. 页面区仍然是「至少保留一个页」，锁定行的「至少保留一个」提示不变；未勾选的页仍不可拖。
3. 右键/托盘菜单：只剩「设置…」「页面管理…」、分隔线、显示/隐藏、退出，**没有**「导出数据…」。
4. 设置窗口 → 常规 → 导出数据 → 导出…：弹出另存为对话框，默认文件名 `灵动岛备份-yyyyMMdd-HHmmss.json`，保存后系统通知提示路径，界面那一行也显示路径。取消则什么也不变。
5. 从设置窗口点导出时，对话框是挂在设置窗口上的模态，不是挂在岛上。

## 四、必要依赖

无新增依赖。复用 `window.island.exportData()`（US-029 已有 IPC）与 `.pm-drop-before`/`.pm-drop-after`（设置窗口 `settings.css` 已有）。

## 五、验收条件

- [ ] 页面区拖到目标行上半 → 被拖页插到目标行前面，其余顺移（断言整条 `pages`）
- [ ] 页面区拖到目标行下半 → 被拖页插到目标行后面，其余顺移
- [ ] 页面区插入结果与「互换」结果不同（反证，防止实现退化成互换仍假通过）
- [ ] 拖动过程中目标行带 `.pm-drop-before` / `.pm-drop-after` 类
- [ ] 页面区「至少保留一个」锁定逻辑未被破坏（最后一页取消不掉）
- [ ] 未勾选的页仍不参与排序
- [ ] 常规分区出现「导出数据」行与「导出…」按钮
- [ ] 点「导出…」能走到 `app:export-data`（用返回值判定通道存活）
- [ ] 右键/托盘菜单不再有「导出数据…」
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `scripts/e2e-settings-shell.mjs` 全过（含新增 S10/S11）
- [ ] 三条回归 `e2e-collapse-order.mjs`、`e2e-head-order.mjs`、`e2e-pages-custom.mjs` 不退步
- [ ] 装机后实测：安装版能拖动插入、能从设置里导出

## 六、不做什么

- 不做数据导入（用户明确说这轮不做）。
- 不做 App 图标角标。
- 不动 4 项 UI 美化。
- 不改收起态组件区的插入逻辑（它已经是对的行为）。
- 不改 `导出` 的数据内容与文件名格式（仍是待办 + 日程、仍是 `灵动岛备份-*` 命名）。
- 不动专注·喝水分区（仍是占位）。
- 不顺手重构 `PageManagerSection` 的其他部分。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-11 | `npm run typecheck`（node + web） | EXIT=0 | — |
| 2026-11-11 | `npm run build` | EXIT=0；产物 `out/renderer/settings.html 0.58 kB`、`settings-DjPYifJV.css 9.14 kB`、`settings-DPgiEyX9.js 22.90 kB`、`index-CHAvylTO.js 92.71 kB`、`out/main/index.js 79.86 kB`、`out/preload/index.js 10.32 kB` | — |
| 2026-11-11 | `node scripts/e2e-settings-shell.mjs` | PASS（43 过 / 0 败），新增 S10a–S10k（11 条插入语义）与 S11a–S11d（4 条导出入口） | — |
| 2026-11-11 | 回归 `node scripts/e2e-collapse-order.mjs` | PASS（22 过 / 0 败）——组件区插入语义未受影响 | — |
| 2026-11-11 | 回归 `node scripts/e2e-head-order.mjs` | PASS（14 过 / 0 败） | — |
| 2026-11-11 | 回归 `node scripts/e2e-pages-custom.mjs` | PASS（6 项通过）——跨重启顺序持久化仍正常 | — |
| 2026-11-11 | 回归 `node scripts/e2e-export.mjs` | PASS（E1 取消分支 / E2 通道 / E3 说明）——导出 IPC 未因入口搬迁而坏 | — |
| 2026-11-11 | 装机：`npx electron-builder --win --config.electronDist=node_modules/electron/dist` + 静默安装 + CDP 探针 | 安装版 asar 已含新产物，设置窗口能拖动插入、常规分区有「导出数据」行 | 未验证：真实鼠标拖拽手感（e2e 用合成 DragEvent）、另存为对话框在真人点击下的模态归属观感、弹出对话框时岛是否被遮挡 |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| — | 待独立验收 | — | — | — |
