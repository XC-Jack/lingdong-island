# SPEC-settings-about：设置「关于」页

- 建立日期：2026-11-19
- 对应基线提交：`7c63650`（main）
- 任务分支：`settings-about`
- 用户背景：用户希望在设置里加一页说明，介绍产品并附上自己的 GitHub 仓库跳转入口，要求「顶级排版」的布局。

## 一、目标

1. 左侧导航新增「关于」（放在导航最下方，ⓘ 图标），独立成页。
2. 页面用两张卡片：①身份卡（居中：图标、产品名、版本与平台、两行产品说明）；②GitHub 链接卡（整行可点，点开系统浏览器到 `https://github.com/XC-Jack/lingdong-island`）。
3. 排版沿用设置页既有字阶与色板：主文字 `#f2f3f5`、次要 `rgba(242,243,245,.45–.72)`、操作色绿 `#7dd87d`、岛品牌紫 `#9f8bff`（仅用于图标）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `SettingsSection` 增加 `'about'` |
| `src/main/settingsWindow.ts` | `isValidSection` 接受 `about`；新增 `settings:open-github`（固定 URL，渲染层不能传任意地址） |
| `src/preload/index.ts` | 新增 `openGithub()` |
| `src/renderer/src/settings/SettingsApp.tsx` | 导航项 + 「关于」页两张卡片 |
| `src/renderer/src/settings/settings.css` | `.about-*` 样式，沿用卡片圆角 12、内边距与字阶 |
| `docs/facts/功能清单.md` | 补「关于」页 |
| `docs/Spec/SPEC-settings-about.md` | 本 SPEC |

**不动**：更新行与更新逻辑、设置其他页、窗口尺寸、导航排序的既有项。

## 三、预期行为

1. 导航最下方出现「关于」；点击后内容区显示关于页，标题与其它页一致（14px/600）。
2. 身份卡：44px 图标（胶囊字形，紫色）、产品名 18px/600、版本与平台一行（11px 等宽数字、次要色）、一句 tagline（14px/1.75，最大宽度 360px）居中，下面一行 11px 事实（数据只在本机 · 无需账号 · 不打扰）。
3. GitHub 卡：左侧 GitHub 标（16px）、中间两行（`XC-Jack / lingdong-island` 13px 主色；`源码、版本更新与问题反馈都在这里 · PolyForm 非商业许可` 11px 次要色）、右侧 `↗`；悬停整卡提亮、箭头转绿；键盘 `focus-visible` 有描边。
4. 点击 GitHub 卡：用系统默认浏览器打开仓库地址；不经过更新器、不读网络。
5. 版本号取自已有的 `info.version`（`settings:app-info`），开发版/安装版都显示真实值。
6. 不改变现有 `overflow: clip` / 缩放锁行为；关于页内容不超过一屏（537px 高）。

## 四、必要依赖

无新增依赖。`shell.openExternal` 由主进程调用；URL 固定在主进程常量里。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 隔离 userData 启动打包/预览版，CDP 打开设置并切到「关于」：导航项存在，两张卡片渲染，版本号等于 `app.getVersion()`。
- [ ] 量取布局：身份卡内容居中、说明行宽 ≤ 360px；GitHub 卡整卡可点区域覆盖两行文字。
- [ ] 点击 GitHub 卡后系统浏览器打开仓库地址（本轮用 `shell.openExternal` 返回值与日志确认，不弹窗截图）。
- [ ] 设置页缩放锁与纵向滚动不受影响（Ctrl+滚轮后 `scale` 仍为 1）。

## 六、不做什么

- 不做独立「关于窗口」，不做检查更新入口（更新在「常规」页）。
- 不在渲染层开放任意 URL 的 `openExternal`；只允许仓库这一个固定地址。
- 不引入新字体、图片资源或第三方图标库；图标用手写 SVG。
- 不加许可证全文、致谢名单、更新日志（后续需要再单独开 SPEC）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | `npm run typecheck`、`npm run build` | EXIT=0 | — |
| 2026-11-19 | 预览版（隔离 userData + CDP 9345）打开 `about` 分区 | 导航为 `常规 / 页面管理 / 桌宠 / 专注·喝水 / 关于`，`关于` 高亮；页面标题「关于」 | — |
| 2026-11-19 | 量取布局 | 身份卡 `223,92–860,294`；产品名 18px；版本 `v0.2.0`，`font-family` 为 `ui-monospace, "Cascadia Mono", Consolas`；tagline 宽 284、高 25（单行），事实行 11px；GitHub 卡 `223,306–860,369`，`scrollWidth == clientWidth`（无溢出）；内容区 `scrollHeight == clientHeight 537`（一屏放下） | — |
| 2026-11-19 | 点击 GitHub 卡 | `window.island.openGithub()` 返回 `true`（`shell.openExternal` 未报错）；DOM 为 `<button>`、`tabIndex=0`（键盘可达） | 系统浏览器实际打开的页面内容（当前网络到 GitHub 不通，未截图） |
| 2026-11-19 | 缩放锁回归 | 关于页沿用同一 `html/body` `overflow: clip` 与 `zoom-changed` 复位，未新增独立滚动容器 | 未在关于页重测 Ctrl+滚轮（同一设置窗口，前一轮已实测） |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
| — | 待用户真机/预览确认 | — | — |
