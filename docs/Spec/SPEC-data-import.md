# SPEC：数据导入（把导出的 JSON 备份合并回来）

- 建立日期：2026-11-27
- 任务分支：`data-import`（基线 `main` `83931f9`）
- 代码提交：`0bbd1e7`（自检针对该提交；其后仅文档改动）
- 来源：`docs/facts/功能清单.md:122` 与 `docs/facts/数据规则.md:53` 都明确记录「导入功能未实现」；`src/main/exportStore.ts:12` 也写明导出格式「将来做导入时可以直接按键拼回」。这是文档里唯一有据可查的功能缺口。

## 一、目标

补上 US-029 的另一半：用户拿到导出的 `灵动岛备份-*.json` 后，能在设置窗口里选这个文件，把**待办**与**日程**合并回本机，实现「换机器 / 重装后把数据带回来」。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/importStore.ts`（新建） | 读文件 → 校验 → 规范化 → 合并进两个 store；IPC `app:import-data` |
| `src/main/todoStore.ts` | 导出 `mergeTodos(list)`：按 id / 内容去重后追加并落盘，返回合并后全量 |
| `src/main/scheduleStore.ts` | 导出 `mergeSchedule(list)`：同上，**必须同时更新内存 `items`**（否则下一次 `schedule:add` 会用旧内存覆盖导入结果） |
| `src/main/index.ts` | `setupImportStore()` |
| `src/main/islandWindowRef.ts` | 无改动（复用已有 `sendToIsland`） |
| `src/preload/index.ts` | 暴露 `importData()`；新增 `onDataImported(cb)` 订阅；`ImportResult` 类型 |
| `src/renderer/src/settings/SettingsApp.tsx` | 「常规」分区「导出数据」行下加「导入数据」行 + 按钮 + 行内结果 |
| `src/renderer/src/App.tsx` | 订阅 `onDataImported`：重算收起态统计，并让已挂载的待办/日程面板重拉列表 |
| `scripts/e2e-import.mjs`（新建） | e2e：坏文件被拒、合并去重、重复导入幂等 |
| `docs/facts/数据规则.md` | 「导入功能未实现」改为已实现，写清合并策略 |
| `docs/facts/功能清单.md` | 第 10 条补导入行为 |
| `docs/facts/用户角色与用户故事.md` | US-029 现状补「导入已实现」 |

不改：导出格式（`version: 1` 保持不变）、`todos.json` / `schedule.json` 落盘结构、置物架与通知（与导出一致，不参与）。

## 三、预期行为

1. **入口**：设置窗口「常规」分区，「导出数据」行下方新增「导入数据」行，说明文字「从备份 JSON 合并待办和日程（不覆盖现有数据）」，按钮「导入…」。
2. **选文件**：主进程原生 `showOpenDialog`，默认目录「文档」，过滤器只认 `json`，模态挂发起调用的窗口（与导出同款 `BrowserWindow.fromWebContents(event.sender)`）。
3. **校验**（任一不满足即整体拒绝，不做部分导入）：
   - 能解析为 JSON 对象；
   - `app === 'lingdong-island'`；
   - `version === 1`（未来版本号不认，提示「备份版本不支持」）；
   - `todos`、`schedule` 至少有一个是数组（都缺则判无效）。
4. **规范化**（对每条逐字段，坏字段丢弃该条而非整份失败）：
   - 待办：`text` 非空字符串才保留；`id` 缺失或非字符串则生成新 id；`done` 转布尔；`createdAt` 非数字取当前时间。
   - 日程：`text` 非空；`day` 必须匹配 `YYYY-MM-DD`，否则落到今天；`time` 必须匹配 `HH:mm`，否则 `null`；`reminded` 一律置 `false`（导入的提醒不算数，避免导入瞬间弹一堆过期提醒）；`done`、`createdAt` 同待办。
5. **合并策略（默认合并，不覆盖）**：
   - 先按 `id` 去重：本机已有同 id 的条目，跳过（重复导入同一份备份不会翻倍）；
   - 再按内容指纹去重：待办指纹 `text`；日程指纹 `text|day|time`。本机已有相同指纹的跳过（换机器后 id 不同但内容相同的，不会重复）；
   - 其余追加到现有列表末尾。
6. **结果反馈**：返回 `{ ok, canceled?, added: {todos, schedule}, skipped: {todos, schedule}, reason?, detail? }`；设置窗口行内显示「已导入待办 N 条、日程 M 条（跳过重复 K 条）」，同时发一次系统通知。
7. **岛内即时刷新**：导入成功后主进程向岛窗口发 `data:imported`；岛收到后重算收起态统计，已挂载的待办/日程面板重拉列表（复用 `NotifyPanel` 的 `refreshTick` 模式，不重挂、不丢正在编辑的草稿）。
8. **取消 / 失败**：取消无副作用；文件不存在、无权限、坏 JSON → 返回 `reason: 'invalid' | 'failed'` 并给中文原因，不崩、不改任何数据。

## 四、必要依赖

无新增依赖。复用 Electron `dialog` / `Notification` / `ipcMain` 与 Node `fs`。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck` EXIT=0 |
| A2 | `npm run build` EXIT=0 |
| A3 | 导出一份真实备份 → 清空两个 store → 导入该文件 → 待办与日程条数、内容与导出时一致（`[实测]` 脚本核对，不靠目测） |
| A4 | 同一份备份连续导入两次：第二次 `added` 全为 0，`skipped` 等于第一次的 `added`（幂等） |
| A5 | 坏输入被拒且数据零改动：非 JSON 文本、`app` 不对、`version: 2`、`todos` 不是数组，四种各一次 |
| A6 | 字段规范化：`day` 非法落今天、`time` 非法落 null、`reminded` 强制 false、空 `text` 条目被丢弃 |
| A7 | 导入后岛内待办页与日程页列表立即反映新数据（无需重启） |
| A8 | 回归：`e2e-export`、`e2e-todo-today`、`e2e-schedule-day`、`e2e-schedule` 通过 |

## 六、不做什么

- **不做「替换 / 清空后导入」模式**：只做合并，避免一个手滑删光用户现有数据。要清空有独立入口。
- 不导入置物架、通知、图标缓存、歌词缓存、界面偏好（与导出范围对称；置物架存本机绝对路径，换机器必失效）。
- 不做自动备份、定时备份、云端同步。
- 不做导入前的预览确认弹窗（结果用行内文字 + 系统通知说明；如需预览另开 SPEC）。
- 不改导出格式、不改 `todos.json` / `schedule.json` 结构。
- 不合并 `main`、不打包、不推送。

## 七、自检记录

自检日期：2026-11-27。分支 `data-import`。

| 验收项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| A1 | `npm run typecheck` | **通过** | `typecheck:node` 与 `typecheck:web` 均无输出，EXIT=0 |
| A2 | `npm run build` | **通过** | `✓ built in 150ms`，EXIT=0 |
| A3 | `node scripts/e2e-import.mjs` I1 | **通过** | 空库导入合法备份：added 待办 2 / 日程 2；落盘条数与内容一致，日程 `day`/`time` 保留 |
| A4 | 同上 I2 + I6 | **通过** | I2 同一份再导入：added 全 0，skipped 待办 2 / 日程 2，落盘总数不变（幂等）；I6 换新 id 但内容相同也跳过（added 0 / skipped 1），覆盖「跨机器 id 不同」场景 |
| A5 | 同上 I3 | **通过** | 非 JSON 文本 / `app` 不对 / `version: 2` / `todos` 不是数组，四种均 `reason='invalid'`，且导入前后条数不变 |
| A6 | 同上 I4 | **通过** | 空 `text` 丢弃、`text` 去空格、`done` 转布尔、`createdAt` 非法取数字、`day` 非法落今天、`time` 非法落 null、`reminded` 强制 false |
| A7 | 同上 I5 | **通过** | 停在待办页时导入：`.todo-item` 条数当场 +1，新条目文字出现在 DOM，无需重启/重开面板 |
| A8 | `e2e-export` / `e2e-todo-today` / `e2e-schedule-day` / `e2e-schedule` | **通过** | export PASS；todo-today PASS；schedule-day PASS；schedule PASS |

**e2e 汇总**：`e2e-import` 30 过 / 0 败（I1–I6）。

**负对照（验证 I5 有判别力）**：临时注释掉 `App.tsx` 里 `setDataTick((t) => t + 1)` 后重跑，I5 两条从 ✅ 变 ❌（`5 → 5`、`false`），其余仍过；恢复后全过。说明 I5 真的在测「导入触发刷新」而不是恒真。

### 未验证项

1. **原生「打开」对话框本身没走过**：e2e 用 `ISLAND_IMPORT_PATH` 跳过对话框。真实用户点「导入…」弹框、选文件、取消这些交互只做了代码核对，未在真机上点过 [未验证]。
2. **系统通知未核对**：导入成功/失败会发 Electron Notification，e2e 环境未断言通知是否弹出（与 `e2e-export` 同样的限制）。
3. **多显示器 / 高 DPI 下设置窗口新增一行未截图**：只验证了功能与行内文案，没做视觉核对 [未验证]。

### 结论

功能完整、四条验收主线（A1–A8）全部实测通过，负对照证明刷新断言有判别力。**未合并 `main`、未打包、未推送**——按规则这三项需单独授权。
