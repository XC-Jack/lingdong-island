# SPEC：桌宠自由走动优化（窗口贴边 + 上下走）

- 建立日期：2026-11-14
- 基线：`main` `8d1a78d`（桌宠自由走动已合并，装机待确认）
- 任务分支：`deskpet-walk-polish`（从 `main` 建）
- 上一轮：`SPEC-deskpet-walk.md`（`5438e11` → 合并 `4a416e9`）
- 用户原话（m01838）：「说几个问题：1、就是这个桌宠的那个透明窗口有点大了，碰不到桌面端边界；还有就是行走的逻辑太呆板了，现在只会左右走，上下走不会，不过这个后面在弄也行，还有就是是不是要我去生成一点动作，给出你的想法，你再给我发的时候注意信息量，别发一推没用的给我」
- 用户定方向（m01841「可以，就按你的来」＋ m01845「开始」）：这轮做「窗口贴边 + 上下走」，动作素材不生成。
- 沟通口径：用户两次要求「注意信息量，别发一堆没用的」（m01812、m01838），回复要短、直接给结论。

## 一、目标

1. **窗口贴边** [实测诊断]：独立桌宠窗口 190×250 DIP，SVG `xMidYMid meet` 让宠物可见内容是与窗口同宽的 190×190、垂直居中，上下各留 30px 纯透明区给底部旋转把手。走动时按整窗钳进 `workArea`，可见宠物离屏幕上下边差 30px，所以「碰不到桌面端边界」。改法：自动走动时按「可见区」算边界，允许 30px 透明留白越出工作区；拖动 / 重启仍按整窗可见（不动 `prefsStore.clampPetPos`）。
2. **上下走** [实测诊断]：当前 `walkDir: 1 | -1` 只有左右两个纯方向，用户嫌「太呆板」。改成 8 个方向（右 / 下 / 左 / 上 / 四个斜向），每段 rest→run 换下一个方向，循环；撞可见区边界时对应分量反弹。
3. 方向→视图：复用现成 `pet:turn-abs` 事件与四视图（`skinPhoto.tsx` 的 `VIEWS`：front0 / side-l1 / back2 / side-r3）。右=3、左=1、上=2（背面）、下=0（正面），斜向横向优先。
4. 走动时轻微上下颠动、停下转回正面、拖动冻结、松手恢复、位置不逐帧写盘：全部沿用上一轮，不变。
5. 去掉的候选「身材更像视频角色」保持去掉，桌宠玩法 / 长大版仍挂起。

[推断] 口径：不做走路逐帧动作素材（用户已同意先不生成）；只调逻辑与边界，不新增素材。最可能错在：用户其实只想把窗口整体缩小，或希望上下走带走路动画——按「最小实现 + 不新增素材」处理，交付时说明。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/petWindow.ts` | 替换走动基础设施：`WALK_DIRS` 8 向、`walkVec`/`walkSeq`、`walkLimits()` 可见区边界、`startWalk()` 二维反弹；`pushWalk` 类型扩 `up`/`down`；drag-end 方向补发改用 `currentWalkDir()` |
| `src/preload/index.ts` | `onPetWalk` 回调联合类型加 `'up' | 'down'`（`IslandApi = typeof api` 自动带类型，`index.d.ts` 不动） |
| `src/renderer/src/petwin/PetWindowApp.tsx` | `walkDir` state 联合类型扩 `up`/`down`；`onPetWalk` 映射补 上=2 / 下=0；`data-pet-walk` 不变 |
| `src/renderer/src/settings/DeskPetSection.tsx` | `free` 档描述从「横向溜达」改为「上下左右斜着溜达、能贴到屏幕边」；tip 同步 |
| `scripts/e2e-deskpet-out.mjs` | P13 断言改二维：方向∈{left,right,up,down}、`data-pet-facing`∈{0,1,2,3}、新增「可见区贴到工作区上下边」断言；P11「整窗可见」不动（拖动/重启仍按整窗） |
| `docs/facts/功能清单.md` | 岛仔 free 条改二维 + 贴边说明 |
| `docs/状态.md` | 顶部一句话状态 |
| 本 SPEC | 六项 + 自检 / 验收记录 |

明确不改：`src/main/prefsStore.ts`（`clampPetPos` 保持整窗可见）、`src/renderer/src/pet/*` 皮肤源码、`src/preload/index.d.ts`、通知页、`src/main/index.ts`、`src/renderer/src/App.tsx`、四份历史 `SPEC-deskpet-*`。

## 三、预期行为

1. 设置→桌宠→「自由走动」：宠物窗口打开，开局朝远离屏幕中心的「纯方向」之一走（右 / 下 / 左 / 上，保证上下视图早点出现），之后每段 rest→run 换下一个方向，右 / 下 / 左 / 上 / 四个斜向都会轮到。
2. 走约 3 秒停约 1.5 秒，循环；停下转回正面并收起颠动，起步再切到对应方向视图。
3. 撞到工作区左右边：横向分量反弹；撞到上下边：纵向分量反弹；可见宠物能贴到工作区上下边（透明留白允许越出）。
4. 拖动期间冻结自动走动、推 idle 转正面；松手按当前相位补回方向与颠动；不逐帧写盘。
5. window / island 模式行为不变：手动转好的朝向不被 `stopWalk()` 复位。
6. 托盘菜单「回到岛里」在 free 下仍显示（上一轮已做，不变）。
7. 岛里不出现两只（上一轮已做，不变）。

## 四、必要依赖

无新增依赖、无新增素材、无新增偏好字段。复用：
- `setBounds` 显式带 width/height（125% 缩放下防窗口越走越大）
- `screen.getDisplayNearestPoint().workArea` 与 `screen.getPrimaryDisplay().workArea`
- `pet:walk` IPC 推送 + `pet:turn-abs` 自定义事件切四视图
- `.petwin.walking .pet-wrap` 的 `petwin-walk-bob` 颠动动画（挂 `.pet-wrap`，避开 `.pet-photo-img` 的 3.6s 呼吸 transform）

## 五、验收条件

- A1 `npm run typecheck` EXIT=0、`npm run build` EXIT=0
- A2 `node scripts/e2e-deskpet.mjs` PASS（三档都可选，无残留禁用档）
- A3 `node scripts/e2e-deskpet-out.mjs` PASS：P11「整窗可见」仍成立；P13 能抓到 `up`/`down` 方向、`data-pet-facing`∈{0,1,2,3}、走动位移含纵向、可见区贴到工作区上下边、尺寸不漂移
- A4 回归 `e2e-collapse-order` / `e2e-head-order` PASS
- A5 grep `scripts/` 无残留「只会左右 / 横向溜达」旧断言
- A6 设置页文案与功能清单事实文档已同步
- A7 固定提交哈希 + `docs/状态.md` 一句话状态
- A8 [只有真人能验] 速度观感、上下走会不会晃眼 / 打扰人、贴边后旋转把手是否被任务栏挡住、侧背视图与方向的协调感

## 六、不做什么

1. 不生成 / 不接入走路逐帧动作素材（用户已同意先不生成）。
2. 不改窗口尺寸 190×250、不动旋转把手布局（只调走动边界）。
3. 不改 `prefsStore.clampPetPos()`、不破 P11「拖动 / 重启整窗可见」。
4. 不新增偏好字段、不改 `PET_MODES` 值。
5. 不做寻路 / 避让桌面图标 / 多显示器跨屏策略（沿用 nearest display）。
6. 不做收起态角标、不顺手重构无关代码。
7. 不合并、不打包、不装机、不做独立验收；预览版给用户试 → 用户确认后再谈合并。

## 自检记录

命令均在 `D:\Users\honor\Documents\Project\灵动岛`、分支 `deskpet-walk-polish` 上跑，跑 e2e 前 `Get-Process electron | Stop-Process -Force`（CDP 端口 9321，由 `isolate-userdata.mjs` 隔离 userdata）。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（tsc node + web 两份配置） |
| `npm run build` | EXIT=0（`pet-DvW6_AwQ.js` 11.90 kB、`index-BvE1zjjf.js` 102.21 kB、`pet-C_XKL1KZ.css` 8.46 kB） |
| `node scripts/e2e-deskpet-out.mjs` | PASS 90 过 / 0 败，P13a–P13h 全绿 |
| `node scripts/e2e-deskpet.mjs` | PASS 34 过 / 0 败 |
| `node scripts/e2e-collapse-order.mjs` | PASS 22 过 / 0 败 |
| `node scripts/e2e-head-order.mjs` | PASS 14 过 / 0 败 |

关键证据（P13 重写后）：P13c 抓到 `data-pet-walk ∈ {left,right,up,down}` 且 `.walking`；P13d 朝向与方向对应（右3/左1/上2/下0）；**P13d2 等待式抓到纵向走动 `up`/`down`**（不再只会左右）；**P13e 16 秒采样里 x 与 y 取值都 >1 种**（二维真移动）；P13f 走动前后 `width/height` 一致（125% 缩放下 `getBounds()` 是物理像素，不硬写 190×250）；P13g 源码断言 `walkLimits()` 含 `padY=(PET_WIN_H-PET_WIN_W)/2`、`minY: area.y - padY`、`maxY: area.y + area.height - padY - PET_WIN_W`；P13h 切回 island 关窗停走。P11「拖动/重启整窗可见」与 P14「窗口真的 show 出来」保持绿。

贴边改法只在自动走动生效：拖动定时器与 createPetWindow 初始位置仍走 `prefsStore.clampPetPos()` 的整窗可见，两套边界不共用，P11 未破。

未验证边界：
- A8 观感类（速度、上下走会不会晃眼/打扰人、贴边后旋转把手是否被任务栏挡住、侧背视图与方向协调感）只有真人看预览版能验；P13g 断言的是 `walkLimits()` 源码里的边界算法，**不是**运行时真的贴到屏幕边的截图证明。
- 多显示器跨屏、另一台缩放比例机器未测。
- 未合并、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 三.5 攒批，本批不做）；安装版 `D:\软件\灵动岛\` 未动。

## 验收记录

（留空：按批攒独立验收，本轮不做）
