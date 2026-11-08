# SPEC 美化-02 收起态组件自由排序与显隐

- 建立日期：2026-11-08
- 对应基线提交：`b10d229`（main HEAD）
- 任务分支：`beautify-02-collapse-order`
- 关联用户故事：US-032 页面自定义（已有显隐能力，本轮补排序 + 铃铛纳入）
- 关联事实文档：[`../facts/功能清单.md`](../facts/功能清单.md) 第 11 节「页面自定义」、第 5 节「收起态状态栏」

## 一、目标

收起态（黑色胶囊）上显示的组件由用户自己决定：**显示哪些**、**按什么顺序排**。

现状差距（[实测] 读 `src/renderer/src/App.tsx:2453-2521`）：
- 显隐：已经有（US-032，页面管理面板里 5 个勾选框），本轮不重做。
- 顺序：**写死在 JSX 里**（电量 → 岛仔 → 时钟 → 网络 → 待办），用户无法调整。
- 铃铛：**不参与勾选**，只要有未读就强制显示。

用户 2026-11-08 原话：「就是岛上面的组件，例如时间，wifi等，我可以自主调换位置，还可以选择显示哪个哪个不显示」；
并确认「铃铛也加入（推荐）」。

## 二、修改范围

改动文件：

| 文件 | 改什么 |
|---|---|
| `src/renderer/src/App.tsx` | `CollapsedKey` 增加 `bell`；`PagesCustom` 增加 `order: CollapsedKey[]`；`defaultPagesCustom()` 补默认顺序；`normalizePagesCustom()` 校验顺序（去重、补全缺失项）；`COLLAPSED_LABELS` 加铃铛；`PageManagerPanel` 的「收起态组件」区改成可拖动排序（插入语义 + 落点提示）；收起态渲染由写死 JSX 改为按 `order` 顺序遍历 |
| `src/renderer/src/styles.css` | 新增 `.pm-drop-before` / `.pm-drop-after` 落点提示线（伪元素，不改行高） |
| `src/main/prefsStore.ts` | 同步 `normalizePagesCustom`：加 `bell`、加 `order` 校验与落盘，保持与渲染层一致 |
| `src/preload/index.ts` | `PagesCustom` 类型同步（`collapsed` 加 `bell`，新增 `order`） |
| `scripts/e2e-collapse-order.mjs` | 新建：排序 + 铃铛开关 + 旧偏好兼容 |
| `docs/facts/功能清单.md` | 第 11 节补一句「收起态组件可拖动排序、铃铛可关」 |

**不动**：
- 展开态面板（`panel-head` 里的迷你岛仔/时钟/电量圈）保持固定顺序，不跟随排序。
- 页面轮播顺序、页面显隐逻辑（US-032 原有部分）。
- 各组件自身的样式与数据来源。
- 铃铛「有未读才出现」的语义：勾着铃铛但无未读时仍然不显示。
- 岛窗口在屏幕上的位置（贴顶居中）——用户本次说的「换位置」已确认指胶囊内组件。

## 三、预期行为

1. 右键岛（或托盘右键）→「页面管理…」→ 面板里「收起态组件」区列出 6 项：岛仔、时钟、电量圈、网络图标、待办数字、通知铃铛。
2. **显隐**：每项前面的勾选框控制收起态是否显示；取消勾选立即从胶囊上消失，勾上立即出现（有数据的前提下）。
3. **排序（插入语义）**：按住任意一行拖到目标行上方松手——落在目标行**上半**就插到它前面，落在**下半**就插到它后面，其余组件顺移（不是两两互换）。拖动时目标行上/下边缘出现一条绿线提示落点。胶囊上的组件顺序立刻跟着变。
   - 变更说明（2026-11-08 验收反馈）：首版实现的是「互换」，用户实测后要求改成「插空放」，本 SPEC 按插入语义修订。
4. **铃铛**：默认勾选。勾选且有未读 → 显示白铃铛 + 红点；勾选但无未读 → 不显示；取消勾选 → 有未读也不显示。
5. **持久化**：顺序与勾选写进 `%APPDATA%\lingdong-island\prefs.json` 的 `pagesCustom.order` / `pagesCustom.collapsed`，重启后保持。
6. **旧偏好兼容**：升级前已有的 `prefs.json`（只有 5 个 `collapsed` 键、没有 `order`）读入后回落为默认顺序 `电量 → 岛仔 → 时钟 → 网络 → 待办 → 铃铛`，铃铛按「开启」处理，用户此前的勾选状态不丢。
7. **重置为默认**：点「重置为默认」恢复全开 + 默认顺序。

## 四、必要依赖

无新依赖。沿用 `prefs.json`（IPC `prefs:get` / `prefs:set`）与 React 现有拖拽写法，不引入拖拽库。

## 五、验收条件

- [ ] e2e-collapse-order：R1 离线写 `order: ['bell','clock','net','battery','pet','todo']` 启动后，收起态 DOM 顺序与之一致（`.collapsed-bell` 在最前、`.collapsed-todo` 在最后）。
- [ ] e2e-collapse-order：R2 旧格式 prefs（`collapsed` 只有 5 个键、无 `order`）启动后不崩，顺序为默认，`collapsed.bell` 视为开启。
- [ ] e2e-collapse-order：R3 `collapsed.bell=false` 且有未读时，收起态不渲染 `.collapsed-bell`；改回 `true` 后渲染。
- [ ] e2e-collapse-order：R4 面板里「收起态组件」区有 6 行，铃铛一份。
- [ ] e2e-collapse-order：R5 面板拖动为**插入**语义——拖到目标行上半插到其前、下半插到其后，断言整条 `order` 数组（中间项会顺移）且不等于互换结果；长度恒为 6、无重复；拖自身不改变。
- [ ] 回归 e2e：`e2e-pages-custom`、`e2e-collapse-beautify`、`e2e-collapsed-todo`、`e2e-shelf-view-pref` 全 PASS。
- [ ] `npm run typecheck` / `npm run build` PASS。
- [ ] 打包装机，`D:\软件\灵动岛\` 下 4 进程存活，用户实机可在面板里拖动换位并看到胶囊顺序变化。

## 六、不做什么

- 不做自由拖拽岛窗口到屏幕任意位置 / 左右预设位置（用户本次已确认不是这个意思；真要做得另开 SPEC，涉及主进程窗口定位与多显示器）。
- 不改展开态头部（迷你岛仔 + 时钟 + 电量）的顺序。
- 不把面板上半部分「页面」区的拖动也从互换改成插入——用户只反馈了收起态组件区的语义，页面区维持既有互换（要改另开 SPEC）。
- 不加新组件类型（倒计时、歌词、天气等），只整理现有 6 个。
- 不改 prefs.json 的存储通道与文件名。
- 不做收起态「至少保留一个组件」的限制（维持现状：允许全关，胶囊变空条）。
- 不修本轮顺手发现但与排序无关的问题。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-08 | `npm run typecheck`（node + web 两套 tsconfig） | PASS，无输出即无错 | — |
| 2026-11-08 | `npm run build`（electron-vite） | PASS，产出 `out/renderer/assets/index-C5hVss3o.js` 664.40 kB（插入语义版） | — |
| 2026-11-08 | `node scripts/e2e-collapse-order.mjs`（新增，**22 条断言**，按插入语义修订后重跑） | **PASS 22/0**：R1 自定义 order 生效；R2a-d 旧偏好（无 `order`、`collapsed` 只有 5 键）补全默认顺序且 `bell` 视为 true；R3a-d 铃铛开关正反对照；R4a-c 面板 6 行/含「通知铃铛」/行序 = order；R5a-j 拖动插入——悬停上半出现 `pm-drop-before` 提示、插入后 order = `['battery','pet','todo','clock','net','bell']`（`net` 顺移，证明不是互换）、悬停下半出现 `pm-drop-after`、插入后 order = `['battery','bell','pet','todo','clock','net']`、长度 6 无重复、拖自身不改变、收岛后视觉顺序同步 | 本机通知库为空时 R3a 会失败（该条依赖真实未读）；本轮跑时库里有未读，通过 |
| 2026-11-08 | 回归 `node scripts/e2e-pages-custom.mjs` | PASS 6/6（页面显隐、页面顺序持久化未受影响） | — |
| 2026-11-08 | 回归 `node scripts/e2e-collapse-beautify.mjs` | PASS 7/0（美化-01 铃铛形态、电量在岛仔前仍在） | — |
| 2026-11-08 | 回归 `node scripts/e2e-collapsed-todo.mjs` | PASS（待办数字出现/消失/收回刷新、DOM 几何顺序） | — |
| 2026-11-08 | 回归 `node scripts/e2e-shelf-view-pref.mjs` | PASS（A6 拍到 `pagesCustom` 已含 `order` 且值与默认一致） | — |
| 2026-11-08 | 面板几何探针 `.tmp/probe-panel-geom.mjs` | 6 行组件后 `.pm-panel` 无溢出（scrollHeight 263 = clientHeight 263），`.pm-reset` / `.pm-close` 完整落在岛体 0~379 内，未回归 US-032「按钮点不到」 | 仅 1280×720 主显示器下测过一次，高 DPI 缩放未验证 |
| 2026-11-08 | 面板打开方式验证（`.tmp/probe-main-inspect.mjs`） | 主进程 `--inspect=9229` + `webContents.send('island:manage-pages')` 可打开面板；**Runtime.evaluate 必须带 `includeCommandLineAPI:true`**，否则 `require is not defined` | 依赖 `--inspect` 参数，正式包不带该参数（仅 e2e 用） |

| 2026-11-08 | 收起态宽度探针 `.tmp/probe-collapsed-width.mjs`（6 个组件全开 + 造 1 条待办 + 造未读，让 6 个都渲染） | 岛宽 207px，6 个组件占 x=18…191，**右侧仍余 16px 未溢出**，无裁切 | 仅 1280×720 / 100% 缩放测过一次；高 DPI 或多显示器未验证 |

| 2026-11-08 | 打包装机：`npm run dist`（走 npmmirror 镜像）→ 静默装到 `D:\软件\灵动岛\` → 启动 | 安装版 `app.asar` 15:26 生成，与本次构建一致；启动后 `灵动岛` 4 进程存活 | — |
| 2026-11-08 | **安装版运行时验证**（`.tmp/probe-installed.mjs`，直接起 `D:\软件\灵动岛\灵动岛.exe` 开 CDP 9321） | PASS：写 `order: ['bell','clock','net','battery','pet','todo']` 后，安装版收起态实测顺序完全一致 → 代码确实进了安装包且能跑 | 只验了排序生效；拖动交互仍需真人手动拖 |

| 2026-11-08 | **安装版插入语义运行时验证**（`.tmp/probe-installed-insert.mjs`，起 `D:\软件\灵动岛\灵动岛.exe` + CDP 9321 + 主进程 inspect 9229） | **PASS 6/0**：安装版能开面板（6 行）；拖动前 order 为默认；悬停上半出现 `pm-drop-before` 提示线；松手后 `prefs.json` order = `['battery','pet','todo','clock','net','bell']`（插入，`net` 顺移），且 ≠ 互换结果 → 插入语义确实进了安装包并能跑 | 合成 `DragEvent`，未用物理鼠标；高 DPI 未验证 |

尚未验证：真实鼠标拖动（e2e 用 `DragEvent` 合成事件，不是物理鼠标位移动画，最终仍需用户手动拖一次确认手感）；高 DPI 缩放下的胶囊宽度余量（见上，100% 缩放下余 16px，125%/150% 时组件会等比放大，可能挤压，未验证）。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| | | | | |
