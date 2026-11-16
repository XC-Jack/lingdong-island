# SPEC：置物架图标视图「一屏 4 个」+ 箭头循环 + 滚轮横滚

## 一、目标

用户 m01366 对置物架页的三条要求（原话：「置物架这个界面做的不好，显示太多了，4个最多，然后左右两边的滚动循环，支持滚轮滚动」）：

1. 图标视图一屏最多显示 **4 个**，超出的靠左右箭头 / 滚轮看。
2. 左右两侧 `‹ ›` 箭头**首尾循环**：到头再点一次跳回另一头。
3. 支持**滚轮**横向滚动，且滚到两端同样循环。

用户给的截图（m01364）里一排挤了 8 个图标、名字被压扁，是本次要修的那一屏。

## 二、修改范围

- `src/renderer/src/styles.css`
  - `.shelf-strip` 的 `max-width` 由 `460px` 改为 `380px`（大图标档），新增 `.shelf-drop.md .shelf-strip{max-width:300px}`、`.shelf-drop.sm .shelf-strip{max-width:236px}`。
  - `.shelf-cell` 增加 `flex: none`（禁止被 flex 压缩，否则容器一窄就把每格压扁、一屏反而塞进 6~8 个）。
- `src/renderer/src/App.tsx`（`ShelfPanel`）
  - 新增 `wheel` 监听（原生 `addEventListener` + `passive:false`）：竖向滚轮转横向，两端绕回；依赖 `[view, items.length]`。
  - `scrollBy(dir)` 改为循环版：已在最右再点右箭头 → 回 0；已在最左再点左箭头 → 跳最右。
- 不改：列表视图（仍 3 行 + 上下滚）、拖放、失效标记、视图记忆、清空确认、格子拖拽换位。
- 不改主进程（`src/main/`）：无新 IPC、无新常量。

## 三、预期行为

1. 大图标视图：10 个文件时一屏正好完整显示 4 个格子，其余靠滚动查看。
2. 中图标 / 小图标视图：同样一屏 4 个（格子小 → 岛窄 → 窗口按 4 格算）。
3. 内容 ≤ 4 个时不出箭头、不能滚（`canScroll` 为 false）。
4. 点右箭头到最右后再点一次 → 回到最左；点左箭头到最左后再点一次 → 跳到最右。
5. 鼠标在图标区滚轮下滚 → 横向右移；滚到右端继续滚 → 绕回左端，反之亦然。
6. 只影响图标视图；列表视图、拖入、双击打开、失效提示等行为不变。

## 四、必要依赖

无新增依赖。复用既有 `.shelf-strip` 横向滚动容器与 `scrollRef`。

## 五、验收条件

1. `npm run typecheck` / `npm run build` 通过。
2. 探针实测（dev 实例 + 隔离数据 + 10 个真实文件）：三档视图 `fullyVisible` 均为 4。
3. 探针实测：箭头到端循环（`atEnd 542 → 点右箭头 → 0`；`scrolledLeft 0 → 点左箭头 → 542`）。
4. 探针实测：合成 `WheelEvent` 与 CDP 真 `mouseWheel` 都能改变 `scrollLeft`（不能只靠合成事件自证）。
5. 既有置物架相关 e2e 不回归：`e2e-exit-and-shelf-view`、`e2e-shelf-view-pref`、`e2e-shelf-missing`、`e2e-m4-drop`、`e2e-reorder`。

## 六、不做什么

- 不改「四种视图」的档位与菜单交互。
- 不改列表视图的行数上限（仍 3 行，属上一轮 SPEC-island-auto-size）。
- 不做触摸板横向手势的特殊适配（原生 `deltaX` 已覆盖）。
- 不加可见滚动条（沿用隐藏滚动条）。
- 不顺手改置物架其它样式（图标尺寸、间距、徽标）。

## 七、自检记录（2026-11-16，分支 `island-auto-size`）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | PASS（EXIT=0） |
| `npm run build` | PASS（EXIT=0） |
| `.tmp/probe-shelfwheel.mjs` 滚轮诊断 | 修前：合成事件 `afterScrollLeft:0 / defaultPrevented:false`、CDP 真滚轮也 `0`；根因是 `useEffect` 只依赖 `[view]`，首帧 `items` 为空、`.shelf-strip` 未渲染 ⇒ `scrollRef.current === null`，监听从未挂上。修后：`{"synthetic":{"afterScrollLeft":121,"defaultPrevented":true}}`、`{"cdpWheel":121}`、`{"cdpWheelAfterMove":121}` |
| `.tmp/probe-shelf4b.mjs` 三档可见数 | `大图标 {islandW:353, cellW:63, fullyVisible:4}`、`中图标 {islandW:293, cellW:48, fullyVisible:4}`、`小图标 {islandW:245, cellW:36, fullyVisible:4}` |
| `.tmp/probe-shelf4.mjs` 箭头/滚轮循环 | `{"loop":{"atEnd":542,"afterRightArrowClicked":0}}`、`{"loopLeft":{"afterLeftArrowClicked":542}}`、`{"wheelLoopFrom0":542}`、`{"wheelFrom0":150}`；列表视图仍 `fullyVisible:3` |
| `node scripts/e2e-exit-and-shelf-view.mjs` | PASS |
| `node scripts/e2e-shelf-view-pref.mjs` | PASS |
| `node scripts/e2e-shelf-missing.mjs` | PASS |
| `node scripts/e2e-m4-drop.mjs` | PASS（首跑 FAIL 是 `.tmp/e2e-userdata` 里残留 12 个文件的旧数据，清空后 PASS，非回归） |
| `node scripts/e2e-reorder.mjs` | PASS（该脚本不自启实例，需先把 electron 起在 9225 端口；未起实例时报 `E2E FAIL: fetch failed`，非回归） |

未验证：

- [未核验] 真人鼠标在装机版上滚轮的体感（探针用 CDP `Input.dispatchMouseEvent` 的 `mouseWheel`，与真人滚轮同源但不等同）。
- [未核验] 触摸板双指横向滑动的实际手感（走 `deltaX` 分支，逻辑已覆盖）。
