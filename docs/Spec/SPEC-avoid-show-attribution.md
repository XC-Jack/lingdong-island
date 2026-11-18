# SPEC：追查「独占全屏游戏每隔几分钟被切到桌面」+ 摸边闪烁循环

- **建立日期**：2026-11-18
- **基线提交**：`c74e683`（main，v0.1.7）
- **任务分支**：`avoid-show-attribution`
- **关联**：`SPEC-fix-exclusive-fullscreen-crash.md`、`SPEC-startup-diagnostics.md`、`../facts/功能清单.md` 第 14 条

## 一、问题

装上 0.1.7（不再闪退）后，用户在那台机器上打《三角洲》（独占全屏）报告新症状：

> 「玩了几分钟就突然切到桌面，然后我点回游戏又玩几分钟，又会突然切到桌面。」

即：**周期性失去前台/被踢出全屏**，不是崩溃。

## 二、分析与本轮改动

判断：`hide`（藏起来）是安全的，**`show`（把岛叫出来）才是杀手** —— 在独占全屏上出现任何置顶窗口，游戏就会切出全屏。所以问题变成「谁每隔几分钟把岛叫出来一次」。代码里能触发现身的有四种：判定翻转（judge→N）、横幅（`banner-on`）、摸边（`cursor-top`）、手动恢复。

本轮做三件事（前两件是确定的 bug/缺陷，第三件是预防）：

1. **归因日志**：每次隐藏/现身都往 `startup.log` 写一条
   `[avoid] show reason=<judge:N|banner-on|cursor-top|reconcile:F|manual-restore|…> judge=… mode=… visible=… temp=… banner=…`
   —— 下次用户复现，日志直接说出是哪一个原因。为此把 `startupLog()` 从 `index.ts` 抽到 `src/main/startupLog.ts`，两个模块共用一个日志文件。
2. **摸边闩锁（修真实 bug）**：改成「按光标坐标判定摸边」之后，出现 show→hide→show 的**闪烁循环**——唤回条件是「光标 y≤2（全宽）」，收起条件是「光标离开岛的矩形」。光标停在顶部但**横向在岛之外**时两者互相触发，实测日志里 200ms 一轮：
   ```
   [avoid] hide reason=cursor-left judge=Z ...
   [avoid] show reason=cursor-top  judge=Z ...
   [avoid] hide reason=cursor-left judge=Z ...
   [avoid] show reason=cursor-top  judge=Z ...
   ```
   在独占全屏游戏里这种循环等于**反复踢游戏**。修法：加闩锁 `revealArmed` —— 一次唤回被「光标离开岛」收起后，必须先让光标回到 y>8 才允许下一次摸边唤回；岛因别的原因现身时也会重新上膛。
3. **现身方向差异化去抖**：藏晚 1 秒无所谓，但在独占全屏上把岛叫出来一下就会踢游戏。所以「从**真全屏（F）**回来」要求非全屏状态稳定 **1.2 秒**才现身（`SHOW_STABLE_MS`），把一闪而过的前台变化（别的程序抢一下焦点、全屏切换过渡帧）全过滤掉；「从普通最大化（Z）回来」仍是原来的 150ms，日常用不会变迟钝。

## 三、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/startupLog.ts` | **新建**：`startupLog()`，`index.ts` 与 `fullscreenWatch.ts` 共用 |
| `src/main/index.ts` | 删掉本地 `startupLog`，改 import；不再直接用 `appendFileSync/mkdirSync` |
| `src/main/fullscreenWatch.ts` | 新增 `avoidLog()`（`apply()` 带 reason）；新增 `REVEAL_REARM_Y` + `revealArmed` 闩锁；新增 `SHOW_STABLE_MS` 与 `lastAvoidJudge`（只对 F→N 用长稳定期） |
| `scripts/e2e-avoid-mode.mjs` | 新增 M9：光标停在顶部但横向在岛外 5 秒，新增 `[avoid]` 事件须 ≤ 3 条（闩锁生效） |
| `docs/facts/功能清单.md`、`docs/状态.md` | 同步 |

**明确不改**：判定三态与三档策略、心跳格式、0.1.7 的「避让路径零窗口创建」、手动隐藏/横幅语义。

## 四、预期行为

1. `startup.log` 里每次隐藏/现身都有一条 `[avoid] … reason=…`，能直接归因。
2. 光标停在屏幕最顶边、但横向不在岛的位置：岛只出现一次，随后收起并保持隐藏，**不再闪烁**（要再唤回得先把光标移离顶部）。
3. 从真全屏退出后，岛在约 1.2~1.5 秒后现身；从普通最大化还原仍是约 0.3 秒。
4. 其余三档策略、延迟（隐藏 285~330ms）、摸边、手动隐藏、横幅行为不变。

## 五、验收条件

| 编号 | 条件 | 判定方式 |
|---|---|---|
| S1 | 隐藏/现身都留归因日志 | 手动造「最大化→隐藏」「光标到顶→现身」，读 `startup.log` |
| S2 | 摸边不再闪烁 | `e2e-avoid-mode` M9（5 秒内新增 `[avoid]` ≤ 3 条） |
| S3 | 日常现身不变迟钝 | `e2e-avoid-mode` M5 现身 ≤1000ms（从 Z 回来走 150ms 路径） |
| S4 | 三档与判定精度不回归 | `e2e-avoid-mode` 全绿、`e2e-fullscreen-avoid` 8/0、`e2e-fullscreen-misjudge` 7/0 |
| S5 | 类型检查/构建 | `typecheck`/`build` EXIT=0 |
| S6 | **真实触发源确认** | **需用户复现一次并回传 `%APPDATA%\lingdong-island\startup.log`**（日志里的 reason 直接指出是谁叫出来的） |

## 六、不做什么

- 这一轮**不猜**触发源（可能是横幅、可能是前台抖动、可能是游戏自身切前台）；先把证据做实。
- 不因为「怕踢游戏」就把全屏下的横幅/摸边一刀砍掉——等日志确认是哪一种之后，再决定要不要在独占全屏时改成「延后显示」。
- 不改判定与三档；不在 `main` 上直接提交。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-18 | [实测] 造「最大化窗口 + 光标停在顶部右侧（1500,0）」并读 `startup.log` | **修前**：0.6 秒内 4 条 `hide/show` 交替（闪烁循环）；**修后**：9 秒内只有 2 条（一次 `show reason=cursor-top`、一次 `hide reason=cursor-left`），之后保持安静 | — |
| 2026-11-18 | [实测] `npm run typecheck` / `npm run build` | EXIT=0 | — |
| 2026-11-18 | [实测] `node scripts/e2e-avoid-mode.mjs` | **14 过 / 0 败**（新增 M9「光标停在顶部边缘不反复唤回/收起：新增 0 条 avoid 事件」；M5 现身 325/320/319ms —— 说明从 Z 回来的快路径没被拖慢） | — |
| 2026-11-18 | [实测] `node scripts/e2e-fullscreen-avoid.mjs` / `e2e-fullscreen-misjudge.mjs` | 8/0、7/0 | — |
| — | 未做 | — | **用户那台机器上的真实触发源**：需要复现一次并回传 `startup.log`（S6）；本轮无法确认「每隔几分钟」到底是横幅、前台抖动还是别的。 |
