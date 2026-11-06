# SPEC-US-032 页面自定义

## 目标

用户能选择展开态显示哪几个页面、收起态显示哪几个状态组件，按自己用法裁剪岛的内容。原视频对应概念是「设置页·页面管理」的裁剪部分；本项目无设置页，入口放在右键/托盘菜单。

> 方案变更（2026-11-06 开发中）：SPEC 原定用 localStorage 承载偏好。实测发现 **file:// 来源的 localStorage 跨进程重启完全丢失**（SIGTERM 与优雅退出均复现，会话内有效），跨重启记忆必须落主进程文件。改为 `prefs.json` + IPC `prefs:get`/`prefs:set`（`src/main/prefsStore.ts`），新增文件。本 SPEC 其余按修订后方案理解。

## 修改范围

- `src/main/prefsStore.ts`（新增）：界面偏好存 `userData/prefs.json`，IPC `prefs:get` / `prefs:set`，含 `pagesCustom` 校验规整（页面索引 0..3 去重排序非空、收起态五键布尔过滤），不合法回落默认。
- `src/main/index.ts`：注册 `setupPrefsStore()`；`buildAppMenu()` 加「页面管理…」项，点击后 `webContents.send('island:manage-pages')`。
- `src/preload/index.ts`：`prefsGet()` / `prefsSet()` / `onManagePages(cb)`。
- `src/renderer/src/App.tsx`：`PagesCustom` 状态（默认全开，mount 后 IPC 回填，用户先操作则不覆盖）；PAGE_META 渲染按开关过滤；轮播只在保留页内循环；当前页被裁自动跳第一个保留页；收起态 5 个组件（岛仔/时钟/电量圈/网络/待办数字）按开关条件渲染（未读红点不可关）；「页面管理」面板（page 4，不进轮播，唯一入口是菜单）两组勾选 + 末页锁定 + 重置。
- `src/renderer/src/styles.css`：页面管理面板样式（复用现有面板类 + 少量新样式）。
- `scripts/e2e-pages-custom.mjs`：新增 e2e。

不改：todos/schedule 等数据文件、打包配置。

## 预期行为

1. 右键岛/托盘 → 「页面管理…」→ 岛展开并切到页面管理面板。
2. 面板两组勾选：「显示的页面」（待办/置物架/通知/日程）与「收起态组件」（岛仔/时钟/电量/Wi-Fi/待办数字），默认全开。
3. 取消勾选立即生效：被裁页面从顶部 tab 与轮播（左右箭头循环）中消失；被裁收起态组件消失；当前页被裁时跳到第一个保留页。
4. 至少保留 1 个页面、0 个组件均合法（全裁收起态 = 只剩岛仔背景，合法）。
5. 重启后记忆保留（prefs.json）；偏好文件不可用/内容非法时静默回默认全开。
6. 「重置为默认」按钮一键恢复全开。

## 必要依赖

无新依赖。Electron ipcRenderer.on / localStorage / 现有 React 状态。

## 验收条件

- [实测] typecheck / build 通过。
- [实测] e2e：入口跳转、勾选后 tab 消失、轮播跳过被裁页、收起态组件显隐、重启记忆（重读 localStorage）、重置按钮。
- [实测] 回归既有 e2e（collapsed-todo / schedule / todo-today / wifi / export）。
- [实测] 重新打包安装 + 4 进程存活。
- [实测] 用户实机验收通过后合并 main。

## 不做什么

- 不做完整设置页（原视频的左导航多页设置——本项目只有一个裁剪面板，扩展留给后续故事）。
- 不做拖拽排序页面顺序（tab 顺序固定）。
- 不裁剪展开态头部的常驻信息（迷你岛仔/时钟/电量圈——那是另一组组件，本次只裁收起态）。
- 不做数据导入导出（US-029 的备份不含此偏好，如实记录即可）。
- 不改岛尺寸/位置逻辑。

## 自检记录（2026-11-06）

- [实测] `npm run typecheck`（node + web）通过。
- [实测] `npm run build` 通过。
- [实测] `node scripts/e2e-pages-custom.mjs` 5 项全 PASS：P1 默认收起态有时钟 / P2 关掉时钟后收起态无时钟 / P3 裁掉日程页后圆点 3 个 / P4 从最后保留页往后翻回第一页 / P5 恢复默认后时钟回来。偏好注入方式：杀应用 → 离线直写 prefs.json → 重启（运行中经 CDP 写入再 reload 有竞态：CDP resolve 可能早于主进程写盘，不可靠）。
- [实测] 回归全过：e2e-wifi（5 项）/ e2e-collapsed-todo / e2e-schedule / e2e-todo-today / e2e-export。
- [实测] 重新打包安装 `D:\软件\灵动岛\`（14:37 目录时间戳）+ 启动 4 进程存活。
- [未验证 → 留给实机验收] 面板勾选/重置的 UI 交互：page4 只能从原生菜单「页面管理…」进入，CDP 无法自动化触发原生菜单；勾选对应的 IPC 与状态更新链路已被其它 e2e 路径覆盖。
- [未验证] 全裁收起态组件（只剩岛仔）极端组合的视觉效果。
- 备注：localStorage 方案按 SPEC 原计划开发完成后，实测跨重启丢失，全链排查后改 prefs.json 方案（见「方案变更」）。过程探针与诊断日志已全部清理，未进交付提交。