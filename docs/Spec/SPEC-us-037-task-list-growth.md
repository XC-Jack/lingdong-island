# SPEC-us-037-task-list-growth

- 建立日期：2026-11-05
- 对应基线提交：08d3055（main，US-036 合并后）
- 任务分支：us-037-task-list-growth
- 关联用户故事：新登记 US-037（用户 2026-11-05 反馈「每天的任务数量有上限，想加加不上」）
- 关联事实文档：docs/facts/功能清单.md（第 1 节待办 / 第 4 节日程）、docs/facts/技术方案.md（布局约束）

## 一、目标

用户报告「每天的任务数量有上限，想加加不上」。排查证实：软件**没有**任何条数上限（连加 12 条全部入库成功），真正的问题是——列表内容超过岛窗口高度上限（420px）后溢出窗口被裁掉，**新加的任务出现在可视区外**，看起来像「加不上」。本任务让超长列表在岛内正常滚动、新加条目自动滚入视野，且不显示滚动条（用户明确要求「可以滚动，但是不要显示滚动条」）。

## 二、修改范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/styles.css` | 修 flex 收缩链：`.page-fade` 加 `align-self: stretch` + `min-height: 0` + flex 列布局；`.todo-panel` 加 `min-height: 0`；`.todo-list` 加 `min-height: 0` + 隐藏滚动条；`.sched-split`/`.sched-day` 加 `min-height: 0`；`.notify-list` 加 `min-height: 0` + 隐藏滚动条 |
| `src/renderer/src/App.tsx` | `TodoPanel`/`SchedulePanel` 列表加 `todoListRef`/`schedListRef`；`add()` 成功后 `scrollTo` 到底，让新条目可见 |

明确**不动**：列表条数逻辑（本来就没有上限）、各页数据结构、置物架/时间选择列的既有滚动样式（不顺手改无关 UI）。

## 三、预期行为

1. 任务条数没有上限：加多少条都入库（[实测] 连加 12 条全部成功，`schedule.json` 12 条齐全）。
2. 任务多到超过岛高度上限时，列表在岛内滚动，不再溢出窗口被裁。
3. 列表滚动时**不显示滚动条**（`scrollbar-width: none` + `::-webkit-scrollbar` 隐藏），鼠标滚轮仍可滚动。
4. 在待办页/日程页添加成功后，列表自动滚到底部，新条目出现在可视区内。
5. 列表不超过岛高度时布局与原先一致（无多余空白）。
6. 置物架页、通知页、时间选择面板的既有滚动行为不变。

## 四、必要依赖

- 无新增依赖。纯 CSS（flexbox 收缩链与滚动条隐藏）+ 既有 React ref 机制。

## 五、验收条件

- [ ] 连加 12 条后：列表底部 = 岛窗口底部以内（`listBottom <= winH`），列表自身滚动（`scrollHeight > clientHeight`）
- [ ] 滚动条不占宽度不可见（`offsetWidth === clientWidth`）
- [ ] 加完后新条目在可视区内（`lastVisible = true`）
- [ ] 回归 e2e：todo-today / schedule / schedule-edit / collapsed-todo / schedule-day / shelf-missing / exit-and-shelf-view / m4-drop / notify 全 PASS
- [ ] 真实鼠标滚轮在列表上可滚动（[未验证] 合成事件无法完全模拟，需用户实机确认手感）
- [ ] 重新打包安装到 `D:\软件\灵动岛\`，进程存活

## 六、不做什么

- 不做「列表分页/折叠/虚拟滚动」等大改动。
- 不显示自定义样式的滚动条（用户明确不要滚动条）。
- 不改置物架、时间选择面板的既有滚动条样式。
- 不加任何「条数上限」提示或限制。
- 不合并回 main、不打标签（等用户验收）。

## 七、自检记录

| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05 | 复现实验：开发版连加 10/12 条，量窗口/列表几何 | 12 条全部入库；列表溢出窗口（listBottom 1938 > winH 420）实锤「加在窗口外看不见」 | — |
| 2026-11-05 | 定位 CSS 根因：`.panel-body` 是 `align-items: flex-start`，`.page-fade` 高度取内容高度不受容器约束 | computed 实测 page-fade h=3196 > panel-body h=304，`max-height:100%` 因父高度对 flex-start 子项非 definite 而无效 | — |
| 2026-11-05 | 修复验证：`align-self: stretch` + 收缩链 `min-height: 0` | listBottom 365 ≤ 420 ✓、列表滚动 ✓ | — |
| 2026-11-05 | 加完自动滚底（两个列表加 ref + scrollTo） | lastVisible=true、lastBeyondWindow=false ✓ | — |
| 2026-11-05 | 隐藏滚动条（用户 m04120 要求） | scrollbarGone=true、scrolling 仍可用 ✓；截图（.tmp/list12.png）肉眼确认任务 12 在列尾、无滚动条 | — |
| 2026-11-05 | typecheck + build | 均 exit 0 | — |
| 2026-11-05 | 回归 9 个 e2e | 全 PASS | — |
| 2026-11-05 | 真实滚轮手感 / 打包安装 | 打包安装已完成（见下行）；滚轮手感待用户实机 | 真实滚轮手感 |
| 2026-11-05 | `npm run dist` + 静默安装 `D:\软件\灵动岛` | exit 0；4 进程存活；asar 含新代码特征 | — |
| 2026-11-05 | 提交 `56ba8df`（分支 `us-037-task-list-growth`） | 6 文件 +121/−5 | — |
| 2026-11-05 | 用户报告「我滑动不了」→ 排查 | 开发版实测滚轮正常（条目上/输入框上都能滚，scrollTop 0→600→0）；**安装版是 20:21 中间构建**（asar 无 `align-self:stretch`），最终构建 20:59 完成后未重新打包 | — |
| 2026-11-05 | 重新打包安装遇阻：NSIS 报 `Failed to uninstall old application files: 2` | 根因：DeepSeek Harness（开发工具宿主）持有旧 `app.asar` 读句柄（Restart Manager 实测锁主），卸载器删不掉；用户重启 DSH 后句柄释放，清残留 + 重装成功 | — |
| 2026-11-05 | 安装版验活 + 最终滚动验证（同一份代码的开发版 CDP 实测） | 4 进程存活；asar 含 `align-self:stretch`（21:00:06）；scrollH=3034/clientH=262、滚动条宽度 0、滚轮下滚 scrollTop=600、上滚回 0，SCROLL VERIFY PASS | 真实滚轮手感（用户实机） |

## 八、验收记录

| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 2026-11-05 | 用户（实机） | 56ba8df / d477b3a | 连加任务全部可见、岛内滚动、无滚动条——用户答复「可以了」 | 通过 |
