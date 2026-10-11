# ShellDesk

轻量化终端管理桌面工具 — 本地终端 / SSH / 快捷指令

> **v1.3.0** — SSH 能力与可观测性: 四种认证方式(密码/密钥/SSH Agent/无密码)、主机密钥信任库(首次确认+变更拒绝)、中文错误归因、连接测试、两步远端系统探测、**服务器状态面板**(CPU/内存/磁盘/网络, 独立通道采集不污染终端)
> **v1.2.1** — 窗口交互完善: 窗口位置/大小/最大化记忆、F11 全屏、标题跟随活动标签、快捷键全局可用(终端聚焦时同样生效: Ctrl+Tab/Ctrl+1~9/字号缩放/Ctrl+Alt+B) + 侧栏拖拽调宽
> **v1.2.0** — 体验增强: 设置面板(字号/字体/主题/自动重连)、标签拖拽排序/双击重命名/中键关闭/右键菜单、断线重连 overlay + 指数退避

## 技术栈

- Electron 33 + Vue 3 + Vite
- xterm.js 6 (终端模拟器)
- @homebridge/node-pty-prebuilt-multiarch (本地伪终端)
- ssh2 (SSH 客户端)
- electron-store (配置持久化)

## 开发

```bash
# 安装依赖 (注意: NODE_ENV 必须是 development)
$env:NODE_ENV="development"
npm install --legacy-peer-deps

# 验证 node-pty 原生模块
# 如果 node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node 不存在:
cd node_modules/@homebridge/node-pty-prebuilt-multiarch
npx prebuild-install -r node --force
cd ../../..

# 开发模式
npm run dev

# 构建
npm run build

# 打包 (Windows x64)
# 产出: dist/win-unpacked (免安装) + dist/ShellDesk-<版本>-setup.exe (安装/覆盖升级包)
npm run package:win
```

# 测试 (单元 + 端到端)
# 端到端会起真实 SSH 服务端: ssh2 的 JS 服务端 + WSL 里的真实 OpenSSH
# 环境不具备时对应项会明确跳过 (返回 0), 不会假装通过
npm test
```

> 覆盖升级、数据保留、安装位置检测与更新包自测方法，见 [更新方式说明.md](更新方式说明.md)

## 目录结构

```
shelldesp/
├── electron/
│   ├── main/          # Electron 主进程
│   ├── main/          # Electron 主进程
│   │   ├── index.ts       # 入口, 窗口创建, IPC 注册
│   │   ├── pty.ts         # 本地终端 (node-pty) + pause/resume
│   │   ├── ssh.ts         # SSH (ssh2) + 认证方式 + keepalive + exec-capture
│   │   ├── security.ts    # 共享 IPC sender 校验
│   │   ├── store.ts       # 配置存储 (electron-store + safeStorage 加密)
│   │   ├── knownHostKey.ts # 主机密钥指纹/比对 (纯逻辑, 可直测)
│   │   ├── knownHosts.ts  # 主机密钥信任库读写
│   │   ├── sshErrors.ts   # SSH 错误 → 中文归因
│   │   ├── remoteOs.ts    # 两步远端系统探测 (uname → cmd /c ver)
│   │   ├── systemStatus.ts # 服务器状态采集与解析 (纯计算, 可直测)
│   │   └── windowState.ts # 窗口位置/大小记忆
│   └── preload/
│       └── index.ts   # contextBridge IPC 桥
├── src/
│   ├── components/    # Vue 组件
│   │   ├── TitleBar.vue      # 自定义标题栏
│   │   ├── Sidebar.vue       # 快捷路径 + 连接 + 指令列表
│   │   ├── TabBar.vue        # 标签栏 (滚动 + 自动定位)
│   │   ├── TerminalPane.vue  # xterm.js 终端面板
│   │   ├── StatusBar.vue     # 底部状态栏
│   │   ├── SystemStatusPanel.vue # 服务器状态面板 (CPU/内存/磁盘/网络)
│   │   ├── SettingsDialog.vue    # 设置面板
│   │   └── ConnectDialog.vue  # SSH 连接对话框
│   ├── stores/        # Pinia stores
│   ├── styles/        # 全局样式 (琥珀荧光主题)
│   ├── types/         # TypeScript 类型 (渲染层与主进程共用)
│   └── main.ts        # Vue 入口
├── scripts/           # 测试与工具脚本
│   ├── run-tests.mjs          # 测试入口 (编译 → 单元 → 端到端)
│   ├── e2e-ssh-check.mjs      # 端到端: ssh2 JS 服务端
│   ├── e2e-error-mapping.mjs  # 端到端: 错误翻译
│   ├── e2e-openssh-check.mjs  # 端到端: 真实 OpenSSH
│   ├── e2e-system-status.mjs  # 端到端: 服务器状态采集
│   ├── e2e-ui-check.mjs       # 端到端: 真实 Electron UI (CDP)
│   └── lib/                   # 测试服务端 (ssh2 Server / WSL OpenSSH)
├── test/              # node:test 单元测试
├── assets/icons/      # 应用图标
└── electron-builder.yml
```

## 配置文件

`%APPDATA%/shelldesk/config/config.json`

SSH 密码使用 `safeStorage.encryptString()` 加密存储。
若系统不支持加密（如 Linux 缺少 libsecret），密码将以明文存储作为降级方案。
