# ShellDesk

轻量化终端管理桌面工具 — 本地终端 / SSH / SFTP / 快捷指令

## 技术栈

- Electron 33 + Vue 3 + Vite
- xterm.js 6 (终端模拟器)
- @homebridge/node-pty-prebuilt-multiarch (本地伪终端)
- ssh2 (SSH/SFTP 客户端)
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
npm run package:win
```

## 目录结构

```
shelldesp/
├── electron/
│   ├── main/          # Electron 主进程
│   │   ├── index.ts   # 入口, 窗口创建, IPC 注册
│   │   ├── pty.ts     # 本地终端 (node-pty) + pause/resume
│   │   ├── ssh.ts     # SSH/SFTP (ssh2) + keepalive + StringDecoder
│   │   └── store.ts   # 配置存储 (electron-store + safeStorage 加密)
│   └── preload/
│       └── index.ts   # contextBridge IPC 桥
├── src/
│   ├── components/    # Vue 组件
│   │   ├── TitleBar.vue      # 自定义标题栏
│   │   ├── Sidebar.vue       # 快捷路径 + 连接 + 指令列表
│   │   ├── TabBar.vue        # 标签栏 (滚动 + 自动定位)
│   │   ├── TerminalPane.vue  # xterm.js 终端面板
│   │   ├── StatusBar.vue     # 底部状态栏
│   │   └── ConnectDialog.vue  # SSH 连接对话框
│   ├── stores/        # Pinia stores
│   ├── styles/        # 全局样式 (琥珀荧光主题)
│   ├── types/         # TypeScript 类型
│   └── main.ts        # Vue 入口
├── assets/icons/      # 应用图标
└── electron-builder.yml
```

## 配置文件

`%APPDATA%/shelldesk/config/config.json`

SSH 密码使用 `safeStorage.encryptString()` 加密存储。
