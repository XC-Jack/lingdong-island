# SPEC-deskpet-skin — 桌宠皮肤包（换形象 + 出现模式框架）

> 用户授权：2026-11-12 11:51「画吧」——按参考图描一版矢量草稿 + 搭皮肤包架子 + 接在岛的 22px 位置上给用户看实物。
> 本轮只做「皮肤」这一层，不碰桌宠的玩法（吃文件/专注守卫/音乐小生物）与独立窗口。

## 一、目标

1. 把岛上那只 22px 的岛仔从「写死在 `App.tsx` 里的一个组件」改成「可换的皮肤」，为以后用户自己画形象打地基。
2. 新画一套「黄豆小怪兽」皮肤（按用户给的 3D 参考图翻译成 2D 矢量），与现有紫胶囊并存。
3. 设置页新增「桌宠」分区：换皮肤 + 三档出现模式的框架（只有一档可用）。
4. **升级不换脸**：老用户 `prefs.json` 里没有 `petSkin` 时仍然是紫胶囊。

## 二、修改范围

新增：
- `src/renderer/src/pet/types.ts` — 皮肤接口与情绪/尺寸类型
- `src/renderer/src/pet/index.tsx` — 皮肤清单、默认皮肤、按 id 取皮肤（含容错回落）
- `src/renderer/src/pet/Pet.tsx` — 对外入口（皮肤 id + 情绪 + 尺寸 → 画）
- `src/renderer/src/pet/skinCapsule.tsx` — 皮肤 1：紫胶囊（原 `App.tsx` 内联组件的原样搬迁）
- `src/renderer/src/pet/skinBean.tsx` — 皮肤 2：黄豆小怪兽
- `src/renderer/src/settings/DeskPetSection.tsx` — 设置页「桌宠」分区
- `scripts/e2e-deskpet.mjs` — 新增 e2e（D1–D8，24 条断言）

修改：
- `src/shared/types.ts` — `SettingsSection` 加 `'pet'`；新增 `PET_SKIN_IDS` / `PetSkinId` / `PET_MODES` / `PetMode`
- `src/preload/index.ts` — `PrefsShape` 加 `petSkin` / `petMode`；import 类型
- `src/main/prefsStore.ts` — 加 `normalizePetSkin` / `normalizePetMode`（白名单校验），load/set 两侧都走校验
- `src/main/settingsWindow.ts` — `isValidSection` 认 `'pet'`
- `src/renderer/src/App.tsx` — 删掉内联 `Pet`；import `./pet/Pet`；加 `petSkin` state + 回填 + 偏好广播同步；`renderStatusItem('pet')` 传 `skin`
- `src/renderer/src/settings/SettingsApp.tsx` — `NAV` 加「桌宠」项；分区渲染分支加 `section === 'pet'`
- `src/renderer/src/styles.css` — 新增 `.pet-wrap`
- `src/renderer/src/settings/settings.css` — 新增「桌宠」分区样式（预览舞台 / 皮肤行 / 模式行 / 单选圈）
- `electron.vite.config.ts` — `manualChunks` 固定 React 到 `vendor`（见「四、必要依赖」）
- `scripts/e2e-settings-shell.mjs` — S2a 从「三项」改成「四项」并断言含「桌宠」
- `scripts/e2e-m2.mjs` — 起手加 `waitFor` 等岛仔挂载（原本起手抢跑会读成 `breathe=false`，见第七节）
- `scripts/e2e-head-order.mjs`、`scripts/e2e-collapse-order.mjs` — 起手固定 `sleep(3500)` 改成 `waitReady()` 轮询（实测起进程到岛挂载要 4.7 秒，原本就会读到空 DOM，见第七节）

不修改：主进程窗口几何、通知/待办/日程/置物架/音乐的任何逻辑、`docs/facts/` 之外的产品行为。

## 三、预期行为

### 皮肤
1. 岛上岛仔按 `prefs.petSkin` 渲染；缺失或查不到时用 `capsule`。
2. 设置页「桌宠」→ 形象区列出全部皮肤（当前第一套胶囊、第二套黄豆），点一条：
   - 立刻写 `prefs.json`（`petSkin`），主进程广播 `prefs:changed`；
   - 岛仔在同一秒内换脸，**不需要重启、不需要重开设置窗口**；
   - 设置页自己的选中态同步。
3. 换肤不改变布局：`.collapsed-pet` 的包围盒与胶囊皮肤下完全一致（窗口 zoom=0.75 下实测 16.5×16.5 CSS px），`.pet-eye` 恒为 2 个。

### 出现模式
4. 「出现在哪里」列出三档：**只在岛里**（可选、默认选中）、**独立小窗口**（禁用 + 「还没做」）、**自由走动**（禁用 + 「还没做」）。
5. 点禁用档位不产生任何写入；点「只在岛里」写 `petMode: 'island'`，且不改动 `petSkin`。

### 升级与容错
6. 老用户 `prefs.json` 无 `petSkin` → 紫胶囊；**不主动写死** `petSkin: 'capsule'` 回文件（以后改默认皮肤老用户才跟得上）。
7. `prefs.json` 里被手改成不存在的 id → `prefsGet()` 返回的 `petSkin` 是 `undefined`（值在 `load()` 就被剔掉），岛仔回落胶囊，不会渲染成空白。

## 四、必要依赖

无新增第三方依赖。

一个构建配置变更：`electron.vite.config.ts` 加 `output.manualChunks` 把 React 归到 `vendor`。
- 原因：桌面宠拆出 `pet/` 后，两个渲染入口共享的 React 被 Rolldown 以「首个引用它的模块名」命名，产物里出现 `Pet-xxxx.js` 587 kB（实际是 react-dom），看目录会误以为是桌宠资源。分组后是 `vendor-DeLoXG_s.js` 564 kB + `Pet-tCghqKAI.js` 21.6 kB。
- 注意：本项目用 rolldown-vite，`manualChunks` **只接受函数**，传对象会 `TypeError: manualChunks is not a function`（实测踩到）。

## 五、验收条件

1. `npm run typecheck` 退出码 0。
2. `npm run build` 退出码 0；`out/renderer/assets/` 有 `vendor-*.js` 且没有超大 `Pet-*.js`。
3. `node scripts/e2e-deskpet.mjs` = PASS（24 过 / 0 败），覆盖：升级不换脸、非法 id 容错、设置页两套皮肤与 132px 预览、换肤落盘 + 岛实时跟随、换肤不改布局、切回胶囊、三档模式、点禁用档位不写入。
4. `node scripts/e2e-m2.mjs` = PASS（岛仔呼吸/眨眼/happy 弹跳三条既有能力不退化）。
5. `node scripts/e2e-settings-shell.mjs` = PASS（51 过 / 0 败，S2a 已是四项）。
5b. `node scripts/e2e-head-order.mjs` = PASS（14 过 / 0 败）、`node scripts/e2e-collapse-order.mjs` = PASS（22 过 / 0 败）——岛仔换皮后头部层与收起态顺序都没退化。
6. 负对照：把 `getPetSkin` 的回落分支改成直接返回第一项之外的错误值（或删掉 `normalizePetSkin`），`e2e-deskpet` 的 D2 必须变红——证明 D2 不是恒真。
7. 截图人工核对：岛收起态在两种皮肤下都能看清、设置页「桌宠」分区排版无溢出。

## 六、不做什么

- **不做独立小窗口 / 自由走动**：只把选项列出来并标「还没做」，`petMode` 存下来但不生效。
- **不做桌宠玩法**：吃文件、专注守卫、音乐小生物、电量小怪物都不在本轮。
- **不做「主动来找你」/「它会盯着你」**：与 2026-11-07 用户否决 US-025「岛仔陪伴反应」的理由（怕打扰）冲突，要做必须用户明确改口。
- **不做 3D、不做序列帧导入、不做用户自带皮肤包的加载**：本轮只留接口和提示文案。用户画好的文件怎么装进来，等真的画完再定格式。
- **不改默认皮肤**：默认仍是 `capsule`，不替用户选。

## 七、自检记录（2026-11-12，执行方）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | EXIT=0（node + web 两套都过） |
| 构建 | `npm run build` | EXIT=0；`vendor-DeLoXG_s.js 564.37 kB`、`Pet-tCghqKAI.js 21.62 kB`、`index-BQbaxwYH.js 103.92 kB`、`settings-UMbbc5qM.js 30.41 kB` |
| 桌宠 e2e | `node scripts/e2e-deskpet.mjs` | **PASS 24 过 / 0 败**（连跑两次都绿） |
| 岛仔回归 | `node scripts/e2e-m2.mjs` | **PASS**（`[1] {"breathe":true,"eyes":2}`、`[5] happy=true`、`[6] 回 idle`） |
| 设置页外壳回归 | `node scripts/e2e-settings-shell.mjs` | **PASS 51 过 / 0 败** |
| 头部/收起态顺序回归 | `node scripts/e2e-head-order.mjs`、`node scripts/e2e-collapse-order.mjs` | **PASS 14 过 / 0 败**、**PASS 22 过 / 0 败** |
| 负对照（验收条件 6） | 把 `normalizePetSkin` 的白名单删掉 → build → `e2e-deskpet` | **FAIL 22 过 / 2 败**：`D2c 非法值没有漏给渲染层 —— 实际 "不存在的皮肤"`、`D3d 当前选中项是胶囊 —— 实际（空）`；还原后 **PASS 24 过 / 0 败** |

实现要点（踩到的坑，供验收方复核）：
- **`.pet-eye` 必须恰好 2 个**：`scripts/e2e-m2.mjs`、`scripts/e2e-head-order.mjs:144`、`scripts/e2e-collapse-order.mjs:139` 都依赖这个数。黄豆皮肤的绿眼珠用 `<g className="pet-eye">` 把「绿底 + 黑瞳」包成一组，不能各算一个。
- **几何断言不能硬写 22**：窗口 `zoom=0.75`，`getBoundingClientRect` 量 22 CSS px 得到 16.5→17。e2e 改成「与胶囊皮肤下同一份测量对比」。
- **`prefsStore.load()` 只过滤不回写**：非法 `petSkin` 在读出时被剔掉，但明文文件里仍留着那条脏值。这是有意的（少一次磁盘写、每次读都会过滤），所以 D2c 断言的是「没漏给渲染层」而不是「文件被改写」。
- **`e2e-m2.mjs` 起手抢跑**：拿到 CDP page target 不等于 React 已挂载，起手立刻查询会读到 `breathe:false, eyes:0`。**这个问题在 `main`（`cebb8e6`）上同样失败，与本轮改动无关**（已用 `git stash` 在干净 main 上复现确认），本轮顺手加了 `waitFor` 修好。
- **起进程到岛挂载实测 4.7 秒**（探针 `.tmp/probe-startup-timing.mjs`：page target `+3420ms`、`.island.collapsed` `+4719ms`）。所以 `scripts/e2e-head-order.mjs`、`scripts/e2e-collapse-order.mjs` 里原本的固定 `sleep(3500)` 也会读到空 DOM（实测 `infoOrder=[]`、`["__no-collapsed"]`、`prefsGet().pagesCustom` 为 undefined），**同样在干净 main 上就失败**，本轮一并改成 `waitReady()` 轮询，两脚本由 9过5败 / 16过6败 变为 **14过0败 / 22过0败**。
- **`manualChunks` 只吃函数**：见第四节。

未验证：
- 设置页在 880×580 之外的分辨率下的排版（未测高 DPI）。
- 黄豆皮肤在 16px（展开态头部 `.head-status .collapsed-pet`）下的观感——只用肉眼看了截图，没有逐像素比对。
- 真实鼠标点击换肤的手感（e2e 走的是 `element.click()`）。
- 独立小窗口 / 自由走动的可行性探针（本轮明确不做，未开工）。

## 八、独立验收记录

待验收（本轮提交后交独立上下文验收）。
