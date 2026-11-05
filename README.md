# 灵动岛（Lingdong Island）

Windows 桌面顶部居中的悬浮胶囊：收起时是一条窄条，点开展开成面板，把待办、日程、通知、置物架收在一处，并养一只会表达情绪的小宠物「岛仔」。

本项目是对一段 B 站演示视频（原作者作品、无源码）的**独立重做**，不复制原作者代码。

## 目录用途

```
灵动岛/
├── README.md              本文件：项目简介与文档入口
├── AGENTS.md              AI 开工必读：该读哪些资料
├── docs/
│   ├── 状态.md             当前进度与下次开工（唯一频繁更新的文档）
│   ├── 工程规则.md          工程规则唯一正文：分支、SPEC、自检、验收、合并上线
│   ├── facts/             产品事实（唯一事实源，同一事实只在一处维护）
│   ├── Spec/              每次开发任务的规格说明书
│   └── archive/           迁移前的旧文档留存
├── src/                   应用源码（main / preload / renderer / shared）
├── scripts/               e2e 自动化脚本
├── build/                 图标等打包资源
└── release/               打包产物（Git 忽略）
```

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
