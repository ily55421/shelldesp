# ShellDesk 代码复查报告(第二轮)

- 复查时间:2026-08-12 13:45
- 复查对象:`E:\code\ai\shelldesp`(相对第一轮 12:57 的修改,16 个文件变更)
- 复查方式:静态代码审查 + `npm run typecheck` 静态类型检查(未安装依赖、未修改任何文件)
- 结论:**第一轮 22 个问题中 16 个已彻底修复,3 个部分修复,2 个未修复;但修改引入了 3 个新问题,其中 2 个导致类型检查全线失败、1 个是安全修复无效。当前项目 `npm run dev` 可跑,`npm run build`/`typecheck` 会失败。**

---

## 一、总体结论

第一轮修复质量整体较高:SSH 密码加密(safeStorage)、StringDecoder 乱码修复、IPC sender 校验、shell 白名单、单实例锁、会话回收、标签上限收敛、keepalive、CSP、本地字体、README/LICENSE/git 初始化等关键项都已正确落地,方向正确。

但本轮修改引入了 3 个新问题,且暴露了此前从未跑过类型检查的事实:

1. **`src/App.vue` 第 2 行 `import { onKeyDown } from 'vue'` 编译错误**(TS2305)——`onKeyDown` 不是 Vue 的导出。`vue-tsc` 直接报错;`electron-vite build`(Rollup)同样会报 "onKeyDown is not exported by vue" 而失败。dev 模式(esbuild)不检查,所以「开发能跑、构建必挂」。
2. **`npm run typecheck:node` 失败,18 个 TS 错误**——三小类:`IpcMainInvokeEvent` 传入 `IpcMainEvent` 参数(pty.ts 4 处 + ssh.ts 12 处)、`ssh2.PseudoTty` 类型不存在(ssh.ts:9)、preload 相对路径 `'../src/types'` 少一层(应为 `'../../src/types'`)。
3. **H1 的私钥路径校验存在逻辑漏洞,等于没限制**(详见 N3):绝对路径可完全绕过 `~/.ssh` 白名单。

| 维度 | 第一轮 | 本轮 | 说明 |
|---|---|---|---|
| 功能完整度 | 7 | 8 | 快捷键、去重、递归删除等补齐 |
| 代码质量 | 6 | 5 | 竞态/泄漏修复,但类型检查失败、重复代码、校验逻辑 bug |
| 安全性 | 4 | 6 | 加密+sender 校验落地,但 privateKey 校验被绕过、win IPC 未校验 |
| 工程化 | 3 | 6 | git/README/LICENSE/CSP/本地字体到位,但无 lint/测试/CI |
| 可维护性 | 5 | 5 | 结构更清晰,isValidSender 三份重复 |

---

## 二、第一轮问题修复状态(22 项逐一核对)

| 编号 | 问题 | 状态 | 证据/说明 |
|---|---|---|---|
| B1 | SSH 密码明文落盘 | ✅ 已修复 | store.ts 用 `safeStorage.encryptString()` 加密,`enc:` 前缀 + 旧明文兼容;降级明文路径有注释 |
| B2 | SSH 输出 UTF-8 乱码 | ✅ 已修复 | StringDecoder 逐 chunk 解码,close 时 `decoder.end()` 冲刷残留字节 |
| H1 | IPC 无 sender 校验 / privateKey 任意读 | ⚠️ 部分修复 | sender 校验✅、shell 白名单✅;privateKey 的 `~/.ssh` 限制有逻辑漏洞,绝对路径可绕过(见 N3) |
| H2 | 切标签丢最后一批输出 | ✅ 已修复 | 主进程 pause 时残留 buffer 写入 pausedBuffer 而非 IPC 发送;残余毫秒级竞态概率极低(见 N9) |
| H3 | 无 git/README/许可证 | ✅ 已修复 | git init(1 提交)、README.md、LICENSE(MIT)齐备 |
| H4 | 调试文件残留 | ✅ 已修复 | err*.txt 等已删除,.gitignore 增加 err*.txt/out*.txt/stderr.txt/mem-log/.codely 等 |
| H5 | 无 CSP + 远程字体 | ✅ 已修复 | CSP meta 添加;字体改为 `local()` 引用系统字体,移除 Google Fonts |
| M1 | 状态栏假数据 | ⚠️ 部分修复 | fontSize 从 settings 读取、latency 不再编造(显示 —);但 connected 仍 = `!!activeTab`,SSH 断开仍显示「已连接」(见 N4) |
| M2 | Ctrl+T/D 提示未实现 | ⚠️ 已实现但引入新问题 | 快捷键功能实现(Ctrl+T/W/D,跳过输入框);但第 2 行 `import { onKeyDown } from 'vue'` 是编译错误(见 N1) |
| M3 | 无单实例锁 | ✅ 已修复 | `requestSingleInstanceLock` + second-instance focus;cleanStaleLocks 只删 DevToolsActivePort |
| M4 | 后台退出会话泄漏 | ✅ 已修复 | resume 检测 exited 后 `setTimeout` 清理 session |
| M5 | SSH 主机无去重 | ✅ 已修复 | 前端 + 主进程双重去重(host:port:username) |
| M6 | titleBarOverlay 双按钮 | ✅ 已修复 | 改为 `frame: false` 纯自定义标题栏,移除 overlay |
| M7 | sshHost 快捷指令路径残缺 | ❌ 未修复 | App.vue handleExecute 逻辑未变:newTab 分支仍建本地标签,sshHost 目标不存在时静默失败 |
| M8 | 新建标签无上限 | ✅ 已修复 | MAX_TABS 收敛到 store,create*Tab 返回 null,三处入口均检查(ConnectDialog/Sidebar 的 createSshTab 未检查,见 N6) |
| M9 | SSH 无 keepalive | ✅ 已修复 | keepaliveInterval 10000 / keepaliveCountMax 3 |
| L1 | 混用 require | ✅ 已修复 | store.ts 全部顶部 import |
| L2 | SFTP 非空目录删除失败 | ✅ 已修复 | sftp:delete 递归删除实现 |
| L3 | 私钥选择器用目录对话框 | ✅ 已修复 | 新增 store:pickFile,ConnectDialog 使用 |
| L4 | 无 lint/测试/CI | ❌ 未修复 | 且本轮 typecheck 失败,更凸显 |
| L5 | 设置项未生效 | ⚠️ 部分修复 | fontSize 已从 settings 读取;fontFamily/theme 仍未接入 TerminalPane |
| L6 | uncaughtException 重复注册 | ✅ 已修复 | 顶层注册 + 补 unhandledRejection,输出完整 stack |

**统计:彻底修复 16 项,部分修复 3 项(H1/M1/L5),未修复 2 项(M7/L4),1 项实现但引入编译错误(M2)。**

---

## 三、本轮新发现问题

### 🟠 高

#### N1. `App.vue` 导入不存在的 `onKeyDown`,构建/类型检查失败

- **位置:** `src/App.vue` 第 2 行 `import { onMounted, onUnmounted, watch, onKeyDown } from 'vue'`
- **严重度:** 高
- **问题描述:** Vue 3 没有 `onKeyDown` 导出(已核对 `node_modules/vue/dist/vue.d.ts` 无此成员)。`npm run typecheck:web` 报 `TS2305: Module '"vue"' has no exported member 'onKeyDown'`;`electron-vite build`(Rollup)对未导出命名导入同样报错,打包流程中断。dev 模式(esbuild 不做导出检查)能跑,且代码实际用的是自定义 `onKeydown` 函数(第 85 行),该 import 是死导入——删掉即可。
- **修复:** 删除 `onKeyDown`(保留其余);顺手把第 2 行与 `onKeydown` 函数名统一风格。

#### N2. `npm run typecheck:node` 失败,18 个 TS 错误

- **位置:** `electron/main/pty.ts`(58/77/127/157 行)、`electron/main/ssh.ts`(64/85/125/209/235/246/260/271/274/286/289/308/331 行)、`electron/main/ssh.ts:9`、`electron/preload/index.ts:30`
- **严重度:** 高
- **问题描述:** 三类错误:
  1. `ipcMain.handle` 回调参数是 `IpcMainInvokeEvent`,传入签名要求 `IpcMainEvent` 的 `isValidSender/getWin`(pty.ts 4 处 + ssh.ts 12 处)——`IpcMainEvent` 的 `ports/reply/returnValue` 属性缺失。
  2. `ssh.ts:9` `import('ssh2').PseudoTty` ——`@types/ssh2` 只有 `PseudoTtyOptions/PseudoTtyInfo`,没有 `PseudoTty` 类型,应改用 `ClientChannel`。
  3. `electron/preload/index.ts:30` `import('../src/types')` ——preload 位于 `electron/preload/`,`../src/types` 解析到 `electron/src/types`(不存在),应为 `'../../src/types'`。类型导入在 esbuild 转译时被擦除所以运行时无感,但 tsc 报错。
- **修复:** ① `isValidSender/getWin` 参数类型改为 `IpcMainEvent | IpcMainInvokeEvent`(两者都有 `sender`);② `PseudoTty` → `ClientChannel`;③ preload 路径改 `'../../src/types'`。修完跑 `npm run typecheck` 应全绿。

#### N3. H1 修复无效:privateKey 的 `~/.ssh` 校验被绝对路径绕过

- **位置:** `electron/main/ssh.ts` 第 47-53 行
- **严重度:** 高
- **问题描述:** 校验条件为 `if (!resolved.startsWith(path.resolve(sshDir)) && resolved !== keyPath)`。当渲染层传入**绝对路径**时(如 `C:\Windows\win.ini`),`path.resolve(keyPath) === keyPath`,第二个条件为 false,整个校验被跳过,`fs.readFileSync` 照常执行任意路径读取——与修复前无异,只是多了个「只允许 ~/.ssh」的错误提示(相对路径反而被拒)。该逻辑还把「限制」写成了「例外」。
- **复现:** 渲染层 DevTools 执行 `window.api.ssh.connect('x',{host:'h',username:'u',privateKey:'C:/Windows/win.ini'})`,校验不报错并尝试读取。
- **修复:** 改为 `if (!resolved.startsWith(path.resolve(sshDir) + path.sep)) throw new Error(...)`;或更稳妥——privateKey 路径改由主进程 dialog 选择后直接使用,不再接受渲染层传入路径。

### 🟡 中

#### N4. M1 未竟:连接状态仍为假

- **位置:** `src/components/StatusBar.vue`(`connected = computed(() => !!activeTab.value)`)
- **问题描述:** latency 已诚实化,但「已连接/连接中」仍只看有没有标签:SSH 断开、PTY 进程退出后状态栏依然绿点「已连接」。TerminalPane 收到 exit 事件时没有通知 StatusBar。
- **修复:** 用 Pinia 会话状态(主进程退出事件 → store 标记 exited),或 StatusBar 订阅 `ssh:exit`/`pty:exit`;cwd 同理建议用真实 pwd。

#### N5. 窗口控制 IPC 无 sender 校验(注释与实现不符)

- **位置:** `electron/main/index.ts` 第 54-60 行(注释写「只接受来自主窗口的调用」,但 `win:minimize/close/toggle-maximize` 三个 handler 无任何校验)
- **问题描述:** 风险低(关闭/最小化窗口无大危害),但与本轮「所有 IPC 校验 sender」的修复目标不一致,且 handler 在 `createWindow` 内注册,`activate` 重建窗口会重复注册监听器。
- **修复:** 统一走 `isValidSender`;监听器注册移到模块顶层一次。

#### N6. `createSshTab` 返回 null 未检查(上限时静默失败)

- **位置:** `src/components/Sidebar.vue`(`connectSsh`)、`src/components/ConnectDialog.vue`(`connect`)
- **问题描述:** M8 已让 `createLocalTab` 三处入口都检查 null,但两个 SSH 入口没检查——标签满 12 个时点「连接」无任何反馈(标签不创建、连接不发起、无 toast)。
- **修复:** 与 App.vue 同样处理 `const id = tabsStore.createSshTab(...); if (!id) { showToast('标签页已达上限'); return }`。

### 🟢 低

#### N7. sender 校验函数三份重复

- **位置:** `pty.ts` `isValidSender`、`ssh.ts` `isValidSender`、`store.ts` `isFromMainWindow` —— 同一逻辑复制三份。
- **修复:** 抽到 `electron/main/security.ts` 统一导出。

#### N8. safeStorage 降级明文未在文档说明

- **位置:** `electron/main/store.ts`(第 29-31 行,`isEncryptionAvailable()` 为 false 时明文存储);README 仅写「SSH 密码使用 safeStorage.encryptString() 加密存储」
- **问题描述:** Linux 无 keyring、部分环境 safeStorage 不可用时会静默降级明文,README 表述与行为不符,用户会误以为始终加密。
- **修复:** README 补充降级说明;或不可用时禁用「保存密码」选项。

#### N9. H2 残余毫秒级竞态(低概率)

- **位置:** `src/components/TerminalPane.vue` onUnmounted 仍先 `pause`(send)后 `removeListeners`;在 renderer 移除监听与主进程处理 pause 之间,16ms flush timer 若恰好触发,会向已无监听的 renderer send 一次(≤16ms 数据丢失)。概率低但存在。
- **修复:** onUnmounted 改为先 `removeListeners` 再 `pause`(一行顺序调整)。

#### N10. git 有 5 个文件未提交

- **位置:** 仓库当前 1 个提交(3ee424b),`git status` 显示 CODELY.md、store.ts、ConnectDialog.vue、Sidebar.vue、shortcuts.ts 未提交。
- **修复:** 修完上述问题后尽快提交,避免丢失。

---

## 四、当前剩余问题总览(按严重度)

| 严重度 | 编号 | 问题 | 工作量 |
|---|---|---|---|
| 🟠 高 | N1 | App.vue 导入不存在的 onKeyDown,构建/typecheck 失败 | 1 行 |
| 🟠 高 | N2 | typecheck:node 18 个 TS 错误(事件类型/PseudoTty/preload 路径) | 0.5 小时 |
| 🟠 高 | N3 | privateKey ~/.ssh 校验被绝对路径绕过(H1 修复无效) | 1 行 |
| 🟡 中 | M7 | sshHost 快捷指令路径残缺(上轮未修) | 0.5 天 |
| 🟡 中 | N4 | 状态栏连接状态仍为假 | 0.5 天 |
| 🟡 中 | N5 | win:* IPC 无 sender 校验 + 重复注册 | 0.5 小时 |
| 🟡 中 | N6 | createSshTab null 未检查,上限静默失败 | 15 分钟 |
| 🟢 低 | L4 | 无 lint/测试/CI(上轮未修) | 持续 |
| 🟢 低 | L5 | fontFamily/theme 设置未生效(部分修复) | 1 小时 |
| 🟢 低 | N7-N10 | 重复代码/文档降级说明/残余竞态/git 未提交 | 各 ≤30 分钟 |

**建议下一步:** 先修 N1+N2+N3(合计改动 20 行以内),跑 `npm run typecheck` 确认全绿,再提交;然后处理 M7/N4-N6;最后补 lint/测试。

---

## 五、验证记录

- `npm run typecheck:node`:**失败**,18 错误(pty.ts 4、ssh.ts 13、preload 1),证据见上文 N2
- `npm run typecheck:web`:**失败**,1 错误 `App.vue(28,41): TS2305 onKeyDown`,证据见上文 N1
- 已核对 `node_modules/vue/dist/vue.d.ts` 无 `onKeyDown` 导出
- 已核对 `node_modules/@types/ssh2/index.d.ts` 无 `PseudoTty` 导出(有 PseudoTtyOptions/PseudoTtyInfo)
- git 状态:1 提交 + 5 未提交文件
- 根目录残留文件(err*.txt 等)已清理,.gitignore 已更新 ✅
- 本报告为静态审查 + 类型检查,未运行项目、未安装依赖、未修改任何文件
