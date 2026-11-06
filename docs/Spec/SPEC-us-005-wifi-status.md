# SPEC-us-005-wifi-status

> 来源：US-005（`docs/facts/用户角色与用户故事.md` 3.1）。用户 2026-11-06 从 P2 候选中指定。
> 修订（2026-11-06，用户提出）：原版只认 Wi-Fi，插网线时图标会直接消失。补网线分支：按网卡介质类型区分 Wi-Fi（802.11）与网线（802.3，且非虚拟网卡），图标分两种。

## 一、目标

收起态胶囊上显示当前网络连接状态，让用户瞥一眼就知道有没有网、是哪种连接：
- **Wi-Fi 已连接**：Wi-Fi 弧线图标（白色），悬停「Wi-Fi：<网络名>（网络正常）」。
- **网线已连接**：网线水晶头图标（白色），悬停「网线：<接口名>（网络正常）」。
- **连上但没网**：图标变橙（警示），悬停提示带「连上了但上不了网」。
- **没联网**：不显示图标（同电量「取不到就隐藏」的既有约定，不打扰）。
- Wi-Fi 与网线同时存在时优先显示网线（更稳定、通常是有意为之）；VPN 等虚拟网卡不算网线。

展开态头部信息条不显示网络图标（保持现状，不扩范围）。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/main/statusStore.ts` | 电量查询命令追加 Wi-Fi 行（同一次 PowerShell 子进程顺带取回，不新开进程）；`StatusSnapshot` 增加 `wifi` 字段；缓存仍 30s |
| `src/preload/index.ts` | `StatusSnapshot` 接口同步增加 `wifi` 字段（含注释） |
| `src/renderer/src/App.tsx` | 收起态胶囊在电量环右侧、待办数字左侧加 Wi-Fi 图标（复用现有 SVG 风格 `IcoWifi`）；有网白色 / 无网橙色 |
| `src/renderer/src/styles.css` | `.collapsed-wifi` 样式（正常白 / 断网橙两态） |
| `docs/facts/功能清单.md` | 收起态状态栏一节补 Wi-Fi 条目 |
| `docs/facts/用户角色与用户故事.md` | US-005 现状改「已实现」 |
| `docs/状态.md` | 一句话状态更新 |

不改：`src/main/index.ts`（IPC 通道复用 `status:snapshot`）、窗口逻辑、展开态。

## 三、预期行为

1. 主进程单次输出格式（同一次 PowerShell 子进程）：
   - 第一行 `电量|是否充电`（与现状一致）
   - 网络行（每接口一条）`net|<IPv4Connectivity>|<IPv6Connectivity>|<接口名>|<MediaType>|<Virtual>`——`Get-NetConnectionProfile` 与 `Get-NetAdapter` 按 `InterfaceIndex` 关联；输出编码显式 UTF-8，中文网络名不乱码——已探针验证
2. 解析规则：
   - `MediaType = 'Native 802.11'` → Wi-Fi（kind='wifi'）；`MediaType = '802.3'` 且 `Virtual !== 'True'` → 网线（kind='ethernet'）；其它介质（蓝牙等）与虚拟网卡（VPN）跳过。
   - Wi-Fi 与网线并存时优先网线；都没有（含查询失败）→ `wifi: null`，UI 不渲染。
3. `WifiSnapshot` 增加 `kind: 'wifi' | 'ethernet'` 字段，渲染层按它选 `IcoWifi`（弧线）/ `IcoEthernet`（水晶头）。
4. 渲染层沿用现有轮询（首取 + 60s），无需新定时器。
5. 断网判定：`IPv4Connectivity !== 'Internet'` 且 `IPv6Connectivity !== 'Internet'` → 无网；任一为 Internet → 有网。

## 四、必要依赖

无新增依赖。仅用 Electron 内置 `child_process.spawnSync`（已有）与 `Get-NetConnectionProfile`（Windows 内置 cmdlet，本机已实测可读）。

## 五、验收条件

1. `npm run typecheck` 通过。
2. `npm run build` 通过。
3. e2e 探针（CDP）确认收起态 DOM：连 Wi-Fi 时出现 `.collapsed-wifi` 元素，`title` 含网络名；主进程快照 `wifi` 字段为 `{connected:true, name:<网络名>}`。
4. 打包安装到 `D:\软件\灵动岛\`，启动后进程存活（4 个），用户屏幕顶部收起态可见 Wi-Fi 图标。
5. 断网场景（关 Wi-Fi 或断开热点）：图标消失（解析失败/无 WLAN → null）或橙色（连上但无 Internet），两种表现均可接受，以实测为准记录。

## 六、不做什么

- 不做展开态网络展示。
- 不做网速、信号强度、SSID 详情页。
- 不做点击图标弹网络设置的交互。
- 不新增 IPC 通道、不加新依赖。

## 七、自检记录

（2026-11-06，分支 `us-005-wifi-status`；初版提交 `e781f71`，网线修订见后续提交）

| 检查 | 命令 | 结果 |
|---|---|---|
| 探针（开发前） | `Get-NetConnectionProfile` + `Get-CimInstance Win32_Battery` 合并查询 ×3 | [实测] 输出 `99|True` + `wifi|Internet|GZHL_Student 3`，单次 358–382ms；UTF-8 输出中文网络名无乱码 |
| 探针（网线修订） | `Get-NetConnectionProfile` × `Get-NetAdapter` 按 InterfaceIndex 关联 | [实测] 能区分介质类型（802.11 / 802.3）与虚拟标记（Radmin VPN virtual=True）；合并查询仅 +46ms |
| 类型检查 | `npm run typecheck` | [实测] node + web 均 exit=0 |
| 构建 | `npm run build` | [实测] electron-vite 构建成功 |
| 新增 e2e | `node scripts/e2e-wifi.mjs` | [实测] 5 项断言全过：快照结构（含 kind='wifi'）→ 图标 kind 与文案/aria 一致 → DOM 顺序 时钟→电量环→网络图标 且无重叠、时钟完整 → 展开态无图标 → null 分支说明 |
| 网线分支单元级验证 | Node 复刻解析逻辑喂模拟行 `net|Internet|NoTraffic|以太网|802.3|False` + VPN 行 | [实测] VPN 被跳过、真网线被选中，kind='ethernet'；真实插网线场景未测（本机无网线口占用） |
| 回归 e2e | `node scripts/e2e-collapsed-todo.mjs` / `e2e-schedule.mjs` / `e2e-todo-today.mjs` | [实测] 三个均 PASS |
| 打包安装 | 见下 | [实测] 通过 |

### 未验证 / 说明

- [未验证] **真实插网线**：本机正在用 Wi-Fi，没有空闲网线口验证真实环境；网线分支靠单元级模拟行验证（见上表），图标水晶头形状未在真机看过。
- [未验证] **断网橙色分支**：脚本无法可靠模拟断网；offline 类的样式分支由 e2e A2 的双向断言覆盖，但真实断网场景没实测。
- [未验证] **未连接 Wi-Fi 时不渲染**：本机当前一直连着 Wi-Fi，无连接配置路径未在真实环境触发；代码路径为解析行缺失时保持 `wifi: null`。
- [未验证] 停用/禁用网卡时的表现（`Get-NetConnectionProfile` 不返回该接口 → 应同样落 null）。
- CDP `Runtime.evaluate` 的 `awaitPromise` 写法坑：裸 `await` 表达式返回 undefined，必须写成 `Promise.then(...)` 链（已记录在 e2e 脚本注释）。
- e2e A3 首版断言把图标位置写反（要求在电量环左侧），实测矩形（电量 100–122 / 图标 132–147）确认应在**右侧**，改断言后 PASS。代码没改。
- 收起态宽度：新增图标后内容约 +25px，仍在 `COLLAPSED_MAX_W = 320` clamp 内（e2e A3 时钟完整 `HH:mm` 佐证）。

## 八、验收记录

（待填——独立验收用）
