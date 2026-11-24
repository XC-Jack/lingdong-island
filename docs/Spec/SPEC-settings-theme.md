# SPEC：设置页主题切换（「外观」分区）

- 建立日期：2026-11-24
- 前置：`docs/Spec/SPEC-island-themes.md`（三套主题、`<html data-theme>`、`prefs.islandTheme` 与广播链路都已就绪，只缺 UI）
- 任务分支：`settings-theme`
- **分支基线说明**：从 `island-themes` 切出，不是从 `main`——主题 token 与 `prefs.islandTheme` 都还在那一支上（未合并）。合并顺序：`island-themes` → `settings-theme` → `main`。
- 背景：用户 2026-11-24 原话「把 A/B/C，三种效果都保留，**后续可以添加一个在设置里换主题的功能**」，本轮兑现这句。

## 一、目标

1. 设置窗口新增「外观」分区，三张卡片选主题；点选立即生效并持久化。
2. 岛在 1 秒内跟着换，无需重启（复用已有的 `prefs:changed` 广播，不新增 IPC）。
3. 当前生效的主题在 UI 上如实显示；prefs 里是非法值或缺失时，显示「亮色玻璃」为选中。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/shared/types.ts` | `SettingsSection` 增加 `'appearance'` |
| `src/renderer/src/settings/SettingsApp.tsx` | 左导航加「外观」项（放在「常规」之后）；新增分区渲染分支 |
| `src/renderer/src/settings/ThemeSection.tsx` | **新增**：三张主题卡片 + 迷你预览 + 选中态 + 读写 prefs |
| `src/renderer/src/settings/settings.css` | 卡片与预览样式 |
| `scripts/e2e-settings-shell.mjs` | S2a 由「六项」改为「七项」并补 `外观` |
| `docs/facts/视觉设计规范.md` | 补一句「换肤入口在设置 → 外观」 |

**不动**：岛的三套主题取值、`prefs.islandTheme` 的数据格式与校验、其它设置分区、布局与窗口尺寸。

## 三、预期行为

1. 设置 → 外观：三张卡片，从上到下为
   - **亮色玻璃**（`glass-light`，默认）：跟随桌面颜色的半透明玻璃，深色文字
   - **纯黑玻璃**（`glass-dark`）：纯黑底 + 极淡白描边，白色文字
   - **纯黑极简**（`mono`）：无描边、无投影的实心黑，白色文字
2. 每张卡片左侧是**迷你预览**（圆角胶囊示意 + 两行小字），右侧是名称、一句说明、单选圆点。
3. 点卡片 → 立即写入 `prefs.json` 并生效；卡片进入选中态（圆点填充 + 边框强调）。没有「保存」按钮（与「桌宠」「页面管理」一致：改了就想立刻看到）。
4. 写失败：选中态回滚到原来的值，卡片下方显示一行「保存失败，请重试」。
5. 切到纯黑两套时，岛的真透视抓屏循环自动停（既有逻辑，`glass-light` 才抓）；切回来自动恢复。
6. 重启后打开设置，选中态与 `prefs.json` 一致。

## 四、必要依赖

无新增依赖。复用 `window.island.prefsGet / prefsSet / onPrefsChanged`。

## 五、验收条件

- V1 `npm run typecheck`、`npm run build` 通过。
- V2 三张卡片逐个点击：`prefs.json` 的 `islandTheme` 依次为 `glass-dark` / `mono` / `glass-light`；岛的 `<html data-theme>` 同步变化（CDP 读回）。
- V3 持久化：设置 `mono` 后重开设置窗口，选中态是「纯黑极简」；把 `prefs.json` 改成非法值 `neon-pink` 再开，选中态回到「亮色玻璃」且岛用默认主题。
- V4 回归：`e2e-settings-shell`（S2a 七项）、`e2e-pages-custom`、主题开关链路（`.tmp/island-themes/check-backdrop-gating.cjs`）。
- V5 用户看一眼实际观感与点的感觉。

## 六、不做什么

- 不做自定义配色、主题导入导出。
- 不做「跟随系统深浅色」。
- 不新增主题、不改三套主题的取值。
- 不做切换动画、不做主题缩略图截图（预览是 CSS 示意图）。
- 不动其它分区与岛的布局。

## 七、风险与取舍

1. **预览是示意图**：设置窗口没有抓屏底图能力，画不出真透视；亮色玻璃用固定的暖色渐变示意。预览色写死在 `settings.css` 的 `.theme-prev[data-t="…"]` 里，与 `styles.css` 的三段主题是**两份值**，改了主题取值必须同步（两处都留了注释）。
2. 左导航从 6 项变 7 项：`e2e-settings-shell` 的 S2a 断言写死了数量，必须同步更新，否则会误报。
3. 选中态用「乐观更新 + 以写回结果为准」：点下去先亮，写失败再回滚——与桌宠分区同一套模式，不引入新的状态机。

## 八、自检记录（2026-11-24，分支 `settings-theme`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | PASS（node + web 两套均无输出） |
| 构建 | `npm run build` | PASS，`built in 118ms`，产物已更新 |
| 设置窗口回归 | `node scripts/e2e-settings-shell.mjs` | **PASS 57/0**；S2a 七项通过，新增 S13a–S13f 全过 |
| 页面自定义回归 | `node scripts/e2e-pages-custom.mjs` | PASS 6/6 |
| 抓屏开关链路 | `node .tmp/island-themes/check-backdrop-gating.cjs` | `glass-light` backdrop=true，`glass-dark`/`mono` false，切回恢复 true |
| 视觉检查 | `.tmp/settings-theme/shoot.cjs` 截图 | 三张卡布局、选中态、预览明暗均正常；见 `.tmp/settings-theme/shots/` |

S13 实际覆盖：

- S13a 三张卡的 `data-theme-id` 顺序为 `glass-light,glass-dark,mono`。
- S13b prefs 里没有 `islandTheme` 时选中「亮色玻璃」。
- S13c 点「纯黑极简」→ `prefs.islandTheme='mono'`、岛 `document.documentElement.dataset.theme='mono'`、卡片选中态 `mono`。
- S13d 点「纯黑玻璃」→ 三处同步为 `glass-dark`。
- S13e 停在 `mono` 关窗重开 → 选中态仍为 `mono`（持久化）。
- S13f 切回 `glass-light` → prefs 与岛都回到默认。

**未验证**：非法值 `neon-pink` 的 UI 回落没有单列 e2e，只在 `ThemeSection.tsx` 的 `normalizeTheme()` 与岛内 `applyIslandTheme()` 两处对照确认逻辑一致（两处都是白名单不中即回 `glass-light`）；用户对三张预览示意图的主观「像不像」。

**实现中的一处必要扩大**：主进程 `settingsWindow.ts` 的 `isValidSection()` 原来手写六个字符串，加「外观」时漏改会让 `openSettings('appearance')` 静默落回「常规」。已改为读 `src/shared/types.ts` 新增的 `SETTINGS_SECTIONS` 清单，以后加分区只改一处。
