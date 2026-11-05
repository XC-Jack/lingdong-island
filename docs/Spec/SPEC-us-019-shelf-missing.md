# SPEC-us-019-shelf-missing

- 建立日期：2026-11-05
- 对应基线提交：`26c4a04257f10e97b23aefb1cf08ba9053d5e145`
- 任务分支：`us-019-shelf-missing`
- 关联用户故事：US-019（见 ../facts/用户角色与用户故事.md 第 3.4 节）
- 关联事实文档：../facts/功能清单.md（第 2 节 置物架）、../facts/数据规则.md（置物架存绝对路径）、../facts/本机约束与踩坑.md

## 一、目标

置物架里的文件被移走或删除后，用户能一眼看出「这个文件已经不在了」，并且能一键把它从架子上移除，不再出现「点了没反应、只弹英文报错」的困惑。

## 二、修改范围

要改的文件：

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `ShelfItem` 增加可选字段 `missing`（不落盘，运行时算）；新增 `ShelfOpenResult`、`ShelfRevealResult` 两个结果类型 |
| `src/main/shelfStore.ts` | 新增 `withMissing(items)`：每次返回列表时用文件系统检查算出 `missing`；`shelf:list/add/remove/clear/reorder` 的返回值都经过它 |
| `src/main/index.ts` | `shelf:open` 改为返回 `{ ok, reason, detail }`，不存在时直接回 `missing`，不再把英文系统报错透给界面；`shelf:show-in-folder` 改为返回定位结果 |
| `src/preload/index.ts` | `shelfOpen`/`shelfShowInFolder` 的类型与实现跟上面同步（`shelfShowInFolder` 由 `send` 改 `invoke`，修复既有「发事件但主进程等的是 handle」导致按钮点了没反应的问题） |
| `src/renderer/src/App.tsx` | `ShelfPanel`：失效条目加视觉标识与中文提示条（含「从架子上移除」按钮）；打开失败按原因分流；失效条目的「在文件夹中显示」禁用 |
| `src/renderer/src/styles.css` | 失效态样式（置灰 + 删除线 + 「失效」徽标）、提示条与移除按钮样式、禁用态样式 |
| `scripts/e2e-shelf-missing.mjs` | 新增 e2e，覆盖失效识别、中文提示、一键移除、定位禁用 |
| `docs/facts/功能清单.md`、`docs/facts/数据规则.md`、`docs/facts/用户角色与用户故事.md`、`docs/状态.md` | 同步事实（缺失状态的计算方式、US-019 现状、一句话状态） |

明确**不动**：待办、通知、日程、岛仔动画、窗口尺寸与动画逻辑；不新增依赖；不改 `shelf.json` 的存储格式（仍只有 `items[]`，不加落盘字段）。

## 三、预期行为

1. 架上有文件被移走/删除后，打开置物架页会看到那个格子/那一行被置灰、名字带删除线，右上（列表是行内）出现「失效」小标识；鼠标悬停显示「文件已不在：<原路径>」。
2. 点（双击或单击）这个失效格子 → 岛内底部出现一行中文提示：「「文件名」已经不在了，可能被移走或删除。」右边有「从架子上移除」按钮。
3. 点「从架子上移除」→ 该条目立即从架子上消失，提示条同时收起；磁盘上的原文件不受影响（本来就已不在）。
4. 失效条目上的「在文件夹中显示」按钮变灰不可点，悬停提示「文件已不在，无法定位」。
5. 文件仍在时行为不变：双击照常打开；「在文件夹中显示」能真正打开资源管理器并选中文件（这是本次顺带修好的既有接线错误）。
6. 文件被放回原位置后，重新打开置物架页，失效标识消失，双击又能打开。

## 四、必要依赖

无新增依赖。只用 Node 内置 `node:fs` 的 `existsSync` 和已有 Electron API。

## 五、验收条件

- [ ] 架上有失效文件时，图标视图格子带 `missing` 标记并显示「失效」徽标；列表视图行内显示「已失效」，名字带删除线
- [ ] 失效条目的 `title` 为「文件已不在：<原路径>」，不再是裸路径
- [ ] 双击失效条目：不出现英文系统报错；底部出现「「文件名」已经不在了，可能被移走或删除。」
- [ ] 该提示条上有「从架子上移除」按钮，点击后条目消失、提示条消失、`shelf.json` 里对应条目被删除
- [ ] 失效条目的「在文件夹中显示」按钮为禁用状态，`title`/`aria-label` 说明原因
- [ ] 文件仍存在时：双击能打开；`shelfShowInFolder` 返回 `{ ok: true }` 且能定位到文件
- [ ] `npm run typecheck`、`npm run build` 通过
- [ ] `node scripts/e2e-shelf-missing.mjs` 通过
- [ ] 开发版真实启动一次，肉眼确认展开置物架页无白屏
- [ ] 重新打包并静默安装到 `D:\软件\灵动岛\` 后 `Get-Process 灵动岛` 有进程
- [ ] `%APPDATA%\lingdong-island\shelf.json` 里没有 `missing` 字段（状态不落盘）

## 六、不做什么

- 不做文件变化的后台实时监听（`fs.watch`/轮询定时扫描）——只在打开置物架页/列表刷新/点击时检查，避免常驻 IO。
- 不做「重新定位到新位置」（手选新路径）——那是另一个故事，成本高且与当前痛点无关。
- 不做自动删除失效条目——数据删除必须是用户主动动作。
- 不改 `shelf.json` 结构、不做数据迁移。
- 不顺手改无关功能；发现的其他问题只记录，不夹带。
- 不合并回 `main`、不 push（仓库无远端）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | `npm run typecheck` | 通过（typecheck:node + typecheck:web 均无输出、退出码 0） | — |
| 2026-11-05 | `npm run build` | 通过（out/main/index.js 23.25 kB、out/preload/index.js 4.61 kB、out/renderer 产物齐全） | — |
| 2026-11-05 | `node scripts/e2e-shelf-missing.mjs` | 通过（A1–A8 全过：missing 标记正确、`shelf.json` 未落 missing 字段、图标视图与列表视图标识与中文 title 正确、点击出中文提示条、一键移除后条目与提示消失、定位/打开失效条目返回 `reason:"missing"`） | 真实鼠标双击与物理拖拽未验证；e2e 结束后已把 `shelf.json` 还原 |
| 2026-11-05 | `node scripts/e2e-m4-drop.mjs`、`node scripts/e2e-m4.mjs` 回归 | 均通过（拖入即时刷新、去重、删单条、清空不崩） | 同上，均为 CDP 合成事件 |
| 2026-11-05 | `npm run dist`（走国内镜像）→ 静默安装 → 启动 | 安装包 `release\灵动岛 Setup 0.1.0.exe` 生成；安装后 `D:\软件\灵动岛\resources\app.asar` 时间戳 14:50:44；启动后 `Get-Process 灵动岛` 有 4 个进程（主进程 + 渲染/GPU 等子进程）；在安装版 asar 里检索到「已经不在了」「从架子上移除」「文件已不在」「shelf-badge-missing」四个新字符串 | 安装版界面未逐步点击（打包版没开 CDP），需用户肉眼确认 |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
|  |  |  |  | 待独立验收 |
