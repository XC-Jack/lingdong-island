# SPEC：功能页移除底部翻页器

- 建立日期：2026-11-24
- 基线：`main` `10228e0`（v0.5.0 已发版）
- 任务分支：`island-no-pager`
- 背景：用户 2026-11-24 看过 v0.5.0 后原话「日历这一页就只有日历，底下得切换不要了」。组件网格已经是页面入口，功能页也有返回键，底部「‹ 圆点 ›」是旧导航的残留。

## 一、目标

1. 所有功能页（待办/置物架/通知/日程/音乐）底部不再显示翻页器。
2. 导航统一为：网格 → 点组件进页面 → 左上角返回键回网格。
3. 不改变铃铛、拖文件等直达入口。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | 删除展开态 `.pager` 区块；删除 `flipPage`；保留一组不可见的 `.dots` 兼容钩子（网格态与页面态都渲染） |
| `src/renderer/src/styles.css` | 删除 `.pager` / `.pager-arrow`；新增 `.dots-compat { display:none }` |
| `scripts/e2e-pages-custom.mjs` | P4 断言改为「底部无翻页器 + 兼容圆点仍能切页」 |
| `scripts/e2e-notify-icon.mjs` | 进通知页改为点网格组件，兜底用兼容圆点（原依赖 `.pager-arrow`） |
| `docs/facts/视觉设计规范.md` | 补「页面导航」规则 |

## 三、预期行为

1. 五个功能页都看不到底部箭头与圆点，页面底部只到内容/输入框为止。
2. 页面之间切换走「返回网格 → 点另一个组件」。
3. 只用 `.dots .dot` 切页的旧脚本不改：隐藏按钮在网格态与页面态都在 DOM 里，程序化点击照常触发切页，但用户看不见、点不到。原先依赖 `.pager-arrow` 的两个脚本（`e2e-pages-custom`、`e2e-notify-icon`）改为点组件或点兼容圆点——箭头已不存在，保留测试只会保护一条用户走不到的路径。
4. 网格页与功能页的尺寸同步、缩放动画逻辑不变。

## 四、必要依赖

无。

## 五、验收条件

- A1 `npm run typecheck`、`npm run build` 通过。
- A2 五页截图确认底部无翻页器，且页面高度相应收窄（`.tmp/no-pager/`）。
- A3 回归：`e2e-todo-today`、`e2e-pages-custom`、`e2e-music`、`e2e-schedule-day`、`e2e-notify`、`e2e-head-order`、`e2e-collapse-order`、`e2e-shelf-view-pref`。
- A4 用户在本机预览版确认。

## 六、不做什么

- 不改网格、不改返回键、不改任何功能逻辑。
- 不合并 `main`、不打包、不发版（等用户看效果）。

## 七、自检记录（2026-11-24）

1. `npm run typecheck`（node + web 两个 tsconfig）通过；`npm run build` 通过（out/renderer 重建）。
2. 截图探针 `.tmp/no-pager-probe.mjs` 输出 [实测]：
   - 五页 `document.querySelectorAll('.pager').length` 均为 0，`.pager-arrow` 均为 0。
   - `.dots-compat` 计算样式 `display: none`，`.dot` 仍是 5 个。
   - 功能页内容底边到岛底固定留 15.8 布局 px（与移除前一致，没有因删翻页器留下空洞）。
   - 五页岛体尺寸：待办 255×210.2、置物架 255×157.1、通知 255×219.2、日程 381.2×254.4、音乐 255×181.9。
   - 兼容钩子程序化点击第 4 个圆点：标题从「待办」变「日程」，说明旧脚本切页链路仍有效。
   - 截图在 `.tmp/no-pager/`（light / glass-dark / mono）。
3. 回归全部通过（退出码 0）[实测]：`e2e-todo-today`、`e2e-pages-custom`（7 项）、`e2e-music`（17 过 / 0 败 / 3 跳过）、`e2e-schedule-day`、`e2e-notify`、`e2e-head-order`（14 过）、`e2e-collapse-order`（22 过）、`e2e-shelf-view-pref`，另跑 `e2e-notify-icon`（10 过）验证改动过的脚本。
4. 未验证：真机上鼠标操作、缩放动画观感（等用户看预览版）。
