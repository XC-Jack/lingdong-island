# SPEC：桌宠原图皮肤（用用户给的参考图做大尺寸形象）

- 建立时间：2026-11-12 12:50
- 状态：已实现，自检完成，待独立验收
- 上游依据：用户 2026-11-12 12:44 明确要求「大尺寸就用我发给你的这张图，不要用你描的近似版」；
  路线图里这块属于「阶段 1 · 宠物出岛」的前置，先把形象本体换成用户的原图。

## 一、目标

让桌宠的**大尺寸**（设置页预览、以后独立小窗口）显示用户本人提供的那张参考图，
而不是我照图描的矢量近似版。小尺寸（岛里 22px）保持矢量画法不变。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/assets/pet/bean-photo.png` | 新增。用户参考图抠成透明底，310×515，133 KB |
| `src/renderer/src/pet/skinPhoto.tsx` | 新增。第三套皮肤，`full` 用照片，`tiny` 复用黄豆矢量简版 |
| `src/renderer/src/pet/index.tsx` | 皮肤清单加一项 `photo` |
| `src/shared/types.ts` | `PET_SKIN_IDS` 加 `'photo'`（主进程落盘白名单） |
| `src/renderer/src/settings/settings.css` | 新增照片皮肤的呼吸/开心/困倦/惊讶动画 |
| `scripts/e2e-deskpet.mjs` | D3b 从「两套」改「三套」；新增 D9a–D9h 八条断言 |
| `docs/Spec/SPEC-deskpet-photo.md` | 本文件 |

## 三、预期行为

1. 设置页「桌宠」分区出现第三项「我的原图」，选中后**立刻生效**（不需要保存按钮、不需要重启）。
2. 选中后 `prefs.json` 落盘 `petSkin: "photo"`；重启后仍然是原图。
3. 大尺寸预览（132px）显示照片本人：颜色、体形、眼睛比例都与用户原图一字不差。
4. 照片下方有一小片投影，让平面照片有「站在桌面上」的感觉。
5. 大尺寸会呼吸（整体轻微缩放，锚点在脚底，脚不动）、开心时弹一下、困时变暗放慢、惊讶时一缩一弹。
6. 岛里那 22px **仍然是矢量简版**（黄豆的简版）：位图缩到 22px 只剩一团黄，绿眼糊成脏点。
   `.pet-eye` 仍恰好 2 个，`.collapsed-pet` 仍是 22×22，换肤绝不改变岛的布局。
7. 缩略图（44px）里照片不播动画——那个尺寸抖起来像在抽搐。

## 四、必要依赖

无新增依赖。图片由 Vite 作为资源导入（`import photoUrl from '../assets/pet/bean-photo.png'`），
构建产物里哈希命名自动处理。CSP 已有 `img-src 'self' data:`，够用。

抠图用的是一次性 Python + Pillow/Numpy 脚本（`.tmp/cutout_bean3.py`），不进仓库、不进构建。

## 五、验收条件

1. 设置页皮肤列表是 3 项，含「我的原图」（e2e D3b）。
2. 选原图后 `prefs.json` 的 `petSkin` 为 `"photo"`（D9b）。
3. 岛仔立刻切到原图皮肤，不重启就生效（D9c）。
4. 大预览里 `.pet-photo-img` 存在、实际绘制尺寸大于 40×40（D9d）——
   只查 DOM 存在会被「坏图占位」骗过去，所以量尺寸。
5. 图片地址指向打包进来的 `bean-photo-*.png`（D9e）。
6. 岛里 22px 仍是 `<svg>` 且**不含** `<image>`，即没有把照片塞进胶囊（D9f）。
7. 原图皮肤下 `.pet-eye` 仍恰好 2 个（D9g）——这是 `e2e-m2` 的硬依赖。
8. 切回胶囊正常（D9h）。
9. 换肤后岛仔占位与胶囊态完全一致（沿用原 D5a，不新增）。
10. `npm run typecheck` / `npm run build` 通过，图片进产物。

## 六、不做什么

- **不做 Live2D / Blender 骨骼动画。** 照片是死的，这轮只加整体运动（呼吸/弹跳/变暗），
  不做眨眼、不做手脚摆动。要真做眨眼得把眼睛拆成独立图层，那是下一页的事。
- **不给 22px 用照片。** 理由见预期行为第 6 条。
- **不做「导入自己的图片」的通用功能。** 这轮只固化了用户这一张图；
  通用皮肤包导入（用户丢文件夹就能换）留到以后单独做。
- **不换掉已有的两套皮肤。** 胶囊和矢量黄豆都保留，用户随时能切回去对比。
- **不动岛的窗口尺寸、不动布局。**
- **不改 `docs/facts/功能清单.md` 的功能编号**——桌宠整块还没进入编号体系。

## 七、自检记录

| 项 | 命令 / 方法 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | EXIT=0（node + web） |
| 构建 | `npm run build` | EXIT=0；产物含 `assets/bean-photo-CzElQFav.png 133.00 kB` |
| 桌宠 e2e | `node scripts/e2e-deskpet.mjs` | **PASS 32 过 / 0 败**（原 24 条 + 新 8 条） |
| 岛仔回归 | `node scripts/e2e-m2.mjs` | PASS（`eyes=2`、`happy=true`） |
| 设置页外壳回归 | `node scripts/e2e-settings-shell.mjs` | PASS 51 过 / 0 败 |
| 抠图质量（目视） | 深色底 / 浅色底各出一张 2× 预览，`.tmp/bean-front-dark.png` / `-light.png` | 边缘无白边、无背景残光；脚底与手部深棕色完整保留 |
| 实物截图 | 设置窗口桌宠页，`.tmp/photo-skin-preview.png` | 132px 预览显示原图，投影在脚下，三套皮肤并排正常 |

抠图做法（[实测]，可复现）：取正面全身那只的包围盒，用「低饱和且较亮」判背景，
从四边泛洪只去掉与边框连通的背景（肚子里的米白高光不会连到边框，所以保住），
再取躯干中心所在连通块甩掉左边大图探进来的边缘，最后 1px 腐蚀 + 0.8px 高斯做抗锯齿。

## 八、独立验收记录

**合并**：2026-11-12 14:15 合并回 `main`，合并提交 `a443108`（用户 2026-11-12 14:07 原话「行先合并」）。

**[实测] 合并后在 `main` 上重跑**（不只是分支上跑）：
- `npm run typecheck` EXIT=0
- `npm run build` EXIT=0；产物含 `assets/bean-photo-CzElQFav.png 133.00 kB`、`vendor-DeLoXG_s.js 564.37 kB`、`Pet-CzXDhign.js 24.12 kB`、`index-DpDvFvYQ.js 103.92 kB`、`settings-_yQDcrWt.js 30.41 kB`
- `node scripts/e2e-deskpet.mjs` **PASS 32 过 / 0 败**（D9a–D9h 全绿）
- `node scripts/e2e-m2.mjs` **PASS**（`eyes=2`、`happy=true`、回 idle）
- `node scripts/e2e-settings-shell.mjs` **PASS 51 过 / 0 败**
- `node scripts/e2e-collapse-order.mjs` **PASS 22 过 / 0 败**
- `node scripts/e2e-head-order.mjs` **PASS 14 过 / 0 败**（首次跑 11 过 1 败，`closePanel()` 报 `Error: no settings target`；连跑第三次全绿）

**未做的**：独立上下文验收（`verifier` 会话）未开，本轮按「合并优先、验收攒批」处理；真机换肤手感、高 DPI 观感、四种动画真机观感仍 `[未验证]`。

**`e2e-head-order` 偶发记录**（非本 SPEC 引入，供以后排查）：`scripts/e2e-head-order.mjs:219` 的 `closePanel()` 在设置窗口刚关闭时 CDP target 已消失，`evalOnTarget` 抛 `no settings target`。属既有脚本的关窗时序竞态，本轮未修。
