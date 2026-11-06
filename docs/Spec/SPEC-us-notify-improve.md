# SPEC：通知页改进（已读消红点 / 清空 / 点击打开来源）

- 日期：2026-11-06
- 分支：us-notify-improve（基于 main `0ad5df8`）
- 来源：用户口头需求（对话 2026-11-06 18:54）：「通知面板里的已读没什么用，我希望我点了他之后，消息的红点全部没了，再加一个清空的功能；还有就是点那些信息可以打开那个信息，且红点消失」

## 1. 目标

通知页三个体验改动：

1. 点「已读」后，收起态红点立刻全部消失，且不会被随后的刷新弹回（修边界）。
2. 新增「清空」按钮：清空后通知列表显示为空（不重新加载出旧通知），红点也消失。
3. 点击单条通知：有真实反应——能打开来源应用的就打开；打开不了的也要有兜底反应（打开 Windows 通知设置），并且点击后红点消失。

## 2. 修改范围

| 文件 | 改动 |
|---|---|
| `src/main/notifyStore.ts` | ① notif-read.json 结构升级为 `{lastOrder, hiddenUntil}`（旧文件无 hiddenUntil 视为 0，向后兼容）；② markAllRead 防御：写「cached 最大 order 与库内最大 order 的较大值」语义不变，但 cached 为空时不再写 0（保留旧水位）；③ 新增 clearAll()：hiddenUntil 提到当前最大 order；④ notify:list / notify:refresh 返回前按 hiddenUntil 过滤（order<=hiddenUntil 隐藏）；⑤ 新 IPC `notify:clear-all`；⑥ openSource 映射表扩展（lingdong-island→聚焦自身窗口、ScreenSketch/SnippingTool→屏幕截图）+ 兜底：映射不到打开 `ms-settings:notifications` 并返回 true |
| `src/preload/index.ts` | 新增 `notifyClearAll(): Promise<NotifyListResult>` |
| `src/renderer/src/App.tsx` | NotifyPanel：加「清空」按钮（已读旁，同 todo-del 样式）；markRead/clearAll 后 onUnread 更新；点击单条的兜底反应保留 markRead |
| `src/renderer/src/styles.css` | 如需微调按钮间距（尽量复用现有类） |
| `scripts/e2e-notify-clear.mjs`（新增） | 清空/隐藏水位/兜底打开的自动化验证 |
| `docs/facts/数据规则.md` | notif-read.json 结构说明更新（{lastOrder, hiddenUntil}） |

## 3. 预期行为

1. **已读**：点「已读」→ 返回 unread=0 → 收起态红点消失。30s 轮询刷新后：只有真正**新**到达的通知（order 大于已读水位）才让红点回来；库内旧通知不会让红点弹回。
2. **清空**：点「清空」→ 列表立即清空显示空态，红点消失。之后 30s 轮询拉回的旧通知（order<=hiddenUntil）不再显示——清空是按 order 水位过滤，不是清数组，所以不会「清了又回来」。新通知（order>hiddenUntil）正常显示。
3. **点击单条**：
   - 映射表内的应用（含新增 lingdong-island、ScreenSketch/SnippingTool）→ 打开对应应用/聚焦窗口，返回 true。
   - 映射不到 → 打开 Windows 通知设置页 `ms-settings:notifications`（兜底，保证点击必有反应），返回 true。
   - 无论哪种，点击后红点消失（已有 markRead 保留）。
4. 「已读」与「清空」并存：已读只消红点保留列表；清空连列表一起隐藏。

## 4. 必要依赖

无新增依赖。Electron 内置 `shell.openExternal`、`dialog`（主进程已有）。

## 5. 验收条件

- [ ] e2e：清空后 notify:list 返回空 + unread=0；hiddenUntil 持久化（重启后旧通知仍隐藏）；已读水位边界（cached 空/新通知场景）。
- [ ] 回归：e2e-wifi / e2e-collapsed-todo / e2e-schedule / e2e-todo-today / e2e-export / e2e-pages-custom 全过。
- [ ] typecheck / build 通过。
- [ ] 重新打包安装 `D:\软件\灵动岛\`，进程存活。
- [ ] 用户实机验收：点已读红点消失、清空列表变空、点通知有反应。

## 6. 不做什么

- 不真删系统通知库 wpndatabase.db（系统锁库只读，「清空」=本地隐藏水位）。
- 不做每条通知的未读/已读视觉区分（用户没要求）。
- 不做通知搜索、分类、置顶。
- 不做映射表穷举所有 AUMID（只加实测遇到的常见项 + 兜底策略）。
- 不动收起态红点的触发逻辑本身（只有未读数>0 才显示）。

## 7. 自检记录（2026-11-06）

- [实测] `npm run typecheck`（node + web）通过。
- [实测] `npm run build` 通过。
- [实测] `node scripts/e2e-notify-clear.mjs` 7 项全 PASS：N1 初始列表非空 / N2 清空后列表空+未读0 / N2b 收起态红点消失 / N3 刷新后旧通知不回来 / N4 重启后列表仍空 / N4b hiddenUntil 已写入 / N5 映射不到的 app 兜底返回 true。e2e 修过两处脚本问题（`node:ws` 不存在改用 Node 自带全局 WebSocket；evaluate 无超时会卡死，加 15s 超时）；spawn 时剥掉宿主注入的 ELECTRON_RUN_AS_NODE。
- [实测] 回归：e2e-wifi / e2e-collapsed-todo / e2e-export / e2e-pages-custom 直接过；e2e-schedule / e2e-todo-today 六套连跑时各出一次失败（窗口标题断言，环境抖动），单独复跑全 PASS（各复跑两次）。
- [实测] 打包安装 `D:\软件\灵动岛\`（19:13）+ 4 进程存活。
- [未验证 → 留给实机验收] 兜底跳转的真实体验（点一条映射不到的通知 → 实际打开 Windows 通知设置页）；「已读」红点在真实新通知到达时的表现。
- [未验证] ScreenSketch → `ms-screenclip:` 协议的实际效果（Win+Shift+S 截图界面是否被唤起——无头环境无法确认）。
- 说明：用户反馈「点已读红点没消」未复现出稳定 bug（原链路 markRead→onUnread 是通的）；本次按防御性修复处理（空列表不动水位 + unread 由 visibleItems 重算），若实机仍复现需另行排查。
