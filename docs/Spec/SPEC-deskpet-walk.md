# SPEC-deskpet-walk：桌宠自由走动

- 建立日期：2026-11-14
- 基线：`main` `824d4f4`（2026-11-14 11:35，通知页修复已打包装机）
- 任务分支：`deskpet-walk`（已从 `main` 建立）
- 用户原话（m01362）：先引用候选清单第 2 项「身材更像视频角色」并说「这个去掉」，再说「开始做宠物自己行走吧」。
- 关联：把 `docs/状态.md:122` 候选①「桌宠自由走动」由「推荐/待选」改为已选定开工；候选③「身材更像视频角色」按用户要求从清单划掉，以后不主动再提。
- 本轮没有截图证据；视觉相关结论只有预览版真人能验（见 A8）。

## 一、目标

1. 让桌宠在 `petMode: 'free'` 时自己沿工作区横向溜达：走一段、停一段，撞到左右边界自动掉头。
2. 走动时朝向跟着方向变（复用现有四视图转身），并有轻微上下颠动；停下时回正面、颠动停止。
3. 自由走动时岛里不再同时出现两只桌宠；托盘/右键菜单在自由走动下也显示「回到岛里」。
4. 设置页「自由走动」从「还没做（禁用）」变成可选档。
5. 把「身材更像视频角色」从候选清单去掉（用户 m01362「这个去掉」）。
6. 不改既有语义：拖动仍能用、右键菜单三支动作、四视图转身、点一下大笑、偏好键不变。

诊断 [实测]：`src/shared/types.ts:68` 的 `PET_MODES` 已含 `free`，`src/main/prefsStore.ts:121-125` 的 `normalizePetMode` 白名单也收 `free`，但 `src/main/petWindow.ts:159-166` 的 `syncPetWindow()` 只认 `window`（注释写明「free 还没做」），`src/renderer/src/settings/DeskPetSection.tsx:31-35` 把 free 标成 `ready: false` + 描述「还没做」，`src/renderer/src/App.tsx:2426` 只在 `window` 下隐藏岛里岛仔，`src/main/index.ts:86` 只在 `window` 下算「已出岛」。也就是说 free 一直是一个「存得下但不生效」的占位档，本轮把它接通。

口径 [推断]：用户说的「自己行走」＝桌宠自己在屏幕上移动。按「不新增素材 + 最小实现」做成横向匀速、走停交替、边界掉头，不引入寻路、纵向移动或新走路动作素材。依据是候选清单原文「现在只能被拖着走、能转方向，不会自己移动」以及设置页原有描述「自己在屏幕上溜达，走过的地方会停下」。最可能错在：用户其实想要二维四方向走动，或想要带走路动作的整套素材；交付时说明，若要扩展另开 SPEC。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/petWindow.ts` | `syncPetWindow()` 放开 `free`；新增走动定时器、边界掉头、走停交替、拖动暂停，以及向宠物窗口推 `pet:walk` 方向/状态 |
| `src/preload/index.ts` | 照 `onPetAction` 加一个 `onPetWalk(cb)` 订阅（`pet:walk`），`IslandApi = typeof api` 会自动带上，全局声明文件不用改 |
| `src/renderer/src/petwin/PetWindowApp.tsx` | 加 `walking` 状态与 `onPetWalk` 订阅，派发既有 `pet:turn-abs` 切侧视，根 div 加 `walking` class 与 `data-pet-walk` |
| `src/renderer/src/petwin/petwin.css` | 在 `.pet-wrap`（三套皮肤共有外层）加 `.petwin.walking .pet-wrap` 上下颠动动画与 keyframes，避开 `.pet-photo-img` 的呼吸 transform |
| `src/renderer/src/App.tsx` | `:2426` 隐藏岛里岛仔的条件扩到 `free` |
| `src/main/index.ts` | `:86` 托盘菜单「已出岛」判据改为显式枚举 `pm === 'window' \|\| pm === 'free'`（不写 `!== 'island'`：老用户 prefs 没有 petMode 时 undefined 会误判成已出岛） |
| `src/shared/types.ts` | 更新 `PET_MODES` 头注释（`free` 已实现），值不变 |
| `src/renderer/src/settings/DeskPetSection.tsx` | `free` 置 `ready: true`、改描述、改头注释与底部提示 |
| `scripts/e2e-deskpet.mjs` | D7c / D8c 由「free 仍禁用」改为「free 已可用且点它会落盘」 |
| `scripts/e2e-deskpet-out.mjs` | P2c / P13 / P13b 由「free 禁用」改为「三档全可用」，并补一组走动行为断言 |
| `docs/facts/功能清单.md` | 「6. 岛仔」节补自由走动的产品事实 |
| `docs/状态.md` | 一句话状态与候选清单（已改） |
| 本 SPEC | 自检记录、验收记录两节留空待填 |

明确不改：`src/main/prefsStore.ts`（不新增偏好字段，只复用 `petMode` / `petWindowPos`）、`src/preload/index.d.ts`、`src/renderer/src/pet/*` 皮肤源码、通知页相关文件、四份历史 SPEC-deskpet-*（其中「本轮不做 free」是历史描述，保留）。

## 三、预期行为

1. 设置页「桌宠 → 自由走动」可选（不再禁用、不再标「还没做」），点它落盘 `petMode: 'free'`。
2. 切到 free 后：独立透明小窗口打开、岛里岛仔消失、托盘菜单显示「让桌宠回到岛里」。
3. 小窗口沿工作区水平方向自己移动；每走约 3 秒停约 1.5 秒再继续；碰到工作区左右边界自动反向，不越界。
4. 走动时宠物切到对应侧面视图（往右 side-r、往左 side-l）并有轻微上下颠动；停下时回正面、颠动停止。
5. 按住身体拖动期间自动走动暂停；松手后从新位置继续，并把新位置落盘到 `petWindowPos`。
6. 右键菜单「回到岛里」或设置页切回「只在岛里」→ 走动停止、窗口关闭、岛里岛仔回来。
7. `window`（独立小窗口）模式行为完全不变：不自动走动、不切走动视图。

## 四、必要依赖

无新增依赖。复用既有能力：Electron `BrowserWindow.setBounds`（显式带 width/height，沿用「125% 缩放下连续 setPosition 会把窗口撑大」的教训）、`clampPetPos()` 的 workArea 钳制、`contextBridge` 的 IPC 推送、皮肤层已有的 `pet:turn-abs` 自定义事件、CSS 动画。

## 五、验收条件

- A1 `npm run typecheck` EXIT=0、`npm run build` EXIT=0。
- A2 受影响 e2e 全绿：`e2e-deskpet.mjs`、`e2e-deskpet-out.mjs`，以及新写的自由走动行为断言。
- A3 设置页三档都可选，free 既无 `disabled` 也无「还没做」。
- A4 点 free 后 `petMode === 'free'` 落盘，宠物窗口打开、岛里无岛仔、托盘菜单为「回到岛里」。
- A5 free 下窗口 x 随时间变化（确实在走），且始终落在 workArea 内（撞边界会反向、不越界）；走停交替可观测。
- A6 走动期间 `data-pet-walk` 有值、切到侧面视图；停下回正面。
- A7 拖动期间窗口跟随光标且不被走动定时器抢写；松手后新位置落盘。
- A8 只有真人能验：走动速度观感、颠动幅度、侧面视图与方向是否协调、会不会打扰人。预览版给出后由用户确认。

## 六、不做什么

1. 不做纵向 / 二维寻路，不避让其它窗口，不做碰撞检测。
2. 不新增走路动作素材、不重抠身材（「身材更像视频角色」已按 m01362 去掉）。
3. 不新增偏好字段（速度、方向、开关等），只复用 `petMode` 与 `petWindowPos`。
4. 不改 `PET_MODES` 的值、不改 `appShortName()`、不动通知页。
5. 不做收起态 App 图标角标（用户两次否决，已排除，以后不主动再提）。
6. 不顺手重构拖动 / 转身 / 动作代码，不改 `window` 模式既有行为。
7. 本轮不合并回 `main`、不打包、不装机、不做批量独立验收（按 `docs/工程规则.md` 攒批）；合并与装机都等用户单独发话。

## 自检记录

（[实测] 均在 `D:\Users\honor\Documents\Project\灵动岛`、任务分支 `deskpet-walk` 上跑；跑 e2e 前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，改完 `src/` 先 `npm run build` 再跑 e2e）

命令与结果：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（tsc --noEmit 两份 tsconfig） |
| `npm run build` | EXIT=0（`pet-CtuBB4kZ.js` 11.88 kB、`index-BvE1zjjf.js` 102.21 kB、`pet-C_XKL1KZ.css` 8.46 kB、`index-DWUdnjDj.css` 58.98 kB） |
| `node scripts/e2e-deskpet.mjs` | `E2E DESKPET: PASS（34 过 / 0 败）`，EXIT=0 |
| `node scripts/e2e-deskpet-out.mjs` | `E2E DESKPET-OUT: PASS（88 过 / 0 败）`，EXIT=0，P13a–P13g 全绿 |
| `node scripts/e2e-collapse-order.mjs` | `PASS（22 过 / 0 败）`，EXIT=0（收起态回归，因 App.tsx 改了岛仔隐藏条件） |
| `node scripts/e2e-head-order.mjs` | `PASS（14 过 / 0 败）`，EXIT=0（展开态/头部顺序回归） |

关键证据：
- 设置页三档全放开：`e2e-deskpet.mjs` D7c「自由走动已可用（disabled=false / soon=false）」、D7e「三档无残留禁用档 / 还没做标签」全绿；`e2e-deskpet-out.mjs` P2c 同口径。
- free 真的在走：`e2e-deskpet-out.mjs` P13 点 free → 落盘 `petMode=free`（P13a）→ 开独立宠物窗口（P13b）→ 收到 `.walking` + `data-pet-walk=left/right`（P13c）→ 朝向切侧视 `data-pet-facing∈{1,3}`（P13d）→ `sleep(900)` 后窗口 x 变了（P13e）→ 走动前后 width/height 一致（P13f，`setBounds` 显式带尺寸，未漂移）→ 切回 island 关窗停走（P13g）。
- 电源/朝向兼容性：P13 新增一次开窗/关窗后 P14 撞上「target 已有、bounds 可读但还没 show」空档，P14d 首轮假红 → 把 P14 前置等待改成主进程读 `w.isVisible()` 并等 `visible === true`；P13f 首轮按硬编码 190×250 判尺寸，125% 缩放下 `getBounds()` 返回 191×251 假红 → 改成走动前后相对比较 `b1.width === b0.width && b1.height === b0.height`。两处都是断言写法问题、非产品回归，改完重跑 88/0 全绿。
- `window` 模式未受影响：`e2e-deskpet-out.mjs` P3–P12 原有出岛/拖拽/转身/三支动作/位置记忆断言全绿。
- grep `还没做|自由走动|pet-set-soon|data-mode="free"|petMode === 'window'|petMode !== 'island'` 于 `scripts/*.mjs` = 17 处，全是本轮改过的两个脚本的新文案，无残留旧「free 禁用」断言。

未验证边界：
- A8 只有真人能验：走动速度观感（40px/秒）、上下颠动幅度（±3px / 520ms）、侧面视图与移动方向是否协调、长时间自己走动会不会打扰人。e2e 断言的是 DOM 结构、`data-pet-*` 属性、窗口 x 位移与尺寸，不是观感。
- 只有单台 125% 缩放 Windows 屏跑过；多显示器 / 其它缩放比 / 工作区变化时的走动边界未实测（沿用 `clampPetPos()` 的既有逻辑）。
- 本轮未合并回 `main`、未打包、未装机、未做批量独立验收（按 `docs/工程规则.md` 攒批）；交付的是预览版，等用户确认。

## 验收记录

（本轮不做独立验收，留空）
