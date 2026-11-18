# SPEC-clock-date-format：收起态/展开态时钟显示日期（三档，可设置）

- 日期：2026-11-18
- 分支：`island-ux-tweaks`
- 背景：用户 2026-11-18「我想让时间显示里面可以显示日期月份，可以在设置里面选择挡位」；在选项里选「三档（含星期）」，并补充「日期第一位，其次星期，然后时间」。

## 一、目标

时钟显示三档，设置页可选，主进程持久化到 `prefs.json`：

1. `time`（默认）：`17:54`
2. `date`：`11/18 17:54`
3. `dateWeek`：`11/18 周二 17:54`

顺序固定为**日期 → 星期 → 时间**。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `ClockFormat = 'time' \| 'date' \| 'dateWeek'` 与 `CLOCK_FORMATS` |
| `src/main/prefsStore.ts` | `PrefsShape.clockFormat`、白名单校验、load/applyPatch |
| `src/preload/index.ts` | `PrefsShape` 同步字段 |
| `src/renderer/src/App.tsx` | `formatClock` 增加格式参数；`App` 读 prefs 并在 `onPrefsChanged` 时热更新；收起态与展开态信息行共用同一渲染 |
| `src/renderer/src/settings/SettingsApp.tsx` | 常规分区新增「时钟显示」三档卡片（复用 `.pet-set-mode`） |

**不改**：时刻本身（仍每分钟更新）、待办页/日程页里用 `formatClock` 做的「已过期」判断（保持 `HH:mm` 语义）、收起态其他组件。

## 三、预期行为

1. 老用户没有该字段 → 按 `time`，与升级前一致。
2. 设置页切档后岛内时钟立即变化（`prefs:changed` 广播），无需重启。
3. 三档都只影响「显示文本」，`17:54` 这类纯时间比较逻辑不受影响。
4. 日期用 `M/D`（不带年份），星期用「周一…周日」。

## 四、必要依赖

无。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `npm run typecheck`、`npm run build` EXIT=0 |
| A2 | 三档切换后收起态 `.collapsed-clock` 文本分别为 `HH:mm` / `M/D HH:mm` / `M/D 周X HH:mm` |
| A3 | 展开态头部时钟与收起态同格式 |
| A4 | `prefs.json` 落盘 `clockFormat`，重开应用仍是上次档位 |
| A5 | 收起态岛宽度随文本自动适配、不裁切（`setCollapsedWidth` 上报值 ≤ 320 上限） |

## 六、不做什么

- 不显示年份。
- 不做 12/24 小时制切换。
- 不改日期分隔符的本地化。

## 七、自检记录

自检日期 2026-11-18，分支 `island-ux-tweaks`，dev 构建 + 隔离 userData。

| 编号 | 结果 |
|---|---|
| A1 | **通过**：`typecheck` / `build` EXIT=0 |
| A2 | **通过**：`prefsSet` 三档后收起态文本依次为 `18:06` / `11/18 18:06` / `11/18 周三 18:06` |
| A3 | **通过**：展开后 `.head-info .collapsed-clock` 同为 `11/18 周三 18:06` |
| A4 | **通过**：设置卡片点击后 `prefs.json` 落 `"clockFormat": "date"`；重启 dev 应用后收起态直接显示 `11/18 18:12` |
| A5 | **通过**：`dateWeek` 档岛宽 259 布局 px（主进程上限 320），`.collapsed-clock` `scrollWidth - clientWidth = 0` |

**附**：设置页「时钟显示」卡片 3 个按钮、标签为「仅时间 / 日期 + 时间 / 日期 + 星期 + 时间」，当前档 `aria-pressed=true`。
