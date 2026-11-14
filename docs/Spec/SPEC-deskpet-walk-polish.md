# SPEC：桌宠自由走动优化（窗口贴边 + 上下走）

- 建立日期：2026-11-14
- 基线：`main` `8d1a78d`（桌宠自由走动已合并，装机待确认）
- 任务分支：`deskpet-walk-polish`（从 `main` 建，固定提交 `929be7b` 为上一版）
- 上一轮：`SPEC-deskpet-walk.md`（`5438e11` → 合并 `4a416e9`）
- 用户原话（m01838）：「说几个问题：1、就是这个桌宠的那个透明窗口有点大了，碰不到桌面端边界；还有就是行走的逻辑太呆板了，现在只会左右走，上下走不会，不过这个后面在弄也行，还有就是是不是要我去生成一点动作，给出你的想法，你再给我发的时候注意信息量，别发一推没用的给我」
- 用户定方向（m01841「可以，就按你的来」＋ m01845「开始」）：这轮做「窗口贴边 + 上下走」，动作素材不生成。
- 验收后反馈（m02126）：「上下左右走没什么问题，就是贴边不行，哪个方向都不行，还是有距离」。本文件按此反馈二次修订。
- 沟通口径：用户两次要求「注意信息量，别发一堆没用的」（m01812、m01838），回复要短、直接给结论。

## 一、目标

1. **上下走**（m01838）：从只有左右两个纯方向，扩成上 / 下 / 左 / 右都会走，不再「只会左右走、太呆板」。
2. **窗口贴边**（m01838 / m02126）：让桌宠**真的**贴住屏幕四条边，解决「哪个方向都不行，还是有距离」。
3. 去掉的候选「身材更像视频角色」保持去掉，桌宠玩法 / 长大版仍挂起；走路逐帧动作素材不生成（用户 m01841 同意先不加）。

### 贴边根因（[已核验]，用户 m02126 后按实际代码复核）

- `src/main/petWindow.ts` 上一版 `startWalk()`：`WALK_RUN_TICKS=60`（每段只走 3 秒 ≈ 120px）就定时换下一个方向，且开局朝屏幕中心走、8 个方向循环，位移互相抵消——桌宠永远在屏幕中间绕圈，**根本走不到边**；上一版加的「30px 留白越界」因此没机会被看到。
- `src/renderer/src/pet/skinPhoto.tsx:45–63,339–358`：SVG viewBox 160×160，桌宠图片本身只占中间约 84 宽、140 高，左右各约 38 画布单位；`src/renderer/src/petwin/petwin.css`：190×250 窗口里内容区 190×190 居中、上下各 30px 透明。scale=190/160=1.1875 换算，图片在窗口内约左 45、右 145、顶 42、底 208。旧 `walkLimits()` 只让纵向 30px 越界、横向一点没放宽——**就算窗口贴边，桌宠看起来离左右边还差 45px、上下约 42px**。
- 上一轮 `scripts/e2e-deskpet-out.mjs` 的 P13g 只**查源码字符串**就报绿（「假绿」），没验证运行时窗口真的贴到边。

### 改法（当前实现）

- 走动改「巡边」：`WALK_DIRS` 4 个纯方向（右 / 下 / 左 / 上，下标即目标边），开局选离当前位置最近的边，朝它一直走，**真的贴住那条边才停 1.5 秒换下一条边**；删掉定时换向与反弹。斜向去掉（斜走会先撞一条边、另一轴还没到，看起来仍贴不到边）。
- 边界按「桌宠图片」算：`WALK_PAD_X = 45`、`WALK_PAD_Y = 42`，`walkLimits()` 返回 `{ minX: area.x - WALK_PAD_X, maxX: area.x + area.width - (PET_WIN_W - WALK_PAD_X), minY: area.y - WALK_PAD_Y, maxY: area.y + area.height - (PET_WIN_H - WALK_PAD_Y) }`，让透明留白越出工作区，图片边缘正好贴屏幕边。**只用于自动走动**；拖动 / 重启仍走 `prefsStore.clampPetPos` 整窗可见（P11b 不破）。
- 方向→视图：复用 `pet:turn-abs` 与四视图（`skinPhoto.tsx` `VIEWS`：front0 / side-l1 / back2 / side-r3）。右=3、左=1、上=2（背面）、下=0（正面）、停=0（正面）。

[推断] 口径：不新增素材、不新增偏好字段、不改 190×250 窗口尺寸与旋转把手布局。最可能错在：用户其实只想把窗口整体缩小，或想让桌宠带走路动画——按「最小实现 + 不新增素材」处理，交付时说明。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/petWindow.ts` | 走动基础设施改为巡边：`WALK_DIRS` 4 纯方向、删 `WALK_RUN_TICKS`、`walkLimits()` 按 `WALK_PAD_X/Y` 放宽四边、`startWalk()` 朝边走到底贴住才停换边；drag-end 方向补发用 `currentWalkDir()` |
| `src/preload/index.ts` | `onPetWalk` 联合类型加 `'up' \| 'down'`（`IslandApi = typeof api` 自动带类型，`index.d.ts` 不动） |
| `src/renderer/src/petwin/PetWindowApp.tsx` | `walkDir` state 加 `up`/`down`；`onPetWalk` 映射补 上=2 / 下=0；`data-pet-walk` 不变 |
| `src/renderer/src/settings/DeskPetSection.tsx` | `free` 档描述 / tip 改为「沿四条边巡边、走到边贴住再换边」 |
| `scripts/e2e-deskpet-out.mjs` | P13 断言：方向∈{left,right,up,down}、朝向映射、纵向走动、二维移动；**P13g 改为运行时真贴边**（把窗口摆到各边附近重启走动，等窗口坐标到达按图片留白算出的极限），P11「整窗可见」不动 |
| `docs/facts/功能清单.md` | 岛仔 free 条改巡边 + 四边贴边说明 |
| `docs/状态.md` | 顶部一句话状态 |
| 本 SPEC | 六项 + 自检 / 验收记录 |

明确不改：`src/main/prefsStore.ts`（`clampPetPos` 保持整窗可见）、`src/renderer/src/pet/*` 皮肤源码、`src/preload/index.d.ts`、通知页、`src/main/index.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/petwin/petwin.css`（颠动动画沿用）、四份历史 `SPEC-deskpet-*`。

## 三、预期行为

1. 设置→桌宠→「自由走动」：宠物窗口打开，开局朝离当前位置最近的那条边直走，几秒内就能看到桌宠真的贴到屏幕边。
2. 贴住一条边后停约 1.5 秒（停下转回正面），再换下一条边（右→下→左→上循环）；四个方向都能贴住，不再绕圈。
3. 走动时切到对应方向视图并带轻微上下颠动；拖动期间冻结、松手恢复、不逐帧写盘。
4. window / island 模式行为不变：手动转好的朝向不被 `stopWalk()` 复位。
5. 托盘菜单「回到岛里」在 free 下仍显示、岛里不出现两只（上一轮已做，不变）。

## 四、必要依赖

无新增依赖、无新增素材、无新增偏好字段。复用：
- `setBounds` 显式带 width/height（125% 缩放下防窗口越走越大）
- `screen.getDisplayNearestPoint().workArea` 与 `screen.getPrimaryDisplay().workArea`
- `pet:walk` IPC 推送 + `pet:turn-abs` 自定义事件切四视图
- `.petwin.walking .pet-wrap` 的 `petwin-walk-bob` 颠动动画

## 五、验收条件

- A1 `npm run typecheck` EXIT=0、`npm run build` EXIT=0
- A2 `node scripts/e2e-deskpet.mjs` PASS（三档都可选，无残留禁用档）
- A3 `node scripts/e2e-deskpet-out.mjs` PASS：P11「整窗可见」仍成立；P13 能抓到 `up`/`down` 方向、朝向映射、二维位移、尺寸不漂移；**P13g 四条边运行时真贴边断言全绿**（不再只查源码）
- A4 回归 `e2e-collapse-order` / `e2e-head-order` PASS
- A5 grep 无残留「8 向 / 斜向 / 30px 留白 / 贴边只查源码」旧断言
- A6 设置页文案与功能清单事实文档已同步
- A7 固定提交哈希 + `docs/状态.md` 一句话状态
- A8 [只有真人能验] 四个方向贴边观感、速度、上下走会不会晃眼 / 打扰人、贴边后旋转把手是否被任务栏挡住

## 六、不做什么

1. 不生成 / 不接入走路逐帧动作素材（用户已同意先不生成）。
2. 不改窗口尺寸 190×250、不动旋转把手布局（只调走动边界）。
3. 不改 `prefsStore.clampPetPos()`、不破 P11「拖动 / 重启整窗可见」。
4. 不新增偏好字段、不改 `PET_MODES` 值。
5. 不做寻路 / 避让桌面图标 / 多显示器跨屏策略（沿用 nearest display）。
6. 不做收起态角标、不顺手重构无关代码。
7. 不合并、不打包、不装机、不做独立验收；预览版给用户试 → 用户确认后再谈合并。

## 自检记录

本轮贴边修复（用户 m02126 反馈）后重跑，[已核验] 全部通过。命令均在 `D:\Users\honor\Documents\Project\灵动岛`、分支 `deskpet-walk-polish` 上跑，跑 e2e 前 `Get-Process electron | Stop-Process -Force`（CDP 端口 9321，由 `isolate-userdata.mjs` 隔离 userdata）。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（tsc --noEmit × tsconfig.node.json / tsconfig.web.json） |
| `npm run build` | EXIT=0（`pet-DvW6_AwQ.js` 11.90 kB、`index-BvE1zjjf.js` 102.21 kB、`pet-C_XKL1KZ.css` 8.46 kB） |
| `node scripts/e2e-deskpet-out.mjs` | `E2E DESKPET-OUT: PASS（98 过 / 0 败）`、OUT_EXIT=0 |
| `node scripts/e2e-deskpet.mjs` | `E2E DESKPET: PASS（34 过 / 0 败）`、DESKPET_EXIT=0 |
| `node scripts/e2e-collapse-order.mjs` | `E2E COLLAPSE-ORDER: PASS（22 过 / 0 败）` |
| `node scripts/e2e-head-order.mjs` | `E2E HEAD-ORDER: PASS（14 过 / 0 败）` |

关键证据（[已核验]，出处 `scripts/e2e-deskpet-out.mjs` 输出）：

- P13g 源码断言：`WALK_PAD_X = 45` / `WALK_PAD_Y = 42`、`minX: area.x - WALK_PAD_X`、`maxX: area.x + area.width - (PET_WIN_W - WALK_PAD_X)`、`minY: area.y - WALK_PAD_Y`、`maxY: area.y + area.height - (PET_WIN_H - WALK_PAD_Y)` 全部命中。
- P13g 运行时四边真贴边：`P13g-左 / 右 / 上 / 下 运行时真贴到…边` 四条全绿（把窗口摆到四条边附近、`window→free` 重启走动后，窗口坐标真的到达按图片留白算出的极限），每条边还各断一次 `P13g-<边>-dir 方向/朝向` 全绿。这是上一版「只查源码字符串报绿」的假绿点，本轮已改成量真实窗口坐标。
- `P13d2 四个方向都走过（含上/下纵向），不再只会左右走` 全绿（四边循环里累积的 x / y 取值都 > 1）；P13e 窗口自己移动过、P13f 走动前后尺寸一致、P13h 切回 island 关窗停走，全绿。
- P11a / P11b「拖动 / 重启整窗可见」保留且全绿，说明 `walkLimits()` 放宽边界只作用于自动走动，没有破坏 `clampPetPos()`。

未核验边界：安装版里贴边观感、不同缩放 / 多显示器下的留白换算、走路动作素材（本轮按用户意见不生成）；未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 三.5 攒批）。

## 验收记录

（留空：按批攒独立验收，本轮不做）
