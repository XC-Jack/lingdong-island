# SPEC-us-028-uninstall-data-notice

- 建立日期：2026-11-05
- 对应基线提交：`9b60db30ad642f4d35416114b86f43c5246b8e0a`
- 任务分支：us-028-uninstall-data-notice
- 关联用户故事：US-028（见 ../facts/用户角色与用户故事.md 第 3.7 节）
- 关联事实文档：../facts/数据规则.md、../facts/功能清单.md（第 9 节 打包安装）、../facts/本机约束与踩坑.md

## 一、目标

让用户在卸载这个软件时，**当场就能看到**两件事：程序会被删掉，但自己的待办、日程、置物架记录不会被删；这些数据放在哪个文件夹、重新安装后会不会自动回来。用户不用去翻文档、也不用猜，卸载完心里有底。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `build/installer.nsh`（新增） | 打包装配脚本（NSIS 安装器的自定义 include）。仅在构建卸载器时（`BUILD_UNINSTALLER`）定义卸载欢迎页标题/正文与卸载完成页标题/正文，用中文写清「只删程序、不删数据、数据在哪、重装自动恢复」。不改安装流程本身。 |
| `docs/facts/数据规则.md` | 订正第 49 行的错误描述：本安装包没有「同时删除应用数据」勾选项。 |
| `docs/facts/功能清单.md` | 订正第 9 节「安装目标机」与实际落点不符的描述，并补一条卸载提示的行为。 |
| `docs/facts/用户角色与用户故事.md` | US-028 现状改为已实现。 |
| `docs/状态.md` | 一句话状态更新；订正「静默覆盖安装（NSIS 记住上次目录）」的错误注释。 |

明确**不动**：`package.json` 的打包配置（不新增 `nsis.include` 字段，靠 electron-builder 默认去 `build/` 找 `installer.nsh`）、`src/` 下任何应用代码、安装目录策略、桌面快捷方式行为、数据目录位置。

## 三、预期行为

1. 双击卸载程序（不加 `/S`）会先出现「卸载 灵动岛」欢迎页，正文用中文写明：卸载只删程序，待办/日程/置物架数据保留在 `%APPDATA%\lingdong-island`，重新安装后自动读回。
2. 卸载完成页同样用中文写明数据仍在、位置在哪、重装后自动恢复。
3. 静默卸载（带 `/S`）不弹任何窗口，行为与现在一致：程序删掉、数据保留。
4. 卸载过程仍然不删 `%APPDATA%\lingdong-island`（与当前版本一致，本次不改变删除行为，只补告知）。
5. 安装器（装的时候）的界面与流程不变。

## 四、必要依赖

- 已有：`electron-builder ^26.18.0`、内置 NSIS 3.0.4.1（`%LOCALAPPDATA%\electron-builder\Cache\nsis-3.0.4.1\`），无需新装任何东西。
- 依赖机制（已核对源码）：`NsisTarget.js:704-714` 会自动把 `buildResourcesDir/installer.nsh` 作为 `!include` 注入，且注入位置在 `installer.nsi` 之前；`uninstaller` 构建时带 `-DBUILD_UNINSTALLER`。MUI2 的 `MUI_DEFAULT` 语义是 `!ifndef`，因此自定义 include 里预定义 `MUI_UNWELCOMEPAGE_TITLE/TEXT`、`MUI_UNFINISHPAGE_TITLE/TEXT` 可覆盖默认文案。

## 五、验收条件

- [ ] `npm run typecheck` 通过（本次不改 TypeScript，但仍跑一遍确认没有连带影响）。
- [ ] `npm run build` 通过。
- [ ] `node scripts/e2e-shelf-missing.mjs`、`node scripts/e2e-m4-drop.mjs`、`node scripts/e2e-m4.mjs` 仍全过（确认本次改动没有影响应用行为）。
- [ ] `npm run dist` 成功产出 `release\灵动岛 Setup 0.1.0.exe`。
- [ ] 安装到 `D:\软件\灵动岛\`（用 `/D=` 指定），`Get-Process 灵动岛` 有进程存活。
- [ ] **实际打开卸载程序（图形界面，非 `/S`）并截图**：欢迎页出现中文正文，写明数据保留与数据位置。
- [ ] 走完卸载流程的完成页截图，同样写明数据仍在、位置、重装自动恢复。
- [ ] 卸载后 `%APPDATA%\lingdong-island\` 及其中的 `shelf.json`、`todos.json`、`schedule.json` 仍存在。
- [ ] 卸载后重新安装，应用能读到原有数据（数据文件内容不变）。
- [ ] 静默卸载 `/S` 仍不弹窗、数据仍保留。
- [ ] `docs/facts/` 三处与 `docs/状态.md` 的错误描述已订正，且与实际行为一致。

## 六、不做什么

- 不新增「同时删除我的数据」勾选框，也不改变卸载的删除行为（本次只解决「用户不知道数据还在」）。
- 不改应用内的界面（不加数据目录提示、不加设置项）。
- 不改安装目录的默认位置（`%LOCALAPPDATA%\Programs\lingdong-island`），也不改静默安装是否复用历史目录的行为；只在文档里写清真相。
- 不引入新的打包依赖、不自定义 NSIS 脚本替换 `installer.nsi`。
- 不改数据文件格式，不做迁移。
- 不合并回 `main`、不打包发版以外的动作（合并与上线需用户单独确认）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 读 electron-builder/NSIS 源码确认接线 | [实测] `build/installer.nsh` 确实被 include：临时加 `!warning` 后构建报出 `!warning: US028: installer.nsh included ... (build\installer.nsh:1)`（警告被当作错误中断构建），随后已删除该行 | 未验证 include 在卸载器那一遍构建中的具体展开顺序 |
| 2026-11-05 | `npm run typecheck` | 通过，`typecheck:node` 与 `typecheck:web` 均无输出，exit 0 | 本次未改 TS，此结果为「无连带影响」的证据 |
| 2026-11-05 | `npm run build` | 通过，out/main 23.25 kB、out/preload 4.61 kB、renderer 产物齐全 | — |
| 2026-11-05 | `node scripts/e2e-shelf-missing.mjs` | `E2E SHELF-MISSING PASS`，A1–A8 全过 | — |
| 2026-11-05 | `node scripts/e2e-m4-drop.mjs` / `node scripts/e2e-m4.mjs` | 分别 `E2E DROP PASS` / `E2E PASS` | — |
| 2026-11-05 | `npm run dist`（带两个国内镜像） | 成功，产出 `release\灵动岛 Setup 0.1.0.exe`（121979296 B，15:32:07） | 未做代码签名（项目本身没配证书） |
| 2026-11-05 | 静默安装到 `D:\软件\灵动岛\` | `Start-Process ... -ArgumentList '/S','/D=D:\软件\灵动岛' -Wait` exit 0；`Get-Process 灵动岛` 有 4 个进程（主 + 子进程），主进程 MainWindowTitle = `灵动岛` | 未验证图形界面安装向导本身（只走了静默安装） |
| 2026-11-05 | 卸载欢迎页截图 | [实测] 打开 `Uninstall 灵动岛.exe`（不带 /S）截图：标题「卸载 灵动岛」，正文「卸载只会删除程序文件，不会动你的数据。……保存在：C:\Users\honor\AppData\Roaming\lingdong-island……重新安装会自动读回来。」 | — |
| 2026-11-05 | 卸载完成页截图 | [实测] 点「下一步」后截图：标题「灵动岛 已卸载」，正文「程序文件已删除，你的数据还在。数据位置：C:\Users\honor\AppData\Roaming\lingdong-island 重新安装后会自动读回来；如果确实要彻底清除，请手动删除上面这个文件夹。」 | — |
| 2026-11-05 | 卸载后 userData 存活 | [实测] 卸载完成后 `%APPDATA%\lingdong-island` 仍存在，`schedule.json`/`shelf.json`/`todos.json` 均在，探测用标记文件 `us028-marker.txt` 也在（该文件为探针，已删除） | — |
| 2026-11-05 | 静默卸载 `/S` 行为 | [实测] `Uninstall 灵动岛.exe /currentuser /S` 不弹窗、exit 0，卸载后 userData 仍完好 | — |
| 2026-11-05 | 重装后数据可读 | [实测] 卸载后重新 `/S /D=` 安装并启动，进程存活；`%APPDATA%\lingdong-island` 内容未被重建或清空 | 未逐条打开界面确认待办/日程内容仍在（数据文件为空的初始态，看不出差异） |

已知踩坑（记录，不属缺陷）：
- 在**已有安装**上直接静默重装会报 `Failed to uninstall old application files. Please try running the installer again.: 2`（旧安装目录里有残留 `resources\app.asar` 使卸载器无法完全删除）。处理办法：先跑一次旧卸载器，再删掉残留目录，然后重装。
- 静默安装 `/S` 不复用上次目录，必须带 `/D=` 才能落到 `D:\软件\灵动岛\`。
- 自定义 NSIS 文案的符号名**不带 UN 前缀**：`MUI_WELCOMEPAGE_TITLE/TEXT`、`MUI_FINISHPAGE_TITLE/TEXT`，不是 `MUI_UNWELCOMEPAGE_*`（`UN` 只出现在语言字符串 ID 里）。写错会静默失效、不报错。

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-05 | 用户本人（实机操作，会话记录 m00864 / m00876） | `2d2095263ff507964050d70ece220110605e9679` | ① 卸载向导能正常弹出并走完（「有弹出卸载灵动岛」）——通过；② 卸载后安装目录只剩 `resources\app.asar` 残留、数据文件 `todos.json`/`schedule.json`/`shelf.json` 全在——通过；③ 欢迎页中文说明「不会动你的数据」用户当时未注意到（该说明是正文段落、不是勾选项，容易被快速点过）——经开发侧截图对照确认文案确实渲染，记「用户未直观确认，非缺陷」 | 通过（合并回 main） |
