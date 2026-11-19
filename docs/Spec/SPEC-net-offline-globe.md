# SPEC-net-offline-globe：断网时显示 Windows 风格的「无 Internet」地球图标

- 建立日期：2026-11-19
- 对应基线提交：`0e2cb08`（main）
- 任务分支：`net-offline-icon`
- 用户反馈（2026-11-19，附参考截图）：把断网后没网络的图标换成参考图这种（Windows 的「地球 + 斜杠」无 Internet 图标）。

## 一、目标

1. 没有可用网络时，收起态显示「地球 + 斜杠」图标，不再显示橙色 Wi-Fi/网线图标，也不再整个隐藏。
2. 区分「确实断网」与「状态读取失败」：读取失败仍不渲染，避免误报。
3. 有网时保持现有 Wi-Fi 弧线 / 网线图标不变。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/main/statusStore.ts` | 命令执行成功但找不到可用连接时返回 `connected:false` 的快照（此前返回 null）；真正读取失败才返回 null |
| `src/renderer/src/App.tsx` | 新增 `IcoNoNet`（Segoe Fluent Icons `U+F384`「地球 + 禁止符」，与 Windows 任务栏同一字形）；网络槽位按「有网 / 无网」选图标与文案 |
| `src/renderer/src/styles.css` | 无网图标的斜杠、字号；去掉离线橙色，保持与其它图标同色 |
| `docs/facts/功能清单.md` | 更新网络图标说明 |

**不动**：网络探测命令、Wi-Fi/网线区分、图标位置与顺序、其它状态栏元素。

## 三、预期行为

1. Wi-Fi 断开（无任何连接配置）：收起态显示地球 + 斜杠，悬停「网络未连接」。
2. 连着 Wi-Fi/网线但 IPv4/IPv6 都不是 Internet：同样显示地球 + 斜杠，悬停保留接口名 +「连上了但上不了网」。
3. 正常联网：Wi-Fi 弧线或网线图标，白色，与现在一致。
4. 状态命令失败（PowerShell 起不来）：不渲染图标（与现在一致），不误报断网。
5. **断网后及时出现**：①网络通/不通翻转由 TCP 探针（每 3 秒，连阿里公共 DNS 的 443 端口）触发强制重读；②系统 `online` / `offline` / `navigator.connection change` 事件立刻重读；③15 秒轮询与 10 秒缓存只作兜底。目标 3~5 秒内更新（此前最长约 90 秒）。
6. **只剩虚拟网卡**（如 Radmin VPN）也算断网：不能因为存在 `net|` 行就保留 `wifi=null`，否则界面什么都不显示（用户 2026-11-19 断网截图正是此现象）。

## 四、必要依赖

无新增依赖；使用系统字体 `Segoe Fluent Icons`（已有网线图标同款字体链）。

## 五、验收条件

- [ ] `npm run typecheck`、`npm run build` EXIT=0。
- [ ] 在线状态：图标仍为 Wi-Fi 弧线（本机实测），位置/尺寸不变。
- [ ] 无网状态：图标为地球 + 斜杠，文案「网络未连接」或「…（连上了但上不了网）」。
- [ ] `node scripts/e2e-wifi.mjs` PASS（在线分支）。
- [ ] 预览版真人查看图标观感。

## 六、不做什么

- 不改网络探测频率与命令。
- 不为「读取失败」造图标。
- 不新增 Windows 通知或声音提醒。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-19 | `npm run typecheck` / `npm run build` | EXIT=0 | — |
| 2026-11-19 | `node scripts/e2e-wifi.mjs`（在线分支） | **PASS**：快照 `connected:true, online:true, name:GZHL_Student 3`；图标仍 Wi-Fi 弧线，文案与 aria 不变 | 真实断网未拔网线 |
| 2026-11-19 | 临时 `ISLAND_FAKE_OFFLINE=1` 强制无网 + CDP 截屏（探针已删，未提交） | 收起态显示地球+斜杠：`.collapsed-wifi.offline`、颜色 `rgba(242,243,245,0.94)`、文案「网络未连接（没有可用的 Wi-Fi 或网线）」、字体 `Segoe Fluent Icons`、尺寸 13.5 视觉 px；截图见 `.tmp/offline-icon-shot.png`（一次性） | 真实断网/只有本地连接两种系统状态 |
| 2026-11-19 | 读取失败分支 | 代码保持 `wifi=null` 不渲染 | 未模拟 PowerShell 失败 |
| 2026-11-19 | 用户实机断网后看不到图标（附截图） | 根因：渲染层 60 秒轮询 + 主进程 30 秒缓存，最长约 90 秒才更新；`Get-NetConnectionProfile` 实测此时为 `IPv4=NoTraffic / IPv6=NoTraffic`，代码会返回 `online:false` | 未实测真实断网→图标的时间（网络已恢复） |
| 2026-11-19 | 改为 15 秒轮询 / 10 秒缓存 + 点岛补拉 | typecheck/build EXIT=0；在线分支 `e2e-wifi` PASS | 同上 |
| 2026-11-19 | 临时探针让 `online` 每 15 秒翻转，CDP 每 2 秒读 DOM（探针已删） | 图标在状态翻转后 **16.3 秒**出现、再 15 秒后消失，与 15 秒轮询一致 | 真实系统断网/恢复的切换时延 |
| 2026-11-19 | 用户再次反馈「断网之后直接就不显示了」：排查发现只剩 Radmin VPN 虚拟连接时仍有 `net\|` 行，旧判据 `!sawNet && sawLine` 不成立 → 返回 `wifi=null`，界面整块不渲染 | 改为 `wifi === null && sawLine`；临时环境变量伪造「只有虚拟网卡」的 PowerShell 输出（钩子已删）验证快照为 `connected:false, online:false`，CDP 确认 `.nonet-ico` 已渲染 | 用户真实断开实体网卡后的最终效果 |
| 2026-11-19 | TCP 探针选点：`node -e` 连 `223.5.5.5:53`、`119.29.29.29:53` 均超时；改 `223.5.5.5:443`、`223.6.6.6:443` 实测 9~12ms 连通 | 采用 443 两主机，任一通即视为可达 | 其它网络环境下这两个地址是否可达 |
| 2026-11-19 | 新增 `status:refresh` IPC + 渲染层 `online`/`offline`/`navigator.connection change` 监听；CDP 调 `window.island.statusRefresh()` | 返回 `{"battery":99,"charging":true,"wifi":{"connected":true,"online":true,"name":"GZHL_Student 3","kind":"wifi"}}`，IPC 通路正常 | 未实测真实断网下探针翻转→图标出现的秒数（网络已恢复） |
| 2026-11-19 | 用户反馈「图标做的太丑了，你参考一下本机的」「完全对不上」（附系统任务栏截图）：U+E774 字形 + 伪元素斜杠与系统图标根本不是同一个形状 | 第一次改手绘 SVG（圆 + 经线椭圆 + 赤道 + 斜杠）仍被判「完全对不上」——**方向错了，不该模仿，应该直接用系统字形** | 手绘 SVG 方案已废弃，未提交 | 
| 2026-11-19 | 按用户截图做像素比对找字形：裁出任务栏图标（20×20），用 fontTools 遍历 `SegoeIcons.ttf` 全部私用区码位、逐字渲染后算 IoU | `U+F384`（uniF384）得分 **0.784** 排第一（第二名 U+E774 仅 0.616）；渲染该字形与截图并排比对，结构完全一致（地球网格 + 右下角圆形禁止符，斜杠方向相同） | 字体渲染与 GDI 任务栏渲染的轻微 hinting 差异 |
| 2026-11-19 | 改为 `<span className="fluent-ico nonet-glyph">&#xF384;</span>`，字号 15px（字形铺满 em 框） | `npm run typecheck` / `npm run build` EXIT=0；CDP 把组件真实标记注入运行中收起态槽位截图放大 10 倍，与用户截图并排比对一致；计算 `fontSize=15px`、`.collapsed-wifi` 槽位 18px | 未在真实断网状态看整条链路；U+F384 仅 Win11 字体有，Win10 会缺字 |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 结论 |
|---|---|---|---|
| 2026-11-19 | 用户（预览版实机） | `f84a1ec` | 用户原话「ok了」：无网图标与系统任务栏同款；断网/恢复自动同步未单独口述结论 |
