# SPEC：桌宠自由走动改为随机漫步

- 建立日期：2026-11-14
- 基线：`main` `3cd16c7`（桌宠两种模式统一图片边界，已打包装机）
- 任务分支：`deskpet-walk-roam`
- 用户原话（m02689）：「他现在的走咯逻辑还是太差了，一直绕屏幕走没有什么不同」
- 上一轮 SPEC：`docs/Spec/SPEC-deskpet-walk-polish.md`（巡边贴边，用户已验收并装机）
- 我给的方向（m02691）：改成随机漫步——每次随机挑个目标（屏幕中间或靠边的点），斜着走过去、到了随机停一会儿再换目标，路线不再重复；边界仍按桌宠图片算，偶尔也能贴住边。用户未否决，按「要变化」开工。

## 一、目标

把自由走动（free）从「四条边依次巡边、固定右→下→左→上循环」改成「随机漫步」：

1. 路线不再重复：每次停下后重新随机挑目标点，目标在按桌宠图片算出的允许范围内，可落在屏幕中间，也可贴某一条边。
2. 方向随意：朝目标直线走（可斜走），不再是四个纯方向轮换；方向变化仍推给渲染层切视图（横向优先：右3/左1/上2/下0）。
3. 节奏有变化：每段停顿时长随机（约 0.5～3 秒），每段步速随机（1～3px/帧），不再是固定 1.5 秒 + 固定 40px/秒。
4. 保留「两个统一，都可以碰边」（m02392）：边界仍用 `prefsStore.ts` 的 `PET_IMG_PAD_X/Y` 共享常量，独立小窗口的拖动/重启与自由走动同一套；自由走动仍有机会贴到四条边（开局第一段先朝最近的一条边直走，之后随机目标里有相当比例贴边）。
5. 保留既有语义：走停交替、拖动冻结、松手恢复、不逐帧写盘、`setBounds` 显式带尺寸防 125% 缩放漂移、岛里不出现两只、托盘回岛、设置页三档全可选。

诊断 [已核验]：当前 `src/main/petWindow.ts:190-277` 的 `startWalk()` 是「巡边」——开局选最近的边、贴住后停 30 帧（1.5 秒）、`walkSeq = (walkSeq + 1) % 4` 固定换下一条边，四边无限循环。路线完全可预测，就是用户说的「一直绕屏幕走没有什么不同」。`walkLimits()`（`:157-174`）与 `clampPetPos()` 共用 `PET_IMG_PAD_X=45` / `PET_IMG_PAD_Y=42`，不动。

口径 [推断]：把「太差、没什么不同」理解成「路线固定绕圈、缺变化」，改随机目标 + 随机停顿 + 随机步速。最可能错在用户其实想保留贴边巡边、只嫌节奏太规整——那样只需加随机停顿和速度（m02691 已给用户这个备选，说一声即可改回）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/petWindow.ts` | 走动基础设施：保留 `WALK_DIRS`/`walkSeq` 仅用于首段贴边，新增 `walkMode: 'edge'/'roam'`、`walkTarget`、随机停顿 `walkRestTicks`、随机步速 `walkStep`、`pickRoamTarget()` / `randomizeWalkPace()`；`startWalk()` 首段仍朝最近边（保贴边能力），之后改为朝随机目标斜走、到达后随机停再换目标 |
| `src/renderer/src/settings/DeskPetSection.tsx` | free 的 `desc` 与底部 tip 文案从「沿四条边溜达」改成「随机溜达、路线不重复」 |
| `src/preload/index.ts` | `onPetWalk` 注释：方向仍是左/右/上/下 + idle（斜向按主导分量归类），随机漫步不改变协议 |
| `src/renderer/src/petwin/PetWindowApp.tsx` | 注释同步「随机漫步」，方向→视图映射不变 |
| `scripts/e2e-deskpet-out.mjs` | P13 段注释从「巡边四边」改成「随机漫步（首段贴近边 + 之后随机目标）」；P13a–P13h 断言保持不变（见五） |
| `docs/facts/功能清单.md` | `:93` free 条改成随机漫步描述（保留共享留白常量与两模式统一边界） |
| `docs/状态.md` | 顶部插入本轮一句话状态 |
| 本 SPEC | 自检记录（待填）、验收记录（留空） |

明确不改：`src/main/prefsStore.ts`（共享留白常量与 `clampPetPos` 不动）、`src/main/index.ts`、`src/renderer/src/App.tsx`、`src/shared/types.ts`（`PET_MODES` 值不变）、`src/renderer/src/pet/*`（皮肤/视图）、`src/renderer/src/petwin/petwin.css`（颠动动画）、`src/preload/index.d.ts`、`pet:walk` 协议本身、通知页、历史 SPEC-deskpet-*。

## 三、预期行为

1. 切到「自由走动」：窗口出现，第一段朝离当前位置最近的一条边直走，几秒内真的贴住那条边（沿用上一轮验收语义，也让 e2e P13g 的运行时贴边断言仍成立）。
2. 贴边后停一段随机时长（0.5～3 秒），转回正面。
3. 之后每段：随机挑一个目标点（约三成概率把某一轴钉在边极限上、七成落在屏幕内部），以随机步速（1～3px/帧）朝它直走，可斜走；方向变化推给渲染层切对应视图并带上下颠动。
4. 到达目标后停随机时长，再换下一个随机目标；路线不再固定循环，长时间看不会重复同一圈。
5. 位置始终在 `walkLimits()` 内（按桌宠图片算，透明留白可越出工作区）；撞到允许范围边界时钳制，不会卡死。
6. 拖动期间冻结走动、松手恢复；位置只在手动拖动松手时落盘；切回 island/window 停走并关窗/停窗。
7. 渲染层协议不变：`pet:walk` 仍推 `'left'|'right'|'up'|'down'|'idle'`，斜向按主导分量（横向优先）归类。

## 四、必要依赖

无新增依赖。复用：`Math.random()`、`walkLimits()` / `PET_IMG_PAD_X/Y`（`prefsStore.ts`）、`setBounds({..., width, height})`、`clampPetPos()`、`pet:walk` IPC、`pet:turn-abs` 自定义事件与 `.petwin.walking .pet-wrap` 颠动动画。

## 五、验收条件

- A1 [已核验] `npm run typecheck` EXIT=0、`npm run build` EXIT=0。
- A2 `node scripts/e2e-deskpet-out.mjs` 全绿：P13a–P13h 保持通过——P13c/d 首段方向与朝向、P13e 窗口自己移动、P13f 尺寸不漂移、P13g 共享常量源码断言 + 左/右/上/下四条运行时真贴边 + 每条边方向/朝向、P13d2 四方向都走过、P13h 切回 island 关窗。P11a/P11b/P11c（独立小窗口按图片边界贴边）不破。
- A3 回归 `e2e-deskpet.mjs` / `e2e-collapse-order.mjs` / `e2e-head-order.mjs` 全绿。
- A4 随机性由源码断言 + 运行时采样证明：源码含 `pickRoamTarget` / `Math.random()` / 随机停顿与步速；运行时在足够长采样里坐标轨迹不是「四边固定循环」（至少出现屏幕内部停留点或斜走段）。
- A5 无残留旧口径：源码与 e2e 注释不再写「四边依次巡边 / 固定循环」。
- A6 两模式统一边界不被破坏：`prefsStore.ts` 的 `PET_IMG_PAD_X/Y` 仍是唯一真源，`clampPetPos` 与 `walkLimits` 共用。
- A7 未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 三.5 攒批）；预览版给用户试 → 用户确认 → 合并 / 装机各需单独授权。
- A8 只有真人能验：路线看起来是否真的「有变化、不呆板」，停顿/速度是否舒服，会不会打扰人。

## 六、不做什么

1. 不改窗口尺寸（190×250）、不重抠素材、不生成走路逐帧动作。
2. 不改 `prefsStore.ts` 的共享留白常量与 `clampPetPos()`，不破坏两模式统一边界。
3. 不改 `pet:walk` 协议、不改渲染层方向→视图映射、不改 CSS 颠动动画。
4. 不新增偏好字段、不改 `PET_MODES` 值、不改设置页三档结构。
5. 不做寻路/避障/多屏跨屏、不引入外部随机库。
6. 不顺手重构无关代码、不重写历史 SPEC。
7. 不合并、不打包、不装机、不做独立验收。

## 自检记录

命令均在 `D:\Users\honor\Documents\Project\灵动岛`（分支 `deskpet-walk-roam`）执行，跑 e2e 前先 `Get-Process electron | Stop-Process -Force`：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | [已核验] EXIT=0（tsconfig.node.json / tsconfig.web.json 都过） |
| `npm run build` | [已核验] EXIT=0（`pet-DvW6_AwQ.js` 11.90 kB、`index-BvE1zjjf.js` 102.21 kB、`vendor-DeLoXG_s.js` 564.37 kB） |
| `node scripts/e2e-deskpet-out.mjs` | [已核验] `E2E DESKPET-OUT: PASS（102 过 / 0 败）` OUT_EXIT=0 |
| `node scripts/e2e-deskpet.mjs` | [已核验] `PASS（34 过 / 0 败）` |
| `node scripts/e2e-collapse-order.mjs` | [已核验] `PASS（22 过 / 0 败）` |
| `node scripts/e2e-head-order.mjs` | [已核验] `PASS（14 过 / 0 败）` |

关键证据 [已核验]：
- P13i（源码含 `pickRoamTarget` / `Math.random()` / `randomizeWalkPace` / `walkRestTicks = 10 + ...` / `walkStep = 1 + ...` / `walkMode = 'roam'` / `Math.hypot(dx, dy)`）、P13i2（` (walkSeq + 1) % WALK_DIRS.length` 已删）、P13j（运行时 18 秒采样出现斜走段或屏幕内部停留点）全绿。
- P11a/P11b/P11c（独立小窗口按图片边界贴边）、P13a–P13h（含 P13g 共享常量源码断言 + 左/右/上/下四条运行时真贴边 + 每条边方向/朝向、P13d2 四方向都走过）全绿＝首段「朝最近边直走、真贴住才停」未被随机漫步破坏，两模式统一边界未被破坏。
- 本轮未改产品侧边界/尺寸/协议代码，只改走动 Segment 逻辑与文案/注释/测试。

未核验边界 [未核验]：真实观感（路线是否真的「有变化、不呆板」、停顿/速度是否舒服、会不会打扰人）只有真人预览版能验；多显示器行为未验；未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 三.5 攒批）。

## 验收记录

（留空：按批攒独立验收，本轮不做）
