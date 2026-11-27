# SPEC：组件网格拖动换位

- 建立日期：2026-11-27
- 基线：`main` `d37fbcf`（0.6.2 发布记录）
- 任务分支：`widget-drag`
- 背景：用户 2026-11-27 原话「我在设置里面随便一东（动），面板就乱了，我希望我鼠标长按某个组件的时候可以拖动它，然后随意摆放位置」。截图显示：设置里把「通知」拖到第一位后，岛上的组件网格出现空洞——「通知」右边空一格，「置物架」被挤到最后一行单独一个。

## 一、目标

1. 在**岛上的组件网格**里，鼠标**按住任意一张组件卡并移动**即可拖动（不用先等长按），松手落到另一张卡上就换到它那一位；顺序立刻写进 `prefs.json` 的 `pagesCustom.pages`。按下后不移动、直接松手仍是点击，打开该组件页。
2. 设置窗口「页面管理」的页面列表读的是同一个字段，两处顺序天然同步，不需要额外迁移。
3. 网格永远排满、不再出现「中间空一格」：**五张卡尺寸统一**（音乐卡不再横跨两列）。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | 组件网格卡片加 Pointer 拖拽（按下 / 移动 / 结束 / 取消）；移动超过 6 屏幕 px 即起拖，不设长按等待；拖动期间不自动收起；拖完吞掉紧随的 click，避免误开页面；换位后写 `prefsSet({pagesCustom})` |
| `src/renderer/src/styles.css` | 删掉 `.widget.wide` 及其派生规则（音乐卡改成普通卡）；新增 `.wg-dragging` / `.wg-reflow` 拖拽态；`.island.expanded.view-grid` 高度随新的三行布局调整 |
| `docs/facts/视觉设计规范.md` | 组件首页一节：五卡等大、网格高度、拖动交互 |
| `docs/facts/功能清单.md` | 页面管理一节补「岛上网格也能拖动排序」 |
| `scripts/e2e-widget-drag.mjs` | 新增：驱动同一条指针事件链验证换位 + 写盘 + 重启后保持 |
| `docs/状态.md` | 本轮交付记录 |

## 三、预期行为

1. 展开岛 → 组件网格 → 在任意卡片上按下鼠标并移动（超过 6 屏幕 px），卡片抬起（放大 4%、带投影）并跟着光标走，其余卡实时滑开让位。
2. 松手：被拖的卡占住光标所在的那一格，其余卡顺移；顺序立即写盘，设置窗口「页面管理」里的页面列表同步变成新顺序。
3. 松手后不会顺带打开该组件页面。
4. 按下后不移动就松手（不论按多久）→ 按普通点击处理，照常打开对应页面。
5. 拖到网格外松手 → 不换位，卡片回到原位。
6. 拖动期间岛不会因为光标移出窗口而自动收起；Esc 取消本次拖动。
7. 四套主题下拖拽态都可见（只用 token 与半透明黑投影）。

## 四、必要依赖

无新增依赖。用 Pointer Events（`setPointerCapture`）+ 现有 `prefsSet` IPC。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2 网格内五张卡等大、三行排布无空洞；岛高不裁内容（截图核对四套主题）。
- A3 拖动换位后，`%APPDATA%\lingdong-island\prefs.json` 的 `pagesCustom.pages` 为新顺序。
- A4 重启应用后顺序保持；设置窗口「页面管理」列表顺序一致。
- A5 按下不动就松手仍能打开对应页面（拖动不抢点击）。
- A6 回归：`e2e-pages-custom`、`e2e-head-order`、`e2e-todo-today`、`e2e-collapse-order` 通过。
- A7 用户在本机预览版看过并认可。

## 六、不做什么

- 不做拖到网格外变成「删除/隐藏该页」。
- 不做设置窗口列表的拖拽语义改动（仍是插入语义，不动）。
- 不改收起态组件（`pagesCustom.order`）的排序与拖拽。
- 不做触摸/触屏适配（本机是鼠标场景）。
- 不打包、不升版本号、不合并 `main`（等用户确认效果）。

## 七、自检记录

### 7.1 实际改了什么（[实测]，2026-11-27）

| 类别 | 改动 |
| --- | --- |
| 卡片布局 | 删掉 `.widget.wide` 与 `[data-theme='glass-clear'] .widget.wide` 系列规则，五张卡等大；`App.tsx` 去掉 `i === 4 ? 'wide' : ''` |
| 网格高度 | `.island.expanded.view-grid` 330 → 362；透明玻璃另加 386（实测卡片 88 vs 96 布局高） |
| 拖拽 | `App.tsx` 加 Pointer Events 拖动（`GRID_DRAG_SLOP = 6` 屏幕 px 起拖，无长按等待）、被拖卡跟手位移、其余卡按预览顺序让位、松手写 `prefsSet` |
| 拖动态样式 | `.widget.wg-dragging`（浮起 + 不透明底 `--bg-pop`）、`.wg-body.wg-reflow`（其余卡 160ms 滑开） |
| 收起保护 | `scheduleCollapse` 在拖动中放弃收起；松手后按 hover 状态补排一次；Esc 取消拖动而非收岛 |
| e2e | 新增 `scripts/e2e-widget-drag.mjs`（17 项） |
| 文档 | `docs/facts/视觉设计规范.md` 组件首页一节、`docs/facts/功能清单.md` 页面管理一节、本 SPEC、`docs/状态.md` |

### 7.2 跑了什么（[实测]）

- `npm run typecheck`：node + web 均 EXIT=0。
- `npm run build`：electron-vite 构建成功。
- `node scripts/e2e-widget-drag.mjs`：**17 项全 PASS**（D1a–D1d 五卡等大/三行、D2a 不裁内容、D3a–D3d 按下移动即起拖/让位/跟手、D4a–D4d 换位/落点/不误开页面/写盘、D5 短按开页面、D6a–D6b 按住不动不换位、D7 重启保持）。
- `.tmp/probe-drag-perf.mjs`（帧率探针）：约 105 帧样本、47 次指针事件，中位 16.7ms / p95 16.8ms / 最大 16.9ms，**超 32ms 的帧 0 个、长任务 0 个**。
- `.tmp/probe-drag-edge.mjs`（边界探针）：拖到窗口外松手 / 拖动中 Esc / 拖动中岛收起 / 连续快拖 10 次，四种情况残留 transform 均为 0、`.wg-dragging` 均为 0、页面异常 0。
- 回归：`e2e-pages-custom` 7/0、`e2e-head-order` 14/0、`e2e-todo-today` PASS、`e2e-collapse-order` 22/0。
- 四套主题截图（`.tmp/widget-drag/grid-*.png`）+ 拖动态 / 松手态截图，网格均排满无空洞、最后一行未被裁。

### 7.3 没验证的

- 真实鼠标拖动的手感（CDP 派发的是合成指针事件，6px 阈值在真人手里的实际感受要试过才知道）。
- 触屏 / 触控板手势、高 DPI 缩放下的位移折算。
- 独立验收（按工程规则第三节第 5 条留待批量验收）。

### 7.4 过程中的两次返工（[实测]，留作证据）

1. 第一版用 `elementFromPoint` 判落点：被拖的卡带 transform 跟光标走，命中测试永远返回它自己，落点始终为 null。改成「拖动开始时快照各卡矩形、按槽位判断」。
2. 第一版把虚线框画在目标卡上：目标卡被拖着的卡盖住，只露出底边一小条（截图可见）。最终改成 iOS 主屏式「其余卡实时让位」，不再需要落点标记。

### 7.5 一个真 bug（[实测]，已修）

`onWidgetPointerUp` 里先调 `endGridDrag()`（它把 `gridDragMoved.current` 清零）再判断「是否移动过」，导致每次都被判成「长按没动」而提前返回、永远不换位。e2e 的 D4a 抓到了（顺序没变）。改成在 `endGridDrag()` 之前先取出 `moved`。

### 7.6 第二轮：改成「按下移动即拖」+ 性能与稳定性（[实测]，2026-11-27）

用户反馈「现在是按着它，我希望按着它的时候鼠标可以拖动」——第一版 350ms 长按期间只要指针有一丝移动就取消计时，等于要求用户按住不动等够时间，与直觉相反。

1. **判定改成位移阈值**：去掉 `GRID_LONG_PRESS_MS`，只留 `GRID_DRAG_SLOP = 6` 屏幕 px。按下后指针移动超过 6px 立刻起拖；不移动就松手 = 点击。没有计时器，也就没有「手抖就取消」。
2. **拖动期间不碰 React 状态**：新增 `GridDragSession`，起拖时一次性快照卡片矩形与 offset，之后每帧直接写 `el.style.transform`；pointermove 用 `requestAnimationFrame` 合并，一帧最多画一次。被拖卡的位移、其余卡的让位位移全部在 DOM 层算，React 全程不重渲染。
3. **松手不闪一帧**：`endGridDrag` 不立刻清 transform，而是把卡片列表存进 `pendingDragClear`，由 `useLayoutEffect` 在 React 重排之后、绘制之前清掉，避免旧位置闪一下。
4. **一个真 bug**：Esc / pointercancel 取消拖动时没设置「吞掉下一次 click」的标志，松手后浏览器合成的 click 会打开组件页。探针实测 click 在松手后 317ms 才到，最初用 0ms 定时器复位标志太早。改成 500ms 时间窗（`swallowNextClick` + `gridSwallowTimer`）。
