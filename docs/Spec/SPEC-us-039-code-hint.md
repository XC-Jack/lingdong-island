# SPEC：US-039 验证码提示（收起态自动显示剪贴板里的验证码）

- 对应基线提交：6fce3d8（main，补验证收官后）
- 关联需求：功能清单.md 需求清单（视频逐帧还原）「验证码提示」项——原视频收起态有此功能，本项目未实现，从未排期。用户 2026-11-07 从三个未排期候选中选定。
- 编号说明：用户故事清单已全部完成/否决，本故事来自需求清单（无用户故事背书），编号顺延取 US-039。

## 目标

用户复制短信/邮件里的验证码后，收起态的岛自动弹出一条「验证码」横幅显示这个码，几秒后自动消失——不用再回到消息里翻找。点击横幅关闭。

## 修改范围

| 文件 | 改动 |
|---|---|
| `src/main/clipboardStore.ts`（新建） | 主进程轮询剪贴板（`clipboard.readText()`，Electron 45 主进程 Promise API；**无变更事件可用**，Chrome 的 `clipboardchange` 是 web 平台特性进不了主进程——调研见 [electronjs.org/docs/latest/api/clipboard](https://electronjs.org/docs/latest/api/clipboard)）；识别验证码；管理去重与有效期 |
| `src/main/index.ts` | 启动时调 `initClipboardWatch()` |
| `src/main/notifyStore.ts` | 不动（横幅推送逻辑独立，验证码走自己的 IPC 通道） |
| `src/preload/index.ts` | `onCodeArrived(cb)` 订阅 `island:code-arrived` |
| `src/renderer/src/App.tsx` | 收起态验证码横幅渲染（复用 `.collapsed-banner` 位与 `setBannerVisible` 加高机制，紫色徽章「验证码」区分通知横幅）；8 秒自动消失；点击关闭 |
| `src/renderer/src/styles.css` | 验证码横幅徽章样式（少量） |
| `scripts/e2e-code-hint.mjs`（新建） | 自动化断言 |
| `docs/facts/功能清单.md` | 需求清单「验证码提示」标注已实现 |

## 预期行为

1. **识别规则（防误报优先）**：
   - 整段剪贴板文本 ≤16 字符且匹配 `\b\d{4,8}\b`（纯数字 4-8 位）或 `\b[a-zA-Z0-9]{6,8}\b` 且同时含字母和数字（混合码）→ 视为验证码。
   - 长文本：仅当含「验证码 / verification code / OTP / code is / 验证代码」关键词时，提取该行内首个 4-8 位数字串；否则不弹（订单号、金额等长文本数字极易误报，宁可漏弹）。
   - 排除：纯重复数字（如 111111）、全零。
2. **展示**：收起态弹横幅「验证码徽章 + 码内容」，8 秒自动消失；展示期间窗口向上加高（复用 `island:set-banner-visible`）；点击横幅立即关闭。
3. **去重**：同一个码 30 秒内不重复弹；跨码（内容变化）立即弹。
4. **展开态**：不弹横幅、不补弹（验证码时效短，展开时用户本来就在操作，补弹意义小）——与通知横幅「补弹」语义有意不同。
5. **隐私**：剪贴板内容只在内存比对，不写盘、不写日志。
6. **并存**：验证码横幅与通知横幅共用同一横幅位，后到者覆盖先到者（各自独立计时收回）。

## 必要依赖

- 无新依赖。Electron 内置 `clipboard` 模块（主进程）。

## 验收条件

1. typecheck / build 通过。
2. e2e 断言（`scripts/e2e-code-hint.mjs`）：
   - C1 复制 `482913` → 收起态 3 秒内弹出验证码横幅且内容正确；
   - C2 复制普通文本（如一段网址）→ 不弹；
   - C3 同码 30 秒内二次复制 → 不重弹；
   - C4 复制长文本无关键词含数字 → 不弹；
   - C5 横幅 8 秒后自动消失、窗口高度还原。
   - e2e 里写剪贴板用主进程 `clipboard.writeText`（经 IPC 或 eval），不再依赖外部 PowerShell。
3. 回归：通知横幅（e2e-notify-live）、collapsed-todo、wifi 全 PASS。
4. 打包安装到 `D:\软件\灵动岛\`，进程存活；用户复制真实验证码实机验收。

## 不做什么

- 不做点击横幅「复制」按钮（显示的内容本来就在剪贴板里；点击=关闭）。
- 不做验证码历史记录、不落盘。
- 不做展开态补弹。
- 不做 macOS/Linux 适配（本项目仅 Windows）。
- 不动通知横幅的推送与补弹逻辑（两条链路独立）。
- 不做长文本无关键词的启发式提取（误报代价 > 漏报）。

## 自检记录

- [实测] 识别规则单测（.tmp/test-extract.mjs，17 用例）：纯数字 4-8 位 ✓、8 位 ✓、9 位 ✗、字母数字混合 ✓、纯字母 ✗、重复数字/全零 ✗、长文本无关键词 ✗（订单号/网址）、关键词提取（中文/英文）✓、「验证码 5544」短文本带关键词 ✓。17/17 PASS。
- [实测] typecheck / build PASS。
- [实测] e2e-code-hint 8/8 PASS：C1 复制 482913→3s 内弹横幅内容正确 / C2 网址不弹 / C3 同码 30s 抑制 / C4 长文本无关键词不弹 / C5a 8s 自动消失 / C5b 点击关闭 / C6 「验证码 7731」弹 7731 / C7 收起窗口常驻 88px。
- [实测] 回归：e2e-notify-live（实时刷新）PASS、e2e-collapsed-todo PASS、e2e-wifi PASS。
- [实测] 打包 npm run dist → /S /D=D:\软件\灵动岛 → app.asar 15:56:10 → 启动 4 进程存活。
- 修正过程记录：①e2e 首跑 C1/C6 败——e2e 开头误 dispatch click 把岛切到展开态（展开态验证码不弹是设计），删掉点击后全过；②C7 初版断言「还原到 ≤50」是过时认知——横幅系列改版后收起窗口常驻 88px（COLLAPSED_WIN_HEIGHT，set-banner-visible 已是空操作），断言改为 ≤90。
- **未验证**：真实手机短信验证码复制（e2e 用 Set-Clipboard 模拟，真机场景=用户复制任意来源验证码）；展开态复制验证码后收起不补弹（人工可观察，未自动化）；剪贴板含图片/文件时轮询 readText 的异常路径（读失败静默 return，已防御但未实测触发）。
