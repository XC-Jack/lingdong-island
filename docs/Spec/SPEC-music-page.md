# SPEC：music-page（音乐页：控制 + 信息）

## 一、抬头

| 项 | 内容 |
|---|---|
| 建立日期 | 2026-11-11 |
| 对应基线提交 | `9a52682`（main，`.dsh-vision-router/` 已清出） |
| 任务分支 | `music-page` |
| 关联用户故事 | US-031「控制音乐播放并看到歌词」（2026-11-05 曾否决，2026-11-11 用户主动要求重启，见 `docs/facts/用户角色与用户故事.md:294` 的重启条款） |
| 关联事实文档 | `docs/facts/功能清单.md`（第 13 节歌词页/音乐控制）、`docs/archive/项目记忆-历史存档-20261105.md:43-46`、`docs/facts/技术方案.md` |

## 二、目标

在岛上新增「音乐」页（第 5 页，索引 4），显示当前系统正在播放的媒体信息并支持控制：

- 显示：歌名、歌手、播放进度条（当前位置 / 总时长）、播放器名。
- 控制：播放/暂停切换、上一首、下一首。
- 数据来源：Windows SMTC（System Media Transport Controls，系统媒体传输控制——Windows 上所有播放器都会注册的「正在播放」接口），不接任何第三方平台 API。

## 三、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `MusicState`、`MusicCommand` |
| `src/main/musicStore.ts` | **新建**：常驻 PowerShell 子进程桥接 SMTC，1 秒轮询，状态变化广播到所有窗口 |
| `src/main/index.ts` | 启动时 `setupMusicStore()`，退出时 `stopMusicStore()` |
| `src/main/prefsStore.ts` | pages 合法范围 0..3 → 0..4；一次性迁移：老 prefs 补上音乐页 |
| `src/preload/index.ts` | 新增 `musicGet` / `onMusicState` / `musicControl` |
| `src/renderer/src/App.tsx` | `PAGE_META` 加第 5 项「音乐」；新增 `MusicPanel` 组件；`page === 4` 渲染；`normalizePagesCustom` 范围放宽到 0..4 |
| `src/renderer/src/settings/PageManagerSection.tsx` | 页面区 4 行 → 5 行（加「音乐」行 + 配色点）；`normalizePagesCustom` 范围同步 |
| `src/renderer/src/styles.css` | 音乐页样式（封面占位、进度条、控制按钮） |
| `scripts/e2e-music.mjs` | **新建** e2e |
| `scripts/e2e-settings-shell.mjs` | S4a / S7 的 4 → 5 |
| `scripts/e2e-pages-custom.mjs` | 圆点数断言随页数变化 |
| `docs/facts/功能清单.md`、`docs/facts/用户角色与用户故事.md`、`docs/状态.md` | 同步事实 |

## 四、预期行为

1. 岛展开后翻到「音乐」页：有媒体会话时显示歌名、歌手、进度条、三个控制按钮；没有会话时显示一句空态提示。
2. 点播放/暂停：系统播放器真的切换状态，1 秒内岛上的图标和进度跟着变。
3. 点上一首/下一首：系统播放器切歌，岛上的歌名跟着变。
4. 播放中进度条每秒前进一格，用 CSS transition 补成连续动画（不跳动）。
5. 音乐页默认开启；在设置窗口「页面管理」里可以关掉，关掉后岛里没有这一页、圆点少一个。
6. 老用户升级后（prefs.json 里原本没有音乐页）自动补上，只补一次；用户手动关掉后不会再自己回来。
7. 播放器没开 / 系统没有媒体会话时，岛的其它页面完全不受影响，进程不报错。

## 五、必要依赖

- 无新增 npm 依赖。
- 依赖本机 Windows PowerShell 5.1（系统自带）+ `System.Runtime.WindowsRuntime`（.NET Framework 自带）。
- 依赖播放器实现了 SMTC。已实测：PotPlayer 可用；未实测：网易云（未在开启状态）。

## 六、验收条件

- [x] 1. `npm run typecheck` 与 `npm run build` 均 exit 0
- [x] 2. `node scripts/e2e-music.mjs` 全过
- [x] 3. 回归 `node scripts/e2e-settings-shell.mjs` 全过
- [x] 4. 回归 `node scripts/e2e-collapse-order.mjs` 全过
- [x] 5. 回归 `node scripts/e2e-pages-custom.mjs` 全过
- [x] 6. 岛里出现第 5 个圆点，可翻到音乐页；无会话时空态文案正确
- [x] 7. 点播放/暂停后 `musicGet()` 返回的 `playing` 发生翻转（用真实 SMTC 会话验证）
- [x] 8. 设置窗口页面管理里出现「音乐」行，取消勾选后岛里圆点从 5 变 4，且落盘到 `prefs.json`
- [x] 9. 老 prefs（pages `[0,1,2,3]`）启动后被补成含 4，且 `musicIntro` 标记落盘；再次启动不重复追加
- [x] 10. 用户手动取消勾选音乐后重启，音乐页保持关闭（不复活）
- [ ] 11. 打包安装到 `D:\软件\灵动岛\` 后，装机版能显示真实歌曲信息
- [ ] 12. 独立验收（未参与实现的会话）通过并写入第八节

## 七、不做什么

- **不做歌词**（用户 m01407 明确选择「先不做歌词，只做控制和信息」）：不显示滚动歌词、不读 `.lrc`、不联网拉歌词。
- **不做封面图**：PowerShell 5.1 无法把 SMTC 缩略图的 `System.__ComObject` 转成可读流（已实测三条路全失败），本轮用音符占位图标；后续如需封面另开 SPEC 走 C# 原生辅助进程。
- 不做音量控制、进度条拖拽点播、随机/循环切换。
- 不新增设置窗口的「音乐与歌词」分区（原视频有，本轮音乐页的显隐复用「页面管理」）。
- 不做音乐页的收起态组件（不往收起态胶囊里加歌词条）。
- 不改 App 图标角标、数据导入（此前已定不做）。
- 不引入任何 native 模块、不引入第三方音乐平台 API。

## 八、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-11 | `npm run typecheck`（node + web） | EXIT=0 | — |
| 2026-11-11 | `npm run build` | EXIT=0，产物 `out/renderer/index.html 0.57 kB`、`settings.html 0.60 kB`、`index-DnBDfXwK.js 102.15 kB`、`index-BvX_0MjM.css 49.54 kB`、`settings-07JWtWzL.js 22.98 kB`、`settings-DjaANCVo.css 9.56 kB` | — |
| 2026-11-11 | `node scripts/e2e-music.mjs`（PotPlayer 在跑，有真实 SMTC 会话） | **PASS 24 过 / 0 败**，M1a–M1d、M2a–M2e、M3a–M3d、M4a–M4c、M5a–M5g 全过；连跑两次结果一致 | 无会话分支（M2f/M2g）在播放器运行时走了 skip 路径，未在「真的没有播放器」时实跑 |
| 2026-11-11 | 回归 `node scripts/e2e-settings-shell.mjs` | **PASS 51 过 / 0 败**（S4a 页面区 5 行、S7 圆点 5 个、S10 按 5 页重算、S12d 峰值 11） | — |
| 2026-11-11 | 回归 `node scripts/e2e-collapse-order.mjs` | **PASS 22 过 / 0 败** | — |
| 2026-11-11 | 回归 `node scripts/e2e-head-order.mjs` | **PASS 14 过 / 0 败** | — |
| 2026-11-11 | 回归 `node scripts/e2e-pages-custom.mjs` | **PASS 6 项通过** | — |
| 2026-11-11 | 回归 `e2e-export.mjs`、`e2e-bell-notify.mjs`、`e2e-shelf-view-pref.mjs`、`e2e-exit-and-shelf-view.mjs` | 全 PASS（bell-notify 15 过 / 0 败） | — |
| 2026-11-11 | 桥接脚本单测（`.tmp/test-fix.mjs` + `fix-candidate.ps1`） | 读到真实会话 `{"active":true,"title":"世界上根本没有这种夜露_BV1FKpP6NEcq.mp4","position":32.2,"duration":364.2,"playing":true,"app":"PotPlayerMini64.exe"}`；`toggle` 回 `{"ok":true}` 且 `playing` 真翻转 | — |

### 开发过程中修掉的两个真实缺陷（供验收复核）

1. **桥接永远读不到会话**（已修）：PowerShell 函数返回 WinRT 对象后，调用方拿到的对象丢了类型投影，再调 `GetPlaybackInfo()` 抛 `System.ArgumentException: 对象的类型不能为 Windows 运行时类型`。原代码把该异常吞在 `try/catch` 里并 emit 空态，现象是「永远没有正在播放」。
   修复：`PickSession()`/`GetSnapshot()` 改为只在**同一作用域内**用 `$sessions[$idx]` 取快照，脚本只向外传索引（`PickIndex` 返回 int）；`catch` 改为 emit `{type:"error",msg}`，Node 侧 `console.warn` 出来，不再静默。
2. **e2e 的 M5e/M5g 偶发失败**（已修）：重启后 React 首帧还没挂载 `.island`，脚本里 `el && el.click()` 静默跳过点击，圆点数读到 0。修复方式是加 `ensureExpanded()`（轮询到 `.island` 出现且展开为止）；M5g 另改为先关设置窗口再展开岛，与真实用户操作顺序一致。

## 九、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 待填 | | | | |
