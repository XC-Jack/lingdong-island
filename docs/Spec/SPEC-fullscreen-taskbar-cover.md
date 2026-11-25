# SPEC：按「任务栏是否被盖住」识别真全屏（VS Code F11 误判为最大化）

日期：2026-11-25　分支：`fix-avoid-self-foreground`

## 1. 目标

用户在 VS Code 里按 F11 进全屏后，岛仍然能被摸顶边唤回；按用户口径这属于「全屏：隐藏且不唤回」。
把这类窗口正确判成 `F`，同时不改变「普通最大化（任务栏仍显示）可唤回」的行为。

## 2. 修改范围

- `src/main/fullscreenWatch.ts` 的 `probeCs()`：`Probe()` 里 F 的判据加上「盖住任务栏」这一条。
- `scripts/e2e-fullscreen-avoid.mjs`：新增 A2c 回归（无边框最大化 = 盖住任务栏但 `IsZoomed=true`）。
- `docs/facts/功能清单.md`：补判据说明。
- 不改三档语义、不改唤回阈值、不改 UI。

## 3. 预期行为

- 前台窗口盖住整屏 且（`IsZoomed=false` **或** 盖住任务栏面积 ≥ 一半）→ `F`：隐藏，摸边不唤回。
- 前台窗口只盖住工作区（任务栏可见、未被盖）→ `Z`：隐藏，摸边可唤回。
- 任务栏自动隐藏时（工作区 = 整屏）：仍按 `IsZoomed` 区分，行为与改动前一致。

## 4. 必要依赖

无新增依赖。新增一个 `FindWindowW` 声明（user32），仍不加载 WinForms。

## 5. 验收条件

1. 真机 VS Code F11（前台 rect=0,0,1920,1200、`IsZoomed=True`、任务栏被盖住）→ 心跳判定 `F`，摸顶边不唤回。
2. 同一台机器上普通最大化窗口（rect 底部停在任务栏之上）→ 判定 `Z`，摸顶边可唤回、移开回隐。
3. 原有回归全绿：`e2e-fullscreen-avoid`（含 A2b）、`e2e-avoid-mode`、`e2e-fullscreen-misjudge`。

## 6. 不做什么

- 不改「窗口最大化是否避让」的三档语义，不改默认档。
- 不处理多显示器下非主屏任务栏的细节（保持现有主屏基准）。
- 不动摸边唤回的 `REVEAL_Y` / 闩锁参数。
