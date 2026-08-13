# ShellDesk 代码审查报告(第九轮 · F1-F9 + v1.2 收尾验证)

- 审查时间:2026-08-13
- 审查对象:提交 `00722e8`(F1-F9 修复)+ `09779b3`(v1.2 收尾:搜索/终端右键菜单/真实 cwd·latency/会话恢复,7 文件 +239/-25)
- 审查方式:提交 diff 全量核对 + 数据流交叉验证(密码落盘链/exec 通道链/恢复链路)+ typecheck/eslint 实测
- 沙箱说明:`npm test`/`build`/`package:win` 因子进程 EPERM 无法在本环境执行;用户本机已验证 `test 10/10 ✅ build ✅`

---

## 一、总体结论

**✅ F1-F9 全部修复,v1.2 清单(2.4-2.7)落地,v1.2 里程碑完成。** 但本轮**新增 2 个高优先级缺陷**,其中一个是**对原始 B1(密码加密)的回归**:

1. 🔴 **S1:SSH 明文密码随会话布局持久化落盘**(`saveTabs` → `settings.lastTabs` → config.json 明文)—— 重新打开 B1 漏洞。
2. 🔴 **S2:延迟测量向用户的 SSH 会话注入 `echo\r`**(StatusBar 每 10s 调 `ssh.exec` 在活动 shell 里「打字」)—— 在 vim/nano 中会插入字符。

实测:
- `npm run typecheck`:**通过**(0 错误)
- eslint:**通过**(0 错误 / 12 警告)

| 维度 | 第八轮 | 本轮 | 说明 |
|---|---|---|---|
| 功能完整度 | 8.5 | 9 | 2.4-2.7 全部落地,roadmap v1.2 完成 |
| 代码质量 | 7.5 | 7 | F1-F9 修复干净;S2 注入缺陷与 S4 恢复失效拉低 |
| 安全性 | 7.5 | **6.5** | S1 明文密码回归(原 B1 防线被 lastTabs 绕过) |
| 工程化 | 8.5 | 8.5 | 门禁持续有效 |
| 可维护性 | 7 | 7 | lastTabs 类型为 any,恢复逻辑集中在 App.vue |

---

## 二、F1-F9 修复核对

| 编号 | 修复 | 状态 |
|---|---|---|
| F1 | defaultShell 生效(newLocalTab/ensureLocalTab/handleExecute/onMounted 均接入) | ⚠️ **有缺口**:`defaultShellId()` 仅映射 `cmd.exe→cmd`,**`powershell.exe` 会被映射成 `pwsh7` 实际启动 pwsh.exe**(见 S3) |
| F2 | confirmClose 生效(Ctrl+W/TabBar 关闭/右键菜单关闭均确认) | ⚠️ **需运行验证**:用了 `window.confirm`,Electron 渲染进程**未实现**该 API(官方文档明确),`confirm()` 恒为 falsy → 开启 confirmClose 后标签可能**永远关不掉**。建议改用主进程 `dialog.showMessageBox` 或组件内确认弹层 |
| F3 | 右键菜单外部点击关闭 | ✅ 全局 click 监听 + 卸载清理 |
| F4 | dragId dragend 清除 | ✅ |
| F5 | 本地重连延迟 150ms(containerRef 为空时安全早退) | ✅ |
| F6 | 字号 clamp 8-32 + NaN 回退 13 | ✅ |
| F7 | update 窄类型 keyof AppSettings;html-quotes 关闭 | ✅ |
| F8 | overlay 期间屏蔽 term.onData | ✅ |
| F9 | CODELY.md 入库 | ✅ |

---

## 三、新发现问题

### 🔴 S1. SSH 明文密码随会话布局持久化落盘(B1 回归)

- **链路:** `App.vue saveTabs()` → `tabs.map(t => ({ ... ssh: t.ssh }))` → `settingsStore.update({ lastTabs })` → `store:settings:set` → **electron-store 明文写入** `%APPDATA%/shelldesk/config/config.json`。`tab.ssh.password` 是明文(ConnectDialog 表单或 `sshHosts.get()` 解密结果),而 settings 通道**没有走 safeStorage 加密**(加密只存在于 sshHosts 通道)。
- **影响:** 用户连接任意带密码的 SSH 后退出应用,`config.json` 即含明文密码 —— 原始 B1(密码加密)的修复被 `lastTabs` 旁路。
- **修复(推荐):** 新增主进程 IPC `store:encrypt`/`store:decrypt`(safeStorage),saveTabs 前加密 `ssh.password` 存 lastTabs,restoreTabs 时解密后建标签 —— 恢复功能与安全兼得;或最小方案:saveTabs 剔除 `password`(安全,但恢复的 SSH 标签无法连接且当前无「修改标签 SSH 配置」入口,体验断链,需配套补密码 UI)。

### 🔴 S2. 延迟测量向用户 SSH 会话注入 `echo\r`

- **链路:** `StatusBar.vue:71` 每 10s `window.api.ssh.exec(tab.id, 'echo')` → 主进程 `ssh:exec` → `stream.write('echo\r')` → **在用户活动 shell 中实际输入并执行 echo**。用户在 vim/nano/htop 中时会插入字符,可能污染正在编辑的文件。
- **且测量无意义:** `ssh:exec` handler 同步 resolve,`Date.now()` 差 ≈ IPC 往返,不含远端 echo 往返,不是真实网络延迟。
- **修复:** 主进程新增 `ssh:ping` handler,用 `client.exec('echo ok')` 开**独立通道**测真实往返(不碰 shell stream);或删除该功能,SSH 延迟显示「—」。

### 🟡 S3. defaultShell 的 powershell.exe 映射错误(接 F1)

- `App.vue defaultShellId()`:`shell === 'cmd.exe' ? 'cmd' : 'pwsh7'` —— 设置选「Windows PowerShell (powershell.exe)」实际启动 pwsh.exe;`restoreTabs` 同样映射。
- **修复:** `LOCAL_SHELLS` 增加 `{ id: 'powershell', exe: 'powershell.exe' }`,`defaultShellId()`/`restoreTabs` 补齐映射(pty 白名单已含 powershell.exe ✓)。

### 🟡 S4. 会话恢复的 saveTabs 挂在 `App.onUnmounted` —— 窗口关闭时大概率不执行

- Electron 关闭窗口即销毁渲染进程,`onUnmounted` **不保证触发**(Vue 卸载钩子只在显式 unmount 时执行),恢复功能可能实际失效。
- **修复:** `window.addEventListener('beforeunload', saveTabs)`;或在主进程 `window close`/`before-quit` 时发 IPC 通知渲染层保存后再退出。

### 🟡 S5. TerminalPane 右键菜单定位偏移

- `TerminalPane.vue` `.ctx-menu { position: absolute }` + `clientX/clientY`(视口坐标)—— terminal-pane 不在视口原点,菜单整体偏移;TabBar 的菜单用 `position: fixed` 是对的,此处不一致。
- **修复:** 改 `position: fixed`(或换算 offset 坐标)。

### 🟢 低优先级

- **S6.** TerminalPane 右键菜单仅 `mouseleave` 关闭,无外部点击关闭(TabBar 已修,此处未同步)。
- **S7.** `lastTabs` 类型:主进程 schema `any[]`、App.vue `as any` ×2(12 个 lint 警告的主要来源);建议用共享类型。
- **S8.** 延迟定时器 10s 常驻(空闲也跑,仅置 0)——可接受;建议在无活动 SSH 时暂停。

---

## 四、实现亮点

- **搜索:** SearchAddon 集成干净(Ctrl+Shift+F 打开、Enter/Shift+Enter 上下、Esc 关闭、输入框不干扰终端键盘通道)。
- **终端右键菜单:** 复制(有选区)/粘贴/清屏/全选/查找五项齐全,替代原裸右键粘贴。
- **StatusBar:** fontSize 改 computed 与设置联动;cwd 本地读 tab.cwd、SSH 读 host;本地延迟显示「—」。
- **恢复的本地标签:** shell 与 cwd 均正确回传(除 powershell 映射缺口)。
- **F5 的安全早退:** 重连延迟 150ms 且 `containerRef` 判空,组件已卸载时不炸。

---

## 五、验证记录

- `npm run typecheck`:**通过**(0 错误)
- eslint:**通过**(0 错误 / 12 警告,主要来自 App.vue `as any` ×2)
- `npm test` / `build` / `package:win`:沙箱 EPERM 无法执行,以用户本机验证为准
- git:10 提交;工作区干净
- 本报告为静态审查 + 数据流交叉验证 + 类型/静态检查,未修改任何文件
