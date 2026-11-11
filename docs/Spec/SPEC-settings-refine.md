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
  - `app:export-data` 的 handler 改为接收 `event`，用 `BrowserWindow.fromWebContents(event.sender)` 取「发起调用的那个窗口」挂模态（取不到时 `?? undefined`，对话框表现为无父窗口的独立对话框；独立验收实测 `owner_title=灵动岛设置`，退化分支在本项目里走不到）。原因：从设置窗口点导出时，原来固定用 `getAllWindows()[0]` 会挂到岛窗口上，模态对话框出现在一个不相关的窗口前面。
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

- [x] 页面区拖到目标行上半 → 被拖页插到目标行前面，其余顺移（断言整条 `pages`）
- [x] 页面区拖到目标行下半 → 被拖页插到目标行后面，其余顺移
- [x] 页面区插入结果与「互换」结果不同（反证，防止实现退化成互换仍假通过）——**注：判别力只在非相邻调换成立**（相邻调换时插入与互换结果恰好相同），见第八节 ⚠️
- [x] 拖动过程中目标行带 `.pm-drop-before` / `.pm-drop-after` 类
- [x] 页面区「至少保留一个」锁定逻辑未被破坏（最后一页取消不掉）
- [x] 未勾选的页仍不参与排序
- [x] 常规分区出现「导出数据」行与「导出…」按钮
- [x] 点「导出…」能走到 `app:export-data`（用返回值判定通道存活）
- [x] 右键/托盘菜单不再有「导出数据…」
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过
- [x] `scripts/e2e-settings-shell.mjs` 全过（含新增 S10/S11；独立验收 5.1 修复后追加 S12，现为 49 条）
- [x] 三条回归 `e2e-collapse-order.mjs`、`e2e-head-order.mjs`、`e2e-pages-custom.mjs` 不退步
- [x] 装机后实测：安装版能拖动插入、能从设置里导出

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
| 2026-11-11 | 独立验收（`.tmp/独立验收-21a254e.md`）指出跨区拖拽瑕疵：页面行拖到组件行会亮错位提示线，drop 后瞬态出现第 7 行（约 3ms，主进程 normalizeOrder 兜住，磁盘数据无损） | 已修：`reorderCollapsed` 的守卫从 `from === null` 改为 `typeof from !== 'string'`（dragFrom 是页面区/组件区共用 ref，页面区装的是 number）；组件区 `onDragOver` 从 `dragFrom.current !== null` 改为 `typeof dragFrom.current === 'string'`，跨区不再亮提示线 | — |
| 2026-11-11 | 修完后重跑 `npm run typecheck` / `npm run build` / `node scripts/e2e-settings-shell.mjs` | typecheck EXIT=0、build EXIT=0（`settings-D4Wwvu3X.js 22.93 kB`）、e2e **PASS（49 过 / 0 败）**，其中新增 S12a–S12f 六条跨区护栏断言 | — |
| 2026-11-11 | 修完后重跑回归 `e2e-collapse-order` / `e2e-head-order` / `e2e-pages-custom` / `e2e-export` | 22 过 / 14 过 / 6 项 / PASS，全部 0 败 | — |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-11 | 独立验收会话 `verifier-refine`（未参与实现，报告 `.tmp/独立验收-21a254e.md` 33189 B） | `21a254e` | 14 条中 ✅13 / ⚠️1 / ❌0。⚠️ 是第 3 条反证：断言实测成立、非恒真，但穷举 24 组发现 12 组（全部相邻调换）插入与互换结果恰好相同，S10 选的两组是非相邻的（2→0、3→1）所以有判别力 —— 即「防退化护栏」只在非相邻场景有效。实跑复现：typecheck EXIT=0、build EXIT=0、`e2e-settings-shell` 43/0、`e2e-collapse-order` 22/0、`e2e-pages-custom` 6 项、`e2e-export` PASS；`e2e-head-order` 第 1 次 9 过 1 败（`Error: no settings target` @ :50）、第 2 次 14/0 —— 该脚本本提交未改，属 `docs/状态.md` 遗留④已登记的偶发时序问题。验收方另做两项超出自检的实证：①物理鼠标点击原生「保存(S)」按钮，开发版与装机版都拿到 `ok:true` + 128 字节五键齐全文件，默认名 `灵动岛备份-YYYYMMDD-HHmmss.json` 格式正确，模态 `owner_title=灵动岛设置`；②抽出装机版 asar 的 `out/main/index.js`（79863 B）核实菜单编译产物只有 5 项（设置/页面管理/sep/显示或隐藏/sep/退出），`导出数据` 全文 2 次命中且都在注释里。 | 有条件通过，阻断项 0 条 |
| 2026-11-11 | 验收方提出的 9 条不阻断项（编号见报告第五节）对本轮的处理：**5.1 已修**（跨区拖拽：守卫改 `typeof from !== 'string'`，组件区 `onDragOver` 只认字符串来源，新增 S12a–S12f 六条回归断言，49/0）；**5.2 已改文档**（SPEC 第二节原写「取不到再退回第一个窗口」与实现不符，改为「取不到时 `?? undefined`，表现为无父窗口的独立对话框，实测退化分支走不到」）；**5.3 已补三处事实文档**（`docs/facts/数据规则.md:51` 的「入口在 `buildAppMenu()`」、`数据规则.md:58`、`docs/facts/用户角色与用户故事.md:216`）；**5.4 已补**（`docs/状态.md` 由后续提交补入，见下方哈希更正）；**5.5/5.7/5.8 记录在案不改**（e2e 对锁定/未勾选页零覆盖已由验收方探针补证；`e2e-head-order` 偶发为既有遗留；S11d 是「或」断言，落盘证据由验收方物理点击补上）；**5.6 记录在案**（S10 反证只在非相邻场景有判别力，属 e2e 覆盖度问题，不影响实现正确性）；**5.9 已核对**（`.tmp/` 临时文件均未进提交，测试落盘的导出文件已删除）。 | `21a254e` + 本轮修复后续提交 | 上述处理逐条落地 | 已处理完毕 |
