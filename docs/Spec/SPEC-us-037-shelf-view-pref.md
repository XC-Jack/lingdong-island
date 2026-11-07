# SPEC：US-037 置物架视图记忆迁移到 prefs.json（修跨重启丢失）

## 一、目标

置物架的视图偏好（大图标/中图标/小图标/列表四选一）目前存在渲染层 localStorage，
而本机实测 file:// 来源的 localStorage 跨进程重启会丢失（2026-11-06 实测记录于
docs/facts/本机约束与踩坑.md:52）——用户选好的视图在重启后变回默认「大图标」。
本次把它迁移到主进程 `userData/prefs.json`（US-032 已建的 IPC 通道），
使视图选择跨重启保留。

## 二、修改范围

- `src/main/prefsStore.ts`：`PrefsShape` 增加 `shelfView?: string` 字段；
  新增 `normalizeShelfView()`（只认 `'lg'|'md'|'sm'|'list'` 四值）；
  `load()` 规整该字段；`prefs:set` 支持只传 `shelfView` 的部分更新（与
  pagesCustom 互不覆盖）。
- `src/preload/index.ts`：`PrefsShape` 同步加 `shelfView?: string`
  （App.tsx 从这里 import 该类型）。
- `src/renderer/src/App.tsx`：删掉 `SHELF_VIEW_KEY`/`loadShelfView`/
  `saveShelfView`（localStorage 版）；置物架组件初始 `view` 由
  `useState<ShelfView>('lg')` 起步，挂载后 `prefsGet()` 读回并 `setView`；
  切换视图时 `prefsSet({ shelfView: v })` 写入（fire-and-forget，不等返回）。
- `docs/facts/功能清单.md`：US-034 条目补一句「视图记忆已迁移 prefs.json
  （US-037），localStorage 版跨重启会丢已废弃」。
- `docs/facts/本机约束与踩坑.md:52`：把「US-035 置物架视图记忆仍用
  localStorage（待另开故事修）」更新为已修复。

## 三、预期行为

- 切换置物架视图 → 立即生效（UI 行为不变）并写入 prefs.json。
- 重启灵动岛 → 置物架自动恢复上次选的视图。
- prefs.json 里没有 shelfView（首次/手工删掉）→ 默认「大图标」，无报错。
- prefs.json 里 shelfView 值非法（手工改坏）→ 回落「大图标」，且下次写入
  自动修正。
- 页面管理（pagesCustom）与视图记忆互不干扰：写 shelfView 不清掉
  pagesCustom，反之亦然。

## 四、必要依赖

无新增依赖。复用现有 `prefs:get`/`prefs:set` IPC 与 `prefs.json` 文件。

## 五、验收条件

1. typecheck / build 通过。
2. e2e（新增 `scripts/e2e-shelf-view-pref.mjs` 或并入现有 shelf e2e）：
   - 切到「列表」视图 → 重启进程 → 断言恢复「列表」；
   - 断言 prefs.json 出现 `"shelfView": "list"`。
3. 回归：现有 shelf 相关 e2e（e2e-shelf-missing、e2e-exit-and-shelf-view）
   与关键套件（collapsed-todo、wifi）全过。
4. 安装版重装后实机：切视图 → 重启 → 视图保留（用户验收）。

## 六、不做什么

- 不做通知页偏好、其他界面偏好的同类迁移（它们已走 prefs.json 或无需迁移）。
- 不做 localStorage 数据迁移读回（旧值本来跨重启就丢，没有可迁移的数据）。
- 不改视图切换的 UI 与交互。
- 不动置物架其余功能（拖放、失效提示、排列）。

## 七、自检记录（2026-11-07，分支 us-037-shelf-view-pref）

跑了什么、结果如何（全部 [实测]）：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS（首跑报 setView 跨组件引用，已改到 ShelfPanel 内回填后过） |
| `npm run build` | PASS |
| `node scripts/e2e-shelf-view-pref.mjs`（新增，6 项） | PASS：A1 默认 lg 且不写 prefs.json / A2 选列表落盘 list / A3 重载恢复 list / A4 改 sm 落盘恢复 / A5 值改坏回落 lg 不白屏 / A6 切视图不动 pagesCustom |
| `node scripts/e2e-exit-and-shelf-view.mjs`（改造：localStorage 断言改读 prefs.json） | PASS（A1~A5 + A6 退出真验证） |
| 回归 e2e-pages-custom / e2e-shelf-missing / e2e-collapsed-todo / e2e-wifi | 全 PASS |
| 打包 `npm run dist` + 静默安装到 D:\软件\灵动岛\ | app.asar 13:38:18，4 进程存活 |

开发中发现并顺手处理：

- e2e-exit-and-shelf-view.mjs 原断言 localStorage 落盘——新实现已不走 localStorage，脚本同步改造为断言 prefs.json（视图持久化完整断言在 e2e-shelf-view-pref.mjs）。
- 新踩坑两条：①JS try 块里声明的 const 在 finally 里不可见（块级作用域），备份变量必须提到 try 外；②e2e 中途挂掉会把测试值残留进 prefs.json 污染后续运行——还原动作必须放 finally 且备份在进程启动时读。

未验证（留用户实机验收）：

- [未验证] 安装版真实点「视图菜单→列表」→ 右键退出 → 重开是否仍是列表（e2e 用 reload 模拟重启，真实跨进程退出只验证了 quitApp 接口本身）。
- [未验证] 用户原有 localStorage 旧值（若有）不迁移——按设计直接回落默认大图标。

提交：`ff53d44`（SPEC）→ `62a14e8`（代码 + e2e）。
