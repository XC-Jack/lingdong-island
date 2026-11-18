# SPEC：网线图标换成 Windows 系统自带图标

- 日期：2026-11-18
- 分支：`ethernet-fluent-icon`
- 背景：用户发了两张截图：「截图二的图标太丑了，换成截图一的」「原图标太丑了，换成系统自带的」。截图一是 Windows 系统里的以太网图标（显示器 + 网线插头），截图二是岛里当前手绘的 RJ45 插口。

## 一、目标

把收起态/展开态头部在「插网线」时显示的 `IcoEthernet` 从手绘 SVG 换成 Windows 系统图标字体里的以太网字形（Segoe Fluent Icons `U+E839`，Win10 回落 Segoe MDL2 Assets 同码位）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | `IcoEthernet` 由 `<IconSvg>` 改为 `<span className="fluent-ico">&#xE839;</span>` |
| `src/renderer/src/styles.css` | 新增 `.fluent-ico`（字体链、18px、行高 1、18×18 盒） |

不改 Wi-Fi 图标、铃铛等其他 SVG，不改网络状态的判定逻辑。

## 三、预期行为

1. 插网线时（`wifi.kind === 'ethernet'`）收起态与展开态头部显示系统以太网图标，与 Windows 设置页的图标一致。
2. 图标尺寸与旁边的 Wi-Fi/铃铛一致（18×18 布局 px），颜色继承父级：有网白色、连上没网橙色。
3. Wi-Fi 连接时仍显示原来的 Wi-Fi 弧线图标；无字体环境回落到 Segoe MDL2 Assets。

## 四、必要依赖

Windows 自带的 `Segoe Fluent Icons`（Win11）/ `Segoe MDL2 Assets`（Win10），两套字体都含 `U+E839`。不新增 npm 依赖、不嵌入字体文件。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck`、`npm run build` EXIT=0 |
| A2 | 强制 `kind='ethernet'` 时收起态渲染出系统字形（非 tofu、非旧 RJ45） |
| A3 | 展开态头部同样显示该字形，与标题/其他状态组件不重叠 |
| A4 | `offline` 时图标变橙（颜色继承未被写死） |
| A5 | `e2e-wifi` 通过（Wi-Fi 分支与几何断言不受影响） |

## 六、不做什么

- 不改 Wi-Fi 图标，不把其他图标也换成字体字形。
- 不改网络状态读取/判定逻辑。
- 不引入外部图标库或字体文件。

## 七、自检结果

环境：dev 构建 + 隔离 userData；本机当前是 Wi-Fi，没有真实网线，临时把 `statusStore.ts` 的 `kind` 强制成 `'ethernet'` 做渲染验收，验收后已还原并重新构建（`git status` 不含该文件）。

| 编号 | 结果 |
|---|---|
| A1 | **通过**：`typecheck` / `build` EXIT=0 |
| A2 | **通过**：收起态 `.fluent-ico` 的 `textContent` 码位 `e839`，字体 `Segoe Fluent Icons`，18×18 布局 px；截图里是系统「显示器 + 网线插头」图标，不是旧 RJ45 |
| A3 | **通过**：展开态同一图标，第二行状态区与标题不重叠（标题 19.5–34.7，状态区 44.3–64.5） |
| A4 | **通过**：给 `.collapsed-wifi` 加 `offline` 后 `.fluent-ico` 计算色 `rgb(255, 183, 77)` |
| A5 | **通过**：`node scripts/e2e-wifi.mjs` **PASS**（先用 time 档重置隔离 prefs，否则 A3 的 `HH:mm` 断言会因 dateWeek 文本误报） |

**未验证**：装机版（未重新打包）；真实网线插拔（本机无有线网卡，图标分支靠临时强制 `kind` 验证）。

