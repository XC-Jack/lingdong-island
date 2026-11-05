# SPEC-us-038-blur-delay

- 建立日期：2026-11-05
- 对应基线提交：5bb291b（US-037 合并后 main）
- 任务分支：us-038-blur-delay（第一刀，已合并删除）；us-038b-blur-immediate（第二刀）
- 关联用户故事：US-036 的后续体验反馈（用户：「我现在点击桌面的时候，岛的缩小反应怎么这么慢」→ 后续澄清：「不是缩放速度……我点桌面了，他要等一会在开始缩小」）
- 关联事实文档：docs/facts/功能清单.md

## 一、目标
分两刀：
1. 第一刀：点桌面收起等待 800ms → 300ms（用户仍不满意）。
2. 第二刀（最终方案）：**窗口失焦后立即收起**，去掉 blur 后的延迟确认——用户要的是「点桌面立即开始缩」，不是动画更快。

## 二、修改范围
| 文件 | 改动 |
|---|---|
| `src/renderer/src/App.tsx` | 第二刀：删除 blur 后 300ms 延迟确认整套逻辑（blurTimer / onFocus 取消 / typing 判据），onWindowBlur 回调直接 setExpanded(false)；注释更新 |

## 三、预期行为
1. 点桌面/其他程序 → 立即开始收起（只剩 220ms 收起动画）。
2. 输入框打字/选字期间岛不收——保护由收起定时器路径的 typing 判据负责（US-036 已修，保留不动）。
3. 输入法安全性依据：US-036 诊断日志实锤，打字收岛发生时窗口 hasFocus=true、**无 blur**——微软拼音等 TSF 输入法的候选窗不夺主窗口焦点、不触发 window blur，所以 blur 路径不需要为输入法留延迟；当年的延迟确认是误诊产物。

## 四、必要依赖
无新增。

## 五、验收条件
- [x] typecheck/build 通过
- [x] 回归 e2e（todo-today / schedule-edit / collapsed-todo）全 PASS
- [x] 打包安装、4 进程存活、asar 含 `blur -> collapse now` 且无 300ms 旧代码残留
- [ ] 用户实机：点桌面立即开始缩；打字收岛问题不复发

## 六、不做什么
- 不改收起动画时长；不动定时器收起路径（typing 判据保留）；不做可调设置。

## 七、自检记录
| 日期 | 执行内容 | 结果 | 未验证部分 |
|---|---|---|---|
| 2026-11-05（第一刀） | typecheck + build | exit 0 | — |
| 2026-11-05（第一刀） | 回归 4 个 e2e | 全 PASS | — |
| 2026-11-05（第一刀） | 打包安装 | exit 0、4 进程、asar 含 300ms 代码（21:54:36） | — |
| 2026-11-05（第二刀） | typecheck + build | exit 0 | — |
| 2026-11-05（第二刀） | 回归 3 个 e2e（todo-today / schedule-edit / collapsed-todo） | 全 PASS | — |
| 2026-11-05（第二刀） | 打包安装 | 首次 dist 因 electron 下载超时挂（设 ELECTRON_MIRROR npmmirror 后 exit 0）；安装版 asar 含 `blur -> collapse now`、无 300ms 残留（22:22:20）；4 进程存活 | — |
| 2026-11-05 | 排查插曲：启动即退 | 根因是 DSH 宿主注入 `ELECTRON_RUN_AS_NODE=1` 把 electron.exe 跑成纯 Node（mini.js 实锤），清环境变量后正常；应用本身无问题 | — |
| 2026-11-05 | 真实输入法下点桌面/打字表现 | 无法自动化复现 | 用户实机 |

## 八、验收记录
| 日期 | 验收人/会话 | 针对提交 | 逐条结论 | 总体 |
|---|---|---|---|---|
| 待填 | | | | |
