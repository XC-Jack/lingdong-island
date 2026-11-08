# 灵动岛（Lingdong Island）

Windows 桌面顶部居中的悬浮胶囊：收起时是一条窄条，点开展开成面板，把待办、日程、通知、置物架收在一处，并养一只会表达情绪的小宠物「岛仔」。

本项目是对一段 B 站演示视频（原作者作品、无源码）的**独立重做**，不复制原作者代码。

## 目录用途

带「※」的是要提交进 Git 的东西，其它都是自动生成或临时材料，可以不管。

```
灵动岛/
├── README.md              ※ 本文件：项目简介与文档入口
├── AGENTS.md              ※ AI 开工必读：该读哪些资料
├── package.json           ※ 项目清单：依赖了哪些工具、有哪些命令（npm run xxx）
├── package-lock.json      ※ 依赖版本锁：保证每次装出来的工具版本一致
├── tsconfig*.json         ※ TypeScript 编译设置（三份：总设置 / 主进程 / 界面）
├── electron.vite.config.ts ※ 构建设置：怎么把源码编译成能跑的程序
├── .gitignore             ※ 告诉 Git 哪些文件不用管
│
├── docs/                  ※ 档案室：所有说明文档
│   ├── 状态.md              当前进度与下次开工（唯一频繁更新的文档）
│   ├── 工程规则.md           工程规则唯一正文：分支、SPEC、自检、验收、合并上线
│   ├── facts/              产品事实（唯一事实源，同一事实只在一处维护）
│   ├── Spec/               每次开发任务的规格说明书（SPEC = 任务说明书）
│   └── archive/            迁移前的旧文档留存，只读不改
│
├── src/                   ※ 厂房：所有代码
│   ├── main/                主进程：建窗口、读写文件、连系统电量与通知（幕后，用户看不见）
│   ├── renderer/            渲染进程：屏幕上看到的全部界面（前台，用户能看见）
│   ├── preload/             中间人：前台要做事必须经它转达给幕后
│   └── shared/              公用字典：两边共用的数据格式
│
├── scripts/               ※ 自动测试脚本（33 个 e2e-*.mjs + 2 个辅助 .mjs = 35 个，2026-11-08 核对），AI 用，用户不用管
├── build/                 图标等打包资源（icon.ico / icon.png）
│
├── node_modules/          （自动）第三方工具包，几万个文件，不要手动改
├── out/                   （自动）编译中间产物，开发时用
├── release/               （自动）打包好的安装包，给用户装机的
├── .backups/              （忽略）改动前的本地快照，保险箱
├── .tmp/                  （忽略）临时垃圾，可随时清
├── .ui-skills/            （忽略）界面设计参考笔记，备查
└── .dsh-vision-router/    （忽略）看屏幕截图时留下的记录，备查
```

## src 里每个文件是干什么的

| 文件 | 中文作用 |
|---|---|
| `src/main/index.ts` | 主进程总入口：建窗口、开机自启、处理「打开文件」「在文件夹中显示」 |
| `src/main/todoStore.ts` | 待办数据的读写（存 `todos.json`） |
| `src/main/scheduleStore.ts` | 日程数据的读写（存 `schedule.json`） |
| `src/main/shelfStore.ts` | 置物架数据的读写 + 提取系统图标（存 `shelf.json` 和 `icon-cache/`） |
| `src/main/notifyStore.ts` | 通知已读记录的读写（存 `notif-read.json`） |
| `src/main/statusStore.ts` | 电量等系统状态的读取 |
| `src/main/prefsStore.ts` | 界面偏好（页面显隐、组件顺序、置物架视图）的读写（存 `prefs.json`） |
| `src/main/exportStore.ts` | 数据导出：把待办和日程打包成一个 JSON 文件（US-029） |
| `src/main/fullscreenWatch.ts` | 全屏自动避让：有应用全屏时岛自动隐藏（US-041） |
| `src/main/notifyIconStore.ts` | 解析通知来自哪个应用、提取该应用的图标 |
| `src/main/clipboardStore.ts` | 验证码提示：轮询剪贴板，识别到验证码后弹横幅（US-039） |
| `src/preload/index.ts` | 中间人：把主进程的能力安全地交给界面 |
| `src/renderer/src/App.tsx` | **界面主体**——你看到的全部画面和交互都在这里 |
| `src/renderer/src/main.tsx` | 界面的启动入口，只负责把 App 挂上去 |
| `src/renderer/src/styles.css` | 全部样式：颜色、尺寸、动画 |
| `src/shared/types.ts` | 主进程和界面共用的数据格式定义 |

## 文档入口

**产品是什么** → [`docs/facts/产品定义.md`](docs/facts/产品定义.md)
**有哪些功能、做到什么程度** → [`docs/facts/功能清单.md`](docs/facts/功能清单.md)
**谁在用、按什么优先级做** → [`docs/facts/用户角色与用户故事.md`](docs/facts/用户角色与用户故事.md)
**数据存在哪、什么会丢** → [`docs/facts/数据规则.md`](docs/facts/数据规则.md)
**技术栈与架构决策** → [`docs/facts/技术方案.md`](docs/facts/技术方案.md)
**本机限制与踩坑记录** → [`docs/facts/本机约束与踩坑.md`](docs/facts/本机约束与踩坑.md)
**有哪些版本、怎么回溯** → [`docs/facts/版本历史.md`](docs/facts/版本历史.md)
**分几个阶段推进** → [`docs/facts/里程碑.md`](docs/facts/里程碑.md)
**现在到哪一步了** → [`docs/状态.md`](docs/状态.md)

**工程怎么做** → [`docs/工程规则.md`](docs/工程规则.md)（唯一正文，其它文件只引用不复述）

## 快速开始

```powershell
npm install
npm start          # 开发版（热更新）
npm run typecheck  # 类型检查
npm run build      # 构建
npm run dist       # 打包安装包到 release/
```

打包前需设置国内镜像，否则会超时或证书失败，详见 [`docs/工程规则.md`](docs/工程规则.md) 第九节。

## 技术栈

Electron 45 + React 19 + TypeScript + electron-vite，打包用 electron-builder（NSIS）。
选型理由与被否方案见 [`docs/facts/技术方案.md`](docs/facts/技术方案.md)。

## 维护约定

- 产品事实只写进 `docs/facts/`，同一项事实只在一个文件里维护，其他位置用链接引用。
- 每次开发的规格写进 `docs/Spec/`，开发与验收都用同一份。
- 工程规则只写在 `docs/工程规则.md`，其它入口引用它。
