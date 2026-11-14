# SPEC-notify-icon-and-single-group 通知页：补齐缺失图标 + 分组只分一次

## 抬头

- 建立日期：2026-11-14
- 基线：`main` `26a5be1b71decf5fa822182a58a22fe442010ca9`（角标功能全部退回后的代码基线）
- 任务分支：`notify-icon-and-single-group`（`git switch -c notify-icon-and-single-group main`）
- 用户原话（m00934）：「先来解决一下这个通知页里的问题，我这个火绒退出的时候这个信息怎么没有图标；还有就是现在app的通知只分一次，不要一直分，如截图二；还有就是你视图看不了你可以借助可以看图的模型，这个你不要忘了」
- 关系：本轮**推翻** `docs/Spec/SPEC-us-040-notify-group.md` 的第二级（按标题细分会话），把两级堆叠简化为一级。该旧 SPEC 作为历史留痕保留，不改其正文。
- 图片证据（本会话已用视觉模型 + OCR 核对，用户第 3 点提醒已落实）：截图一 `sha256:b365623a18fb1e114aa23e506bcd43985b56bebdebb50b2128cb03cb9b466191`，截图二 `sha256:c5d75c57f73b6ad97cbcf246546b0289cd5fe939d11dc0fc0320c0485044fbef`。

## 一、目标

1. **补齐缺失图标**：通知页里「Windows 安全中心」那类通知不再显示成一坨紫色文字（`SecurityCenter`），而是显示来源应用图标；并且今后任何解析不到图标的通知也不再是光秃秃的文字，至少有一个中性占位图标方块。
2. **分组只分一次**：默认列表按应用堆叠一层，点开应用**直接平铺该应用的全部具体通知**，不再按标题再分一层「会话」。
3. 不改已读水位、清空、实时刷新、点击直达、未读蓝点、收起态红点等既有语义。

### 诊断（[实测]，定位真因，不是凭截图猜）

- 截图一 OCR 精确文本：「通知 / 99 10:05 / 自启关 / 2 条通知 / 已读 清空 / SecurityCenter / 刚刚 / 启用病毒防护 / 屏幕截图已复制到剪贴板 / 4 分钟前 / 已自动保存到屏幕截图文件夹。」视觉复核：第一条「SecurityCenter / 启用病毒防护」左侧只有紫色纯文字，没有图标也没有空白方块；第二条屏幕截图有图形图标。
- 只读探针 `.tmp/probe-notify-apps.mjs`（复制 `wpndatabase.db` 后只读查询）：order 2074 的 `appId` 是 `Windows.Defender.SecurityCenter`、title「启用病毒防护」；同来源还有 order 2072/2068/2042/2016 多条「启用病毒防护」与 2071「启用 Windows 防火墙」。⇒ 用户说的「火绒退出」其实是火绒退出后 **Windows Defender 安全中心**弹的提醒，不是火绒自己发的通知。
- `src/main/notifyStore.ts:96–101` 的 `appShortName()` 把该 AUMID 截成 `SecurityCenter`；`src/main/notifyIconStore.ts:186–258` 的三条解析链（自家图标 / UWP `Get-AppxPackage` / App Paths 注册表与开始菜单 `.lnk` 找 `SecurityCenter.exe`）全部落空；`%APPDATA%\lingdong-island\icon-cache` 里没有 `notify-SecurityCenter.png` ⇒ `appIcon()` 返回 `null`。
- `src/renderer/src/App.tsx:1340–1345` 无 icon 时渲染 `<span className="notify-app">{g.app}</span>`，即截图一那坨紫字。
- 截图二 OCR 精确文本含两次「分钟前」，视觉复核有缩进子列表、两层结构 ⇒ 点开应用后又按标题再分了一层，正是用户要去掉的「一直分」。
- 可用图标源 [实测]：`C:\WINDOWS\System32\SecurityHealthSystray.exe` 存在，用项目既有 `SHGetFileInfo` 提 32px 图标成功（base64 长度 1572，见 `.tmp/securitycenter-icon.png`）；`Microsoft.SecHealthUI` 包内另有 `WindowsSecurityAppList.targetsize-48.png` 等 14 个变体。本轮选 exe 路线，复用现成 `exeIconPng()`，不新增提取机制。

### 口径说明（[推断]）

「只分一次，不要一直分」理解为：**保留按应用的一级堆叠，点开直接平铺具体条目，删掉按标题的二级会话层**。依据是截图二显示的正是点开应用后的第二层。最可能错在用户其实想「完全不分组、所有通知一条条平铺」；若用户试用后说不对，改方向即可，本 SPEC 的修改范围仍复用。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/notifyIconStore.ts` | 新增「已知系统应用短名 → exe 绝对路径」别名表（当前一条：`SecurityCenter` → `SecurityHealthSystray.exe`），在 `appIcon()` 的 Win32 路线之前先查；命中走既有 `exeIconPng()` 提图标并缓存。路径用 `process.env.SystemRoot` 拼，不写死盘符。 |
| `src/renderer/src/App.tsx` | ①NotifyPanel 删掉 `openThreads` / `toggleThread` 与组内按 title 的 `threads` 计算；展开应用后直接渲染 `g.list` 的具体条目（沿用原 `notify-leaf` 的 JSX、点击直达 `openOne`、时间/蓝点 `renderSide`）。②无 icon 的兜底分支在应用名文字前补一个中性占位图标方块（首字），让「每条通知都有图标位」成立。 |
| `src/renderer/src/styles.css` | 清理本功能引入、单级后已失效的 `.notify-thread` 相关规则；把 `.notify-leaf` 的深缩进改为单级缩进；新增 `.notify-icon-fallback` 占位方块样式。 |
| `scripts/e2e-notify-group.mjs` | 断言从两级改为一级：G3 点击组条目直接出现 `.notify-leaf`，删掉 G3b/G4/G5a 的会话层断言，G7 改为「展开所有组后 leaf 数 = 工具栏计数」，G8 重拉后展开状态仍保留。 |
| `docs/facts/功能清单.md` | 同步图标解析链（别名表）与通知分组结构（一级堆叠）。 |
| `docs/状态.md` | 追加一句话状态。 |
| `docs/Spec/SPEC-notify-icon-and-single-group.md` | 本 SPEC（含自检记录）。 |

不改动：`src/main/notifyStore.ts` 的数据结构/SQL/水位、`src/preload/`、通知横幅、收起态铃铛与红点、已读与清空逻辑、页面管理、其它 e2e 脚本。

## 三、预期行为

1. 默认列表：同一 app 的多条通知仍合并为一条组条目，图标右上角数字 = 条数，预览取最新一条，时间/蓝点在右侧。
2. 点击组条目 → 立刻平铺出该应用的**全部具体通知**（每条自带图标或占位方块、标题、正文、相对时间、未读蓝点），点具体条目正文 = 打开来源应用；再次点击组条目 → 收起。不再出现「会话」中间层、不再需要点两次才看到内容。
3. **Windows 安全中心通知**（AUMID `Windows.Defender.SecurityCenter`）显示真实盾牌/安全中心图标，不再是紫字 `SecurityCenter`。图标写入 `icon-cache/notify-SecurityCenter.png`，后续命中文件缓存不再重提。
4. 任何解析不到图标的通知：显示应用名首字的中性方块占位 + 应用名文字，不再是「只有文字没有图标」。
5. 页面顶部「N 条通知」仍按通知条数累计，不受分组影响；已读、清空、实时刷新、展开状态保留的行为不变。
6. 组条目排序仍按最新通知时间倒序（Map 插入序），组内具体条目保持新→旧。
7. 只有一条通知的应用仍不带数字徽标。

## 四、必要依赖

无新依赖、无新 npm 包、无新 IPC 通道。复用：`NotifyItem`（app/icon/title/body/arrival/order）、`appIcon()` 与 `exeIconPng()` 的 `SHGetFileInfo` 提取、`iconUrl()` 的 `ldapp://` 协议、现有 e2e 基建（CDP 9321 + dev electron）、`%SystemRoot%\System32\SecurityHealthSystray.exe`（Windows 自带，本机已实测存在）。

## 五、验收条件

- A1 [实测] `npm run typecheck` EXIT=0、`npm run build` EXIT=0。
- A2 [实测] `scripts/e2e-notify-group.mjs` 单级断言全过：默认按 app 堆叠、组带计数徽标、点组直接出具体条目、点组收起、单条 app 无徽标、展开全部后条目数 = 工具栏计数、重拉后展开状态保留、页面里**不存在 `.notify-thread`**。
- A3 [实测] 图标补齐：`appIcon('SecurityCenter')` 返回非空路径且 `icon-cache/notify-SecurityCenter.png` 落盘；CDP 断言 `Windows.Defender.SecurityCenter` 那条通知渲染出 `img.notify-icon` 且 `naturalWidth > 0`（不是空灰底）。
- A4 [实测] 兜底：构造一个解析不到图标的通知，断言渲染出 `.notify-icon-fallback` 占位方块而不是纯文字。
- A5 [实测] 回归：`e2e-notify-icon`、`e2e-notify-clear`、`e2e-notify-live`、`e2e-notify`（基础）、`e2e-beautify-04`（通知页蓝点/右侧列）全 PASS 或原有跳过口径不变。
- A6 [实测] 改完 `git status --short` 里无 `.tmp/` 与 `out/` 残留进提交；交付给出固定提交哈希。
- A7 [实测] 预览版已开（停安装版实例、只开一个），用户能在通知页亲手点开应用验证。
- A8 [未验证／只有真人能验] 真实观感：盾牌图标清晰度、占位方块配色、平铺后列表长度与滚动手感、真实火绒/Defender 再弹一次通知时的表现。本模型只能读 DOM 与文件，不能替人判断好不好看。

## 六、不做什么

- 不做「完全不分组、所有通知一条条平铺」（口径见第一节，用户未要求）。
- 不做收起态 App 图标角标（用户 2026-11-14 已两次否决，永久排除）。
- 不改主进程数据结构、SQL、已读水位、隐藏水位、横幅逻辑；堆叠是纯渲染层显示变换。
- 不改 `appShortName()` 的短名规则（改了会影响既有缓存键与横幅应用名）。
- 不新增通用图标提取机制（不遍历 `imageres.dll`、不新建 UWP 包名猜测表）；别名表只补已实测确认的已知系统应用。
- 不按日期分组、不做搜索、不做手动置顶、不持久化展开状态。
- 不合并回 `main`、不打包、不装机、不做独立验收（按 `docs/工程规则.md` 第三节第 5 条攒批）；这些都需要用户单独授权。

## 自检记录

全部在 `D:\Users\honor\Documents\Project\灵动岛` 于分支 `notify-icon-and-single-group` 上跑，[实测]。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | EXIT=0（`tsc --noEmit` 两份 tsconfig 均通过） |
| `npm run build` | EXIT=0（electron-vite，`out/renderer/assets/index-CwNBg2Dk.js` 102.19 kB / `index-DWUdnjDj.css` 58.98 kB；改 App.tsx 后重跑一次仍 EXIT=0） |
| `node scripts/e2e-notify-group.mjs`（本轮重写为单级） | **12 过 / 0 败**：G1 堆叠(34 条/6 组)、G2 计数徽标、G3 点组直接平铺 20 条、G3b 无 `.notify-thread`、G4 每条都有图标区、G5 收起、G6 单条无徽标、G7 展开后 34=34、G9 40 个图标位(33 真+7 占位)、G10 占位方块不冒充真图标、G11 Windows 安全中心真图标(`img=true 占位=false naturalWidth=32 src=ldapp:`)、G8 重拉后展开保留 |
| `node scripts/e2e-notify-icon.mjs` | **10 过 / 0 败**：I1 34 条中 29 条带 icon、I2/I2b/I2c 图标缓存落盘、I3 图标/徽标分支渲染、I3b `naturalWidth>0` 4/4、I3c `ldapp:` 协议、I4–I6 横幅与注册 |
| `node scripts/e2e-notify-clear.mjs` | **7 过 / 0 败**（清空/隐藏水位/红点消失） |
| `node scripts/e2e-notify-live.mjs` | **1 过 / 0 败**（新消息实时出现） |
| `node scripts/e2e-notify.mjs` | PASS（基础列表 6 条、IPC n=34/unread=26、已读按钮） |
| `node scripts/e2e-beautify-04.mjs` | **27 过 / 0 败**（蓝点/右侧列/月历） |
| `node scripts/e2e-notify-open.mjs` | **8 过 / 0 败**（launch 解码、协议白名单） |
| `node scripts/e2e-notify-compact.mjs` | **2 过 / 0 败**（条目高 30px、无空白卡） |

关键证据：

- A3 图标补齐：`.tmp/e2e-userdata/lingdong-island/icon-cache/notify-SecurityCenter.png` **1178 B，2026-11-14 10:53:21 落盘**（`appIcon('SecurityCenter')` 由 null 变非空，别名表生效）；G11 用 CDP 断言该条渲染出 `img.notify-icon`、`naturalWidth=32`、协议 `ldapp:`、且**不是** `.notify-icon-fallback` 占位方块。
- A4 兜底：G9 统计 40 个 `.notify-icon-wrap` 里 7 个是占位方块（真图标 33），每个占位方块都带 `title` 与首字文本；G4 断言 20 个平铺条目全有图标区。
- A2 单级：G3b 断言 `.notify-thread` 恒为 0；G3 点组直接出 `.notify-leaf` 且数量 = 组计数，G7 展开全部组后 leaf 数 = 工具栏「N 条通知」。
- e2e-notify-icon 的 I3 分支仍成立：占位方块用独立类名 `.notify-icon-fallback`，不复用 `.notify-icon`，因此 I3b 的 `naturalWidth`、I3c 的 `ldapp:` 协议断言不会被污染；有图标的条目也保留了 `.notify-app` 之外的正文结构，I3 的「图标+文字徽标 >0」仍通过。

未验证／边界：

- A8 真实观感（盾牌图标清晰度、占位方块配色、平铺后列表长度与滚动手感、真实火绒/Defender 再弹一次通知时的表现）只有真人预览版能验；本模型只读 DOM 与文件，不替人判断好不好看。
- 别名表只补了本机实测确认的 `SecurityCenter` 一条；别的系统应用若短名与 exe 对不上仍可能退回占位方块（按「不做什么」不新增通用猜测机制）。
- 未合并回 `main`、未打包、未装机、未做独立验收（按 `docs/工程规则.md` 攒批）；这些都需要用户单独授权。
- `.tmp/probe-notify-apps.mjs`、`.tmp/securitycenter-icon.png` 是本机只读探针产物，不进交付提交。

## 验收记录

（本轮不做独立验收，按批进行；留空待批量验收时针对合并后的 `main` 提交补记。）
