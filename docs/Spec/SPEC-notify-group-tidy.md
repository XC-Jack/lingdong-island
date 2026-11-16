# SPEC：通知页组条目（主干）整理（用户 m03042）

## 一、目标

展开某个应用的通知组后，主干与分支之间不显得空、主干右侧不再和时间挤在一起，并且再点一次主干能收起。

用户原话（m03042）：「如截图，以这个信息为例，主干和分支之间是不是隔的有点开，然后主干下面和时间打架了,我觉得可以把主干下面的这个时间给去掉，然后两个之间的距离可以缩短，还有几十再点击一次主干，分支收起」

## 二、修改范围

1. `src/renderer/src/styles.css`：`.notify-group` 加 `flex-wrap:wrap` 与 `row-gap:3px`；`.notify-sublist` 的 `margin` 由 `2px 0 2px 14px` 改 `0 0 0 8px`、`width` 由 `calc(100% - 14px)` 改 `calc(100% - 8px)`、加 `flex:0 0 auto`。
2. `src/renderer/src/App.tsx`：`renderSide` 增加 `showTime = true` 形参；组条目（主干）调用处传 `false`。
3. `docs/facts/功能清单.md`、`docs/状态.md` 同步。

不动：叶条目（分支内每条）仍带时间；通知数据来源、铃铛跳转、已读/清空、3 条可见高度。

## 三、预期行为

1. 主干右侧**不再显示相对时间**（只保留未读蓝点；无未读时该列宽 0，不占位）。
2. 分支列表独占主干下方一行，不再与主干横向争宽。
3. 主干与分支的视觉间隙比修改前更小。
4. 再点一次主干 → 该组收起（行为原本就有，本次回归验证）。

## 四、必要依赖

无新增依赖。只用 CSS flex 换行与原按钮的 `onClick`。

## 五、验收条件

1. 收起态/展开态下每个 `.notify-group > .notify-side .notify-time` 为空。
2. 展开后 `.notify-sublist` 的 `x` 偏移从 56.1 降到 12 左右，`.notify-body` 宽度不再被压成 0。
3. 组条目高度由 68.3 降到约 62.3（可视行距更紧）。
4. `npm run typecheck`、`npm run build` 通过。
5. `scripts/e2e-notify-group.mjs`、`e2e-notify-compact.mjs`、`e2e-bell-notify.mjs`、`e2e-beautify-04.mjs` 通过（`e2e-notify-group.mjs` 的 G11 依赖本机通知库里有「启用病毒防护」那条，库里没有时本来就是跳过项）。

## 六、不做什么

1. 不改分支内每条通知的布局（它们仍带时间与蓝点）。
2. 不改分组规则（仍只按应用分一层）。
3. 不给主干加「点击展开」以外的交互。

## 七、实现记录与自检

### 7.1 抓到的真 bug（比用户描述更严重）

[已核验] 展开组后 `.notify-item` 是 `display:flex` 且 **没有换行**，`.notify-sublist` 作为第三个 flex item 与 `.notify-body`、`.notify-side` 并排横挤，实测 `.notify-body` 宽度被压成 **`w=0`**（`{"cls":"notify-body has-icon","x":6,"y":3,"w":0,"h":24}`），主干标题完全不可见、时间（29.1px）叠在图标上方——这正是用户截图里「主干下面和时间打架」的形状。加 `flex-wrap:wrap` 后 `.notify-body` 恢复 `201.8px`。

### 7.2 改动

1. `.notify-group { flex-wrap: wrap; row-gap: 3px; }`
2. `.notify-sublist`：`margin 2px 0 2px 14px → 0 0 0 8px`、`width calc(100% - 14px) → calc(100% - 8px)`、新增 `flex: 0 0 auto`。
3. `renderSide(arrival, unread, showTime = true)`；组条目调用改为 `renderSide(latest.arrival, latest.order > lastOrder, false)`。

### 7.3 自检

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | EXIT=0 |
| 构建 | `npm run build` | EXIT=0，`✓ built in 118ms` |
| 通知分组 | `node scripts/e2e-notify-group.mjs` | 11 过 / 1 败（唯一失败 G11「库里暂无该通知，跳过判定」，与本次改动无关） |
| 通知紧凑 | `node scripts/e2e-notify-compact.mjs` | 2 过 / 0 败 |
| 铃铛跳转 | `node scripts/e2e-bell-notify.mjs` | 15 过 / 0 败 |
| 美化批次 | `node scripts/e2e-beautify-04.mjs` | PASS 27 / 0 |

几何（CDP）：

| 指标 | 改前 | 改后 |
|---|---|---|
| `.notify-body` 宽 | 0（被挤没） | 201.8 |
| `.notify-sublist` 相对 x | 56.1 | 12 |
| `.notify-sublist` y | 4.5 | 29.3（独占下一行） |
| 组条目高 | 68.3 | 62.3 |
| 主干 `.notify-time` | `2 分钟前` / `39 分钟前` | `null` / `null` |

截图 `.tmp/shot-notify-closed.png`（收起组）、`.tmp/shot-notify-opened.png`（展开组）。

### 7.4 踩坑记录

1. **跑 `scripts/e2e-notify-group.mjs` 前必须先杀掉预览版 electron**：该脚本自己 `spawn` 一个带 `--remote-debugging-port=9321` 的实例，若已有实例占着 9321，脚本会连到旧实例（旧数据、旧页面），首轮出现「3 过 / 9 败」（`groups=0`、`stated=-1`）。杀掉后稳定 11/1。
2. 出现大面积失败时先用 `git stash` 退回 HEAD 跑一遍对照，确认是不是自己改出来的——本次对照同样是 11/1，说明 G11 是环境缺失而非回归。
3. `.tmp/*.mjs` 用 `require('fs')` 会报 `ReferenceError: require is not defined in ES module scope`，一律用 `import fs from 'node:fs'`。

### 7.5 未核验

1. [未核验] 用户对「缩短后」间距的观感是否合适（本次把 sublist 上边距压到 0、行距 7→3 布局 px）。
2. [未核验] 装机版尚未打包。
