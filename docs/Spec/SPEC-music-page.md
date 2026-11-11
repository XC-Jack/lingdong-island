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
| `src/main/smtcScript.ts` | **新建**：桥接用的 PowerShell 脚本正文（`String.raw` 模板），只读会话 + 播放控制 |
| `src/main/index.ts` | 启动时 `setupMusicStore()`，退出时 `stopMusicStore()` |
| `src/main/prefsStore.ts` | pages 合法范围 0..3 → 0..4；一次性迁移：老 prefs 补上音乐页 |
| `src/preload/index.ts` | 新增 `musicGet` / `onMusicState` / `musicControl` |
| `src/renderer/src/App.tsx` | `PAGE_META` 加第 5 项「音乐」；新增 `MusicPanel` 组件；`page === 4` 渲染；`normalizePagesCustom` 范围放宽到 0..4 |
| `src/renderer/src/settings/PageManagerSection.tsx` | 页面区 4 行 → 5 行（加「音乐」行 + 配色点）；`normalizePagesCustom` 范围同步 |
| `src/renderer/src/styles.css` | 音乐页样式（封面占位、进度条、控制按钮） |
| `scripts/e2e-music.mjs` | **新建** e2e |
| `scripts/e2e-music-session.mjs` | **新建**多会话回归 e2e（造 2 个以上假会话，让「正在播放」落在索引 > 0） |
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
- [x] 11. 打包安装到 `D:\软件\灵动岛\` 后，装机版能显示真实歌曲信息
- [x] 12. 独立验收（未参与实现的会话）通过并写入第九节

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
| 2026-11-11 | `node scripts/e2e-music.mjs`（PotPlayer 在跑，有真实 SMTC 会话） | **PASS 25 过 / 0 败**，M1a–M1d、M2a0、M2a–M2e、M3a–M3d、M4a–M4c、M5a–M5g 全过；连跑多次结果一致 | 无会话分支（M2f/M2g）在播放器运行时走了 skip 路径，另单独在「真的没有播放器」时跑过一次（15 过 / 0 败 / 3 跳过） |
| 2026-11-11 | `node scripts/e2e-music.mjs`（关掉播放器，本机真的没有 SMTC 会话） | **PASS 15 过 / 0 败 / 3 跳过**，M2a0 正确判「本机真实会话数 0 → 不算失败」，M2f/M2g 空态分支真跑 | 该次 M3/M4 仍走 skip（没有会话可控制） |
| 2026-11-11 | `node scripts/e2e-music-session.mjs`（**新建**，多会话回归） | **PASS 10 过 / 0 败**：造出 3 个会话、`PLAYING_IDX=1`（正在播放的不在索引 0），桥接三次 poll 全 `active:true`、无 error 帧、挑中播放中的那个、toggle 回 `ok:true`、未知命令只回 1 条 ack | 假会话用的静音 wav 没有元数据，故不断言歌名非空 |
| 2026-11-11 | **负对照**：把两处 `@($sessions)[$idx]` 临时改回裸索引 `$sessions[$idx]` 后跑同一多会话 e2e | **FAIL 5 过 / 5 败**（S5/S6/S7/S8/S9 全败，error 帧「不能对 Null 值表达式调用方法。」）；恢复后 10 过 / 0 败 —— 证明该 e2e 对本缺陷有判别力 | — |
| 2026-11-11 | 回归 `node scripts/e2e-settings-shell.mjs` | **PASS 51 过 / 0 败**（S4a 页面区 5 行、S7 圆点 5 个、S10 按 5 页重算、S12d 峰值 11） | — |
| 2026-11-11 | 回归 `node scripts/e2e-collapse-order.mjs` | **PASS 22 过 / 0 败** | — |
| 2026-11-11 | 回归 `node scripts/e2e-head-order.mjs` | **PASS 14 过 / 0 败** | — |
| 2026-11-11 | 回归 `node scripts/e2e-pages-custom.mjs` | **PASS 6 项通过** | — |
| 2026-11-11 | 回归 `e2e-export.mjs`、`e2e-bell-notify.mjs`、`e2e-shelf-view-pref.mjs`、`e2e-exit-and-shelf-view.mjs` | 全 PASS（bell-notify 15 过 / 0 败） | — |
| 2026-11-11 | 打包装机 | `release/灵动岛 Setup 0.1.0.exe` 122108600 B（17:17:44）静默装到 `D:\软件\灵动岛\`；装机 `resources/app.asar` 9215990 B、SHA256 `8C9BB1030B110204A14E9CE70A69204D0685F5D4DB931E4A36513F5FF15CF22A`（上一版 `26C73E76…C9C757`） | — |
| 2026-11-11 | 从装机 asar 抽出 `out/main/index.js` 核对（`npx asar extract`） | **94576 B（81825 个 UTF-16 字符）**；`@($sessions)[$idx]` **命中 2 处**、裸索引 `$s = $sessions[$idx]` **0 处** —— 装进去的确实是修好的版本 | — |
| 2026-11-11 | 装机版多会话验证（`.tmp/verify-installed-multi.mjs`，用 `.tmp/multi-session-probe.ps1` 造场景） | **PASS 6 过 / 0 败**：场景 `SESSIONS=3`，`i=0 bare=obj`（PotPlayer）、`i=1 bare=NULL wrapped=obj status=Playing`、`i=2 bare=NULL wrapped=obj`——正在播放的确实在索引 1；装机版 `musicGet()` 返回 `{"active":true,"playing":true,"app":"powershell.exe","position":6,"duration":30}`，不是被暂停的 PotPlayer、不是空态 | 假会话用静音 wav 无元数据，故 `title` 为空是预期 |
| 2026-11-11 | 桥接脚本单测（`.tmp/test-fix.mjs` + `fix-candidate.ps1`） | 读到真实会话 `{"active":true,"title":"世界上根本没有这种夜露_BV1FKpP6NEcq.mp4","position":32.2,"duration":364.2,"playing":true,"app":"PotPlayerMini64.exe"}`；`toggle` 回 `{"ok":true}` 且 `playing` 真翻转 | — |

### 开发过程中修掉的三个真实缺陷（供验收复核）

1. **桥接永远读不到会话**（已修）：PowerShell 函数返回 WinRT 对象后，调用方拿到的对象丢了类型投影，再调 `GetPlaybackInfo()` 抛 `System.ArgumentException: 对象的类型不能为 Windows 运行时类型`。原代码把该异常吞在 `try/catch` 里并 emit 空态，现象是「永远没有正在播放」。
   修复：删掉 `PickSession()`/`GetSnapshot()` 两个函数，改为 `PickIndex` 只返回索引（int），快照在**主循环同一作用域内联**取；`catch` 改为 emit `{type:"error",msg}`，Node 侧 `console.warn` 出来，不再静默。
2. **多会话时仍然读不到（第一版修复没修干净，独立验收 B1）**：`$mgr.GetSessions()` 返回的是 `System.__ComObject` 包装的 WinRT `IVectorView`，**裸索引 `$sessions[$i]` 只有 `[0]` 有效，`[1]` 及以后一律 `$null`**：
   ```
   i=0  $sessions[0] = obj   callOK   |  @($sessions)[0] = obj  callOK
   i=1  $sessions[1] = NULL           |  @($sessions)[1] = obj  callOK
   ```
   第一版修复用 `$s = $sessions[$idx]`，单会话时 `idx` 恒为 0 恰好命中，所以本地和 e2e 都看不出来；用户同时开着两个播放器、正在播放的不是索引 0 时就恒显示「现在没有在放歌」。
   修复：两处改为 `$s = @($sessions)[$idx]`；同时订正了 `PickIndex` 上方写反的注释、把未知命令的重复 ack 挡掉、把空 `catch` 补上说明。
3. **e2e 的 M5e/M5g 偶发失败**（已修）：重启后 React 首帧还没挂载 `.island`，脚本里 `el && el.click()` 静默跳过点击，圆点数读到 0。修复方式是加 `ensureExpanded()`（轮询到 `.island` 出现且展开为止）；M5g 另改为先关设置窗口再展开岛，与真实用户操作顺序一致。
   同一轮还修掉了 e2e 的**假绿**（独立验收 B2）：原 `const active = state?.active === true` 把「本机真没会话」和「有会话但读不到」混成一件事，两者都走 `skip()`，功能已坏仍报 PASS；现在用独立 PowerShell 查询拿真实会话数，`会话数 > 0 && active === false` 判**失败**（M2a0），并且脚本以 `process.exit(failed > 0 ? 1 : 0)` 结束。

### 两条残余风险（2026-11-11 第二轮验收方指出，如实记录、本轮不修）

1. **`countSessions()` 查询失败（返回 `-1`）时会退回旧的 skip 路径**：这是代码注释里写明的有意回退（「返回 -1 表示查询本身失败（未知），调用方应退回旧的跳过行为」）。此时 M2a0 会显示 ✓ 并打出 `本机真实 SMTC 会话数 -1`，整场仍报 `PASS（15 过 / 0 败 / 3 跳过）`。**只有「独立计数器自己也坏了」才触发**，且不是静默假绿（屏幕上明确有 -1）。若以后要收紧，可把 `-1` 也判失败。
2. **主 e2e（`e2e-music.mjs`）在单会话下对「裸索引」缺陷没有判别力**：验收方把构建产物改回裸索引后，主 e2e 仍报 `25 过 / 0 败 PASS` —— 因为单会话时 `idx` 恒为 0，恰好命中。**判别力在多会话 e2e `scripts/e2e-music-session.mjs`**（它自造 2 个静音会话把「正在播放」推到索引 > 0）。以后改这段代码，两个脚本都要跑，只跑主 e2e 不算验证过。

## 九、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-11 第一轮 | `verifier-music`（未参与实现的独立会话） | `e557daf` | 12 条：9 ✅ / 1 ⚠️（第 2 条 e2e 不可作依据）/ 1 ❌（验收记录待填）；第 11 条 SPEC 未勾但验收方实测通过 | **不通过，阻断 2 条** |
| 2026-11-11 第一轮阻断项 | 同上，报告 `.tmp/独立验收-e557daf.md` | | **B1（产品缺陷）** `src/main/smtcScript.ts:93`/`:117` 裸索引 `$sessions[$idx]` 只在 `[0]` 有效，`[1]` 起回 `$null` → 多会话时恒空态；**B2（e2e 假绿）** `scripts/e2e-music.mjs:176` 把「本机真没会话」与「有会话但读不到」都走 `skip()`，且脚本失败时退出码仍为 0 | |
| 2026-11-11 第一轮已修复 | Lead | `0935273` | B1：两处改 `@($sessions)[$idx]`，订正写反的注释，未知命令不再吐两条 ack；B2：新增独立 `countSessions()` 判「有会话却读不到」为失败（M2a0）、末尾 `process.exit(failed>0?1:0)`、`startApp` 改轮询 CDP 就绪；新增 `scripts/e2e-music-session.mjs` 多会话回归并用负对照证明有判别力（裸索引 5 过 5 败 → 修好 10 过 0 败） | 待第二轮复验 |
| 2026-11-11 第一轮不阻断项处理 | Lead | `0935273` | 未知命令双 ack 已修、空 `catch` 补说明、SPEC 第 6 条勾选口径已明确、`docs/状态.md` 过期表述已改、装机版已重打（含 B1 修复） | |
| 2026-11-11 第二轮 | `verifier-music-2`（未参与实现的独立会话），报告 `.tmp/独立验收-fb2d052.md`（28046 B） | `fb2d052` | 12 条：**11 ✅ / 1 ⚠️ / 0 ❌**。B1、B2 均判定已真修好，且验收方**自建负对照**证明测试有判别力：B1 裸索引副本 `active=[]` + 「不能对 Null 值表达式调用方法」（修复版 `active=[true,true,true]`），仓库多会话 e2e 正对照 10/0、负对照 5 过 5 败 EXIT=1；B2 把 Git 未跟踪的 `out/main/index.js` 两处取值改成 `$null` 后跑**未改动的** `e2e-music.mjs` → `✗ M2a0 真实会话 1 个，但 musicGet().active = false`、`FAIL（12 过 / 1 败 / 3 跳过）`、**EXIT=1**，跑完已还原（SHA256 复核）。验收方另亲自核：`git diff --stat 0935273 HEAD -- src scripts` 为空；装机 asar `8C9BB103…5CF22A` 9215990 B 含修复（抽出 `out/main/index.js` 与本地构建哈希一致）；装机版实跑 PASS 11/0（读到真实歌名、6:04、进度条 scaleX 与 position/duration 相符、toggle 后 position 3.6→6.9 再还原）；复跑全套回归全绿 | **通过，阻断 0 条** |
| 2026-11-11 第二轮不阻断项 | 同上 | `fb2d052` | ①SPEC 记账把 `String.length` 当字节数（81825 → 实际 94576 B / 81825 字符），已订正；②SPEC 第八节补记「`countSessions()` 返回 -1 时退回旧 skip 路径」这条残余风险；③SPEC 第八节补记「主 e2e 在单会话下对裸索引缺陷无判别力，判别力全在多会话 e2e」，防止以后只跑主 e2e 就以为够；④`SPEC` 第 12 条已勾选 | 已处理 |
