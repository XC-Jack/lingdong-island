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
