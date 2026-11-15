# SPEC：音乐页真实封面（第 2 批）

- 基线：`main@e83eb36`（第 1 批已合并，未打包）
- 分支：`music-cover`（从 `main` 新建）
- 关联：用户 m00072「全都补、分批做」；用户 m01471「下一批」＝开工第 2 批
- 上游规格：`docs/Spec/SPEC-music-page.md`（第 5 页音乐页）、`docs/Spec/SPEC-music-controls.md`（第 1 批，已验收合并）
- 历史卡点：`docs/facts/本机约束与踩坑.md:87`、`docs/facts/技术方案.md:84` 曾记「PS 5.1 拿不到 SMTC 封面字节，用音符占位，后续如需封面另开 SPEC 走 C# 原生辅助进程」——**本批实测推翻，见第七节，结论须作废**。
- **合并/上线状态（2026-11-15 16:15，最新，覆盖下方「六、不做什么」与「八、边界」的历史表述）**：用户 m01786「合并打包」明确授权后，本批已合并回 `main`（合并提交 `d04b4e5`，`git diff --stat music-cover main` 为空），并已 `npm run dist` 打包、静默安装到 `D:\软件\灵动岛\`（装入 `app.asar` `10967021 B` / SHA256 `FFFA8492…9060`，与 win-unpacked 逐字节一致）、干净环境启动安装版 4 进程主窗口正常、包内复核命中 `IslandCoverGrab`/`coverCacheKey`/`music-cover-img`。详见第九节。下方「不合并、不打包、不装机」是开发阶段的历史状态，已被本条取代。

## 一、目标

把音乐页 `.music-cover` 的粉色音符占位，换成当前播放歌曲的真实专辑封面（SMTC `Thumbnail`）。取不到封面时**仍显示原来的音符占位**，不留空白、不报错。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `MusicState` 新增 `cover: string`（`data:image/...;base64,...` 或空串） |
| `src/main/smtcScript.ts` | 新增内嵌 C# `IslandCoverGrab`（反射 `AsStreamForRead`）+ `GetCover` 缓存；poll 时读 `Thumbnail` 字节并 base64 成 data URL；按「`app｜title｜artist｜album`」缓存，未换歌回 `$null` 沿用缓存、换歌才重读 |
| `src/main/musicStore.ts` | `EMPTY_STATE` / `sameState` / `handleLine` 同步 `cover`（空态清空、`null` 沿用缓存、只放行合法 `data:image/(png｜jpeg);base64,` 正则） |
| `src/renderer/src/App.tsx` | `.music-cover` 内：`cover` 非空且未加载失败时渲染 `<img className="music-cover-img">`，否则保留 `<IcoMusic />`；新增 `coverFailedFor` 状态防止坏图反复闪 |
| `src/renderer/src/styles.css` | 新增 `.music-cover-img`（`object-fit:cover` 填满、继承圆角，`overflow:hidden`） |
| `scripts/e2e-music.mjs` | 补 `M2a1`/`M2a2` `cover` 结构断言、`M2m`/`M2n` 封面容器与 img src 断言 |
| `scripts/e2e-music-session.mjs` | S11 补 `'cover' in lastState`，新增 `S18`（桥接脚本含 `IslandCoverGrab`/`GetCover`）、`S19`（`cover` 为 null/空串/合法 data URL） |
| `docs/facts/功能清单.md` | 音乐页进展条补「真实封面」，去掉「未做封面」 |
| `docs/facts/技术方案.md` | 音乐行补封面实现；`:84` 旧结论标注作废 |
| `docs/facts/本机约束与踩坑.md` | `:87` 旧结论标注作废并写正确做法（本次实测依据） |
| `docs/状态.md` | 顶部新增一句话状态 |

一次性探针放 `.tmp/`，不进交付提交。

## 三、预期行为

1. 桥接脚本在 poll 快照里多带一个 `cover` 字段：取到封面时是 `data:image/png;base64,...`（或 `image/jpeg`），取不到是空串 `""`。
2. 封面按「`app|title|artist|album`」缓存：同一首歌不重复读流（封面约 46KB，base64 约 62KB，每秒重读/重发是浪费）；换歌、换播放器、切到空态后重新取。
3. 渲染层 `cover` 非空时显示封面图，空时显示原音符占位；封面图裁切填满 44×44 圆角方块。
4. 封面读取**任何一步失败都只回空串**，不影响歌名/进度/控制按钮，不吐 `error` 帧打断状态。
5. 不新增页、不改第 5 页以外的界面、不改现有控制逻辑（点播/按应用音量）。

## 四、必要依赖

- 无新增 npm 依赖、无新增系统工具、无原生辅助进程。
- 复用现有常驻 `powershell.exe` 桥接；封面走同进程 `Add-Type -TypeDefinition` 编译的一小段 C#（`System.Runtime.WindowsRuntime` 已随 `AsTask` 反射加载，从 `AppDomain.CurrentDomain.GetAssemblies()` 取，不用 `Assembly.Load` 简单名）。
- `src/renderer/index.html:8` 的 CSP 已含 `img-src 'self' data: ldapp:`，`data:` 封面可直接给 `<img>`。

## 五、验收条件

1. `npm run typecheck` 通过。
2. `npm run build` 通过。
3. `node scripts/e2e-music.mjs` 通过（`cover` 是字符串、空态为 `""`）。
4. `node scripts/e2e-music-session.mjs` 通过（S1–S17 不回归，新增 `cover` 断言通过）。
5. `node .tmp/probe-music-controls-render.mjs` 通过（P 系列 + D 系列不回归，新增 `P2b`/`P13`/`P14` 封面断言通过）。
6. 一次性探针「抽生产桥接脚本 + 真实播放会话 poll」拿到非空 `data:image/png;base64,...` 且字节头为 PNG/JPEG；第二次 poll `cover` 为 `null`（缓存生效、不重发大 base64）。
7. 真人预览版：放一首带封面的歌，音乐页显示真实封面；切到无封面的歌/暂停到无会话时回到音符占位；拖动进度、调音量不受影响。

## 六、不做什么

- 不做歌词、滚动歌词、收起态歌词条（第 3 批）。
- 不做封面缓存落盘、不做封面淡入动画、不做封面点击放大。
- 不改音量（仍是按应用音频会话）、不改点播、不加回随机/循环按钮（用户已拍板删除）。
- 不引入新依赖、不加原生辅助进程、不改行协议（`cover` 只是 state 快照里多一个字段）。
- ~~不合并回 `main`、不打包、不装机（各需用户单独点头）~~（历史表述，已于 2026-11-15 16:15 由用户 m01786 授权合并打包完成，见抬头与第九节）。

## 七、开工前实测结论（推翻历史卡点）

历史三条路复验（真实会话「一生不变（港风女版）」）[已核验]：

1. `props.Thumbnail` 非 null，`OpenReadAsync()` 返回 `System.__ComObject`（WinRT 类型投影丢失），`Size`/`ContentType` 读不出来。
2. PS 直接 `[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)` → `找不到"AsStreamForRead"的重载，参数计数为:"1"。`
3. `[Windows.Storage.Streams.IRandomAccessStream]$stream` 强转 → `无法将"System.__ComObject"转换为"Windows.Storage.Streams.IRandomAccessStream"。`
4. `DataReader` / `GetInputStreamAt` → `[System.__ComObject] 不包含名为"GetInputStreamAt"的方法。`
5. C# 里 `Assembly.Load("System.Runtime.WindowsRuntime")` → `未能加载文件或程序集…系统找不到指定的文件。`

**新路走通（[已核验]，`.tmp/probe-cover-art2.mjs` 连跑两次一致）**：`AsTask` 用的是同一程序集，说明 DLL 已加载；改从 `AppDomain.CurrentDomain.GetAssemblies()` 按 `GetName().Name == "System.Runtime.WindowsRuntime"` 找程序集 → 反射取 `System.IO.WindowsRuntimeStreamExtensions.AsStreamForRead`（1 参数重载）→ `mi.Invoke(null, new object[]{ st })` 直接把原始 `__ComObject` 传进去 → CLR 自动完成 COM 接口协商 → `Stream.CopyTo(MemoryStream)` → `C=OK|bytes=46512|magic=89504e470d0a1a0a|png=true`。

结论：**历史「封面做不了、须另开 SPEC 走 C# 原生辅助进程」作废**；同进程反射即可，且不需要编译期引用任何 `.winmd`（绕开 CS1701 / CS0012）。

## 八、自检记录（2026-11-15）

实现期抓到并修掉一个真实缺陷 [已核验]：首版 `GetCover` 用 `$script:coverKey` 存缓存键，poll 分支里又用 `$coverKey` 给当前歌算键——`-File` 脚本的主脚本体就是 script 作用域，两个名字是同一个变量，算键那一步先把缓存覆盖成当前键，导致 `GetCover` 首帧就误判「未换歌」而恒返回 `$null`（一次性探针 `.tmp/probe-prod-bridge-cover.mjs` 首跑 `cover=null` 抓到）。修法：缓存键改名 `$script:coverCacheKey`、poll 里算键用 `$coverId`，彻底不同名；复跑首帧拿到 46512 字节 PNG（data URL 62038 字符）、第二次 poll 回 `null` 缓存生效。

1. [已核验] `npm run typecheck`（node + web 两个 `tsc --noEmit`）无输出通过。
2. [已核验] `npm run build` 通过：`out/main/index.js 146.79 kB`、`out/preload/index.js 12.71 kB`、`index-BTEVLA-C.css 61.26 kB`、`index-BBPFi6-Q.js 107.08 kB`。
3. [已核验] `node scripts/e2e-music.mjs` → `PASS（33 过 / 0 败）`，本机真实会话「一生不变（港风女版）/ 汽水音乐」，M2a1/M2a2/M2m/M2n 全跑到未跳过。
4. [已核验] `node scripts/e2e-music-session.mjs` → `PASS（20 过 / 0 败）`，`PLAYING_IDX=1`（S2 通过），S18/S19 封面断言通过、S1–S17 不回归。
5. [已核验] `node .tmp/probe-music-controls-render.mjs` → `PASS（18 过 / 0 败）`，含 P2b/P13 与既有 D1–D5 拖动回归。
6. [已核验] `node .tmp/probe-prod-bridge-cover.mjs` → `PASS（5 过 / 0 败）`：真实封面 46512 字节 PNG、`magic=89504e470d0a1a0a`、第二次 poll `cover=null`（缓存生效）。
7. [未核验] 真人预览版：封面显示效果、换歌时封面切换、无封面回落音符、拖动进度/调音量不受影响——需用户在本机预览版实测。
8. 边界：~~本批未合并回 `main`、未 `npm run dist` 打包、未装机~~（历史状态，已由用户 m01786 授权完成，见第九节）；`music-cover` 分支工作区已提交后干净（以 `git status --short` 为准）。

## 九、合并与上线记录（2026-11-15 16:15，用户 m01786「合并打包」）

1. [已核验] 合并：`git switch main` → `git merge --no-ff music-cover -m "merge: 音乐页真实封面（第 2 批，用户授权合并打包）"` 无冲突 → 合并提交 **`d04b4e5`**；合并后在 `main` 上重跑 `npm run typecheck` / `npm run build` EXIT=0，`git diff --stat music-cover main` 为空＝逐字节一致。
2. [已核验] 打包：双镜像 `npm run dist` **DIST_EXIT=0**（打包前先停预览版 electron 释放内存，避免 7-Zip 32 位 `ERROR: Can't allocate required memory!`）。安装包 `release\灵动岛 Setup 0.1.0.exe` **123670976 B** / 16:13:28 / SHA256 `56473A20741D16BEB49E0D8DC9FD5133C624336A19968457C0E1F1FC82C6E72A`；`release\win-unpacked\resources\app.asar` **10967021 B** / SHA256 `FFFA8492F1E902A375D649BDF4DBD67EA20D722B3F646CB882C2FFB3B0249060`。
3. [已核验] 装机：静默安装 `Start-Process -FilePath 'release\灵动岛 Setup 0.1.0.exe' -ArgumentList '/S','/D=D:\软件\灵动岛' -Wait`（`INSTALLER_EXIT=0`）；装后 `D:\软件\灵动岛\resources\app.asar` **10967021 B** / SHA256 `FFFA8492…9060` 与 win-unpacked 逐字节一致（`ASAR_MATCH=True`）；旧包 10937922 B / `070AC860…EF44` 已被覆盖。
4. [已核验] 启动与包内复核：干净子进程 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 后 `Start-Process 'D:\软件\灵动岛\灵动岛.exe'` → **4 进程**、主窗口「灵动岛」pid 2904 Responding=True、开发预览版 0 进程；UTF8 解码安装版 `app.asar` 命中 `IslandCoverGrab` / `function GetCover` / `coverCacheKey` / `music-cover-img` / `AsStreamForRead` / `IslandAppVol` / `seekGuardRef` ⇒ 本批封面代码与第 1 批控制代码确实进包。
5. 边界：独立验收按 `docs/工程规则.md` 三.5 攒批、本批未做（验收记录留空，与历史先例一致）；未打新生产锚点标签（沿用 `prod-20261113`）；任务分支 `music-cover` 保留未删；[未核验] 真人上手看安装版封面显示/换歌切换/无封面回落/控制不受影响。
