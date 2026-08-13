# ShellDesk 代码审查报告(第八轮 · v1.2.0 体验增强验证)

- 审查时间:2026-08-13
- 审查对象:提交 `7721252`(v1.1 打磨)+ `59c2127`(v1.2.0 体验增强,10 文件 +424/-37)
- 审查方式:提交 diff 全量核对 + 交叉引用验证(设置项消费链/会话清理链)+ `npm run typecheck` / eslint 实测
- 沙箱说明:`npm test`/`build`/`package:win` 因子进程管道 EPERM 无法在本环境执行;用户本机已验证 `test 10/10 ✅ build ✅ package:win ✅`

---

## 一、总体结论

**✅ v1.2.0 三大主项(设置面板、标签交互、断线重连)全部落地,实现质量良好,无阻断问题。** 发现 **2 个「死设置」**(界面能改、代码不消费)和 3 个小交互缺陷,均易修。

实测:
- `npm run typecheck`:**通过**(0 错误)
- eslint:**通过**(0 错误,14 警告 —— 较上轮 +6,新增项见 F7)

| 维度 | 第七轮 | 本轮 | 说明 |
|---|---|---|---|
| 功能完整度 | 8.5 | 8.5 | 三大项落地;但 defaultShell/confirmClose 未接线(-) |
| 代码质量 | 7.5 | 7.5 | 重连状态机复用 disconnected 标志,逻辑清晰 |
| 安全性 | 7.5 | 7.5 | 无新攻击面 |
| 工程化 | 8.5 | 8.5 | 门禁/CI 持续有效 |
| 可维护性 | 6.5 | 7 | settings store + THEME_PRESETS 结构良好 |

---

## 二、v1.2 清单逐项核对(roadmap §2)

| 项 | 内容 | 状态 | 备注 |
|---|---|---|---|
| 2.1 | 设置面板 | ⚠️ 部分 | SettingsDialog + settings store + THEME_PRESETS + TerminalPane 动态订阅(fontSize/fontFamily/theme 实时生效)✅;**但 defaultShell 与 confirmClose 未消费,见 F1/F2** |
| 2.2 | 标签交互 | ✅(小缺陷) | 拖拽排序/双击重命名/中键关闭/右键菜单(重命名/关闭/关闭其他/全部)全部实现;tabs store 新增 reorder/closeOthers/closeAll;App.vue watch 自动 kill 关闭标签的会话 ✅ |
| 2.3 | 断线重连 | ✅ | 断开 → overlay(SSH「重新连接」/本地「重启终端」);手动重连清理旧监听 + 重新 initTerminal;SSH 自动重连指数退避 1s→30s cap,设置开关;autoReconnect 正确限定 SSH 场景 |

---

## 三、新发现问题

### 🟠 F1. 「默认终端」设置是死设置 —— 改了下一次新建标签仍用 pwsh

- **证据:** `settings.defaultShell` 仅在 `SettingsDialog.vue:8` 被写入;全项目**无任何读取点**。新建标签路径全部硬编码:`Sidebar.vue` `newLocalTab('pwsh7'|'cmd')`、`TabBar.vue` `newLocal('pwsh7'|'cmd')`、`App.vue` `createLocalTab('pwsh7', ...)`,而 `tabs.ts` 的 `createLocalTab(shellId)` 只按传入 shellId 解析。
- **修复(约 10 行):** `createLocalTab()` 无参时回退 `settings.defaultShell`(映射 pwsh.exe/powershell.exe/cmd.exe → shellId);或 Sidebar/TabBar 的「默认」入口直接读 settings。

### 🟠 F2. 「关闭标签时确认」设置是死设置 —— 勾了也直接关

- **证据:** `settings.confirmClose` 仅写入,`TabBar.vue:216` `closeTab` 直接 `tabsStore.closeTab(id)`,无任何确认;关闭其他/全部同样不确认。
- **修复(约 15 行):** closeTab 前若 `confirmClose` 且存在活动会话(PTY/SSH 连接中)则弹确认(可复用 toast 或小 confirm 组件);或接入 Electron `dialog.showMessageBoxSync`。

### 🟡 F3. 右键菜单不随外部点击关闭

- `TabBar.vue` ctx-menu 仅在 `@mouseleave` 或执行动作后消失;右击标签打开菜单后点击其他标签/空白处,菜单仍悬浮遮挡界面。
- **修复:** 组件挂载时加 `document.addEventListener('click', 关闭菜单)`,卸载时移除(注意菜单自身点击 `@click.stop`)。

### 🟡 F4. 拖拽释放到标签外后 `dragId` 残留

- `TabBar.vue` `dragId` 只在 `onDrop` 清空;拖到标签外松开(无 drop)时 `.dragging`(opacity 0.4)永久残留,直到下次拖拽。
- **修复:** 加 `@dragend="dragId = ''"`(1 行)。

### 🟢 低优先级

- **F5.** 本地「重启终端」在会话「后台退出未清理」窗口期(约 100ms)内点击会立即再次退出:resume 返回 exited 后主进程 100ms 才 `cleanupSession`;快速点击 → 又 exited → overlay 闪回(自愈但体验差)。可在 `doReconnect` 对 local 先 `pty.kill` 强制清理再 init。
- **F6.** SettingsDialog 字号 `min=8 max=32` 仅 HTML 约束,手输 100 也会保存;建议 `update('fontSize')` 时 clamp 8-32。
- **F7.** lint 警告 8→14:`vue/html-quotes`(SettingsDialog 单引号属性 ×2)、`no-explicit-any`(SettingsDialog `update` 的 `as any` 等);0 错误,不阻塞。`update(key, value as any)` 可改 `update(key: keyof AppSettings, value: AppSettings[keyof AppSettings])` 消除。
- **F8.** reconnect overlay 期间 `term.onData` 仍活跃,盲打会进入 inputBuffer(连接期)或静默丢弃;可接受,可考虑 overlay 时忽略输入。
- **F9.** `CODELY.md` 工作区为 M(未提交)状态;如非有意,建议随下次提交一起处理。

---

## 四、实现亮点(建议保留的模式)

- **重连状态机复用 `disconnected` 标志**:`onDisconnected()` 由多个事件(exit/closed/error/resume-exited)触发,但每个事件入口都已先置位 `disconnected` 去重 → 自动重连调度只跑一次,无重复定时器。
- **`doReconnect` 全量清理**:清定时器 + removeListeners + dispose term + 断开 ResizeObserver/contextmenu 再 `initTerminal`,避免了二次挂载的监听器泄漏。
- **主题预设集中化**:THEME_PRESETS 单点维护,TerminalPane 通过 `term.options.theme` 热切换,无需重建实例。
- **关闭标签的会话回收链路完整**:`closeOthers`/`closeAll` 直接替换数组,由 App.vue 既有 deep watch 统一 `pty.kill`/`ssh.disconnect`,无泄漏路径。

---

## 五、验证记录

- `npm run typecheck`:**通过**(0 错误)
- eslint:**通过**(0 错误 / 14 警告,新增 6 个均来自 v1.2 新文件)
- `npm test` / `build` / `package:win`:沙箱 EPERM 无法执行,以用户本机验证为准(10/10、build、package ✅)
- git:8 提交;工作区仅 `CODELY.md` 未提交
- 本报告为静态审查 + 交叉引用 + 类型/静态检查,未修改任何文件
