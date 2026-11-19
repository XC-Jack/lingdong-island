# SPEC-settings-zoom-lock：设置页锁定缩放、禁止页面级滚动

- 建立日期：2026-11-19
- 对应基线提交：`13e5f0a`（main）
- 任务分支：`settings-zoom-lock`
- 用户背景：0.1.17 设置页出现整页偏移——左侧导航栏和标题栏被推出窗口外，只剩内容卡片右侧（用户截图）。窗口坐标实测完整在屏幕内（`24,103 → 920,692`，屏幕 1536×960）；正常实例里内容无横向溢出、文档不可滚动。关闭设置窗口再打开后恢复正常。

## 一、目标

1. 设置窗口禁止页面缩放（Ctrl+滚轮、触控板捏合），避免缩放导致的布局溢出与滚动锚点位移。
2. 设置页禁止任何页面级/内容区横向滚动：`scrollIntoView`、焦点滚动、缩放锚点都不能再把整页带偏。
3. 纵向滚动（常规页内容较长时）保持可用。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/settingsWindow.ts` | 设置窗口创建时 `setVisualZoomLevelLimits(1,1)`、`setZoomFactor(1)`，`zoom-changed` 时强制回到 100% |
| `src/renderer/src/settings/settings.css` | `html/body/#root` 改 `overflow: clip`；`.set-content` 增加 `overflow-x: clip`（保留 `overflow-y: auto`） |
| `docs/Spec/SPEC-settings-zoom-lock.md` | 本 SPEC |

**不动**：窗口尺寸（880×580、不可缩放）、设置页布局、岛窗口。

## 三、预期行为

1. 设置窗口内 Ctrl+滚轮或触控板捏合不再改变页面缩放，布局始终按 100% 显示。
2. 对 `document`/`.set-content` 调用 `scrollTo` / `scrollIntoView` 不会产生横向位移；左侧导航与标题栏始终可见。
3. `.set-content` 纵向仍可滚动（内容超出 580 高时）。

## 四、必要依赖

无新增依赖；`setVisualZoomLevelLimits` / `setZoomFactor` / `zoom-changed` 均为 Electron 内置能力。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 开发版（隔离 userData + CDP）打开设置：执行 `scrollTo(222,44)` 与 `.set-content.scrollIntoView()` 后 `scrollX/scrollY` 保持 0，左侧导航 `left` 仍为 0。
- [ ] CDP 派发 Ctrl+滚轮事件后，页面 `innerWidth` / 缩放因子不变。
- [ ] `.set-content` 设置 `scrollTop` 仍生效（纵向滚动未被破坏）。
- [ ] 设置页链接、更新行等既有内容渲染正常。

## 六、不做什么

- 不改设置窗口的可调整大小策略（一直不可缩放）。
- 不给岛窗口加缩放锁（本次问题只在设置页复现；岛另有固定排版，后续如复现再单开 SPEC）。
- 不做「记录并恢复滚动位置」——固定排版下不需要。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | `npm run typecheck`、`npm run build` | EXIT=0 | — |
| 2026-11-19 | 开发版（隔离 userData + CDP 9335）打开设置页，读初始值 | `innerWidth 882`、`visualViewport.scale 1`、`scrollX/Y 0`、`.set-nav.left 0.8`；`.set-content` `scrollWidth 1081` / `clientWidth 537`（横向有溢出，符合锁定前会横向滚动的判断） | — |
| 2026-11-19 | 执行 `scrollTo(222,44)` + `.set-content.scrollIntoView()` 后复测 | `scrollX/Y 仍为 0`，`innerWidth 882`，`navLeft 0.8`（横向/整页位移被阻止） | — |
| 2026-11-19 | CDP `Input.dispatchMouseEvent` Ctrl+滚轮（modifiers=2, deltaY -240）后复测 | `innerWidth 882`、`visualViewport.scale 1`、`scrollX 0`、`navLeft 0.8`（未缩放） | — |
| 2026-11-19 | `.set-content.scrollTop = 120` | `{"top":120,"scrollHeight":1081,"clientHeight":537}`（纵向滚动正常） | — |
| 2026-11-19 | 脚本汇总 | `RESULT OK` | 用户真机原始故障（重开设置后恢复）未复现，属间歇性；本次为机制性防护，不能证明根因已消除 |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
