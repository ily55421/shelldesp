# ShellDesk 代码审查报告（第四轮）

- 审查时间: 2026-08-13
- 审查对象: `E:\code\ai\shelldesp`（2 个提交 `3ee424b` / `a50948d`，working tree clean，44 个跟踪文件）
- 审查方式: 全量源码阅读 + `npm run typecheck:node` + `npm run typecheck:web` 实测 + git 核对
- 相对第三轮（`shelldesk-review-2026-08-13.md`）的变化: **无代码变更**，working tree clean，上一轮提出的全部问题原样保留

---

## 一、总体结论

**第三轮报告中的 2 个阻断级 + 3 个高优先级 + 6 个中优先级 + 7 个低优先级问题，一项未修。** 项目仍处于「dev 可跑、typecheck/build 必挂」状态。

实测 typecheck 结果与第三轮完全一致：
- `typecheck:node`: **19 错误**（pty.ts 4、ssh.ts 14、preload 1）
- `typecheck:web`: **1 错误**（`App.vue:28` `onKeyDown` 不存在）
- 总计 **20 个编译错误**，`npm run build` / `npm run package:win` 必失败

| 维度 | 第三轮 | 本轮 | 变化 |
|---|---|---|---|
| 功能完整度 | 7.5 | 7.5 | 无变化 |
| 代码质量 | 5 | 5 | 无变化 |
| 安全性 | 6 | 6 | 无变化 |
| 工程化 | 6 | 6 | 无变化 |
| 可维护性 | 5 | 5 | 无变化 |

---

## 二、阻断级问题（不修则无法交付）

### 🔴 B1. typecheck 全挂，build 必失败

20 个 TypeScript 编译错误，分 4 类：

| 类别 | 数量 | 位置 | 原因 |
|---|---|---|---|
| `IpcMainInvokeEvent` → `IpcMainEvent` | 16 | pty.ts(4) + ssh.ts(12) | `isValidSender`/`getWin` 参数声明为 `IpcMainEvent`，但 `ipcMain.handle` 回调参数是 `IpcMainInvokeEvent` |
| `PseudoTty` 不存在 | 1 | ssh.ts:9 | `@types/ssh2` 无此导出，应为 `ClientChannel` |
| 模块路径错误 | 1 | preload:30 | `'../src/types'` 应为 `'../../src/types'`（preload 在 `electron/preload/`，types 在 `src/types/`） |
| `onKeyDown` 不存在 | 1 | App.vue:28 | 从 `vue` 导入了不存在的 `onKeyDown`（实际用的是自定义 `onKeydown` 函数，第 115 行） |

**修复（约 20 行，30 分钟）:**
1. `App.vue:28` — 删掉 `onKeyDown`
2. `pty.ts` / `ssh.ts` — `isValidSender` 和 `getWin` 参数改为 `IpcMainEvent | IpcMainInvokeEvent`
3. `ssh.ts:9` — `PseudoTty` → `ClientChannel`
4. `preload/index.ts:30` — `'../src/types'` → `'../../src/types'`

### 🔴 B2. privateKey 白名单可被绝对路径绕过

**位置:** `electron/main/ssh.ts:70-75`

```ts
const resolved = path.resolve(keyPath)
if (!resolved.startsWith(path.resolve(sshDir)) && resolved !== keyPath) {
  throw new Error('只允许读取 ~/.ssh 目录下的私钥文件')
}
```

`resolved !== keyPath` 让绝对路径直接放行 — 传入 `C:\Windows\win.ini` 时 `path.resolve` 返回原值，第二个条件为 `false`，整条校验短路。**H1 安全修复形同虚设。**

**修复:** `if (!resolved.startsWith(path.resolve(sshDir) + path.sep)) throw ...`

---

## 三、高优先级问题

### 🟠 H1. `win:*` IPC 无 sender 校验 + 重复注册

**位置:** `electron/main/index.ts:70-76`

三个 `ipcMain.on('win:*')` handler 注释写「只接受来自主窗口」但无校验。且注册在 `createWindow()` 内，macOS `activate` 重建窗口会叠加监听器。

### 🟠 H2. sshHost 快捷指令路径残缺

**位置:** `src/App.vue:64-89`

`shortcut.sshHost` 字段被完全忽略 — `newTab` 分支永远 `createLocalTab`，非 newTab 分支对非 SSH 标签执行 `ssh:exec` 静默 no-op。用户配置了「在 SSH 连接上执行」的指令，实际全部在本地执行或静默失败。

### 🟠 H3. 连接状态全为假

- `StatusBar.vue:35`: `connected = !!activeTab` — SSH 断开/PTY 退出后仍显示绿点
- `Sidebar.vue:63`: SSH 主机条目 `.dot.on` 无条件显示绿色脉冲「在线」
- `Sidebar.vue:239`: `sessionCount` 实为标签数，不是活动会话数

---

## 四、中优先级问题

| # | 问题 | 位置 |
|---|---|---|
| M1 | TerminalPane 本地分支 `pty.create().then().then()` 无 `.catch`，shell 创建失败时 Unhandled rejection | TerminalPane.vue:136-150 |
| M2 | SSH 连接期间（最长 15s）用户输入被静默丢弃，stream 未就绪时 `ssh:write` no-op | TerminalPane.vue:160-161 |
| M3 | `ssh:error` / `ssh:closed` 事件 preload 已暴露但渲染层未注册监听，连接错误详情丢失 | TerminalPane.vue:125-131 |
| M4 | SFTP 完整实现（ssh.ts 244-337 + preload 65-78 + types 57-69）但**零 UI 调用**，README 宣称的 SFTP 功能不可达 | 全局 |
| M5 | 保存 SSH 主机时已存在条目只跳过不更新，改了密码/密钥后重连保存仍用旧配置 | ConnectDialog.vue:107-125 |
| M6 | 设置项（fontSize/fontFamily/theme）未接入 TerminalPane，硬编码 `fontSize: 13`；齿轮按钮「设置功能开发中…」 | TerminalPane.vue:30-31 |

---

## 五、低优先级问题

| # | 问题 |
|---|---|
| L1 | sender 校验函数三份重复（pty.ts / ssh.ts / store.ts），应抽 `security.ts` |
| L2 | safeStorage 降级明文存储未在 README 文档化 |
| L3 | TerminalPane onUnmounted 先 `pause` 后 `removeListeners`，毫秒级竞态 |
| L4 | shortcuts store 的 `add/update/remove` 不 await `saveShortcuts`，快速连续编辑可能丢更新 |
| L5 | 无 lint / test / CI；两次提交都带编译错误入库 |
| L6 | `asar: false` + `npmRebuild: false`，正式分发前需改 |
| L7 | ConnectDialog 对 port 无范围校验（0/65535+ 直接透传） |

---

## 六、修复优先级建议

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **P0（立即）** | B1: 4 处类型修复（~20 行）+ B2: privateKey 校验加 `path.sep`（1 行） | 30 分钟 |
| **P1（本周）** | H1 win IPC 校验 + H2 sshHost 语义 + H3 真实连接状态 + M1 补 catch + M3 注册 error/closed | 0.5-1 天 |
| **P2（两周内）** | M2 输入队列 + M4 SFTP 面板或撤宣传 + M5 更新主机配置 + M6 设置接入 | 2-3 天 |
| **P3（持续）** | L1-L7 + lint/test/CI + 提交前 typecheck 门禁 + asar 正确化 | 持续 |

---

## 七、验证记录

- `npm run typecheck:node`: **失败**，19 错误（pty.ts 4 + ssh.ts 14 + preload 1）
- `npm run typecheck:web`: **失败**，1 错误（`App.vue:28 TS2305 onKeyDown`）
- git: 2 提交，working tree clean，自第三轮审查以来无代码变更
- 本报告为静态审查 + 类型检查，未运行项目、未修改任何文件
