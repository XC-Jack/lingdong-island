# SPEC：去掉岛头部的开机自启胶囊

## 一、目标

用户 m01514：「岛上的这个自启开关去掉吧，在设置页里即可」。

展开态面板头部右上角那枚「自启开 / 自启关」胶囊，是岛内唯一能改开机自启的入口。用户要求删除它，把开机自启的入口收敛到设置窗口「常规」分区这一处。

## 二、修改范围

改：

- `src/renderer/src/App.tsx`：删 `autoStart` state、两处 `useEffect`（读初值 + 订阅 `onAutostartChanged`）、`flipAutoStart` 回调、头部那段 `<button className="autostart-toggle">` JSX。
- `src/renderer/src/styles.css`：删 `.autostart-toggle` / `.autostart-toggle:hover` / `.autostart-toggle.on` / `.autostart-dot` / `.autostart-toggle.on .autostart-dot` 五段。
- `scripts/e2e-head-order.mjs`：H5b 原本断言「状态区与自启开关不重叠」，胶囊删掉后该断言恒真（`autoR` 为 null），改成断言头部无胶囊。
- `scripts/e2e-settings-shell.mjs`：S9 段原本靠点岛上胶囊做双向同步，改写为「岛上无胶囊 + 设置页开关改主进程 + 设置页跟随广播」。
- `docs/facts/功能清单.md` 三处描述同步。

不改：

- 主进程 `autostart:get` / `autostart:set` / `autostart:changed` 三个 IPC 通道，以及 `src/main/index.ts` 里注册它们的代码——设置页仍在用。
- `src/preload/index.ts` 的 `autostartGet` / `autostartSet` / `onAutostartChanged` 三个暴露接口。
- `src/renderer/src/settings/SettingsApp.tsx` 的「常规」分区开关（`Row label="开机自启"`，`set-switch`）。
- 待办页的完成度 `n/m` 与圆环。

## 三、预期行为

1. 展开态面板头部只有：左侧彩色徽章 + 页名、中间状态区（岛仔 + 时钟 + 电量等）、右侧待办页的 `n/m` 完成度；不再有自启胶囊。
2. 设置窗口「常规」分区的「开机自启」开关仍是唯一入口，点它能真的改系统自启。
3. 主进程自启状态被别处改掉时，设置页开关仍通过 `autostart:changed` 广播实时跟随。
4. 头部右侧少了胶囊后，`0/0` 完成度往右靠、布局不被撑坏。
5. 岛宽自适应仍成立（当前待办空态 225 视觉 px）。

## 四、必要依赖

无新增依赖。

## 五、验收条件

- [x] 展开态 `document.querySelectorAll('.autostart-toggle').length === 0`（CDP 实测 `chipCount:0`、`dotCount:0`）。
- [x] 头部文本只剩「待办 / 97 / 13:29 / 0/0」（CDP 实测 `headText:"待办9713:290/0"`）。
- [x] 设置页「开机自启」开关仍能改主进程状态（`e2e-settings-shell` S9b）。
- [x] 设置页开关仍跟随 `autostart:changed` 广播（`e2e-settings-shell` S9e）。
- [x] `npm run typecheck`、`npm run build` 通过。
- [x] 头部相关 e2e 无回归：`e2e-head-order`（14/0）、`e2e-settings-shell`（51/0）、`e2e-beautify-04`（27/0）、`e2e-collapse-order`（22/0）、`e2e-pages-custom`（6 项）。
- [ ] 用户在真实安装版上看一眼头部区域观感（未打包，待授权）。

## 六、不做什么

1. 不动主进程自启实现（注册表 `Run` 项读写逻辑保持原样）。
2. 不把设置页开关改成别的位置，也不新增第二个入口。
3. 不顺手调整头部其它元素（徽章、状态区、完成度）的位置与样式。
4. 不删 `docs/Spec/SPEC-settings-shell.md` 里关于「岛头部胶囊与设置页共用同一份 IPC」的历史记录（那是当时的事实），只在 `docs/facts/功能清单.md` 里标注现状。

## 七、实现记录

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | 删 `autoStart` state（原 `:2153-2154`）、读初值 `useEffect`、广播订阅 `useEffect`、`flipAutoStart`（原 `:2340-2362`）、头部 `<button className="autostart-toggle">` JSX（原 `:2819-2830`）；三处各留一段中文注释说明去向 |
| `src/renderer/src/styles.css` | 删 `.autostart-toggle` 等 5 段（原 `:656-690`），留注释指向 `src/renderer/src/settings/settings.css` 的 `.set-switch` |
| `scripts/e2e-head-order.mjs` | H5b 改为「头部不再有自启胶囊，胶囊数 = 0」 |
| `scripts/e2e-settings-shell.mjs` | S9a–S9e 全部重写为新事实 |
| `docs/facts/功能清单.md` | 7. 展开态通用 / 12. 页面自定义 / 设置页「常规」三处同步 |

自检：

1. `npm run typecheck` EXIT=0。
2. `npm run build` EXIT=0（`✓ built in 207ms`）。
3. `node scripts/e2e-head-order.mjs` → PASS 14 过 / 0 败，H5b 输出「头部不再有自启胶囊」。
4. `node scripts/e2e-settings-shell.mjs` → PASS 51 过 / 0 败，S9a–S9e 全绿。
5. `node scripts/e2e-beautify-04.mjs` → EXIT=0。
6. `node scripts/e2e-collapse-order.mjs` → PASS 22 过 / 0 败。
7. `node scripts/e2e-pages-custom.mjs` → PASS 6 项。
8. CDP 探针 `.tmp/probe-chip-gone.mjs` → `{"expanded":true,"chipCount":0,"dotCount":0,"headText":"待办9713:290/0","islandRect":{"w":225,"h":158},"statText":"0/0"}`。
9. 截图 `.tmp/shot-autostart-removed.png`（593×424，2 倍缩放）确认头部右侧只剩 `0/0`。

[未核验]

1. 用户在装机版上的观感——本轮未打包未装机（各需单独授权）。
2. 用户在设置页点开关、看系统自启是否真的生效——e2e 只验证到主进程状态翻转，未验证重启后自启行为。
