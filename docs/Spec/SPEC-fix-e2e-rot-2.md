# SPEC-fix-e2e-rot-2：修第二批测试腐化（颜色断言、展开首屏、音量时序、taskkill）

- 日期：2026-11-27
- 分支：`fix-e2e-rot-2`
- 来源：2026-11-27 批量独立验收（基线 `83931f9`）。全量 47 个 e2e 中 9 个失败，经逐个定位，**0 个是产品回归**，全部是测试脚本腐化或环境问题。结论见 `.tmp/acceptance-e2e-triage.md`。

## 一、目标

让这批 e2e 单独执行时的结果如实反映产品状态，消除「产品正确但测试长期假红」的噪声，使后续开发的回归信号可信：

1. 电量类颜色断言不再写死旧色值，改为读当前主题 token 并算 RGB 距离（与 `e2e-beautify-04` 2026-11-27 的修法一致）。
2. 依赖「展开后直接进功能页」的断言，按 SPEC-island-widget-grid 之后「展开先进组件网格」的新结构修正。
3. 音乐页音量断言消除「取 state 与读 UI 分两次采样」造成的时序竞态。
4. 通知类脚本收尾 `taskkill` 对已退出进程报错，不再把脚手架问题算成测试失败。

## 二、修改范围

只改 `scripts/` 下的文件，**不碰 `src/` 与 `package.json`**：

| 文件 | 改动 |
|---|---|
| `scripts/e2e-color.mjs` | 新增（共用颜色工具，非测试） |
| `scripts/e2e-battery-states.mjs` | 颜色断言改为读 `--ink-1` / `--ok` / `--danger` token |
| `scripts/e2e-battery-push.mjs` | 同上 |
| `scripts/e2e-bell-notify.mjs` | N4 断言按「展开先进网格」修正 |
| `scripts/e2e-wifi.mjs` | A4 断言同上（网格态头部无 `.head-pet`） |
| `scripts/e2e-music.mjs` | M2l 在同一次 eval 内同时取 state 与 UI |
| `scripts/e2e-notify-clear.mjs` | `stopApp` 吞掉 taskkill 非零退出 |
| `scripts/e2e-notify-compact.mjs` | 同上 |
| `scripts/e2e-notify-live.mjs` | 同上 |

## 三、预期行为

1. `e2e-battery-states` / `e2e-battery-push`：四个场景（普通/充电/充电低电/低电）的弧色与数字色断言，在任何主题下都跟随实际 token；换主题不再假红。
2. `e2e-bell-notify`：N4 反证改为「只点胶囊空白处 → 展开，且不是通知页」，不再要求落在第一页（待办）。
3. `e2e-wifi`：A4 在网格态下不再要求 `.head-pet`，改为断言网络图标在 `.head-info` 内。
4. `e2e-music`：M2l 的 `canVolume` 与 UI 状态在同一帧读取，不再因 `canVolume` 从 false 翻 true 而误判。
5. 三个通知脚本：断言照常执行，收尾 kill 失败不再导致退出码 1。

## 四、必要依赖

无新增依赖。新增 `scripts/e2e-color.mjs` 为纯 ESM 工具模块，被电池两个脚本 import。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `git diff main -- src/ package.json` 为空 |
| A2 | `node scripts/e2e-battery-states.mjs` 退出码 0，四场景全过 |
| A3 | `node scripts/e2e-battery-push.mjs` 退出码 0，P3 全过 |
| A4 | `node scripts/e2e-bell-notify.mjs` 退出码 0 |
| A5 | `node scripts/e2e-wifi.mjs` 退出码 0 |
| A6 | `node scripts/e2e-music.mjs` 退出码 0（47 过 / 0 败或明确跳过） |
| A7 | 三个 `e2e-notify-*` 退出码 0 |
| A8 | `npm run typecheck` EXIT=0 |

## 六、不做什么

- 不改任何产品行为、不改 `styles.css`、不改主题 token。
- 不放宽断言到「永远为真」：颜色断言必须保留「取不到 token 就判失败」的严格性。
- 不修 `e2e-music-session` 的 SKIP 分支（本机环境限制，非腐化）。
- 不顺手改其它 e2e；不跑全量（只跑受影响路径，全量留到下次批量验收）。

## 七、自检记录

自检日期：2026-11-27。分支 `fix-e2e-rot-2`。

| 验收项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| A1 | `git diff main -- src/ package.json` | **通过** | 输出为空；`git diff main --stat` 只有 8 个 `scripts/` 文件 |
| A2 | `node scripts/e2e-battery-states.mjs` | **通过** | `== 结果：31 过 / 0 败 ==`，EXIT=0；四个场景全部走 token 距离断言 |
| A3 | `node scripts/e2e-battery-push.mjs` | **通过** | `== 结果：23 过 / 0 败 ==`，EXIT=0；P3-2/4/10/14/17/20 全部改为 token 判定 |
| A4 | `node scripts/e2e-bell-notify.mjs` | **通过** | `== 结果：15 过 / 0 败 / 0 跳过 ==`，EXIT=0；N4 改为「展开在组件网格且不是通知页」 |
| A5 | `node scripts/e2e-wifi.mjs` | **通过** | `E2E WIFI PASS`，EXIT=0；A4 不再要求 `.head-pet` |
| A6 | `node scripts/e2e-music.mjs` | **通过（M2l 未执行）** | `E2E MUSIC: PASS（17 过 / 0 败 / 3 跳过）`，EXIT=0。**本机无 SMTC 会话，M2l 落在跳过分支内，改动后的代码路径本次未跑过** |
| A7 | 三个 `e2e-notify-*` | **通过** | clear `7 过 / 0 败`、compact `2 过 / 0 败`、live `1 过 / 0 败`，均 EXIT=0 |
| A8 | `npm run typecheck` | **通过** | `typecheck:node` 与 `typecheck:web` 均无输出，EXIT=0 |

### 未验证项（如实记录）

1. **`e2e-music` 的 M2l 改动未被执行**：本机真实 SMTC 会话数为 0，脚本走「跳过」分支。改动本身是语法正确的，且 `npm run typecheck` 通过，但「轮询到 canVolume 与 UI 一致」这条路径**没有实际跑过**。等本机有播放器会话时再验证。
2. **A1 之外没有验证产品行为**：本次不碰 `src/`，所以产品行为按定义未变；没有重新打包、没有重装、没有推送。
3. **没有跑全量 e2e**：按 SPEC 六、只跑受影响路径。全量留到下次批量验收。
4. **`e2e-fullscreen-misjudge` 未纳入本次范围**：它是串行跑时的前台窗口竞争偶发（单独连跑 3 次均 7 过 / 0 败），不是脚本腐化，不在本 SPEC 修改范围内。

### 断言有效性（反证）

`e2e-battery-states` 做过一次负对照：把断言用的 token 从 `--ink-1`/`--ok`/`--danger` 换成 `--accent-ink` 后重跑，结果 **24 过 / 7 败**（颜色相关断言全部失败）。证明这批断言有判别力，不是「改成永远为真」的假通过。

## 八、验收记录

（待独立验收填写）
