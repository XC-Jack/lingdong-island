# SPEC：音乐页补齐控制（第 1 批）

- 创建日期：2026-11-15
- 基线：`main` @ `6c4348d`
- 任务分支：`music-controls`
- 关联：`docs/Spec/SPEC-music-page.md`（2026-11-11 第 5 页音乐页，只做「控制与信息」）
- 用户决策（m00072）：音乐页未完善部分「全都补、分批做」；本 SPEC 是第 1 批，只做「把控制补齐」。
  第 2 批真实封面、第 3 批滚动歌词 + 收起态歌词条另开 SPEC，本批不动。
- **重大修订（2026-11-15，用户 m00534 纠正）**：用户明确否决「音量绑成系统主音量」，要求「对应应用音量」。
  本 SPEC 里「音量＝Windows 系统主音量 / 这是接口客观限制 / UI 注明系统音量」等旧结论**全部作废**。
  音量改为只读写「当前播放应用的那条 Core Audio 音频会话」，绝不碰系统主音量；对不上应用时
  `canVolume=false`、滑块置灰、不读写任何音量，绝不回退系统音量。详见下方「音量语义（修订后）」与
  第九节修订自检。点播 / 随机 / 循环三项不变。

## 一、目标

给第 5 页音乐页补齐 4 个原规格明确「不做」的控制项，让音乐页能像原视频那样操作：

1. 进度条拖拽 / 点击点播（跳到歌曲任意位置）。
2. 随机播放开关。
3. 循环模式切换（不循环 / 单曲循环 / 列表循环）。
4. 音量调节。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `MusicState` 扩字段；`MusicCommand` 从字符串联合改为带参数命令对象 |
| `src/main/smtcScript.ts` | PS 5.1 桥接脚本：poll 输出扩字段；命令解析改 JSON；新增 seek/shuffle/repeat/volume 分支；内嵌音量 C# COM 定义 |
| `src/main/musicStore.ts` | `EMPTY_STATE` / `sameState` / `handleLine` 同步扩字段；`music:control` 改带参数签名 |
| `src/preload/index.ts` | `musicControl` 签名跟随新命令类型 |
| `src/renderer/src/App.tsx` | 新增 4 个图标；`MusicPanel` 加控件渲染、事件、能力位禁用逻辑 |
| `src/renderer/src/styles.css` | 进度条热区、新控件行、音量滑块、禁用态样式 |
| `scripts/e2e-music.mjs` | 新控件用独立 `.music-extra` / `.music-chip`，不放进 `.music-ctl`，故 M2b「恰好 3 个按钮」断言零改动；可补新字段结构断言 |
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
3. **对号入座**：SMTC `SourceAppUserModelId` 对桌面播放器就是进程可执行名（如 `powershell.exe`），音频会话按 PID 取进程名比对；
   商店应用再比 `GetApplicationUserModelId` 包族名。显示名不可靠（实测空串 / `@%SystemRoot%\System32\AudioSrv.Dll,-202`），绝不按显示名匹配。
4. **对不上号怎么办（用户已拍板）**：`canVolume=false` → 音量滑块置灰、数字显示 `--`、不读写任何音量，**绝不回退系统主音量**。
5. 音乐页音量控件 `title` 注明「当前播放应用的音量（只影响这个应用）」；交付说明不再说「会影响所有程序声音」。

### 能力位禁用（[已核验] 的必要性）

`.tmp/probe-smtc-controls.mjs` 实测假 MediaPlayer 会话 `IsShuffleEnabled=False`、`IsRepeatEnabled=True`、`IsPlaybackPositionEnabled=True`。不支持的能力必须禁用对应按钮，不能一律可点；否则点了没反应又无提示。音量控件按 `canVolume` 能力位置灰：对不上当前播放应用的音频会话时禁用，不显示可拖的假滑块。

### 渲染层

1. 进度条改成可点击 / 可拖拽：用一个透明热区覆盖（3px 的 `.music-bar` 太细，热区做到至少 14px 高），按下 / 拖动时按 `clientX` 换算秒数，松手发 `seek`；拖动期间本地 `live` 跟随、暂停每秒插值避免跳回。`duration<=0` 或 `canSeek=false` 时不响应。
2. 控件行布局：原 3 个按钮保持居中一行；随机 / 循环 / 音量另起一行（`.music-extra`），避免把 470×320 固定面板撑破（实测内容区约 422×280 布局 px，当前音乐页约 168px，加一行 32px 仍有余量）。
3. 随机 / 循环按钮带 `.on` 高亮（跟随 `shuffle` / `repeat`）；循环按钮点击在 `None → Track → List → None` 间轮换，仅在 `canRepeat` 为真时发命令。
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
3. `scripts/e2e-music.mjs` 通过（混合行协议下 M2b 断言零改动仍全绿），`scripts/e2e-music-session.mjs` 通过（纯文本命令保留，S1–S10 不回归）。
4. 新增协议断言：seek / shuffle / repeat / volume 四条命令各收到一条 `ack`，`ok` 为布尔；未知命令仍只回一条 `ack ok=false`（原 S10 语义不变）；静态护栏断言桥接脚本正文不含系统主音量接口（`IAudioEndpointVolume` / `GetMasterVolumeLevelScalar` / `SetMasterVolumeLevelScalar`）。
5. 本机实测（真人验证，助手不代验）：打开任意播放器放歌 → 展开岛切到音乐页 → 拖进度条能跳、随机/循环按钮按能力位禁用或高亮正确、拖音量滑块**只改这个播放器**的音量（其它程序声音不变）；对不上号的播放器音量滑块置灰显示 `--`。
6. 音量语义在 UI 上有可见提示（`title` 含「当前播放应用」、不含「系统」），交付说明里明说只影响当前播放应用、绝不碰系统主音量。
7. 不改原三按钮的 aria-label / title 文案与 `music-btn` class，避免影响既有 e2e 与无障碍。
8. 自检记录写明跑了哪些命令、结果、**哪些没验证**（真机独占项按工程规则注明只有真人能验）。

## 六、不做什么

1. 不做封面图（第 2 批）。
2. 不做滚动歌词 / `.lrc` / 联网拉取 / 收起态歌词条（第 3 批）。
3. 不新增设置窗口「音乐与歌词」分区。
4. 不做静音切换（`GetMute` 在 PS 5.1 下报 `Value does not fall within the expected range.`，非必需）、不做倍速、快进/快退、上一首/下一首以外的曲目操作。
5. 不做进度条拖拽时的服务端实时预览（本地插值即可）、不做音量随播放器变化自动回读之外的事件订阅。
6. 不引入 native 模块、第三方音乐平台 API、C# 辅助进程。
7. 不改第 5 页以外的任何页面、不改页签数量、不改 App 图标角标、不改数据导入。
8. 不合并回 `main`、不打包安装（按 `docs/工程规则.md`，需用户单独明确授权）。

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
