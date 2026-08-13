# ShellDesk 代码审查报告(第三轮)

- 审查时间:2026-08-13
- 审查对象:`E:\code\ai\shelldesk`(当前工作树,git 2 个提交 `3ee424b` / `a50948d`,working tree clean,44 个跟踪文件)
- 审查方式:静态代码审查 + `npm run typecheck`(node/web 双侧执行)+ git 提交核对;未修改任何文件
- 相对第二轮(`shelldesk-review-2026-08-12-r2.md`)的变化:新增提交 `a50948d`(终端配色柔和化、Ctrl+C 复制 / Ctrl+V 粘贴、右键粘贴、扫描线纹理等 UI 细节)

---

## 一、总体结论

**第二轮提出的两个构建阻断问题(N1、N2)一行未改,当前项目仍处于「dev 可跑、typecheck/build 必挂」状态。** 实测:

- `npm run typecheck:node`:**失败**,19 个错误(pty.ts 4 处、ssh.ts 14 处、preload 1 处)——与第二轮 N2 逐条一致。
- `npm run typecheck:web`:**失败**,`src/App.vue(28,41): TS2305 Module '"vue"' has no exported member 'onKeyDown'`——与第二轮 N1 一致。

最新提交 `a50948d` 只改动了 `TerminalPane.vue`(剪贴板/配色/扫描线)、`store.ts`(1 行)、`ConnectDialog.vue`(1 行)、`Sidebar.vue`(2 行)、`shortcuts.ts`(7 行)、`CODELY.md`、review 文档本身,没有触碰任何第二轮遗留问题。**第二轮 10 项新问题中 9 项未修,1 项(N10 未提交文件)已随提交解决。**

好消息:第一、二轮修复的大头(B1 密码加密、B2 StringDecoder、H1 sender 校验、H2 缓冲竞态、M3 单实例、M4 会话回收、M5 去重、M8 标签上限、M9 keepalive、CSP/本地字体、README/LICENSE/git)均已落地并提交,方向正确,无回退。

| 维度 | 第一轮 | 第二轮 | 本轮 | 说明 |
|---|---|---|---|---|
| 功能完整度 | 7 | 8 | 7.5 | 剪贴板/配色提升体验;但 SFTP 全程无 UI(空转 API)、sshHost 指令仍残缺 |
| 代码质量 | 6 | 5 | 5 | 类型检查失败依旧;新增本地分支无 `.catch`、连接期输入丢弃 |
| 安全性 | 4 | 6 | 6 | 加密+sender 校验在;privateKey 白名单仍可绕过、win IPC 仍未校验 |
| 工程化 | 3 | 6 | 6 | git/README/审查文档齐备;仍无 lint/test/CI,typecheck 未接入任何门禁 |
| 可维护性 | 5 | 5 | 5 | 结构清晰;N7 三份重复校验仍在,SFTP/SftpEntry 死代码 |

---

## 二、第二轮问题核对(10 项)

| 编号 | 问题 | 第二轮状态 | 本轮核对 |
|---|---|---|---|
| N1 | `App.vue` 导入不存在的 `onKeyDown` | 未修 | ❌ **未修**。`src/App.vue:28` 原样;`typecheck:web` 实测仍报 TS2305;该导入是死导入(实际用的是自定义 `onKeydown`,第 115 行),删掉即可 |
| N2 | `typecheck:node` 19 个 TS 错误 | 未修 | ❌ **未修**。实测 19 个错误,与上轮逐条一致(见第三节) |
| N3 | privateKey `~/.ssh` 校验被绝对路径绕过 | 未修 | ❌ **未修**。`ssh.ts:70-75` 逻辑原样:`resolved !== keyPath` 仍让绝对路径直接放行 |
| N4 | 状态栏连接状态仍为假 | 未修 | ❌ **未修**。`StatusBar.vue:35` `connected = !!activeTab`;且新增发现:Sidebar 的 SSH 主机条目 `.dot.on`(第 63 行)永远显示绿色「在线」脉冲,同样是假状态 |
| N5 | `win:*` IPC 无 sender 校验 + `createWindow` 内重复注册 | 未修 | ❌ **未修**。`index.ts:70-76` 原样;macOS `activate` 重建窗口会叠加监听器 |
| N6 | `createSshTab` 返回 null 未检查 | 未修 | ❌ **未修**。`Sidebar.vue:263-266` 与 `ConnectDialog.vue:104` 均未检查,标签满 12 个时静默失败 |
| N7 | sender 校验函数三份重复 | 未修 | ❌ **未修**。`pty.ts`/`ssh.ts`/`store.ts` 各一份 |
| N8 | safeStorage 降级明文未文档化 | 未修 | ❌ **未修**。`store.ts:37` 降级路径仍在,README 仍宣称「加密存储」 |
| N9 | onUnmounted 顺序(先 pause 后 removeListeners) | 未修 | ❌ **未修**。`TerminalPane.vue:194-199` 仍先 `pause` 再 `removeListeners`,毫秒级竞态保留 |
| N10 | git 有 5 个文件未提交 | 未修 | ✅ **已解决**。working tree clean,全部已提交 |

**统计:10 项中 1 项随提交自然解决,9 项原样保留。**

---

## 三、当前阻塞问题(不修则无法交付)

### 🔴 B1. `npm run typecheck` 全挂,`npm run build` 必失败(即 N1+N2)

- **位置:** `src/App.vue:28`;`electron/main/pty.ts:27`(及 58/77/127/157 调用点);`electron/main/ssh.ts:29`(及全部 12 处 handle 调用点)、`ssh.ts:9`;`electron/preload/index.ts:30`
- **实测证据:**
  - `typecheck:web`:`TS2305 onKeyDown`(1 错误)
  - `typecheck:node`:`TS2345 IpcMainInvokeEvent → IpcMainEvent`(pty.ts 4 + ssh.ts 12 处)、`TS2694 ssh2 无 PseudoTty 导出`(ssh.ts:9)、`TS2307 找不到模块 ../src/types`(preload:30),共 19 错误
- **影响:** `npm run build` 在渲染层 Rollup 阶段会因 `onKeyDown` 未导出直接中断;`npm run package:win` 同样失败。dev 模式(esbuild 不校验导出)能跑,所以长期未被发现。
- **修复(合计约 20 行,30 分钟内):**
  1. `App.vue:28` 删掉 `onKeyDown`;
  2. `pty.ts`/`ssh.ts` 的 `isValidSender`、`getWin` 参数类型改为 `IpcMainEvent | IpcMainInvokeEvent`(两者都有 `sender`);
  3. `ssh.ts:9` `PseudoTty` → `import('ssh2').ClientChannel`;
  4. `preload/index.ts:30` `'../src/types'` → `'../../src/types'`。

### 🔴 B2. privateKey 白名单仍可被绝对路径绕过(即 N3)

- **位置:** `electron/main/ssh.ts:70-75`
- **现状:** `if (!resolved.startsWith(path.resolve(sshDir)) && resolved !== keyPath) throw ...`。渲染层传绝对路径(如 `C:\Windows\win.ini`)时 `path.resolve(keyPath) === keyPath`,第二个条件为假 → 整条校验短路 → `readFileSync` 任意路径读取照常执行;相对路径反而被拒。这是把「限制」写成了「例外」,等于 H1 修复无效。
- **修复:** 改为 `if (!resolved.startsWith(path.resolve(sshDir) + path.sep)) throw new Error(...)`;更稳妥的是完全由主进程 `dialog` 选择私钥后回填路径,不再接受渲染层传参。

---

## 四、🟠 高优先级遗留(安全/功能)

#### H1. `win:*` IPC 无校验 + `createWindow` 内重复注册(即 N5)
`index.ts:70-76` 三个 handler 注释写着「只接受来自主窗口的调用」但没有一行校验;且注册在 `createWindow` 内,macOS `activate` 重建窗口会叠加监听。修复:统一走 `isValidSender`,注册移到顶层一次。

#### H2. sshHost 快捷指令路径残缺(即 M7,两轮未修)
`App.vue:64-89`:`newTab` 分支永远 `createLocalTab`(本地标签),`shortcut.sshHost` 被忽略;非新标签分支若当前标签不是 SSH 会话,`ssh:exec` 对不存在 session 静默 no-op,用户零反馈。建议:按 `sshHost` 匹配已有 SSH 标签并切换;找不到则 toast「未找到 SSH 会话」;或删掉该字段。

#### H3. 状态栏/侧边栏「连接状态」全为假(即 N4 + 新发现)
- `StatusBar.vue:35`:`connected = !!activeTab`,SSH 断开/PTY 退出后仍显示绿点「已连接」;
- `Sidebar.vue:63`:保存的 SSH 主机列表条目 `.dot.on` 无条件显示绿色脉冲「在线」,与实际连接无关;
- `Sidebar.vue:239`:`sessionCount` 实为标签数,不是会话数。
建议:主进程退出事件 → store 标记 exited → 状态栏/侧边栏订阅;无真实数据一律显示「—」。

---

## 五、🟡 中优先级(含本轮新发现)

#### M1. TerminalPane 本地分支无 `.catch`(新)
`TerminalPane.vue:136-150`:`pty.create(...).then(...).then(...)` 链没有 catch。`pty:create` 抛错时(如 shell 白名单拒绝、pwsh 未安装导致 `pty.spawn` 失败)渲染层出现 Unhandled rejection,用户无任何提示。SSH 分支(159-165)有 catch,行为不一致。另建议:pwsh 缺失时主进程回退 `powershell.exe` 或返回明确错误。

#### M2. SSH 连接期间输入被静默丢弃(新)
`TerminalPane.vue:160-161` 发起 `ssh:connect`(最长 15s readyTimeout)期间,用户输入走 `ssh:write` → `sessions.get(id)?.stream?.write` 对未创建 stream 静默丢弃。建议在渲染层做输入队列,stream 就绪后回放。

#### M3. `ssh:error` / `ssh:closed` 事件渲染层无监听(新)
preload 暴露了 `onError`/`onClosed`(`preload/index.ts:48-51`),但 `TerminalPane.vue:125-131` 只注册了 `onData`/`onExit`。连接建立后的错误(keepalive 失败、服务端主动断开)详细信息丢失,只剩「连接已断开」字样。建议注册并展示错误详情。

#### M4. SFTP 是空转 API,无任何 UI(新)
主进程(`ssh.ts:244-337`)与 preload(`preload/index.ts:65-78`)完整实现了 sftp:open/readdir/download/upload/delete/mkdir,`types/index.ts:57-69` 定义了 `SftpEntry`,但**渲染层没有任何组件调用它们**——README 宣称的「SFTP」功能实际不可达,属「提示了功能但未实现」的典型项。二选一:补 SFTP 面板(工作量 1-2 天),或从 README/文档中撤下该特性声明。

#### M5. 保存主机时已存在条目不更新配置(新)
`ConnectDialog.vue:107-125`:去重只做「跳过已存在」,用户改了密码/私钥后重连并保存,列表仍是旧值,下次连接会失败或连错机器。建议已存在时更新该条目配置(密码重新加密)。

#### M6. 设置项仍未生效(即 L5)
`TerminalPane.vue:30-31` `fontSize: 13`、`fontFamily` 硬编码;`theme` 也硬编码。StatusBar 已从 settings 读字号,但终端本体不读;UI 上齿轮按钮仍是「设置功能开发中…」,settings 只能写 API 无入口。建议 TerminalPane 读 `store:settings:get` 并订阅变更重建 xterm。

---

## 六、🟢 低级(沿用 + 新)

- **L1.** sender 校验三份重复(N7)——抽 `electron/main/security.ts`。
- **L2.** safeStorage 降级明文未文档化(N8)——README 补说明,或不可用时禁用「保存密码」。
- **L3.** `TerminalPane.vue:194-199` onUnmounted 顺序(N9)——先 `removeListeners` 再 `pause`。
- **L4.** 快捷指令保存 fire-and-forget(新)——`shortcuts.ts:28-52` `add/update/remove` 不 await `saveShortcuts`,快速连续编辑可能丢更新;建议串行化或 debounce。
- **L5.** 无 lint/test/CI(L4,两轮未修)——至少在 git 提交前接入 `npm run typecheck`(两次提交都带着编译错误入库,正是没有门禁的后果);加 eslint 与最小 node:test 冒烟。
- **L6.** `asar: false` + `npmRebuild: false`(`electron-builder.yml`)——正式分发前需改 `asar: true` + `asarUnpack` native 模块。
- **L7.** `connectSsh` 从列表连接时未区分密码/密钥场景、无端口校验(新)——`ConnectDialog` 对 port 无范围校验(0/65535+ 直接透传给 ssh2)。

---

## 七、修复路线建议

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **P0(立即,30 分钟)** | B1:删 `onKeyDown`、事件类型改联合、`PseudoTty→ClientChannel`、preload 路径;跑 `npm run typecheck` 确认全绿;B2:privateKey 校验加 `path.sep` 或改 dialog 选路径 | ~20 行 |
| **P1(本周)** | H1 win IPC 校验、H2 sshHost 语义、H3 真实连接状态、M1 补 catch、M3 注册 error/closed | 0.5-1 天 |
| **P2(两周内)** | M2 输入队列、M4 SFTP 面板或撤宣传、M5 更新主机配置、M6 设置接入 TerminalPane | 2-3 天 |
| **P3(持续)** | L1-L7;lint/test/CI;提交前 typecheck 门禁;asar 正确化 | 持续 |

---

## 八、验证记录

- `npm run typecheck:node`:**失败**,19 错误(pty.ts 4、ssh.ts 13、preload 1),证据见第三节
- `npm run typecheck:web`:**失败**,1 错误 `App.vue(28,41) TS2305 onKeyDown`
- `npm run build` 在本沙箱环境因 esbuild 子进程管道被 EPERM 拦截无法执行;但 `typecheck:web` 的 `onKeyDown` 错误即为渲染层 Rollup 的必挂点,结论不受影响
- git:2 提交,working tree clean;`a50948d` 仅 UI 细节,未触碰任何遗留问题
- 本报告为静态审查 + 类型检查,未运行项目、未修改任何文件
