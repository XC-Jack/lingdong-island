# SPEC-glass-clear：第四套主题「透明玻璃」

> 事实依据：[`docs/facts/视觉设计规范.md`](../facts/视觉设计规范.md)（整体气质、色彩系统）、
> [`docs/facts/功能清单.md`](../facts/功能清单.md)（外观设置）。
> 本 SPEC 只写本次差异，不复制产品设定。

## 一、目标

新增第四套岛主题 `glass-clear`（中文名「透明玻璃」）：玻璃本体几乎不染色，颜色全部来自岛背后的桌面；
配套把组件首页（`view === 'grid'`）的排版权重改成参考图的层级 —— 卡片刻度大、数字在右上、3D 物件在左上。

**现有三套主题（`glass-light` / `glass-dark` / `mono`）的 token、DOM 表现、视觉结果全部保持不变。**
新主题的差异只落在 `[data-theme='glass-clear']` 作用域内，以及默认 `display:none`、只有该主题才显示的新节点。

## 二、修改范围

| 文件 | 改什么 |
|---|---|
| `src/shared/types.ts` | `ISLAND_THEMES` 增加 `'glass-clear'`（排在最后，设置页显示为第 4 张卡） |
| `src/renderer/src/styles.css` | 新增 `[data-theme='glass-clear']` token 块；新增该主题下的组件网格排版；新增 `@font-face`（Inter）与字体回退链覆盖；设置页预览卡样式 |
| `src/renderer/src/App.tsx` | ①抓屏条件放行 `glass-clear`；②组件网格卡片新增两个默认隐藏的节点：`.widget-sticker`（3D 物件的 `<img>`）与 `.widget-num`（右上数字）；③拉一次置物架/日程数量供卡片使用 |
| `src/renderer/src/settings/ThemeSection.tsx` | `THEME_META` 增加第 4 项；底部说明补一句 |
| `src/renderer/src/assets/fonts/` | 新增 Inter 可变字体 latin 子集（48KB，SIL OFL） |
| `src/renderer/src/assets/stickers/` | 新增 5 张 Fluent Emoji 3D PNG（256×256，MIT）+ 许可声明文件 |
| `docs/facts/视觉设计规范.md` / `功能清单.md` | 同步第 4 套主题的事实 |

## 三、预期行为

### 3.1 材质

- 岛体 `background` 只剩 `rgba(255,255,255,.055)` 量级的中性白 + 顶部一条极淡反光；**不压任何深色、不加任何色调**。
- 颜色来自真透视链路：主进程抓屏 → `.island-backdrop`（`blur(26px) saturate(1.7)`）。
- **没有外投影**：`--shadow-island` 只保留内阴影（顶部受光 + 1px 极淡内描边）。
- 边框 `1px rgba(255,255,255,.16)`；文字为白色系。

### 3.2 组件网格（仅 `glass-clear`）

- 卡片从「彩色图标方块 + 标题 + 说明」改为：**3D 物件贴纸在左上、数字在右上、标题与说明在左下**。
- 数字用等宽数字（`tabular-nums`）+ 负字距；待办显示 `完成/总数`，通知显示未读数，置物架与日程显示条目数，音乐保留曲名。
- 贴纸带 4~11° 倾角与紧贴的接触影（`drop-shadow`，属于卡内画面，不是岛的外投影）。
- 另外三套主题下，新增节点 `display: none`，原有 `.widget-icon` 照常显示。

### 3.3 字体

- `glass-clear` 下 `--font-ui` 改为 `Inter → Noto Sans SC → Microsoft YaHei UI`；Inter 以 `@font-face` 内嵌，不依赖系统安装。
- 其它三套主题仍用 `Segoe UI Variable`，不受影响。

### 3.4 设置页

- 第 4 张卡「透明玻璃」，预览示意图为深色桌布 + 近乎无色的胶囊。

## 四、必要依赖

- 现有真透视链路（`desktopCapturer` 抓屏 → `App.tsx` 的 `measure`/`setBackdrop`）——已存在，只放行新主题，不新增抓屏频率。
- Inter 可变字体 woff2（SIL Open Font License 1.1），48,256 B，latin 子集。
- Fluent Emoji 3D PNG 五张（MIT），合计约 149 KB。

## 五、验收条件

1. 设置页出现第 4 张「透明玻璃」卡，点选后岛当场换肤，重启后保持（`prefs.json` 落盘）。
2. `glass-clear` 下岛体背景不含深色叠加，背后桌面经模糊后可见；岛**没有外投影**。
3. 组件首页五张卡片：贴纸在左上、数字在右上、标题与说明在左下；待办数字 = 完成/总数。
4. 切回 `glass-light` / `glass-dark` / `mono`，三套主题的岛外观与改动前逐像素一致（截图对照）。
5. 切到 `glass-dark`（纯黑）时仍不抓屏，不出现底图；切到 `glass-clear` 时抓屏生效。
6. `npm run typecheck`、`npm run build` EXIT=0；受影响的 e2e 全过。
7. 设置窗口的浅色/深色无回归：四张卡在设置页里都可读、可点。

## 六、不做什么

- 不改 `glass-light` / `glass-dark` / `mono` 的任何 token 与样式。
- 不重写五个页面（待办/置物架/通知/日程/音乐）的布局与交互，只在主题作用域内改字体与配色。
- 不做白底自动切换、不做「色调档」。
- 不改抓屏的频率与主进程窗口尺寸逻辑。
- 不改安装包体积策略以外的打包配置。

## 七、自检记录（2026-11-25，实现方）

**命令 [实测]**

- `npm run typecheck` → EXIT=0（node + web 两段都过）
- `npm run build` → EXIT=0；产物里能看到 `Inter-var-latin-*.woff2` 48.25 kB 与四张贴纸 PNG
- `node scripts/e2e-settings-shell.mjs` → **PASS（58 过 / 0 败）**；S13a 断言四张卡顺序
  `glass-light,glass-dark,mono,glass-clear`，新增 S13d2 断言点「透明玻璃」后 prefs / 岛 / 卡片三处同步

**CDP 探针 [实测]**（`.tmp/shot-glass-clear.mjs`，隔离 userData，端口 9358）

- `documentElement.dataset.theme = 'glass-clear'`；`.island` 上 `hasBackdrop = true`（抓屏链路生效）
- 五张组件卡都渲染出 `.widget-sticker`；数字分别为 `0/11`、无（置物架 0 个文件）、`29`、`11`、无（音乐）
- 四套主题各截一张：`grid-glass-light.png` / `grid-glass-dark.png` / `grid-mono.png` / `grid-glass-clear.png`，
  前三张与改动前的卡片结构一致（彩色图标方块 + meta 文案 + 待办右下进度环仍在）

**未验证**

- 真实壁纸下的观感、白底应用作为岛背景时的可读性（这是本主题的已知代价，见第五节）
- 125% / 150% 缩放下 Inter 的字形重量
- 打包后的安装包体积增量（预计 +200 KB 量级，未实测）
- 独立验收（按工程规则第三节第 5 条，攒批做）
