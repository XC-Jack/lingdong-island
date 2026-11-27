# SPEC-fix-e2e-accent-token：e2e-beautify-04 的强调色断言改为读主题 token

- 日期：2026-11-27
- 分支：`fix-e2e-accent-token`
- 来源：`docs/状态.md` 多处登记的「既有失败 `e2e-beautify-04` C2b（断言写死旧蓝色）」；用户 2026-11-27 点名处理这一条。

## 一、目标

让 `scripts/e2e-beautify-04.mjs` 的 C2b 断言不再依赖写死的 RGB 常量，改为在页面里读当前主题的 `--accent` 计算距离，从而：

1. 在当前默认主题（`glass-light`，`--accent: #0a6cf0`）下 C2b 由红转绿；
2. 换任意主题（`glass-dark` / `mono` / `glass-clear`）或以后改配色，这条断言都跟着 token 走，不再需要同步改脚本。

## 二、修改范围

只改 `scripts/e2e-beautify-04.mjs` 一个文件，**不碰 `src/`、`package.json`、其它脚本**。

具体：第 330~376 行那段注入页面执行的 IIFE 里，把两处硬编码的 `(100, 181, 246)`（旧 `#64b5f6`）与阈值 `9000` 换成「先读 `getComputedStyle(document.documentElement).getPropertyValue('--accent')`，解析成 RGB 后再算距离」。

## 三、预期行为

1. 页面里取不到 `--accent` 时，断言**判失败并打印实测值**，不做静默放行（避免又一次「永远绿」的假信号）。
2. `glass-light` 下：选中日 `background-color` 等于 `--accent` → 距离 0 → `isBlueBg` 为真；未选中时 `box-shadow` 里的描边色等于 `--accent` → `hasBlueRing` 为真。
3. 非蓝色主题（`mono` 的 `--accent: #ffffff`）下这条断言语义会变化——`mono` 下「今天」本来就靠白色描边/白底表达，所以断言应改为「与当前 `--accent` 一致」而不是「是蓝色」。C2b 的标题文字同步改成「与当前主题强调色一致」。

## 四、必要依赖

无新增依赖。复用现有的 `scripts/isolate-userdata.mjs` 与 CDP 端口 9321。

## 五、验收条件

| 编号 | 条件 |
|---|---|
| A1 | `git diff main -- src/ package.json` 为空 |
| A2 | 修改前在 `main` 上复跑 `node scripts/e2e-beautify-04.mjs`，C2b 为 ✗ 并记录实测距离 |
| A3 | 修改后 `node scripts/e2e-beautify-04.mjs` 退出码 0，C2b 为 ✓，且其余 C 段断言不回归 |
| A4 | 负对照：把页面里的 `--accent` 临时改成非强调色（或在断言里故意取错变量名），C2b 必须变 ✗——证明这条断言仍然有判别力，不是被改成了恒真 |
| A5 | `npm run typecheck` EXIT=0（脚本改动不牵连类型检查） |

## 六、不做什么

- 不改日历的实际样式（`styles.css` 的 `.cal-day.today` / `.selected` 一律不动）。
- 不改 C2c（蓝点反色）里写死的 `#8fc9fb`、`#f2f3f5` 两个期望值——那是「点与底色反色」的具体色值，属另一条断言；本轮只修 C2b。若它也过期，另开 SPEC。
- 不做全量 e2e 回归，只跑 `e2e-beautify-04`（全量留到批量验收）。
- 不顺手改其它脚本里同类写死的颜色。

## 七、自检记录

自检日期 2026-11-27，分支 `fix-e2e-accent-token`（基线 `main@83648b3`）。工作树只含 `scripts/e2e-beautify-04.mjs` 与本 SPEC。

**修改前基线（A2）[实测]**：`node scripts/e2e-beautify-04.mjs` → `E2E BEAUTIFY-04: FAIL（26 过 / 1 败 / 0 跳过）`，失败项即 C2b，实测输出 `ring=color(srgb 0.0784314 0.0862745 0.105882 / 0.9) 0px 0px 0px 1.5px inset selected=true`。按旧算法，(10−100)²+(108−181)²+(240−246)² = 8100+5329+36 = **13465 > 9000**，判「不是蓝」。

**修改后（A3）[实测]**：`node scripts/e2e-beautify-04.mjs` → `E2E BEAUTIFY-04: PASS（27 过 / 0 败 / 0 跳过）`。C2b 输出 `accent=rgb(10, 108, 240) ring=color(srgb 0.0784314 0.0862745 0.105882 / 0.9) 0px 0px 0px 1.5px inset selected=true`，其余 C 段与 N/T 段断言无回归。

**负对照（A4）[实测]**：复制脚本到 `scripts/_negctl-accent.mjs`，只把探针的 `var(--accent)` 改成 `var(--accent-ink)`（白色），结果 `✗ C2b … accent=rgb(255, 255, 255)` → `FAIL（26 过 / 1 败）`。证明这条断言没有被改成恒真。临时脚本已删除。

**两个分支都覆盖 [实测]**：

1. 选中态（打开日程页默认）：今天底色 `rgb(10,108,240)`，与 `--accent` 距离 **0**。
2. 未选中态（点另一天后）：今天描边 `rgb(10,108,240)`，与 `--accent` 距离 **0**。用临时探针 `scripts/_probe-accent-ring.mjs` 取证，取证后已删除。

**踩坑记录 [实测]**：这段断言代码是塞进模板字符串再传给页面的，①**反斜杠会被吃掉**（正则 `\s` 失效），②**反引号会提前截断模板字符串**（`SyntaxError: missing ) after argument list`）。因此改用 `indexOf` 定位颜色函数片段 + 字符类 `[0-9.]+` 取数字，不写转义、不写模板字符串。这条与文件头既有注释「一律用字符类取数字，不要写转义括号」一致，本轮补上了「反引号也不能用」这一条。

**类型检查（A5）[实测]**：`npm run typecheck` → `TYPECHECK_EXIT=0`。

**`src/` 零改动（A1）[实测]**：`git diff --stat main -- src package.json` 输出为空；`git status --short` 只有 `M scripts/e2e-beautify-04.mjs` 与新增的 SPEC 文件。

**未验证**：

- 只跑了 `e2e-beautify-04`，没跑全量 e2e（按 SPEC 第六节，全量留到批量验收）。
- 只在默认主题 `glass-light` 下实跑过；`glass-dark` / `mono` / `glass-clear` 三套下「跟随 token」属代码推导——`mono` 的 `--accent` 是白色，语义变成「与白色一致」，C2b 标题已相应改成「强调色」而非「蓝色」，但没有逐主题实跑。
- C2c（蓝点反色）里的写死色值 `#8fc9fb`、`#f2f3f5` 未动，是否也过期未查（SPEC 第六节已声明不在本轮范围）。

## 八、验收记录

（待填）
