# SPEC：桌宠自由走动优化（窗口贴边 + 上下走 + 两种模式统一边界）

- 建立日期：2026-11-14
- 基线：`main` `8d1a78d`（桌宠自由走动已合并，装机待确认）
- 任务分支：`deskpet-walk-polish`（从 `main` 建，固定提交 `929be7b` 为上一版）
- 上一轮：`SPEC-deskpet-walk.md`（`5438e11` → 合并 `4a416e9`）
- 用户原话（m01838）：「说几个问题：1、就是这个桌宠的那个透明窗口有点大了，碰不到桌面端边界；还有就是行走的逻辑太呆板了，现在只会左右走，上下走不会，不过这个后面在弄也行，还有就是是不是要我去生成一点动作，给出你的想法，你再给我发的时候注意信息量，别发一推没用的给我」
- 用户定方向（m01841「可以，就按你的来」＋ m01845「开始」）：这轮做「窗口贴边 + 上下走」，动作素材不生成。
- 验收后反馈（m02126）：「上下左右走没什么问题，就是贴边不行，哪个方向都不行，还是有距离」。
- 再反馈（m02380 / m02389）：「可以了，但是在单窗口里行动为什么碰不到边」「单窗口的意思就是独立小窗口摸式」。
- 用户拍板（m02392）：「两个统一，都可以碰边」＝独立小窗口（window）与自由走动（free）用同一套边界、都能贴边。本文件按此三次修订。
- 沟通口径：用户两次要求「注意信息量，别发一堆没用的」（m01812、m01838），回复要短、直接给结论。

## 一、目标

1. **上下走**（m01838）：从只有左右两个纯方向，扩成上 / 下 / 左 / 右都会走，不再「只会左右走、太呆板」。
2. **窗口贴边**（m01838 / m02126）：让桌宠**真的**贴住屏幕四条边，解决「哪个方向都不行，还是有距离」。
3. **两种模式统一边界**（m02392）：自由走动（自动走动）与独立小窗口（拖动 / 重启恢复位置）都按「桌宠图片」算边界，都能贴到屏幕边，不再两套边界。
4. 去掉的候选「身材更像视频角色」保持去掉，桌宠玩法 / 长大版仍挂起；走路逐帧动作素材不生成（用户 m01841 同意先不加）。

### 贴边根因（[已核验]，按实际代码复核）

- `src/main/petWindow.ts` 上上版 `startWalk()`：`WALK_RUN_TICKS=60`（每段只走 3 秒 ≈ 120px）就定时换方向，且开局朝屏幕中心、8 个方向循环，位移互相抵消——桌宠永远在屏幕中间绕圈，**根本走不到边**。
- `src/renderer/src/pet/skinPhoto.tsx:45–63,339–358`：SVG viewBox 160×160，桌宠图片只占中间约 84 宽、140 高，左右各约 38 画布单位；`src/renderer/src/petwin/petwin.css`：190×250 窗口里内容区 190×190 居中、上下各 30px 透明。scale=190/160=1.1875 换算，图片在窗口内约左 45、右 145、顶 42、底 208。**就算窗口贴边，桌宠看起来离左右边还差 45px、上下约 42px**。
- `scripts/e2e-deskpet-out.mjs` 上一版 P13g 只**查源码字符串**就报绿（「假绿」），没验证运行时窗口真的贴到边。
- 贴边修好后仍有两套边界：free 走 `walkLimits()`（按图片留白算），window 的拖动 / 重启仍走 `prefsStore.clampPetPos()` 的「整窗可见」——所以用户 m02380 又报「独立小窗口碰不到边」。

### 改法（当前实现）

- 走动改「巡边」：`WALK_DIRS` 4 个纯方向（右 / 下 / 左 / 上，下标即目标边），开局选离当前位置最近的边，朝它一直走，**真的贴住那条边才停 1.5 秒换下一条边**；删掉定时换向与反弹。斜向去掉（斜走会先撞一条边、另一轴还没到，看起来仍贴不到边）。
- **留白常量提到 `prefsStore.ts` 作为唯一真源**：`export const PET_IMG_PAD_X = 45` / `export const PET_IMG_PAD_Y = 42`。`clampPetPos(pos, w, h)` 改为按图片留白钳制（拖动、重启自动生效）；`petWindow.ts` 的 `walkLimits()` 删本地 `WALK_PAD_*`、改用同一组共享常量。三个入口（拖动 / 重启 / 自动走动）共用一份边界，不会再出现两套。
  - `clampPetPos` 返回 `x: Math.round(Math.min(area.x + area.width - (w - PET_IMG_PAD_X), Math.max(area.x - PET_IMG_PAD_X, pos.x)))`、y 同理。
  - `walkLimits()` 返回 `{ minX: area.x - PET_IMG_PAD_X, maxX: area.x + area.width - (PET_WIN_W - PET_IMG_PAD_X), minY: area.y - PET_IMG_PAD_Y, maxY: area.y + area.height - (PET_WIN_H - PET_IMG_PAD_Y) }`，让透明留白越出工作区、图片边缘正好贴屏幕边。
- 方向→视图：复用 `pet:turn-abs` 与四视图（`skinPhoto.tsx` `VIEWS`：front0 / side-l1 / back2 / side-r3）。右=3、左=1、上=2（背面）、下=0（正面）、停=0（正面）。

[推断] 口径：不新增素材、不新增偏好字段、不改 190×250 窗口尺寸与旋转把手布局。最可能错在：用户其实只想把窗口整体缩小，或想让桌宠带走路动画——按「最小实现 + 不新增素材」处理，交付时说明。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/prefsStore.ts` | 新增共享常量 `PET_IMG_PAD_X=45` / `PET_IMG_PAD_Y=42`；`clampPetPos()` 改按图片留白钳制（拖动 / 重启都生效） |
| `src/main/petWindow.ts` | import 共享常量；`walkLimits()` 删本地 `WALK_PAD_*` 改用共享常量；走动基础设施为巡边 4 纯方向、`startWalk()` 朝边走到底贴住才停换边；drag-end 方向补发用 `currentWalkDir()` |
| `src/preload/index.ts` | `onPetWalk` 联合类型加 `'up' \| 'down'`（`IslandApi = typeof api` 自动带类型，`index.d.ts` 不动） |
| `src/renderer/src/petwin/PetWindowApp.tsx` | `walkDir` state 加 `up`/`down`；`onPetWalk` 映射补 上=2 / 下=0；`data-pet-walk` 不变 |
| `src/renderer/src/settings/DeskPetSection.tsx` | `free` 档描述 / tip 改为「沿四条边巡边、走到边贴住再换边」 |
| `scripts/e2e-deskpet-out.mjs` | P13 方向∈{left,right,up,down}、朝向映射、二维移动；**P13g 运行时四边真贴边 + 源码断言共享常量**；**P11 改按图片可见并新增 P11c 独立小窗口拖动真贴边** |
| `docs/facts/功能清单.md` | 岛仔节改为两种模式统一图片边界说明 |
| `docs/状态.md` | 顶部一句话状态 |
| 本 SPEC | 六项 + 自检 / 验收记录 |

明确不改：`src/renderer/src/pet/*` 皮肤源码、`src/preload/index.d.ts`、通知页、`src/main/index.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/petwin/petwin.css`（颠动动画沿用）、四份历史 `SPEC-deskpet-*`。

## 三、预期行为

1. 设置→桌宠→「自由走动」：宠物窗口打开，开局朝离当前位置最近的那条边直走，几秒内就能看到桌宠真的贴到屏幕边。
2. 贴住一条边后停约 1.5 秒（停下转回正面），再换下一条边（右→下→左→上循环）；四个方向都能贴住，不再绕圈。
3. 走动时切到对应方向视图并带轻微上下颠动；拖动期间冻结、松手恢复、不逐帧写盘。
4. 设置→桌宠→「独立小窗口」：手动拖它到屏幕边、或重启恢复位置，都按同一套图片边界——桌宠图片能贴住屏幕边，不再被「整窗可见」拉回留一截距离。
5. window / island 模式行为不变：手动转好的朝向不被 `stopWalk()` 复位。
6. 托盘菜单「回到岛里」在 free 下仍显示、岛里不出现两只（上一轮已做，不变）。

## 四、必要依赖

无新增依赖、无新增素材、无新增偏好字段。复用：
- `setBounds` 显式带 width/height（125% 缩放下防窗口越走越大）
- `screen.getDisplayNearestPoint().workArea` 与 `screen.getPrimaryDisplay().workArea`
- `pet:walk` IPC 推送 + `pet:turn-abs` 自定义事件切四视图
- `.petwin.walking .pet-wrap` 的 `petwin-walk-bob` 颠动动画

## 五、验收条件

- A1 `npm run typecheck` EXIT=0、`npm run build` EXIT=0
- A2 `node scripts/e2e-deskpet.mjs` PASS（三档都可选，无残留禁用档）
- A3 `node scripts/e2e-deskpet-out.mjs` PASS：P13 能抓到 `up`/`down` 方向、朝向映射、二维位移、尺寸不漂移；**P13g 四条边运行时真贴边 + 共享常量源码断言全绿**（不再只查源码）
- A3b P11 改为按图片可见：屏幕外坐标被拉到「图片正好贴上/左边」的落点；**P11c 独立小窗口拖动时也能贴到屏幕边**（与自由走动同一套边界）
- A4 回归 `e2e-collapse-order` / `e2e-head-order` PASS
- A5 grep 无残留「8 向 / 斜向 / 30px 留白 / `WALK_PAD_*` / 贴边只查源码 / 两套边界」旧文案
- A6 设置页文案与功能清单事实文档已同步
- A7 固定提交哈希 + `docs/状态.md` 一句话状态
- A8 [只有真人能验] 四个方向贴边观感、独立小窗口拖到边的手感、速度、上下走会不会晃眼 / 打扰人、贴边后旋转把手是否被任务栏挡住

## 六、不做什么

1. 不生成 / 不接入走路逐帧动作素材（用户已同意先不生成）。
2. 不改窗口尺寸 190×250、不动旋转把手布局（只调边界）。
3. 不再保留「两套边界」：`clampPetPos()` 与 `walkLimits()` 必须共用 `PET_IMG_PAD_X/Y`，不回退到「整窗可见」（用户 m02392 明确要求统一）。
4. 不新增偏好字段、不改 `PET_MODES` 值。
5. 不做寻路 / 避让桌面图标 / 多显示器跨屏策略（沿用 nearest display）。
6. 不做收起态角标、不顺手重构无关代码。
7. 不合并、不打包、不装机、不做独立验收；预览版给用户试 → 用户确认后再谈合并。

## 自检记录

本轮「两种模式统一边界」（用户 m02392）改动后重跑，[已核验] 全部通过。命令均在 `D:\Users\honor\Documents\Project\灵动岛`、分支 `deskpet-walk-polish` 上跑，跑 e2e 前 `Get-Process electron | Stop-Process -Force`（CDP 端口 9321，由 `isolate-userdata.mjs` 隔离 userdata）。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（tsc --noEmit × tsconfig.node.json / tsconfig.web.json） |
| `npm run build` | EXIT=0（`pet-DvW6_AwQ.js` 11.90 kB、`index-BvE1zjjf.js` 102.21 kB、`settings-B_VhYv7X.js` 30.69 kB） |
| `node scripts/e2e-deskpet-out.mjs` | `E2E DESKPET-OUT: PASS（99 过 / 0 败）`、OUT_EXIT=0 |
| `node scripts/e2e-deskpet.mjs` | `E2E DESKPET: PASS（34 过 / 0 败）`、DESKPET_EXIT=0 |
| `node scripts/e2e-collapse-order.mjs` | 单跑 `E2E COLLAPSE-ORDER: PASS（22 过 / 0 败）`；串行批次偶发 21/1（R5j 收岛时序），单跑恢复，判启动时序非回归 |
| `node scripts/e2e-head-order.mjs` | `E2E HEAD-ORDER: PASS（14 过 / 0 败）` |

关键证据（[已核验]，出处 `scripts/e2e-deskpet-out.mjs` 输出）：

- P11a 屏幕外坐标被拉回、落点按 `PET_IMG_PAD_X/Y` 算（图片正好贴上/左边）；P11b 图片可见矩形不越界；**P11c 独立小窗口拖动时也能贴到屏幕边**（window 模式运行时真拖一次，不再被「整窗可见」拉回）。
- P13g 源码断言：`prefsStore.ts` 的 `PET_IMG_PAD_X = 45` / `PET_IMG_PAD_Y = 42`、`Math.max(area.x - PET_IMG_PAD_X, ...)`，与 `petWindow.ts` `walkLimits()` 的 `minX/maxX/minY/maxY` 全部命中，证明两种模式共用一份常量。
- P13g 运行时四边真贴边：`P13g-左 / 右 / 上 / 下 运行时真贴到…边` 四条全绿，每条边各断一次 `-dir 方向/朝向`；`P13d2 四个方向都走过（含上/下纵向）` 全绿。
- P13f 首轮两处假红的处理 [已核验]：本机 125% 缩放下 `getBounds()` 读回 191×251 且走动期间 ±1px 舍入抖动，`getSize()` 同抖（实测 `DIP 191x251,192x251`），所以「走动前后 width/height 完全相等」与「DIP 尺寸唯一」都不成立；改与项目既有 P9c 同口径——只量走动期间波动 `max - min <= 1`（真漂移是单调 +70px 以上）。同时把 P11c / `movePet` 里 `setBounds` 的尺寸从「`getBounds()` 读回的物理像素回设」改回 DIP 常量 190×250，消除真实撑大隐患。两处都是测试侧修正，未改产品代码。
- `e2e-collapse-order.mjs` 串行批次偶发 21/1（R5j 收岛后视觉顺序），单跑 22/0 恢复；本轮未改收起态组件 / 顺序逻辑，判启动时序偶发非回归（与上一轮同类现象一致）。

未核验边界：安装版里贴边观感、不同缩放 / 多显示器下的留白换算、独立小窗口拖到四边的手感、走路动作素材（本轮按用户意见不生成）；未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 三.5 攒批）。

## 验收记录

（留空：按批攒独立验收，本轮不做）

交付流水（非独立验收）：用户 2026-11-14 m02622「没问题」＝预览版验收通过 → 合并回 `main`（`2e4dd52`，`git diff --stat deskpet-walk-polish main` 为空）→ 合并后 `npm run typecheck` / `npm run build` EXIT=0 → 用户单独确认「现在就装」后双镜像 `npm run dist` + 静默安装到 `D:\软件\灵动岛\`。上文「六.7 不合并、不打包、不装机」「自检记录未核验边界：未合并、未打包、未装机」均指**本轮实现阶段**的口径，交付流水以后续 `docs/状态.md` 记录为准。
