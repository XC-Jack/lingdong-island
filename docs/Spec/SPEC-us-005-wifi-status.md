# SPEC-us-005-wifi-status

> 来源：US-005（`docs/facts/用户角色与用户故事.md` 3.1）。用户 2026-11-06 从 P2 候选中指定。

## 一、目标

收起态胶囊上显示 Wi-Fi 连接状态，让用户瞥一眼就知道网络是否正常：
- **已连接**：显示 Wi-Fi 图标（白色），鼠标悬停提示「Wi-Fi：<网络名>（网络正常）」。
- **连上但没网**：图标变橙（警示），悬停提示「Wi-Fi：<网络名>（连上了但上不了网）」。
- **未连接 Wi-Fi**：不显示图标（同电量「取不到就隐藏」的既有约定，不打扰）。

展开态头部信息条不显示 Wi-Fi（保持现状，不扩范围）。

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

1. 主进程 `readBattery()`（顺带读 Wi-Fi，函数名含义不变）单次输出格式变为：
   - 第一行 `电量|是否充电`（与现状一致）
   - 第二行 `wifi|<IPv4Connectivity>|<网络名>` 或 `wifi|none`（按 `InterfaceAlias` 含 `WLAN` 过滤；输出编码显式 UTF-8，中文网络名不乱码——已探针验证）
2. 解析失败 / 无 WLAN 条目 → `wifi: null`，UI 不渲染图标。
3. 渲染层沿用现有轮询（首取 + 60s），无需新定时器。
4. 断网判定：`IPv4Connectivity !== 'Internet'` 且 `IPv6Connectivity !== 'Internet'` → 无网；任一为 Internet → 有网。

## 四、必要依赖

无新增依赖。仅用 Electron 内置 `child_process.spawnSync`（已有）与 `Get-NetConnectionProfile`（Windows 内置 cmdlet，本机已实测可读）。

## 五、验收条件

1. `npm run typecheck` 通过。
2. `npm run build` 通过。
3. e2e 探针（CDP）确认收起态 DOM：连 Wi-Fi 时出现 `.collapsed-wifi` 元素，`title` 含网络名；主进程快照 `wifi` 字段为 `{connected:true, name:<网络名>}`。
4. 打包安装到 `D:\软件\灵动岛\`，启动后进程存活（4 个），用户屏幕顶部收起态可见 Wi-Fi 图标。
5. 断网场景（关 Wi-Fi 或断开热点）：图标消失（解析失败/无 WLAN → null）或橙色（连上但无 Internet），两种表现均可接受，以实测为准记录。

## 六、不做什么

- 不做展开态 Wi-Fi 展示。
- 不做网速、信号强度、SSID 详情页。
- 不做有线网（Ethernet）状态。
- 不做点击图标弹网络设置的交互。
- 不新增 IPC 通道、不加新依赖。

## 七、自检记录

（2026-11-06，分支 `us-005-wifi-status`，交付提交 `e781f71`）

| 检查 | 命令 | 结果 |
|---|---|---|
| 探针（开发前） | `Get-NetConnectionProfile` + `Get-CimInstance Win32_Battery` 合并查询 ×3 | [实测] 输出 `99|True` + `wifi|Internet|GZHL_Student 3`，单次 358–382ms；UTF-8 输出中文网络名无乱码 |
| 类型检查 | `npm run typecheck` | [实测] node + web 均 exit=0 |
| 构建 | `npm run build` | [实测] electron-vite 构建成功（renderer 15 modules） |
| 新增 e2e | `node scripts/e2e-wifi.mjs` | [实测] 5 项断言全过：快照 wifi 字段结构 → 收起态图标出现+文案含网络名+有网不带 offline 类 → DOM 顺序 时钟→电量环→Wi-Fi 且无重叠、时钟完整 → 展开态无 Wi-Fi 图标 → null 分支说明 |
| 回归 e2e | `node scripts/e2e-collapsed-todo.mjs` / `e2e-schedule.mjs` / `e2e-todo-today.mjs` | [实测] 三个均 PASS |
| 打包安装 | 见下 | [实测] 通过 |

### 未验证 / 说明

- [未验证] **断网橙色分支**：脚本无法可靠模拟断网；offline 类的样式分支由 e2e A2 的双向断言覆盖（快照 online=false 时断言类存在），但真实断网场景没实测。
- [未验证] **未连接 Wi-Fi 时不渲染**：本机当前一直连着 Wi-Fi，`wifi|none`（无 WLAN 连接配置）路径未在真实环境触发；代码路径为解析行缺失时保持 `wifi: null`。
- [未验证] 停用/禁用 WLAN 网卡时的表现（`Get-NetConnectionProfile` 不返回该接口 → 应同样落 null）。
- e2e A3 首版断言把 Wi-Fi 位置写反（要求在电量环左侧），实际 SPEC 是电量环**右侧**——已用 `.tmp/debug-collapsed-rect.mjs` 实测矩形（电量 100–122 / Wi-Fi 132–147）后修正断言并删除调试脚本。代码本身没改。
- 收起态宽度：新增图标后内容约 +25px，仍在 `COLLAPSED_MAX_W = 320` clamp 内（e2e A3 时钟完整 `HH:mm` 佐证）。

## 八、验收记录

（待填——独立验收用）
