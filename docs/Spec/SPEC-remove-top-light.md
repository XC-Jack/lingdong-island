# SPEC：去掉岛体顶部的打光

## 1. 目标

用户 2026-11-25 原话：「把顶部的打光都不要了」。去掉岛体上模拟「光从上方打下来」的亮部，让四套主题的岛面变成纯底色，不再有顶部高光边和顶部渐亮。

## 2. 修改范围

只改 `src/renderer/src/styles.css` 的四个主题 token：

| 主题 | 去掉的东西 |
|---|---|
| B `glass-light` | `--shadow-island` 里的 `inset 0 1px 0 rgba(255,255,255,.95)`；`--island-hi`（左上受光斑，改 `transparent`） |
| A `glass-dark` | `inset 0 1px 0 rgba(255,255,255,.14)`；`--island-hi`（0.085 的左上受光斑） |
| C `mono` | 本来就是 `--shadow-island: none`、`--island-hi: transparent`，无需改动 |
| D `glass-clear` | `inset 0 1px 0 rgba(255,255,255,.3)`；`--island-veil` 顶部那条 14%→0 的受光带；无底图回落态里同样的一条 10%→0 受光带 |

## 3. 预期行为

- 岛收起、展开时，顶边不再有一条更亮的 1px 线；岛面上半部分不再比下半部分亮。
- 其余不变：描边、圆角、底色、文字、B 的右上冷光与右下暖光色斑、D 的 5.5% 中性白与抓屏底图都保留。
- 不动 C（本来就没有打光），不动组件与页面结构。

## 4. 必要依赖

无新增依赖。

## 5. 验收条件

- `npm run typecheck`、`npm run build` EXIT=0。
- `e2e-settings-shell` 仍 58 过 / 0 败。
- 四套主题各截一张展开态图，肉眼确认顶部无亮边、无上亮下暗；`getComputedStyle(.island).boxShadow` 不再含 `inset 0 1px 0`。
- 装机版（`D:\软件\灵动岛\`）为本次改动后的构建。

## 6. 不做什么

- 不改 B 的右上冷光、右下暖光色斑（属于环境色，不是顶部打光）。
- 不改描边 `--border-island`。
- 不改任何组件、页面、交互。
- 不顺带调其他视觉参数。
