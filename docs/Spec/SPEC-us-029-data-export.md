# SPEC — US-029 数据导出（备份待办与日程）

> 用户故事：作为用户本人，我想要能备份/导出我的待办和日程，以便换机器或重装不丢。（P2，`docs/facts/用户角色与用户故事.md:215`）

## 一、目标

给用户一条「把我的数据拿走」的路：在应用里点一下，把**全部待办**和**全部日程**导出成一个 JSON 文件，存到用户自己选的位置。换机器或重装后，靠这个文件可以把数据带回来。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/exportStore.ts`（新建） | 导出/导入主进程逻辑：读 todos.json + schedule.json 组装导出对象；`dialog.showSaveDialog` 选保存位置；写文件 |
| `src/main/index.ts` | import exportStore；`setupExportStore()`；`buildAppMenu()` 加「导出数据…」菜单项；新增 `app:export-data` IPC |
| `src/preload/index.ts` | 暴露 `exportData()`（返回 `{ok, canceled?, path?, reason?, detail?}`） |
| `src/renderer/src/App.tsx` | 无改动（入口在右键/托盘菜单，主进程原生弹窗，渲染层不参与） |
| `scripts/e2e-export.mjs`（新建） | e2e：验证导出 IPC 返回结构与落盘文件内容 |
| `docs/facts/数据规则.md` | 「什么情况下数据会丢」表更新：有导出功能了 |
| `docs/facts/用户角色与用户故事.md` | US-029 现状改「已实现（待验收）」 |
| `docs/facts/功能清单.md` | 新增导出功能条目 |

不改：todoStore / scheduleStore / statusStore / shelfStore / notifyStore 的现有逻辑；不导入（先只做导出，导入另开 SPEC）；不做自动备份/定时备份。

## 三、预期行为

1. **入口**：岛内右键或托盘右键，菜单第一项「导出数据…」（原「退出灵动岛」保留在最后）。点击后弹 Windows 原生「另存为」对话框。
2. **默认文件名**：`灵动岛备份-YYYYMMDD-HHmmss.json`，默认目录取系统「文档」文件夹。
3. **导出内容**（一个 JSON，UTF-8，缩进 2）：
   ```json
   {
     "app": "lingdong-island",
     "version": 1,
     "exportedAt": "2026-11-06T12:00:00.000+08:00",
     "todos": [{ "id": "...", "text": "...", "done": false, "createdAt": 1730000000000 }],
     "schedule": [{ "id": "...", "text": "...", "day": "2026-11-06", "time": "09:00", "done": false, "reminded": false, "createdAt": 1730000000000 }]
   }
   ```
   - 数据直接读 `userData` 下的 `todos.json` / `schedule.json`（内存 items，不重新读盘，主进程 store 持有最新值——实际通过现有 store 模块导出 getter 或直接读文件，选实现时定）。
   - 不含：置物架（存的是文件绝对路径，换机器路径必失效，导出无意义）、通知（只读外部系统库）、已读记录。
4. **成功反馈**：写盘成功后弹一次系统通知（Electron Notification）：「已导出到 <路径>」。
5. **取消**：对话框点取消 → 什么都不发生，无报错。
6. **失败**：写盘失败（目录只读、盘满等）→ 弹通知「导出失败：<原因>」，不崩进程。
7. 导出的 JSON 里 `todos` / `schedule` 键名与 `todos.json` / `schedule.json` 各自内部数组键一致，且条目字段就是 store 原样字段（不加工），保证将来导入可以做「键值对拼回」。

## 四、必要依赖

- 无新依赖。用 Electron 自带 `dialog`、`Notification`、`ipcMain` 与 Node `fs`。

## 五、验收条件

1. 展开态/收起态右键岛（或托盘图标），菜单出现「导出数据…」，点它弹「另存为」。
2. 保存后所选位置出现 JSON 文件，内容含 `app`/`version`/`exportedAt`/`todos`/`schedule` 五个键；`todos` 与 `%APPDATA%\lingdong-island\todos.json` 的 `todos` 数组一致，`schedule` 同理。
3. 点取消无副作用。
4. 现有功能回归不受影响（右键菜单「退出灵动岛」仍在、待办/日程页正常）。
5. typecheck / build / e2e-export / 既有 e2e 回归全过。

## 六、不做什么

- **不做导入**（恢复）：本故事只解决「数据拿得走」；导入涉及重复条目合并策略（按 id 还是按内容去重），另开 SPEC 单独做。
- 不导出置物架、通知、图标缓存。
- 不做自动备份、定时备份、多份历史版本。
- 不做云端同步。
- 不加设置页；入口只用右键/托盘菜单。
- 不改数据存储格式本身（`todos.json` / `schedule.json` 原样不动）。

## 自检记录

2026-11-06，全部 [实测]：

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（node + web） | ✅ 通过 |
| `npm run build` | ✅ 通过 |
| `scripts/e2e-export.mjs`（E1 真实 IPC 弹对话框→ESC 取消分支；E2 渲染层 todos/schedule 通道） | ✅ PASS |
| `scripts/verify-export-payload.mjs`（离线 payload 组装：五键、字段一致、本地时区 ISO、缺文件/坏 JSON 防御） | ✅ PASS |
| `scripts/probe-export-write.mjs`（真实 userData 种子 2 条 → 组装 → 写盘 → 读回比对 → 清理） | ✅ PASS，清理后 todos/schedule 均空 |
| 回归：e2e-wifi 5 项 / e2e-collapsed-todo 6 项 / e2e-schedule 5 项 / e2e-todo-today 10 项 | ✅ 全 PASS |
| 重新打包 `npm run dist` + 静默安装 `/S /D=D:\软件\灵动岛\` + 启动 | ✅ 4 进程存活（13:14） |

**未验证**：
- 真实点「另存为」选目录保存成功的完整人工路径（自动化只验证了取消分支 + 探针直接落盘；对话框里的真实点击只有用户能做）。
- 系统通知的实际弹出（notifyResult 走 Electron Notification，自动化环境未观测）。
- 无待办无日程时点导出（reason='empty' 分支代码路径未实跑）。

**踩坑**：contextBridge 的 promise 链里嵌套第二个 `window.island.*` 调用，CDP evaluate(awaitPromise) 返回 {}（跨世界对象序列化失败）——e2e/探针里每个 IPC 单独一次 CDP 往返。
