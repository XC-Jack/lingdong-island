# SPEC：灵动岛动画不跟随系统「减弱动态效果」

日期：2026-11-28
分支：`collapsed-lyric-bar`
授权：用户 2026-11-28 在本轮对话中明确选择「完全忽略系统设置」。

## 一、目标

让灵动岛的所有动画**始终播放**，不再读取 Windows 的「减弱动态效果」（`prefers-reduced-motion: reduce`）。

背景：用户机器上该设置为开（`MinAnimate=0`），导致页面切换缩放、页面淡入、岛仔呼吸/眨眼、
待办勾选、歌词条淡入等动画全部不播；用户确认希望这些动画回来，并接受页面切换 340ms 缩放一并恢复。

## 二、修改范围

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/styles.css` | 删除 5 处 `@media (prefers-reduced-motion: reduce)` 块（主可访问性块、通知骨架、封面呼吸、歌词滚动、音量浮层），在原位置留一条说明注释 |
| `src/renderer/src/App.tsx` | 删除切页缩放里 `matchMedia('(prefers-reduced-motion: reduce)')` 的跳过判断 |
| `docs/facts/视觉设计规范.md` / `功能清单.md` / `本机约束与踩坑.md` / `用户角色与用户故事.md` | 同步「岛不跟随该设置」的事实 |
| `docs/Spec/SPEC-island-widget-grid.md` / `SPEC-music-layout-2.md` / `SPEC-collapsed-lyric-bar.md` | 修正本轮早先写的「reduce 时跳过」记录 |

## 三、预期行为

- 系统「动画效果」开或关，岛的动画表现一致：
  - 点组件进页面 / 返回网格：340ms 放大/缩小照常播放；
  - 页面内容淡入照常；
  - 岛仔呼吸/眨眼、待办勾选弹跳、通知骨架呼吸、封面播放动画照常；
  - 收起态歌词条淡入、切句淡入照常；
  - 岛的开合动画本来就不读该设置，行为不变。
- 功能、数据、窗口尺寸链路不变；只恢复动画。

## 四、必要依赖

无新增依赖。仅删代码，不引入新库、不改 IPC、不改主进程。

## 五、验收条件

1. `npm run typecheck`、`npm run build` EXIT=0。
2. `rg "prefers-reduced-motion" src/` 在渲染层无命中（`src/renderer/src/pet/skinPhoto.tsx` 的说明性注释除外）。
3. CDP 实测（本机 reduce=true）：点组件进音乐页时 `.page-fade` 上存在 340ms 动画；`.island` 计算样式的 `transition-duration` 不是 1ms。
4. `e2e-music`、`e2e-collapsed-lyric` 全 PASS；再回归 `e2e-pages-custom` / `e2e-settings-shell` / `e2e-collapse-order` / `e2e-collapsed-todo`，确认动画恢复后没有把尺寸断言带崩。
5. 真人在预览版里确认页面缩放、淡入、岛仔动画恢复。

## 六、不做什么

- 不新增「始终播放动画」的应用内开关；本次直接不读系统设置。
- 不改岛的展开/收起时长（原本就不受该系统设置影响）。
- 不改任何功能逻辑、数据、窗口尺寸与歌词链路。
- 不处理非 Windows 平台的等价设置（本项目只发行 Windows）。

## 七、自检记录（2026-11-28）

- `npm run typecheck` EXIT=0；`npm run build` EXIT=0。
- `rg "prefers-reduced-motion" src/`：只剩 `pet/skinPhoto.tsx` 的说明性注释与 `styles.css` 的决定注释，没有任何判断/媒体查询。
- CDP 强制 media（同一会话先 `Emulation.setEmulatedMedia` 再 evaluate）：
  - `matchMedia('(prefers-reduced-motion: reduce)').matches` = **true**；
  - `.island` 计算样式 `transition-duration` = **0.22s, 0.22s, 0.22s, 0.6s**（改前 reduce 下是 1ms）；
  - 点组件进音乐页后 `.page-fade` 上有 **340ms running** 动画（改前 reduce 下被跳过）。
- `node scripts/e2e-collapsed-lyric.mjs`：**PASS（43 过 / 0 败）**。
- `node scripts/e2e-music.mjs`：**41 过 / 3 败 / 2 跳过**。失败的 M2d/U5（时间显示 `--:--`）与 M3a（toggle 后状态不变）是当前唯一 SMTC 会话为 Rainmeter 可视化皮肤（无总时长、不响应播放控制）导致；同一脚本在真实播放器会话下本轮之前为 47/0/1，失败与本次删代码无关。
- 回归：`e2e-pages-custom` **PASS（7）**（首跑有一次 6 项后 FAIL 的启动时序抖动，复跑通过）、`e2e-settings-shell` **PASS（60/0）**、`e2e-collapsed-todo` **PASS**、`e2e-collapse-order` **21/1**（失败项 R2d 为本机无电池、电量环不渲染，既有环境问题）。
- 未验证：真人观感；本机系统「动画效果」当前实测为 false（可能用户已打开），模拟 reduce 用的是 CDP 媒体覆盖，不是真实系统开关。
