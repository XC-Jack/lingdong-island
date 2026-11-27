# SPEC：修掉展开瞬间岛被窗口裁成「宽扁条」

- 建立日期：2026-11-26
- 基线：`main` `f2c527c`（v0.6.1）
- 任务分支：`fix-island-expand-clip`
- 用户原话：「下载目录中有一个最新的视频，是我在另一台电脑的使用情况，出现了一个 bug，就是岛在展开的时候的问题，请解决」

## 一、目标

展开岛时不再出现「内容被窗口裁成顶部一条、约 0.2 秒后才恢复」的中间态。岛与窗口在展开过程中同步长大，任何一帧都不允许岛超出窗口。

## 二、现象与根因

**现象 [实测，用户视频 `37af5d334292c6b393e54428e09dd49c.mp4`，1280×720 / 30fps]**：点击岛后约第 32–37 帧（≈0.2 秒）岛只剩一条宽扁带（宽约完整面板的 75%、高约 18%），第 38 帧起才变成完整面板。

**根因一 [实测，本机 CDP 逐帧探针 `.tmp/repro-expand.mjs`]**：展开瞬间 `.island.expanded` 的宽高立即到位（t=28ms 已是 229×222 视觉 px），而窗口仍在从收起尺寸补间（t=28ms 窗口 172×76），直到 t≈262ms 才追到 256×248。这 230ms 里岛比窗口大，被 `.island { overflow: hidden }` 裁掉，屏幕只剩左上角一块。

- 直接成因：`.island.island-anim-open` 写了 `transition: none`（`styles.css`），把 `.island` 原有的 220ms 宽高过渡关掉，尺寸瞬间跳到终值。
- 宽度还有一层：收起态 `.island.collapsed` 是 `width: max-content`，展开态是 `width: 340px`。`max-content` 与长度之间不可插值，即使不写 `transition: none`，宽度也会跳变。

**根因二 [实测，主进程临时探针 `.tmp/probe-main-log.mjs`]**：`island:backdrop` 的 `desktopCapturer.getSources()` 在主进程阻塞 **135–192ms**（连续 3 次实测 192 / 166 / 135 ms），把 16ms 的补间定时器卡住——补间首帧 t=96302 之后，下一帧直到 t=96413 才执行（108ms 空档）。于是「窗口不动、岛已展开」的裁切态被拉长到接近半秒，弱机上更明显（用户那台机器即为此）。

## 三、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | 展开时先把岛宽度钉成当前收起态的布局 px，下一帧解除，让宽度可插值过渡；`island:backdrop` 拉取在展开入场期间跳过 |
| `src/renderer/src/styles.css` | `.island.island-anim-open` 由 `transition: none` 改为与窗口补间同向的宽高过渡（略慢于窗口，保证岛始终 ≤ 窗口） |
| `src/main/index.ts` | 补间进行中（`tweenTimer` 非空）时 `island:backdrop` 直接返回 `null`，抓屏不再阻塞补间定时器 |
| `docs/facts/视觉设计规范.md`、`docs/状态.md` | 同步「开合动画」条款与本轮记录 |

## 四、预期行为

1. 展开：窗口 220ms 单调补间到目标尺寸；岛宽高用**略慢于窗口**的同向过渡从收起尺寸长到面板尺寸，任一帧岛都不超出窗口，屏幕上看不到被裁的扁条。
2. 收起：窗口 220ms 单调缩小；岛同步收缩回胶囊，同样不出现岛超出窗口的帧。
3. 展开入场期间不抓屏，展开稳定后按原节奏恢复（展开态 1.5s / 收起态 5s）。
4. 切页（网格 ⇄ 功能页）仍是 `setBounds` 一次到位 + `nav-snap`，不受本次改动影响。
5. 收起态宽度自适应（随电量/网络等内容变化）保持不变。

## 五、必要依赖

无。

## 六、验收条件

- A1 `npm run typecheck` / `npm run build` 通过。
- A2 逐帧探针：展开全过程每一帧 `island` 的 `getBoundingClientRect()` 宽高都 ≤ 窗口 `innerWidth/innerHeight`（允许 1px 取整误差），最终尺寸与改动前一致（网格 255×247.5 视觉）。
- A3 真屏幕抓帧：点击展开后逐帧检查，无「只有页头一条」的中间帧。
- A4 补间不被阻塞：主进程补间相邻两帧间隔 ≤ 40ms（不再出现 100ms 级空档）。
- A5 回归：`e2e-head-order`、`e2e-todo-today`、`e2e-schedule-day`、`e2e-notify`、`e2e-music`、`e2e-pages-custom` 全过。
- A6 用户预览确认观感。

## 七、不做什么

- 不改每页固定尺寸（`SPEC-fixed-page-size`）与切页 `nav-snap` 机制。
- 不改收起态内容、宽度上下限与主进程 `COLLAPSED_WIN_HEIGHT`。
- 不改成「窗口一次 setBounds + 纯 CSS 动画」：`SPEC-island-motion` 已实测透明窗跳变后合成器几百毫秒不呈现新画面。
- 不合并 `main`、不打包、不发版。

## 八、自检记录（2026-11-26）

**根因复核 [实测]**（本机 1536×960，125% 缩放）：

1. 用户视频逐帧：点击后第 32–37 帧（30fps，≈0.2 秒）岛只剩一条宽扁带，第 38 帧恢复。
2. CDP 逐帧探针 `.tmp/repro-expand.mjs`：`t=28ms` 岛已是 229×222 视觉 px，窗口仍 172×76；窗口到 `t≈262ms` 才追到 256×248。
3. 主进程临时探针 `.tmp/probe-main-log.mjs`：补间首帧 `t=96302` 之后下一帧 `t=96413`，中间 **108ms 空档**；同时 `island:backdrop` 的 `desktopCapturer.getSources` 连续三次耗时 **192 / 166 / 135 ms**。

**实现 [实测]**：

- `styles.css`：新增 `.island.expanded.island-entrance`（`width/height: var(--entrance-*)`、放开 min/max、关过渡），排在 `.island.expanded.page-*` 之后靠顺序压过固定页高；`.island-anim-open` 保留 0.9→1 缩放与淡入关键帧。
- `App.tsx`：新增 `ZOOM = 0.75`、`entranceFromRef` / `entranceToRef`；展开时同步写入起点宽高；`entrance === 'open'` 期间每帧按 `innerWidth/innerHeight` 在起点→终点之间取进度写 `--entrance-w/h`（布局 px = 视觉 px ÷ 0.75）；入场结束移除变量。
- `main/index.ts`：`island:backdrop` 在 `tweenTimer` 非空时返回 `null`。

**验证 [实测]**：

- A1 `npm run typecheck` / `npm run build` EXIT=0。
- A2 逐帧探针：展开 65 帧、收起 50 帧，**超出窗口 0 帧**；最终尺寸与改动前一致（网格 255×247.5、收起 168.1×39.0），入场结束后内联变量已清空（`style` 为空）。
- A3 真屏幕 60fps 录屏（`.tmp/repro-record.mjs` + ffmpeg gdigrab）：逐帧检查无「只有页头一条」的中间帧，岛从胶囊连续长大成完整面板。
- A4 主进程补间相邻帧最大间隔 **39ms**（改动前 108ms 空档）。
- A5 回归：`e2e-head-order` 14/0、`e2e-todo-today` PASS、`e2e-schedule-day` PASS、`e2e-notify` PASS、`e2e-music` 17/0/3 跳过、`e2e-pages-custom` 7/0。
- 对照实验（已回退）：把开合改成一次 `applyBoundsNow` 后，60fps 录屏显示岛整个消失约 0.2–0.3 秒，复现了 SPEC-island-motion 记录的「跳变后不呈现」；确认不能走这条路。

**未验证**：

- 用户那台电脑（视频来源机）的真机观感；
- 高 DPI（本机 125%）、多显示器、非主屏；
- 展开期间刚好触发抓屏的极端时序（已用补间期跳过规避，但未构造该竞态）。

## 九、验收记录

**用户预览确认（2026-11-27）[实测]**：起预览版（分支 `fix-island-expand-clip`，提交 `52fafaf`）给用户，用户看过展开效果后回复「可以」，视为验收通过并授权合并回 `main`。

**未做独立验收**：按工程规则第三节第 5 条（按批验收），本项随下一批统一做一次独立验收；本轮只完成研发自检 + 用户预览确认。
