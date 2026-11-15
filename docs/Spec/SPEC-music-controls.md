# SPEC：音乐页补齐控制（第 1 批）

- 创建日期：2026-11-15
- 基线：`main` @ `6c4348d`
- 任务分支：`music-controls`
- 关联：`docs/Spec/SPEC-music-page.md`（2026-11-11 第 5 页音乐页，只做「控制与信息」）
- 用户决策（m00072）：音乐页未完善部分「全都补、分批做」；本 SPEC 是第 1 批，只做「把控制补齐」。
  第 2 批真实封面另开 SPEC（已完成并合并打包）；~~第 3 批滚动歌词 + 收起态歌词条另开 SPEC~~
  ——**第 3 批歌词已于 2026-11-15 由用户 m02341「算了不要歌词这个功能了，歌词完全对不上」实测否决取消，不再排期**（分支 `music-lyrics` / `a474ed5` 仅历史留痕，未合并 `main`）。本批不动歌词。
- **重大修订（2026-11-15，用户 m00534 纠正）**：用户明确否决「音量绑成系统主音量」，要求「对应应用音量」。
  本 SPEC 里「音量＝Windows 系统主音量 / 这是接口客观限制 / UI 注明系统音量」等旧结论**全部作废**。
  音量改为只读写「当前播放应用的那条 Core Audio 音频会话」，绝不碰系统主音量；对不上应用时
  `canVolume=false`、滑块置灰、不读写任何音量，绝不回退系统音量。详见下方「音量语义（修订后）」与
  第九节修订自检。点播 / 随机 / 循环三项不变。
- **二次修复（2026-11-15，用户 m00809 报「按钮音量都动不了」）**：按应用音量第一版（提交 `928c22c`）在真实播放器上
  音量滑块置灰、随机/循环按钮也点不动，是真 bug 不是「对不上号」的设计降级。根因：SMTC 标识是中文
  「汽水音乐」、音频会话进程名却是 `SodaMusic`，旧逻辑按名字相等匹配必失败；且能力位 `canShuffle/canRepeat`
  被播放器报成 False 就硬禁用按钮。改法：对号入座改三层匹配（精确名 → 扫进程窗口标题/产品名建候选名集合 →
  全场仅一条 active 会话直接用），随机/循环按钮去硬禁用改本地乐观反馈。详见第十节。
  第九节里「对号入座＝进程名相等」「不支持的能力必须禁用按钮」两处结论随之作废。
- **三次修复（2026-11-15，用户 m01006 报「循环和随机播放功能没有」＋用户拍板「直接删掉这两个按钮」）—— 本 SPEC 最终形态**：
  二次修复让按钮「一按就变粉」只是本地乐观高亮的假象，播放器实际不执行随机/循环。查证 [已核验，官方文档]
  [Microsoft Learn TryChangeShuffleActiveAsync](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession.trychangeshuffleactiveasync?view=winrt-26100)：
  `TryChange*` 返回 `False` 就是「播放器拒绝/没执行」，不是「成功但不上报」；真实「汽水音乐」把 `canShuffle/canRepeat`
  都报成 `False`、命令发了状态也不跟随。结论＝SMTC 这条路既没法让它真随机/循环、也没法可靠显示开关。
  **用户明确选择「直接删掉这两个按钮」**：界面删掉随机/循环按钮、两枚图标，以及上一版「一按就变粉」的本地乐观假逻辑
  （`shuffleOverride`/`repeatOverride`/`clickShuffle`/`clickRepeat`/`onReject` 等），音乐页只留真能用的控件
  （上一首/播放暂停/下一首、进度条点播、按应用音量）。桥接层 `MusicState` 的 `shuffle`/`repeat` 字段与
  seek/shuffle/repeat/volume 协议**保留**（删它们会连带掀动大量测试且不影响界面，属「不做」）。
  **第一/三/五节及第九/十节里「补齐随机 / 循环」「按钮可点 / 高亮 / 乐观反馈」等描述全部作废**，以本节与第十一节为准；
  音量三层匹配、按应用音量语义、点播三项不变。详见第十一节三次修复自检。
- **四次修复（2026-11-15，用户 m01234 报「拖动进度条会回缩再到目标刻度，很怪」）**：进度条点播虽能跳到目标，但拖动/松手瞬间会先缩回拖动前的位置、再滑到目标。根因两处叠加：① `MusicPanel` 里「收到新快照就 `setLive(music.position)`」的 useEffect 依赖含 `seeking`，松手 `seeking` 翻 false 那一帧用**旧 position** 把 `live` 拽回；② `.music-bar-fill` 的 `transition: transform 960ms linear` 把「回缩—再滑」放成约 1 秒慢动作，拖动时条子也不跟手。改法：加 `seekGuardRef` 保护窗口（松手后到播放器回传「跳到目标附近」的快照前忽略旧 position，换歌/2.5s 超时兜底放弃保护）+ `seekingRef` 同步镜像（拖动中 effect 不打断）+ 拖动期间 `.music-seek.dragging .music-bar-fill { transition: none }` 关缓动。新增探针 D1–D5 真驱动 PointerEvent 并做 A/B 自证：旧代码下 D2/D3/D5 必失败（scale 只到 0.24、时间文本跳回 0:07），新代码 16/0 全过，证明不是假绿。详见第十二节。本次只改 `App.tsx` 与 `styles.css`（及一次性探针），桥接层与两个正式 e2e 零改动。

- **合并状态（2026-11-15 14:55，最新，覆盖下方各节的历史表述）**：用户 m01389「没问题了」＝第 1 批预览版验收通过；用户明确选择「只合并回 `main`，暂不打包」。已执行 `git switch main` → `git merge --no-ff music-controls` → 合并提交 **`2ae9dfb`**（无冲突），`main` 由 `6c4348d` 前进到 `2ae9dfb`，`git diff --stat music-controls main` 为空＝逐字节一致；合并后在 `main` 上重跑 `npm run typecheck` EXIT=0、`npm run build` EXIT=0。**未打包、未装机**：按 `docs/工程规则.md` 五.2「合并 ≠ 上线」，不跑 `npm run dist`、不改 `D:\软件\灵动岛\`。独立验收按批攒、本批未做（验收记录留空），与历史先例一致；合并前置＝用户预览版验收通过。**下方各节自检记录里「本批不合并回 `main`、不打包安装」是当时写完自检时的历史状态，已被本条取代，仅留历史。**

## 一、目标

> **三次修订作废说明**：本节第 2、3 项（随机 / 循环）按用户 m01006 后的拍板「直接删掉这两个按钮」**已作废**，
> 真实播放器上无法通过 SMTC 真随机/循环，界面已删除这两个按钮。当前最终有效目标只有：进度条点播 + 按应用音量。
> 以下保留原文仅为记录本 SPEC 的演进。详见头部「三次修复」与第十一节。

给第 5 页音乐页补齐 4 个原规格明确「不做」的控制项，让音乐页能像原视频那样操作：

1. 进度条拖拽 / 点击点播（跳到歌曲任意位置）—— **本批最终保留**。
2. ~~随机播放开关。~~ —— **三次修订后删除**。
3. ~~循环模式切换（不循环 / 单曲循环 / 列表循环）。~~ —— **三次修订后删除**。
4. 音量调节 —— **本批最终保留（按应用音频会话，见音量语义修订）**。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `MusicState` 扩字段；`MusicCommand` 从字符串联合改为带参数命令对象 |
| `src/main/smtcScript.ts` | PS 5.1 桥接脚本：poll 输出扩字段；命令解析改 JSON；新增 seek/shuffle/repeat/volume 分支；内嵌音量 C# COM 定义 |
| `src/main/musicStore.ts` | `EMPTY_STATE` / `sameState` / `handleLine` 同步扩字段；`music:control` 改带参数签名 |
| `src/preload/index.ts` | `musicControl` 签名跟随新命令类型 |
| `src/renderer/src/App.tsx` | 新增图标 + 控件渲染/事件；**三次修订后随机/循环图标、按钮、乐观假逻辑全部删除**，只剩点播、音量与三个原按钮 |
| `src/renderer/src/styles.css` | 进度条热区、音量滑块、禁用态样式；**三次修订后 `.music-chip` / `.music-chip-badge` 样式删除** |
| `scripts/e2e-music.mjs` | 独立 `.music-extra` 行，不放进 `.music-ctl`，故 M2b「恰好 3 个按钮」断言零改动；**三次修订后 M2h 改为断言 `.music-chip` 数量为 0、M2k 删除** |
| `scripts/e2e-music-session.mjs` | 纯文本命令保留（混合行协议），S1–S10 零改动；补 seek/shuffle/repeat/volume 协议断言 |
| `docs/facts/功能清单.md`、`docs/facts/技术方案.md`、`docs/状态.md` | 同步「未做」清单与本批状态 |

不新增页面、不新增设置分区、不改 `smtc-bridge.ps1` 以外的产物路径。

## 三、预期行为

### 数据字段（`MusicState` 新增，全部由 `poll` 每 1 秒刷新）

1. `shuffle: boolean` —— 当前是否随机，来自 `GetPlaybackInfo().IsShuffleActive`（PS 5.1 已自动解包 `Nullable<bool>`，直接 `[bool]` 强转）。
2. `repeat: number` —— 循环模式 `0=None / 1=Track / 2=List`，来自 `GetPlaybackInfo().AutoRepeatMode`（解包成枚举，`[int]` 强转）。
3. `volume: number` —— **当前播放应用的音频会话音量** `0..1`，来自 Core Audio `ISimpleAudioVolume.GetMasterVolume`（修订后，见音量语义）；对不上号时为 `0` 且 `canVolume=false`。
4. `canSeek: boolean`、`canShuffle: boolean`、`canRepeat: boolean` —— 来自 `GetPlaybackInfo().Controls.IsPlaybackPositionEnabled / IsShuffleEnabled / IsRepeatEnabled`。
5. `canVolume: boolean` —— 是否成功把 SMTC 的 `SourceAppUserModelId` 对上某条 Core Audio 音频会话；`false` 时 `volume=0`、UI 滑块置灰、不读写任何音量。

### 控制命令（混合行协议，最小改动）

**决策（2026-11-15 收敛）**：两个 e2e 脚本用纯文本命令（`poll` / `toggle` / `bogus` / `resync`）直接驱动桥接，若把协议全量改成 JSON 会无谓打断 S1–S10 与 M3c。按「复用优先、选最简单」，保留纯文本命令原样，**只有带参数的新命令用一行 JSON**：

1. 桥接读一行：以 `{` 开头 → `ConvertFrom-Json` 取 `cmd` / `value`；否则整行就是纯文本 `cmd`。解析失败回一条 `ack ok=false` 后 `continue`。
2. `{"cmd":"seek","value":<秒>}` → `TryChangePlaybackPositionAsync([int64][TimeSpan]::FromSeconds([double]$val).Ticks)`（参数是 100 纳秒 ticks，不是秒）。
3. `{"cmd":"shuffle","value":<bool>}` → `TryChangeShuffleActiveAsync([bool]$val)`。
4. `{"cmd":"repeat","value":<0|1|2>}` → `TryChangeAutoRepeatModeAsync([Enum]::Parse($enumT, $name))`，`$enumT = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType=WindowsRuntime]`，`$name` 取 `None` / `Track` / `List`。
5. `{"cmd":"volume","value":<0..1>}` → 调内嵌 C# `[IslandAppVol.AppVol]::Set($app, [float]$val)`，**依赖当前 SMTC 会话**：取选中的会话 `SourceAppUserModelId`，按它匹配对应的 Core Audio 音频会话后只改那一条；无会话或对不上号时回 `ack ok=false`。
6. `toggle` / `next` / `prev` / `poll` / `resync` 仍是纯文本，行为不变；`ack` 的 `cmd` 字段统一取解析后的 `$cmd`（JSON 命令回 `seek` 等名字，不回整行 JSON）。未知命令（如 `bogus`）仍只回一条 `ack ok=false`，保住 S10。

`MusicCommand` 用联合类型同时容纳两者：
`type MusicCommand = 'toggle' | 'next' | 'prev' | { cmd: 'seek'; value: number } | { cmd: 'shuffle'; value: boolean } | { cmd: 'repeat'; value: 0 | 1 | 2 } | { cmd: 'volume'; value: number }`

`musicStore.ts` 里 `send()` 仍收字符串：字符串命令直接写，对象命令 `JSON.stringify` 后写。这样 `scripts/e2e-music.mjs` 的 `window.island.musicControl('toggle')` 与 e2e-session 的 `send('toggle')` 全部零改动。

### 音量语义（修订后，2026-11-15 用户 m00534 纠正）

> **作废旧结论**：此前「音量只能走 Windows 系统主音量、会影响所有程序声音、这是接口客观限制不是取舍」的说法**错误、全部作废**。
> 当时只验证了「SMTC 会话接口没有音量方法」这一半，就跳到了「只能改系统主音量」，漏查了 Windows 音量合成器所用的
> 「按应用音频会话音量」接口。用户明确指出不要绑成系统，要对应应用音量。

1. SMTC 会话接口确实没有音量方法（[已核验]，`.tmp/probe-smtc-capabilities.ps1`）；但这不等于只能改系统主音量。
2. Windows 另有 Core Audio 音频会话接口，可对**单个应用的音频会话**分别读写音量（就是音量合成器里每个应用一根滑块）：
   `IAudioSessionManager2` → `IAudioSessionEnumerator` → `IAudioSessionControl2.GetProcessId` → `ISimpleAudioVolume.GetMasterVolume/SetMasterVolume`。
   [已核验] `.tmp/probe-app-volume.mjs` 在本机 PS 5.1 同进程 `Add-Type` 编译成功、枚举到会话、拿到 PID、按应用读写并还原
   （`RW_ORIG=1 → RW_TEST=0.3 → RW_AFTER_SET=0.3 → RW_RESTORED=1`、`RW_EFFECTIVE=True`）。
3. **对号入座（二次修订，2026-11-15）**：~~SMTC `SourceAppUserModelId` 对桌面播放器就是进程可执行名，按 PID 取进程名相等比对即可~~
   —— 这是第一版以偏概全（只验过自造的 `powershell.exe` 假会话），真实播放器会失败。实测「汽水音乐」SMTC 标识是中文名、
   音频会话进程名却是 `SodaMusic`，名字相等匹配不上。改为三层：①精确名（`Exe(smtc)` 去路径去 `.exe`）与 AUMID/包族名比对；
   ②扫全进程，把窗口标题 / `ProductName` / `FileDescription` 含 SMTC 标识的进程的 `ProcessName` 收进候选集合再比（按 smtc 缓存，
   `poll` 1/s 不重复全扫）；③全场仅一条 `state==1 && pid>0` 的 active 音频会话时直接用它（声音物理上只能从这条出，仍是应用音量，
   不是系统主音量）。多条 active 且无匹配仍禁用。显示名不可靠（实测空串 / `@%SystemRoot%\System32\AudioSrv.Dll,-202`），绝不按显示名匹配。
4. **对不上号怎么办（用户已拍板）**：`canVolume=false` → 音量滑块置灰、数字显示 `--`、不读写任何音量，**绝不回退系统主音量**。
5. 音乐页音量控件 `title` 注明「当前播放应用的音量（只影响这个应用）」；交付说明不再说「会影响所有程序声音」。

### 能力位与按钮可用性（二次修订，2026-11-15）—— 三次修订后本节已作废

> **作废**：真实播放器「汽水音乐」把 `canShuffle/canRepeat` 报成 `False`，`TryChange*` 发了状态也不跟随；
> 「按钮一律可点 + 本地乐观高亮」只制造了「能用」的假象，用户 m01006 实测无效并拍板删除按钮。
> 以下保留原文仅为记录演进，最终以头部「三次修复」与第十一节为准。

~~`.tmp/probe-smtc-controls.mjs` 实测假 MediaPlayer 会话 `IsShuffleEnabled=False`，故「不支持的能力必须禁用对应按钮」~~
—— 这是第一版基于假会话的误判。真实播放器诊断（`.tmp/diag-app-volume.mjs` / `.tmp/diag-match.mjs`）：「汽水音乐」
把 `canShuffle/canRepeat` 都报成 `False`，但 `TryChangeShuffleActiveAsync`/`TryChangeAutoRepeatModeAsync`/`TryChangePlaybackPositionAsync`
实测都回 `True`；能力位只是建议性声明、各播放器报得不一致。故随机/循环按钮**一律可点**（仅命令进行中 `busy` 时禁用），
不再按 `canShuffle/canRepeat` 硬禁用。又因很多播放器收了命令却始终不上报 `IsShuffleActive/AutoRepeatMode`
（`CMD_SHUFFLE_STATE_FOLLOWS=False`），点击后界面用**本地乐观值**立即翻转显示，命令被 IPC 拒绝才回退，换歌/换播放器时清空重跟随；
`title` 诚实注明「部分播放器不反馈状态，以界面显示为准」。进度条 `canSeek` 仍按能力位决定是否响应（诊断 `canSeek=True`）。
音量控件仍按 `canVolume` 置灰：对不上当前播放应用的音频会话时禁用，不显示可拖的假滑块。

### 渲染层

> **三次修订后**：下面第 2、3 条（随机/循环按钮）已删除，第 1、4、5 条仍有效。

1. 进度条改成可点击 / 可拖拽：用一个透明热区覆盖（3px 的 `.music-bar` 太细，热区做到至少 14px 高），按下 / 拖动时按 `clientX` 换算秒数，松手发 `seek`；拖动期间本地 `live` 跟随、暂停每秒插值避免跳回。`duration<=0` 或 `canSeek=false` 时不响应。
2. ~~控件行布局：原 3 个按钮保持居中一行；随机 / 循环 / 音量另起一行（`.music-extra`）。~~ —— 三次修订后 `.music-extra` 只放音量。
3. ~~随机 / 循环按钮带 `.on` 高亮、本地乐观值、循环三态轮换。~~ —— 三次修订后整段删除。
4. 音量用 `<input type="range" min=0 max=1 step=0.01>`，旁边小喇叭图标；拖动时本地立即显示数值，`onChange` 120ms 防抖发 `volume`。`canVolume=false` 时加 `.off` 类整块置灰、input `disabled`、数字显示 `--`，不发命令。
5. 空态（`active=false`）保持原样，不渲染新控件。

## 四、必要依赖

1. 无新增 npm 依赖、无 native 模块、不联网。
2. 运行期依赖 Windows SMTC（同原规格）：播放器必须注册 SMTC 会话，否则音乐页为空态；音量同样依赖当前 SMTC 会话来「对号入座」，用系统默认输出设备上的音频会话枚举，但只改匹配到的那一条，不改设备主音量。
3. 桥接脚本继续由 `writeBridgeScript()` 写 UTF-8 BOM，PS 5.1 才能正确解码中文类型名。
4. 内嵌音量 C# 源码必须是**全 ASCII、无中文注释**的 here-string（`@'...'@` 结束符在行首），否则 PS 5.1 会把 C# 当 PS 解析（[已核验]，`.tmp/probe-system-volume.ps1` 首版即因此失败）；`Add-Type -TypeDefinition` 与 WinRT 类型在同一进程编译成功（`.tmp/probe-app-volume.mjs` 实测 `ADDTYPE=OK`）。

## 五、验收条件

1. `npm run typecheck` 与 `npm run build` 通过。
2. 有真实 SMTC 会话时，`poll` 返回的新字段齐全且类型正确（`shuffle` 布尔、`repeat` 0/1/2、`volume` 0..1、四个 `can*` 布尔含 `canVolume`）；无会话时 `poll` 空态同样带全部新字段（不出现 `undefined`）。
3. `scripts/e2e-music.mjs` 通过（混合行协议下 M2b 断言零改动仍全绿；**三次修订后 M2h 改为断言 `.music-chip` 数量为 0、M2k 删除**），`scripts/e2e-music-session.mjs` 通过（纯文本命令保留，S1–S10 不回归；S2 场景顺序偶发失败按第八节定位记录，不修）。
4. 新增协议断言：seek / shuffle / repeat / volume 四条命令各收到一条 `ack`，`ok` 为布尔；未知命令仍只回一条 `ack ok=false`（原 S10 语义不变）；静态护栏断言桥接脚本正文不含系统主音量接口（`IAudioEndpointVolume` / `GetMasterVolumeLevelScalar` / `SetMasterVolumeLevelScalar`）。
5. 本机实测（真人验证，助手不代验）：打开任意播放器放歌 → 展开岛切到音乐页 → 拖进度条能跳、**界面上不再有随机/循环按钮**、拖音量滑块**只改这个播放器**的音量（其它程序声音不变）；对不上号的播放器音量滑块置灰显示 `--`。生产桥接脚本在真实「汽水音乐」会话上的 `canVolume=true` 已由 `.tmp/probe-prod-bridge-volume.mjs` 自动核验。
6. 音量语义在 UI 上有可见提示（`title` 含「当前播放应用」、不含「系统」），交付说明里明说只影响当前播放应用、绝不碰系统主音量。
7. 不改原三按钮的 aria-label / title 文案与 `music-btn` class，避免影响既有 e2e 与无障碍。
8. 自检记录写明跑了哪些命令、结果、**哪些没验证**（真机独占项按工程规则注明只有真人能验）。

## 六、不做什么

1. 不做封面图（第 2 批，已完成并合并打包）。
2. 不做滚动歌词 / `.lrc` / 联网拉取 / 收起态歌词条：原列「第 3 批」，**2026-11-15 用户 m02341 已实测否决取消，歌词从此不做、不再排期**（非「暂缓」）。
3. 不新增设置窗口「音乐与歌词」分区。
4. 不做静音切换（`GetMute` 在 PS 5.1 下报 `Value does not fall within the expected range.`，非必需）、不做倍速、快进/快退、上一首/下一首以外的曲目操作。
5. 不做进度条拖拽时的服务端实时预览（本地插值即可）、不做音量随播放器变化自动回读之外的事件订阅。
6. 不引入 native 模块、第三方音乐平台 API、C# 辅助进程。
7. 不改第 5 页以外的任何页面、不改页签数量、不改 App 图标角标、不改数据导入。
8. 不合并回 `main`、不打包安装（按 `docs/工程规则.md`，需用户单独明确授权）。
9. **（三次修订追加）不做随机 / 循环的任何界面开关**——真实播放器上 SMTC 无法真执行也无法可靠显示状态，已按用户拍板删掉按钮；桥接内部字段与协议保留但不在 UI 暴露，更不制造「一按就变粉」的假反馈。

## 七、已核实的前置结论（本批开工前实测，避免返工）

1. `.tmp/probe-smtc-signatures.ps1`：`TryChangePlaybackPositionAsync(Int64 ticks)`、`TryChangeShuffleActiveAsync(Boolean)`、`TryChangeAutoRepeatModeAsync(MediaPlaybackAutoRepeatMode)`。
2. ~~`.tmp/probe-volume-set.ps1`：`SetMasterVolumeLevelScalar` 真能改系统音量（`AFTER_SET=0.06999999`）并已还原。~~ **本条作废**：系统主音量方案被用户 m00534 否决，最终实现不用它；留此行只为记录当时确实验证过、且是错误推理的起点。
3. `.tmp/probe-smtc-controls.mjs`（带 2 个真实播放会话）：Nullable 解包、枚举构造、三个 `TryChange*` 全返回 `True`、同进程 `Add-Type` 音量 C# 成功、`IsShuffleEnabled=False` 故必须禁用按钮。
4. `.tmp/probe-app-volume.mjs`（修订新增，带真实播放会话）：按应用音频会话 COM 编译 `ADDTYPE=OK`、枚举会话拿 PID、`GetProcessId` 虚表第 14 槽正确、按应用读写还原 `RW_EFFECTIVE=True`、SMTC `SourceAppUserModelId=powershell.exe` 与 `pname=powershell` 对号入座成功、显示名不可靠。
5. 面板固定 `470×320`、`padding 20px 24px`，内容区约 `422×280` 布局 px；加一行控件不会撑破。
6. 按应用音量接口 IID（[已核验]，[MicrosoftDocs/sdk-api](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/audiopolicy/nn-audiopolicy-iaudiosessionmanager2.md) 等交叉）：`IAudioSessionManager2=77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F`、`IAudioSessionEnumerator=E2F5BB11-0570-40CA-ACDD-3AA01277DEE8`、`IAudioSessionControl=F4B1A599-7266-4319-A8CA-E70ACB11E8CD`、`IAudioSessionControl2=BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D`、`ISimpleAudioVolume=87CE5498-68D6-44E5-9215-6DA47EF883D8`。

## 八、自检记录（2026-11-15，任务分支 `music-controls`）—— 历史留痕，音量部分已作废

> 本节是「系统主音量」旧方案（提交 `f7d3e19`）的自检记录，其中凡涉及音量语义的表述
> （P10 title 含「系统音量」、拖音量滑块系统音量随之变化等）**均已被用户 m00534 否决、作废**。
> 保留仅为历史留痕，最新有效自检见第九节。

1. [已核验] `npm run typecheck`：`tsc --noEmit -p tsconfig.node.json` + `tsc --noEmit -p tsconfig.web.json` 无输出通过。
2. [已核验] `npm run build`：`electron-vite build` 通过，`out/main/index.js 133.26 kB`、`out/preload/index.js 12.71 kB`、`out/renderer/assets/index-BrbXwNC8.css 61.35 kB`、`out/renderer/assets/index-XwyZKJht.js 108.83 kB`。
3. [已核验] `node scripts/e2e-music.mjs` → `E2E MUSIC: PASS（16 过 / 0 败 / 3 跳过）`。本机真实 SMTC 会话数为 0，故「有会话」分支 M2a–M2e、M2h–M2k、M3、M4 按脚本既有逻辑跳过；空态新字段齐全（M2a1）、prefs 迁移（M5 全组）通过。
4. [已核验] `node scripts/e2e-music-session.mjs` → `E2E MUSIC SESSION: FAIL（16 过 / 1 败）`，复跑两次结果一致。唯一失败是 `S2 正在播放的会话确实不在索引 0（构造出目标场景） —— PLAYING_IDX=0`：两个静音 MediaPlayer 会话里 Playing 恰在索引 0，目标场景（Playing 在 >0）没构造出来。这是 `SCENE_PS1` 会话顺序不确定导致的偶发，`Compare-Object` 比对 `.backups/music-controls-20261115/e2e-music-session.mjs.bak` 与当前文件得 `REMOVED_OR_CHANGED_LINES=0` / `ADDED_LINES=46`，即本批只新增 S11–S17、未改动任何原有行（含 `SCENE_PS1` 与 S2 断言），故 S2 失败在基线同样存在，**不是本批引入的回归**。按工程规则「不顺手改无关功能，发现问题记录下来另开 SPEC」，本批不修 `SCENE_PS1`/S2。其余 16 条全过，含本批新增的 S11（poll 新字段齐全）、S12–S15（seek/shuffle/repeat/volume 各收到一条 ack 且 ok 为布尔）、S16（畸形 JSON 只回一条 ack）、S17（畸形输入后桥接仍存活）。
5. [已核验] 一次性探针 `.tmp/probe-music-controls-render.mjs`（不进交付提交）：复用 `SCENE_PS1` 造 2 个静音会话、在场景存续期启动 dev electron、先切到音乐页触发 `musicGet()` 懒启动桥接，补上被主 e2e 跳过的「有会话」渲染层分支 → `PROBE MUSIC CONTROLS RENDER: PASS（12 过 / 0 败）`。P0 切页、P1 active=true、P2 新字段齐全、P3 `.music-ctl .music-btn` 恰好 3（M2b 口径未破）、P4 两个 `.music-chip`、P5 音量 range、P6 `.music-seek`、P7 seekable 与 canSeek 一致、P8/P9 随机/循环按钮按能力位禁用、P10 音量控件 title 含「系统音量」、P11 单曲循环角标仅 repeat===1 出现。
6. **未验证（只有真人能验）**：拖进度条实际跳到指定秒、点随机/循环按钮播放器真的切换、拖音量滑块只改当前播放器音量（其它程序不变）、对不上号的播放器音量滑块置灰、真实播放器（非静音 MediaPlayer 假会话）下能力位与命令 `ok=true` 的表现。按工程规则不代验，交预览版由用户实测。
7. 本批不合并回 `main`、不打包安装，按 `docs/工程规则.md` 等用户单独授权。

## 九、修订自检记录（2026-11-15，用户 m00534 纠正音量后重跑）

> 第八节记录的是「系统主音量」版本（提交 `f7d3e19`）的自检，**音量部分已作废**；本节为按应用音量重写后的最新自检。

1. [已核验] `npm run typecheck`：node + web 两个 `tsc --noEmit` 无输出通过。
2. [已核验] `npm run build`：`electron-vite build` 通过，`out/main/index.js 139.77 kB`、`out/preload/index.js 12.71 kB`、`out/renderer/assets/index-ChXj_t4c.css 61.69 kB`、`out/renderer/assets/index-NIIqjTZ_.js 109.06 kB`。
3. [已核验] `node scripts/e2e-music.mjs` → `E2E MUSIC: PASS（16 过 / 0 败 / 3 跳过）`，含 M2a1「四个 can* 布尔（含 canVolume）」。
4. [已核验] `node scripts/e2e-music-session.mjs` → `E2E MUSIC SESSION: FAIL（17 过 / 1 败）`。唯一失败仍是 `S2 …PLAYING_IDX=0`（既有 `SCENE_PS1` 会话顺序偶发，见第八节第 4 条备份比对，非本批回归）；新增的 S11b「桥接脚本不含系统主音量接口」静态护栏：首跑因桥接注释里写了 `IAudioEndpointVolume` 字样被误判失败，删掉该字样后**通过**。S11/S12–S17 全绿。
5. [已核验] `.tmp/probe-music-controls-render.mjs` → `PROBE MUSIC CONTROLS RENDER: PASS（13 过 / 0 败）`，其中 P10 验音量 `title` 含「当前播放应用」且不含「系统」、P12 验 `canVolume` 置灰与 `--` 显示。
6. [已核验] `.tmp/probe-app-volume.mjs` → `ADDTYPE=OK`、`RW_EFFECTIVE=True`、SMTC AUMID 与音频会话进程名对号入座成功（修订前置证据）。
7. **未验证（只有真人能验）**：真实播放器下拖进度条 / 随机 / 循环 / 音量只改当前应用音量、对不上号置灰。交预览版由用户实测。
8. 本批不合并回 `main`、不打包安装，按 `docs/工程规则.md` 等用户单独授权。

## 十、二次修复自检记录（2026-11-15，用户 m00809 报「按钮音量都动不了」后）

> 第九节记录的是按应用音量第一版（提交 `928c22c`）的自检，当时脚本与探针用的是「自造假会话 + 名字相等匹配」，
> 没覆盖真实播放器，结论过于乐观。用户实测发现音量滑块置灰、随机/循环按钮也点不动（真 bug），本节为二次修复后的最新自检。

现场与根因（[已核验]）：
1. 用户截图（附件 `sha256:099286b37e0909efc431e8f25e79c153b1f0c77e1c6691d2eb09fc5fb5d3785c`）：音乐页正在放歌
   （`1:21 / 4:20`、暂停键粉色亮），随机按钮暗、音量滑块灰且显示 `--`。
2. `.tmp/diag-app-volume.mjs`（只读）：真实会话 `SMTC_0 aumid=汽水音乐 canShuffle=False canRepeat=False`；
   音频会话 `pid=13928 pname=SodaMusic state=1`；三条候选对「汽水音乐」全 `match=False` → `canVolume=false` → 置灰。
   根因＝SMTC 中文标识与进程名 `SodaMusic` 不相等，旧逻辑按名字相等匹配必漏配。
3. `.tmp/diag-match.mjs`（只读+可还原）：扫进程命中 `pid=14816 pname=SodaMusic hit=windowTitle`（窗口标题含「汽水音乐」），
   证明可用「扫窗口标题/产品名建候选进程名集合」把中文标识映射到 `SodaMusic`；`CMD_SHUFFLE_SAME_OK=True`、
   `CMD_REPEAT_SAME_OK=True`、`CMD_SEEK_SAME_OK=True`，但 `CMD_SHUFFLE_STATE_FOLLOWS=False`（播放器不上报随机状态）。

改法（[已核验] 已落盘；**第 1 项音量三层匹配仍有效，第 2/3 项已被三次修订删除作废**）：
1. `src/main/smtcScript.ts` 内嵌 C# 匹配改三层（精确名/AUMID → 候选进程名集合 → 全场唯一 active 会话），`using System.Collections.Generic;`，
   `Dictionary<string, HashSet<string>> NameCache` 按 smtc 缓存；找不到仍禁用、绝不碰系统主音量。**（仍有效）**
2. ~~`src/renderer/src/App.tsx`：随机/循环按钮去掉 `canShuffle/canRepeat` 硬 `disabled`，新增 `shuffleOverride`/`repeatOverride`
   本地乐观值（点击即翻转、IPC 拒绝回退、换歌清空）；`ctl` 加可选 `onReject` 回调。~~ —— **三次修订全部删除**。
3. ~~`scripts/e2e-music.mjs` M2k 与 `.tmp/probe-music-controls-render.mjs` P8/P9 同步改为断言「按钮一律可点」。~~ —— **三次修订删除**。

自检命令与结果（全部 [已核验]）：
1. `.tmp/probe-prod-bridge-volume.mjs`（抽取生产 `String.raw` 正文写带 BOM 的 .ps1、真实 `poll`、只读）→
   `PROBE PROD BRIDGE VOLUME: PASS（5 过 / 0 败）`；真实会话 `app="汽水音乐"`、`canVolume=true volume=1`、
   无 error 帧（C# `Add-Type` 编译成功、桥接循环活着）。**这是本次 bug 最直接的证据：修复前 `canVolume=false`。**
2. `npm run typecheck`：node + web 两个 `tsc --noEmit` 无输出通过。
3. `npm run build`：`electron-vite build` 通过，`out/main/index.js 142.82 kB`、`out/renderer/assets/index-DzBps6-z.js 109.69 kB`。
4. `node scripts/e2e-music.mjs` → `E2E MUSIC: PASS（31 过 / 0 败）`。本次本机真实有会话（汽水音乐），
   故 M2a–M2e/M2h–M2l/M3/M4 全部跑到未跳过：含 M2k「随机/循环按钮一律可点」、M2l「音量滑块按 canVolume 置灰」。
5. `node scripts/e2e-music-session.mjs` → `E2E MUSIC SESSION: PASS（18 过 / 0 败）`（这次 `PLAYING_IDX=1`，S2 也通过，
   印证第八/九节的 S2 失败确为 `SCENE_PS1` 会话顺序偶发、非回归）。
6. `.tmp/probe-music-controls-render.mjs` → `PROBE MUSIC CONTROLS RENDER: PASS（13 过 / 0 败）`，含 P8/P9「按钮一律可点」、
   P10「当前播放应用」不含「系统」、P12「canVolume 置灰与 `--`」。

未验证（只有真人能验）：拖进度条实际跳到指定秒、~~点随机/循环后播放器内部状态真的切换~~（三次修订后按钮已删，无需再验）、
拖音量滑块只改当前播放器音量且其它程序声音不变、对不上号的播放器音量滑块置灰。交预览版由用户实测。
本批不合并回 `main`、不打包安装，按 `docs/工程规则.md` 等用户单独授权。

## 十一、三次修复自检记录（2026-11-15，用户 m01006 报「循环和随机播放功能没有」＋用户拍板「直接删掉这两个按钮」）

> 第十节记录的「按钮一律可点 + 本地乐观高亮」是假功能：用户实测随机/循环根本没生效。
> 本节为删除假按钮后的最新有效自检；音量三层匹配、按应用音量、点播三项不变，第九/十节里涉及
> 「随机/循环按钮可点、高亮、乐观反馈」的结论全部作废。

查证与决策（[已核验]）：
1. 用户 (m01006)「循环和随机播放功能没有」；用户 (m01008)「用」同意先只读诊断；
   用户经 `ask_user_question`（id `shuffle_repeat_decision`）在三个选项中**明确选择「直接删掉这两个按钮」**。
2. [已核验，官方文档] [Microsoft Learn TryChangeShuffleActiveAsync](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession.trychangeshuffleactiveasync?view=winrt-26100)：
   `IAsyncOperation<bool> TryChangeShuffleActiveAsync(bool requestedShuffleState)`，返回「**True indicates success; False otherwise**」。
   ⇒ `TryChange*` 回 `False` 就是播放器拒绝 / 没执行，不是「成功但不上报」；第十节把 `ok=true` 当「能执行」是错的。
3. `.tmp/diag-shuffle-repeat.mjs`（抽生产桥接脚本发 shuffle/repeat 命令 + 多次 poll）：首跑恰逢 SMTC 空态
   （`app=""`，ack `ok:false` 是桥接 `if ($idx -lt 0)` 的正常返回，不能据此断言播放器拒绝）；结合 b34 既有证据
   「汽水音乐」`canShuffle=False/canRepeat=False`、`CMD_SHUFFLE_STATE_FOLLOWS=False`，综合判定
   SMTC 这条路既不能让该播放器真随机/循环、也不能可靠显示开关。

改法（[已核验] 已落盘）：
1. `src/renderer/src/App.tsx`：删 `IcoShuffle`/`IcoRepeat` 两图标组件；删 `shuffleOverride`/`repeatOverride` 两 state 与换歌清空 useEffect；
   `ctl` 去掉 `onReject` 回调简化回 `(cmd)`；删 `shuffleOn`/`repeatVal`/`repeatLabel`/`clickShuffle`/`clickRepeat`；
   JSX `.music-extra` 里删两个 `.music-chip` 按钮（保留 `.music-volume`）。grep 全 `src` 确认这些标识符零残留。
2. `src/renderer/src/styles.css`：删 `.music-chip` / `.on` / `:hover` / `:disabled` / `:focus-visible` / `.music-chip-badge` 样式，
   `.music-extra` 注释改为「音量（当前播放应用）」。
3. `scripts/e2e-music.mjs`：M2h 从「渲染 2 个开关」改为护栏「`.music-extra .music-chip` 数量为 0」；删 M2k「一律可点」。
4. `.tmp/probe-music-controls-render.mjs`（一次性，不进提交）：P4 改为「不再渲染假按钮」；删 P8/P9；P11 改为「不再有循环角标」。
5. 桥接层 `src/main/smtcScript.ts`、`src/shared/types.ts`、`src/main/musicStore.ts`、`src/preload/index.ts` 及
   `scripts/e2e-music-session.mjs` **一字未改**：`MusicState` 的 shuffle/repeat 字段与四条命令协议保留，界面不再暴露。

自检命令与结果（全部 [已核验]）：
1. `npm run typecheck`：node + web 两个 `tsc --noEmit` 无输出通过。
2. `npm run build`：`electron-vite build` 通过，`out/main/index.js 142.82 kB`、`out/renderer/assets/index-B1vKc88g.css 60.89 kB`、`out/renderer/assets/index-B30QI8d7.js 106.12 kB`。
3. `node scripts/e2e-music.mjs` → `E2E MUSIC: PASS（16 过 / 0 败 / 3 跳过）`（本机真实 SMTC 会话数 0，有会话分支按既有逻辑跳过）。
4. `node scripts/e2e-music-session.mjs` → 连跑两次均 `FAIL（17 过 / 1 败）`，唯一失败 `S2 …PLAYING_IDX=0`。
   本次只改了渲染层与 e2e-music.mjs，桥接脚本与 e2e-session 一字未动；b19 已用备份比对证明 S2 是既有 `SCENE_PS1`
   会话顺序偶发、非回归，b36 也实证过同脚本 `PLAYING_IDX=1` 时 18/0 全过。按工程规则不顺手改无关功能，记录不修。
5. `node .tmp/probe-music-controls-render.mjs` → `PROBE MUSIC CONTROLS RENDER: PASS（11 过 / 0 败）`：
   P3 原三按钮仍恰好 3（M2b 口径未破）、**P4「不再渲染随机/循环假按钮」通过**、P5/P6 音量与进度条仍在、
   P10 音量提示「当前播放应用」不含「系统」、P11 不再有循环角标、P12 `canVolume` 置灰与 `--` 保留。

未验证（只有真人能验）：真实播放器下拖进度条确实跳到指定秒、拖音量滑块只改当前播放器音量且其它程序声音不变、
对不上号的播放器音量滑块置灰显示 `--`。随机/循环按钮已删除，无需再验其「生效」。交预览版由用户实测。
本批不合并回 `main`、不打包安装，按 `docs/工程规则.md` 等用户单独授权。

## 十二、四次修复自检（2026-11-15，用户 m01234 进度条回缩）

现场与根因见头部「四次修复」段。改法只动 `src/renderer/src/App.tsx` 与 `src/renderer/src/styles.css`，
桥接层 `src/main/smtcScript.ts` / `src/shared/types.ts` / `src/main/musicStore.ts` / `src/preload/index.ts`
及两个正式 e2e `scripts/e2e-music.mjs` / `scripts/e2e-music-session.mjs` **一字未改**。

自检命令与结果（全部 [已核验]）：
1. `npm run typecheck`：node + web 两个 `tsc --noEmit` 无输出通过。
2. `npm run build`：`electron-vite build` 通过，`out/main/index.js 142.82 kB`、`out/renderer/assets/index-DyORRla1.css 61.09 kB`、`out/renderer/assets/index-Bv_yRcvz.js 106.76 kB`。
3. `node .tmp/probe-music-controls-render.mjs` → `PROBE MUSIC CONTROLS RENDER: PASS（16 过 / 0 败）`，
   含新增 D1–D5：拖动中挂 `.dragging`、拖到 0.75 实时跟手、松手后 1.7s 内 scale 不低于 0.70 不回缩、
   松手后 `.dragging` 移除、时间文本停在目标刻度（≈22.5s）不被旧快照拽回。
4. **A/B 自证（防假绿）**：把修复版暂存到 `.tmp/seekfix-*`，`git checkout HEAD -- App.tsx styles.css` 回退到本批基线
   `986d9de` 后重建跑同一探针 → `FAIL（12 过 / 4 败）`，D1/D2/D3/D5 全失败（D2 scale 仅 0.24、
   D3 采样 0.24→0.21 回缩、D5 时间文本跳回 0:07）；拷回修复版重建复跑 → `PASS（16 过 / 0 败）`。
   证明 D1–D5 真能抓到用户所报的回缩现象，不是「探针条件太理想」的假绿。
5. `node scripts/e2e-music.mjs` → `E2E MUSIC: PASS（30 过 / 0 败）`（本机真实会话 1：「时过境迁 / 汽水音乐 / 暂停」，
   M2a–M2l / M3 / M4 全跑到未跳过）。
6. `node scripts/e2e-music-session.mjs` → `E2E MUSIC SESSION: PASS（18 过 / 0 败）`（本次 `PLAYING_IDX=1`，S2 通过）。

未验证（只有真人能验）：在「汽水音乐」等真实播放器上按住进度条拖到任意秒，条子全程跟手、松手不缩回再滑；
拖动中时间文本实时跟随；不同播放器（网页 / 商店应用）下行为一致。交预览版由用户实测。
本批不合并回 `main`、不打包安装，按 `docs/工程规则.md` 等用户单独授权。
