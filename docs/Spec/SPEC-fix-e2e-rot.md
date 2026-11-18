# SPEC-fix-e2e-rot：修掉三处测试腐化与不可独立运行的 e2e

- 日期：2026-11-18
- 分支：`fix-e2e-rot`
- 来源：`docs/验收清单-0.1.9.md` 第 47~50 行记录的 4 个未通过项（11-18 机械复测，40/44 通过）

## 一、目标

让这批 e2e 单独执行时的结果如实反映产品状态，不再用「假红」或「环境不满足」冒充失败：

1. `e2e-battery-states` / `e2e-battery-push` 的白色电量弧期望常量与产品当前样式对齐（2026-11-16 美化轮改色后测试未同步）。
2. `e2e-reorder` 不再要求人工先起 9225 实例：无实例时自动交给已有的启动包装 `e2e-reorder-run.mjs`，单独跑也能真实执行断言。
3. `e2e-music-session` 在无法构造「多会话且播放中会话不在索引 0」的前置场景时，明确输出 `SKIP` 并以 0 退出，而不是把前置不成立报成功能失败。

## 二、修改范围

只改 `scripts/` 下的 5 个文件，**不碰 `src/` 与 `package.json`**：

| 文件 | 改动 |
|---|---|
| `scripts/e2e-battery-states.mjs` | `WHITE` 常量 `rgba(255,255,255,0.85)` → `0.98` |
| `scripts/e2e-battery-push.mjs` | 同上 |
| `scripts/e2e-reorder.mjs` | 连不上 9225 且非包装启动时，委派 `e2e-reorder-run.mjs` 起实例后重跑；更新头注释 |
| `scripts/e2e-reorder-run.mjs` | 启动本脚本时带 `E2E_REORDER_WRAPPED=1`，防止递归委派 |
| `scripts/e2e-music-session.mjs` | 场景前置（`SESSIONS>=2` 且 `PLAYING_IDX>0`）不成立时整轮 SKIP，退出码 0，并打印实测值 |

## 三、预期行为

1. `node scripts/e2e-battery-states.mjs` 在 80% 不充电场景下，弧色断言读取到 `rgba(255, 255, 255, 0.98)` 并全部通过；绿色/红色常量不动（本就与样式一致）。
2. `node scripts/e2e-battery-push.mjs` 同理通过。
3. 直接 `node scripts/e2e-reorder.mjs`：若 9225 无实例，打印一行说明后由包装脚本起隔离实例执行，最终结果与 `node scripts/e2e-reorder-run.mjs` 一致；包装内部不出现无限递归。
4. `node scripts/e2e-music-session.mjs`：场景构造成功时照旧跑 S1~S19；构造失败时只打印 `E2E MUSIC SESSION: SKIP（…）` 与实测 `SESSIONS` / `PLAYING_IDX`，退出码 0，且**不再把前置断言计为失败**。

## 四、必要依赖

无新增依赖；复用现有 `scripts/isolate-userdata.mjs` 与 `e2e-reorder-run.mjs`。所有脚本仍走项目约定的 CDP 端口与隔离 userData。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `git diff main -- src/ package.json` 为空 |
| A2 | `e2e-battery-states` 退出码 0，且输出含「S1 弧白色」✓ |
| A3 | `e2e-battery-push` 退出码 0 |
| A4 | 未起实例时直接跑 `e2e-reorder`，退出码 0，输出含 `E2E REORDER PASS` |
| A5 | `e2e-reorder-run` 退出码 0，输出 `E2E REORDER WRAPPER PASS`，只起一棵实例进程树 |
| A6 | `e2e-music-session` 退出码 0；输出要么全部断言通过，要么明确 `SKIP` 并附 `SESSIONS` / `PLAYING_IDX` 实测值 |
| A7 | `npm run typecheck` EXIT=0（确认脚本改动未牵连类型检查） |

## 六、不做什么

- 不改电量弧颜色、不改 `styles.css`、不改任何产品行为。
- 不删除 `e2e-reorder.mjs`（它是 `e2e-reorder-run.mjs` 的被测主体，且多份历史 SPEC 引用它）。
- 不修 `e2e-music-session` 的构造失败本身（属本机 SMTC 环境限制，非产品缺陷）；不改 `e2e-music` 主脚本。
- 不顺手改其它 e2e、不做全量回归（受影响路径跑一遍即可，全量留到批量验收）。

## 七、自检记录

自检日期 2026-11-18，分支 `fix-e2e-rot`，工作树改动只含 `scripts/` 5 个文件 + 本 SPEC。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | **EXIT=0**（node + web 两段 tsc 均无报错） |
| `node scripts/e2e-battery-states.mjs` | **EXIT=0，31 过 / 0 败**（`S1 弧白色` ✓） |
| `node scripts/e2e-battery-push.mjs` | **EXIT=0，23 过 / 0 败** |
| `node scripts/e2e-reorder.mjs`（未预起 9225 实例） | **EXIT=0**，输出 `[bootstrap] 9225 端口无实例…` → `E2E REORDER PASS` → `E2E REORDER WRAPPER PASS`（自动委派生效，未递归） |
| `node scripts/e2e-reorder-run.mjs`（独立重跑） | **未通过，非代码原因**：子进程 V8 报 `Check new_pages != nullptr failed: VirtualAlloc failed`，退出码 `3221226505 (0xC0000409)`。实测当时系统提交内存仅剩约 295 MB（限额 15.7 GB，已用 15.55 GB），属本机内存不足。同一包装路径已在上一行 A4 的委派运行中实际执行并打印 `WRAPPER PASS` |
| `node scripts/e2e-music-session.mjs` | **EXIT=0，20 过 / 0 败**（本次成功构造多会话场景，S1~S19 全跑） |
| `git diff main -- src/ package.json` | 空（未触碰产品代码与依赖） |

**未验证**：

1. `e2e-music-session` 的 **SKIP 分支**本次未被触发（本机这次场景构造成功）；代码路径为「前置不成立 → 抛 skip → finally 清理 → exit 0」，未单独注入故障验证。
2. `e2e-reorder-run.mjs` **独立启动**在内存充足机器上的表现；本机两次尝试均因系统提交内存不足在进程创建阶段失败。
3. 未跑全量 44 个 e2e（按 SPEC 第六节，只跑受影响路径；全量留到批量验收）。

## 八、验收记录

（待独立验收填写）
