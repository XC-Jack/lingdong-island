# SPEC-US-032 页面自定义

## 目标

用户能选择展开态显示哪几个页面、收起态显示哪几个状态组件，按自己用法裁剪岛的内容。原视频对应概念是「设置页·页面管理」的裁剪部分；本项目无设置页，入口放在右键/托盘菜单。

## 修改范围

- `src/renderer/src/App.tsx`：新增「页面管理」面板（page 4，不进 PAGE_META 轮播，或进 meta 但可被裁剪逻辑排除）；两组勾选 UI；`pages-custom` localStorage 键读写（沿用 SHELF_VIEW_KEY 的容错写法）；PAGE_META 渲染按开关过滤；收起态 5 个组件（岛仔/时钟/电量圈/Wi-Fi/待办数字）按开关条件渲染。
- `src/preload/index.ts`：`onManagePages(cb)` 监听入口（或复用现有模式加一个 ipcRenderer.on）。
- `src/main/index.ts`：`buildAppMenu()` 加「页面管理…」项，点击后 `webContents.send('island:manage-pages')`。
- `src/renderer/src/styles.css`：页面管理面板样式（复用现有面板类 + 少量新样式）。
- `scripts/e2e-pages-custom.mjs`：新增 e2e。

不改：数据文件（localStorage 承载，不新增 json）、主进程 store、打包配置。

## 预期行为

1. 右键岛/托盘 → 「页面管理…」→ 岛展开并切到页面管理面板。
2. 面板两组勾选：「显示的页面」（待办/置物架/通知/日程）与「收起态组件」（岛仔/时钟/电量/Wi-Fi/待办数字），默认全开。
3. 取消勾选立即生效：被裁页面从顶部 tab 与轮播（左右箭头循环）中消失；被裁收起态组件消失；当前页被裁时跳到第一个保留页。
4. 至少保留 1 个页面、0 个组件均合法（全裁收起态 = 只剩岛仔背景，合法）。
5. 重启后记忆保留（localStorage）；localStorage 不可用时静默回默认全开。
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

## 自检记录

（开发完成后填）