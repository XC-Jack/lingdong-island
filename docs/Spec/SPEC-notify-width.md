# SPEC：通知页宽幅收窄（用户 m02896）

## 一、目标

通知页展开时的岛宽从「被超长通知标题顶到上限」收到与待办页一致，视觉上不再是一条特别长的横幅。

用户原话（m02896）：「这个通知消息的也改一下，宽幅有点长，」

## 二、修改范围

1. `src/renderer/src/styles.css`：`.notify-list` 加固定上限 `max-width:300px`；`.notify-title` 改 flex 排布；新增 `.notify-title-text`；`.notify-more-hint` 改 `flex:none`。
2. `src/renderer/src/App.tsx`：通知组条目与子条目的标题文本各包一层 `.notify-title-text`。
3. `docs/facts/功能清单.md`、`docs/状态.md` 同步。

不动：通知数据来源、铃铛跳转、已读/清空按钮、3 条可见高度、其它页布局。

## 三、预期行为

1. 通知页展开的岛宽 = **285 视觉 px**（布局 380px），与待办页、置物架页、音乐页同宽。
2. 超长标题在标题行内出省略号，不再把岛撑宽。
3. 「（等 N 条）」提示完整可见，不被挤压、不越出岛右缘。
4. 其它四页宽度不受影响。

## 四、必要依赖

无新增依赖。只用 CSS flex 与 `text-overflow`。

## 五、验收条件

1. 逐页量几何：待办/置物架/通知/音乐均为 285 视觉 px，无元素右缘越界（`over` 为空）。
2. `.notify-more-hint` 宽度等于文本自然宽（38.8px），右缘 ≤ 岛右缘。
3. `npm run typecheck`、`npm run build` 通过。
4. `scripts/e2e-notify-compact.mjs`、`e2e-bell-notify.mjs`、`e2e-beautify-04.mjs`、`e2e-head-order.mjs`、`e2e-pages-custom.mjs` 全绿。

## 六、不做什么

1. 不改通知条目的字体、行高、图标尺寸。
2. 不改铃铛/已读/清空交互。
3. 不把通知列表改成可横向滚动。
4. 不改日程页宽度（它 393.2 是日历内容需要）。

## 七、实现记录与自检

### 7.1 改动

1. `.notify-list` 加 `max-width:300px`（布局 px；`.app` 上 `zoom:.75`，视觉 225）。理由：`66%` 这类百分比以 `.music-main`/父级可用宽为基准，在宽岛上等于没限制——音乐页上一轮已踩过这个坑。
2. 分档实测（CDP 注入临时样式）：

   | `.notify-list` 上限 | 岛视觉宽 | 布局宽 |
   |---|---|---|
   | 220px | 285 | 380px |
   | 260px | 285 | 380px |
   | 300px | 285 | 380px |
   | 330px | 285.1 | 380.1px |
   | 360px | 307.6 | 410.1px |

   ⇒ 220~330 都落在 285，取 300 给标题留足宽度。
3. `.notify-title` 原来靠自身的 `overflow:hidden`+`text-overflow:ellipsis` 处理超长文本，但「（等 N 条）」是它的**子元素**，行内排布时会被超长标题推到岛外（实测右缘 340.3，超出岛 285.7）。改为 flex：标题文本进 `.notify-title-text`（`flex:1 1 auto; min-width:0` 承担省略号），提示 `flex:none` 保持完整。

### 7.2 自检

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | EXIT=0 |
| 构建 | `npm run build` | EXIT=0，`✓ built in 137ms` |
| 通知紧凑 | `node scripts/e2e-notify-compact.mjs` | PASS 2 过 / 0 败 |
| 铃铛跳转 | `node scripts/e2e-bell-notify.mjs` | PASS 15 过 / 0 败 |
| 美化批次 | `node scripts/e2e-beautify-04.mjs` | PASS 27 过 / 0 败 |
| 头部顺序 | `node scripts/e2e-head-order.mjs` | PASS 14 过 / 0 败 |
| 页面自定义 | `node scripts/e2e-pages-custom.mjs` | PASS 6 项 |

逐页几何（CDP，真鼠标 hover 保持展开）：

| 页 | 岛视觉宽 | 岛高 | 越界元素 |
|---|---|---|---|
| 待办 | 285 | 170.3 | 无 |
| 置物架 | 285 | 138.1 | 无 |
| 通知 | 285 | 192.2 | 无 |
| 日程 | 393.2 | 255.8 | 无 |
| 音乐 | 285 | 203.3 | 无 |

通知页细节：`.notify-list` 225（视觉）、`max-width:300px`；`.notify-title` 115.5；`.notify-more-hint` 38.8、右缘 196.8 ≤ 岛右缘 285.7。截图 `.tmp/shot-notify-final.png`（358×243）。

### 7.3 未核验

1. [未核验] 真机 DPI 非 100% 时的观感（本机缩放 100%）。
2. [未核验] 装机版（`npm run dist`）尚未打包，用户看到的是预览版。
3. [未核验] 用户在真实通知流（非测试数据）下的长期观感。

### 7.4 踩坑记录

1. `e2e-notify-compact.mjs` 用 `Select-Object -Last 3` 取结果时会连带前一轮的输出片段（`C2 …✅` + `== 结果：1 过 / 1 败 ==`），看起来像失败；单独重跑、清 `.tmp/e2e-userdata` 后稳定 2 过 0 败。**跑 e2e 前一律先清 `.tmp/e2e-userdata`。**
2. 探针脚本用 `require('fs')` 会报 `ReferenceError: require is not defined in ES module scope`，`.tmp/*.mjs` 一律用 `import fs from 'node:fs'`。
3. `.notify-more-hint` 上写 `display:inline-block; max-width:100%` 不能解决被推出岛外的问题——它被父级 `.notify-title` 的 `overflow:hidden` 裁掉一部分、又被排到父级右缘之外。必须改父级排布方式（flex + 子文本省略）。
