# 更新日志

本文件记录 Desktop Pet 的重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.2] - 2026-11-10

### 修复

- 改进 macOS 与 Windows 的启动和拖拽行为，修复多显示器顶部边缘拖拽不稳定的问题。
- 将「淘淘」体验包下载地址及用户手册图片地址更新为 `pet.zexu.dpdns.org`，修复旧域名失效的问题。

## [0.1.1] - 2026-07-17

### 新增

- 新增首次启动引导：自动打开控制面板，并可一键下载、校验、安装和切换到「淘淘」体验包。
- System 页面新增“关于”与更新检查，可显示当前版本、查询 GitHub Releases，并跳转到新版本下载页。
- 新增 macOS 与 Windows 的标签发布工作流，自动构建固定文件名的安装包并创建 GitHub Release。
- 绿幕视频新增实时预览和透明 WebM 烘焙；运行时优先使用 WebGL，必要时回退到 Canvas2D。
- 动画新增 `interrupt: true` 立即打断能力，以及绑定 `oneshot` 生命周期的移动、缓动和起止延迟。
- 新增状态型规则、退出条件与退出动作，并支持基于全局鼠标位置连续驱动关键帧进度。
- 新增规则导入导出、互动开关动作、独立规则定时器和时间条件冲突提示。
- 官网新增 macOS/Windows 直接下载入口、安装后引导和在线用户手册。

### 变更

- 控制面板整理为 Overview、Assets、Animations、Rules、Display 和 System 六个页面，并改进表单实时更新、拖放排序和编辑反馈。
- 规则结构统一为 `conditions`、内联 `actions` 和可选的 `state`，移除旧版 States / Actions 工作流。
- 多条件规则默认在 1000ms 窗口内组合匹配；需要更长时间时可通过 `conditionWindowMs` 显式配置。
- 普通规则共享当前活动冷却期，连续鼠标规则可绕过冷却以保持实时响应。
- 动画播放改为非打断式单槽队列：受保护动画完成后播放最新等待项，重复和中间请求会被忽略或替换。
- 动画控制器统一负责播放结束、返回默认动画、循环边界切换和配置热更新；`loop.durationMs` 表示单次循环时长。
- Petpack 导入不再使用固定的文件数、单文件大小或总包大小上限，改为根据可用内存和磁盘空间动态限制资源。
- README 和用户手册改为面向普通用户的安装、体验与宠物包制作流程。

### 修复

- 修复拖拽结束强制返回默认动画、覆盖等待动画，以及连续手势错误中断受保护动画的问题。
- 修复 `stopAnimation` 丢失等待项、循环边界继续使用旧时长，以及删除活动或等待剪辑后残留无效状态的问题。
- 修复控制面板部分字段不能实时刷新、规则条件字段残留、素材表单不同步和关键帧草稿保存不完整的问题。
- 修复宠物顶部区域拖拽、本地与全局鼠标事件重复触发，以及规则冷却只在部分事件路径生效的问题。
- 修复 Petpack 导入导出时将 `.DS_Store`、`__MACOSX`、`._*` 和 `Thumbs.db` 等系统元数据打包的问题。

### 安全

- Petpack 解压增加动态内存与磁盘资源保护，并继续拒绝符号链接、不安全路径和未知素材格式。
- Petpack 安装采用临时目录、备份和原子替换，失败时自动回滚。
- 素材导入继续要求经过文件选择器或拖放授权，Renderer 仅通过受控 preload API 访问主进程能力。

### 文档

- 更新开发指南、用户手册、当前架构、控制面板架构和发布检查清单。
- README 增加安装包下载、快速体验、更新日志、赞助和社区入口。

## [0.1.0] - 2026-06-21

### 新增

- 首个 Desktop Pet Electron 客户端版本，支持 macOS 和 Windows。
- 透明、无边框、置顶的桌面宠物窗口，以及独立控制面板和系统托盘。
- 基础 Petpack 格式，可打包 `manifest.json`、动画素材和触发规则。
- 默认、单次、循环和关键帧动画类型。
- 点击、拖拽、悬停、定时和应用生命周期等基础触发条件。
- 动画播放、消息气泡、缩放、透明度、窗口移动、显示隐藏和位置重置等动作。
- 本地配置持久化、素材导入、Petpack 导入导出和双语界面基础能力。
- Vitest 单元测试、Playwright 端到端测试、Vite 构建和 Electron Builder 打包流程。

### 安全

- Renderer 启用 Context Isolation 并禁用直接 Node.js 访问。
- 文件路径、素材扩展名、Manifest 结构和动画引用在导入前进行校验。
- 配置和包安装使用临时文件或目录进行原子写入。

[未发布]: https://github.com/duzexu/desktop-pet/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/duzexu/desktop-pet/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/duzexu/desktop-pet/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/duzexu/desktop-pet/releases/tag/v0.1.0
