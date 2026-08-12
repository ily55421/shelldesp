# ShellDesk 项目代码审查报告

- 审查时间:2026-08-12
- 审查对象:`E:\code\ai\shelldesk`(ShellDesk v1.0.0,Electron 33 + Vue 3 + Vite 5 终端管理桌面应用)
- 审查方式:静态代码审查(未运行项目、未修改任何文件)
- 覆盖范围:主进程 4 文件、preload 1 文件、渲染层 12 文件、构建/打包配置 4 文件,合计 18 个 TS/Vue 源文件约 2954 行

---

## 一、总体评价与健康度摘要

ShellDesk 是一个功能完整的 Electron 终端应用:本地 PTY(xterm.js + node-pty)、SSH/SFTP(ssh2)、多标签、快捷指令、自定义无边框标题栏均已实现,主进程/渲染进程分层清晰,`contextIsolation: true` + `nodeIntegration: false` 的基础隔离配置正确,标签切换采用「主进程保活 + 缓冲」的设计在思路上是合理的。

但项目整体处于「可运行的 MVP 原型」阶段,距离可交付/可维护的成品还有明显差距:**无版本控制、无文档、无测试、无 lint**;存在 2 个阻塞级问题(SSH 凭据明文落盘、SSH 中文输出乱码)和 1 个高危安全面(IPC 无 sender 校验 + 任意文件读取);UI 层存在若干「提示了功能但未实现」或「展示假数据」的情况(快捷键、状态栏)。

### 健康度评分(满分 10)

| 维度 | 评分 | 说明 |
|---|---|---|
| 功能完整度 | 7 | 核心功能齐全,但快捷键/状态栏/设置项多处未落地 |
| 代码质量 | 6 | 结构清晰,但存在竞态、泄漏、硬编码假数据 |
| 安全性 | 4 | 凭据明文存储、IPC 无校验、无 CSP,基础隔离正确但纵深不足 |
| 工程化 | 3 | 无 git、无 README、无测试/lint/CI,调试文件残留 |
| 可维护性 | 5 | 单文件 Sidebar.vue 691 行,无注释规范,无类型复用 |

**最关键发现(按处理优先级):**

1. **SSH 密码明文写入 `config.json`**(`store.ts` + `ConnectDialog.vue`)——所有保存的连接密码以明文落盘,任何能读取用户目录的程序均可窃取。
2. **SSH 输出按 TCP chunk 直接 `toString('utf-8')`**(`ssh.ts`)——中文/emoji 等多字节字符跨 chunk 时必现乱码,这是中文用户最高频场景。
3. **全部 IPC 无 sender 校验 + 私钥路径参数导致主进程可被要求读取任意文件**(`pty.ts`/`ssh.ts`/`index.ts`)——一旦渲染进程被注入(无 CSP 防御),等于获得本机任意命令执行与任意文件读取能力。
4. **项目无 `.git` 目录、无 README**,根目录残留 5 个调试输出文件(`err.txt`、`err2.txt`、`out.txt`、`out2.txt`、`stderr.txt`)及 `mem-log/`(141KB)、`.codely/`(约 500KB 截图)等 AI 工具产物,均未被 `.gitignore` 覆盖。

---

## 二、问题清单(按严重程度分级)

### 🔴 阻塞级(2 项)—— 影响安全或核心功能正确性,必须优先修复

#### B1. SSH 密码/密钥材料明文持久化

- **位置:** `electron/main/store.ts`(`sshHosts` 存储)+ `src/components/ConnectDialog.vue`(第 109-118 行,保存 `config` 含 `password`)
- **严重度:** 阻塞
- **问题描述:** `ConnectDialog.vue` 在「保存此连接到列表」时将完整 `SshConfig`(含明文 `password`)经 `store:sshHosts:set` 写入 `electron-store` 的 `config.json`。`electron-store` 默认不加密,文件位于 `%APPDATA%/shelldesk/config/config.json`。任何能读取该用户目录的进程、备份或同步工具都能直接拿到所有服务器的明文密码。
- **复现路径:** 连接 SSH → 勾选保存 → 打开 `config.json` → 可见 `"password": "xxxxxx"`。
- **修复建议:** ① 用 `safeStorage.encryptString()` 加密密码后落盘,读取时解密;② 或改用 `electron-store` 的 `encryptionKey`(基于 `safeStorage` 派生);③ 更稳妥的做法是默认不保存密码,只保存主机/用户名/私钥路径,连接时询问;④ 若保存,在 UI 中明确提示「密码将加密保存在本机」。

#### B2. SSH 输出多字节字符乱码(UTF-8 截断)

- **位置:** `electron/main/ssh.ts` 第 110-117 行(stdout `stream.on('data')`)、第 139-146 行(stderr `stream.stderr.on('data')`)
- **严重度:** 阻塞
- **问题描述:** `data` 是 TCP 分包后的 `Buffer`,直接 `data.toString('utf-8')` 转换。一个多字节 UTF-8 字符(中文、emoji)被 TCP 拆到两个 chunk 时,前一个 chunk 的半个字符会被转成 `�` 乱码,后续字节错位可能污染整行输出。SSH 会话中 `ls`、`cat`、`vim` 等任何输出中文的场景都会出现。
- **复现路径:** SSH 连接到输出中文的 Linux 主机(如 `locale` 为 zh_CN 的环境),执行 `ls` 查看含中文文件名的目录,观察乱码。
- **修复建议:** 使用 Node 内置 `string_decoder.StringDecoder('utf-8')` 对每个 chunk 先 `decoder.write(data)` 再拼接;PTY 侧(`pty.ts`)因为 `node-pty` 的 `onData` 已按字符串交付,不受影响,但建议同样走 StringDecoder 统一处理。

### 🟠 高级(5 项)—— 安全风险或明显功能缺陷,应尽快处理

#### H1. 全部 IPC 无 sender 校验,privateKey 参数可触发任意文件读取

- **位置:** `electron/main/pty.ts`、`electron/main/ssh.ts`(全部 handler)、`electron/main/index.ts`(第 45 行 `sandbox: false`)
- **严重度:** 高
- **问题描述:** ① 所有 `ipcMain.on/handle` 未校验 `event.sender` 是否为本应用主窗口的 WebContents;② `ssh:connect` 的 `config.privateKey` 由渲染进程传路径,主进程直接 `fs.readFileSync(config.privateKey)`——恶意/被注入的渲染代码可让主进程读取任意路径文件;③ 配合 `pty:create`(任意 `shell` 路径)+ `pty:write`,渲染进程被攻破即等于本机任意命令执行。当前无 CSP(`index.html` 无 `Content-Security-Policy`)、`sandbox: false`、preload 暴露了全部能力,纵深防御为零。
- **复现路径:** 在渲染进程 DevTools 执行 `window.api.ssh.connect('x', { host:'h', username:'u', privateKey:'C:/Windows/win.ini' })` 观察错误回显;或 `window.api.pty.create('x', { shell: 'cmd.exe' })` 后写入命令。
- **修复建议:** ① 在 IPC handler 中校验 `BrowserWindow.fromWebContents(e.sender)` 是否为 `mainWindow`,不是则拒绝;② `privateKey` 改为不接收路径:由主进程 `dialog.showOpenDialogSync` 选择,或只允许读取用户 `.ssh` 目录下的路径;③ `index.html` 增加 CSP;④ 评估恢复 `sandbox: true`(preload 需相应改造);⑤ 限制 `pty:create` 的 `shell` 参数为白名单(`pwsh.exe`/`cmd.exe`/`powershell.exe`)。

#### H2. 标签切换时丢失最后一批输出(竞态)

- **位置:** `src/components/TerminalPane.vue` 第 155-168 行(`onUnmounted`,pause 调用在 156/159 行);`electron/main/pty.ts` 第 121-129 行(`pty:pause`)、`electron/main/ssh.ts` 第 158-166 行(`ssh:pause`)
- **严重度:** 高
- **问题描述:** `onUnmounted` 先 `send('pty:pause')`(异步 IPC)再同步 `removeAllListeners`。主进程收到 pause 后会把残留 buffer **先发送**给渲染层再置 `paused=true`;此时渲染层监听器已移除,这批数据无人接收直接丢失(且不会进入 `pausedBuffer`,切换回来后也不可恢复)。SSH 路径同样存在。用户切换标签会丢失最近 16ms 累积的输出(命令回显、程序提示等)。
- **复现路径:** 终端里运行持续输出的程序(如 `ping -t`),快速切走标签再切回,对比输出连续性。
- **修复建议:** 调整顺序——先 `removeListeners`,再 `pause`;或将 pause 改为 `invoke` 并在主进程 flush 完成后再返回;或在主进程 pause 时若检测到 renderer 已无监听(不可行),更简单方案:flush 的残留数据写入 `pausedBuffer` 而非直接 send。

#### H3. 项目无版本控制、无 README、无许可证落地

- **位置:** 项目根目录(无 `.git/`、无 `README.md`)
- **严重度:** 高
- **问题描述:** `package.json` 声明了 `license: MIT` 但仓库未初始化 git;无 README 说明架构、开发命令、打包方式;无 `.gitignore` 之外的工程约束。代码无法回滚、无法协作、无法追溯引入问题的提交。
- **修复建议:** `git init` 并提交基线;补 README(开发环境要求、`npm run dev/build/typecheck/package:win` 用法、目录结构说明);确认 LICENSE 文件;`.gitignore` 补充下文 H4 的条目。

#### H4. 调试与临时文件残留根目录且未纳入忽略规则

- **位置:** 根目录 `err.txt`(114B)、`err2.txt`(2.9KB)、`out.txt`、`out2.txt`、`stderr.txt`;`mem-log/mem-2026-08-12.log`(141KB);`.codely/`(约 500KB 截图与剪贴板);`.codely-cli/`
- **严重度:** 高
- **问题描述:** 这些是开发调试/编码助手产生的过程文件,直接堆积在项目根目录。若纳入版本控制会污染仓库、泄露屏幕截图等敏感信息;当前即使不提交,也干扰项目清洁度与工具扫描。
- **复现路径:** `dir` 根目录即可见。
- **修复建议:** 删除上述文件(或移入 `tools/tmp`);`.gitignore` 增加:`err*.txt`、`out*.txt`、`stderr.txt`、`mem-log/`、`.codely/`、`.codely-cli/`、`*.log`。

#### H5. 无 CSP + 远程 Google Fonts + 关闭 sandbox 的安全基线缺失

- **位置:** `src/index.html`(无 CSP;第 7-14 行加载 `fonts.googleapis.com`);`electron/main/index.ts`(第 45 行 `sandbox: false`)
- **严重度:** 高
- **问题描述:** ① 渲染进程无 `Content-Security-Policy`,一旦出现 XSS(如未来渲染远程 HTML)没有任何缓解;② 字体依赖 Google Fonts 远程加载:离线/内网环境字体失效,且每次启动产生外网请求(隐私与稳定性);③ `sandbox: false` 使 preload 拥有完整 Node 能力,叠加无 CSP,渲染层被攻破后果严重。
- **修复建议:** ① 增加 CSP meta(如 `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'`);② 字体改为本地打包(`assets/fonts/`),移除远程 `preconnect/link`;③ 研究恢复 `sandbox: true` 的可行性。

### 🟡 中级(9 项)—— 功能缺陷或体验问题,建议近期修复

#### M1. 状态栏展示硬编码/推断的假数据

- **位置:** `src/components/StatusBar.vue`(`connected` 仅判断 `!!activeTab`;第 46-47 行 `fontSize = 13`、`latency = 12` 硬编码;`cwd` 用 `tab.cwd` 而非真实目录;`shellLabel` 靠 `includes('pwsh')` 猜测)
- **严重度:** 中
- **问题描述:** 「已连接」「12ms」「UTF-8」「CRLF」等均为写死的展示值,不代表真实状态。用户会据此误判连接质量与当前目录;「未连接」状态在无标签时也不准确(标签存在即显示已连接,即使 SSH 实际断开)。
- **修复建议:** 从主进程真实采集:PTY 启动时用 `cwd` 回调、SSH 用 `exec('pwd')` 或维护会话状态;latency 可在 `ssh:shell` 建立后用定时 echo 测量;无真实数据时应显示「—」而不是编造值。

#### M2. Ctrl+T / Ctrl+D 快捷键提示存在但未实现

- **位置:** `src/components/TabBar.vue`(第 24 行「新建标签 (Ctrl+T)」)、`src/components/Sidebar.vue`(第 9 行「添加常用目录 (Ctrl+D)」);全项目无 `keydown` 监听
- **严重度:** 中
- **问题描述:** UI 明示的快捷键无任何实现;Ctrl+T 在部分系统上可能触发浏览器默认行为。用户按提示操作无效,属于「提示了未实现的功能」。
- **修复建议:** 在 `App.vue` 增加全局 `keydown` 监听(Ctrl+T 新建标签、Ctrl+D 打开路径对话框、Ctrl+W 关闭标签),或移除提示文案。

#### M3. 无单实例锁,且启动时强删锁文件

- **位置:** `electron/main/index.ts` 第 13-22 行(`cleanStaleLocks` 删除 `SingletonLock/SingletonSocket/DevToolsActivePort`);无 `app.requestSingleInstanceLock()`
- **严重度:** 中
- **问题描述:** ① 未请求单实例锁,多开时多个实例同时读写同一个 `electron-store` 文件,配置互相覆盖;② `cleanStaleLocks` 无条件删除锁文件——若另一实例正在运行,删除其 `SingletonLock` 会让两个实例并存且 Chromium 缓存/GPU 进程行为异常。
- **复现路径:** 启动两个 ShellDesk 实例,分别添加不同快捷指令,观察配置互相覆盖。
- **修复建议:** `app.requestSingleInstanceLock()`,拿不到锁则 `app.quit()` 并 focus 已有窗口;`cleanStaleLocks` 仅在确认无其他实例时执行(拿到锁之后)。

#### M4. 后台退出会话泄漏,Map 条目不回收

- **位置:** `electron/main/pty.ts` 第 97-110 行(`ptyProcess.onExit`,仅活跃会话 `sessions.delete`);`electron/main/ssh.ts` 第 122-136 行(`stream.on('close')`,同理)
- **严重度:** 中
- **问题描述:** 标签切到后台后进程/连接退出时,会话被保留在 `sessions` Map 中(设计上为 resume 返回 `exited: true`),但**没有任何路径删除该条目**——用户 resume 看到「已退出」提示后,条目仍永久留存,直至应用退出。反复切换 + 后台退出可累积数十个僵尸条目(含已死的 PTY 进程句柄、SSH client 对象)。
- **复现路径:** 开标签 → 切走 → 终端内 `exit` → 切回(显示已退出)→ 反复多次,主进程 `sessions` Map 持续增长。
- **修复建议:** resume 返回 `exited: true` 后,渲染层应调用 kill/disconnect 清理;或主进程在 resume 检测到 exited 时直接 `sessions.delete(id)` 后再返回。

#### M5. SSH 主机列表保存无去重

- **位置:** `src/components/ConnectDialog.vue` 第 109-118 行(每次 `push` 新条目)
- **严重度:** 中
- **问题描述:** 同一主机重复连接并勾选保存,列表不断累积重复条目;`ssh-hosts-updated` 事件刷新后侧边栏越来越长,无编辑入口(右键只能删除)。
- **修复建议:** 保存前按 `host:port:username` 去重(更新已有条目);补编辑功能;删除时确认。

#### M6. 自定义窗口按钮与 titleBarOverlay 可能重叠

- **位置:** `electron/main/index.ts` 第 34-39 行(`titleBarStyle: 'hidden'` + `titleBarOverlay` 同时配置);`src/components/TitleBar.vue` 第 7-18 行(自定义 `.win-controls` 按钮)
- **严重度:** 中(需运行确认)
- **问题描述:** `titleBarOverlay` 会在 Windows 上绘制**系统原生**窗口控制按钮(占用右侧固定区域),而 `TitleBar.vue` 又渲染了自定义最小化/最大化/关闭按钮——两者可能在同一区域重叠,出现「两套按钮」或点击错位。这是该配置组合的典型陷阱。
- **修复建议:** 二选一:移除 `titleBarOverlay`,完全使用自定义按钮(推荐,样式统一);或保留 overlay 并移除自定义 `.win-controls`,用 `-webkit-app-region` 区域避开系统按钮区。运行时截图确认后再定。

#### M7. 快捷指令的「SSH 上执行」路径残缺

- **位置:** `src/App.vue` 第 73-95 行(`handleExecute`);`src/types/index.ts`(`sshHost` 字段)
- **严重度:** 中
- **问题描述:** `ShortcutCommand.sshHost` 存在且 `isSsh = !!shortcut.sshHost`,但 `newTab` 分支永远 `createLocalTab`(本地标签);对已有标签执行时若当前标签不是该 SSH 会话,`ssh:exec` 目标 session 不存在,主进程静默丢弃(`ssh:exec` handler 第 196-198 行,`sessions.get(id)?.stream?.write` 对不存在会话静默失败),用户无任何反馈。
- **修复建议:** 明确语义:按 `sshHost` 匹配已存在 SSH 标签并切换过去执行;若不存在则提示「未找到 SSH 会话」;或移除该字段避免误导。

#### M8. 新建标签无上限检查

- **位置:** `src/components/TabBar.vue`(第 122-126 行 `newLocal`)、`src/components/Sidebar.vue`(第 255-258 行 `newLocalTab`、第 142-145 行 `connectSsh`)
- **严重度:** 中
- **问题描述:** `App.vue` 的 `handleExecute` 检查了 `MAX_TABS = 12`,但 TabBar 与 Sidebar 的入口不检查。每个标签对应一个常驻 PTY 进程/SSH 连接,无限新建会耗尽系统资源(进程数、文件句柄)。
- **修复建议:** 上限检查收敛到 `tabsStore.createLocalTab/createSshTab` 内部(统一返回失败并 toast),而不是散落在各调用点。

#### M9. SSH 无 keepalive,空闲连接易被断开

- **位置:** `electron/main/ssh.ts` 第 67 行(`connectConfig` 仅设 `readyTimeout: 15000`)
- **严重度:** 中
- **问题描述:** 未设置 `keepaliveInterval`/`keepaliveCountMax`。经过 NAT/防火墙(家用路由、云厂商安全组)的 SSH 空闲一段时间(通常 1-30 分钟)后被静默掐断,用户回到终端才发现已断开,且无自动重连。
- **修复建议:** 设置 `keepaliveInterval: 10000`、`keepaliveCountMax: 3`;断线后渲染层提示并提供「重连」操作。

### 🟢 低级(6 项)—— 整洁度与细节,有空再处理

#### L1. 混用 import 与 require

- **位置:** `electron/main/store.ts` 第 61 行(`const { dialog } = require('electron')`)
- **修复建议:** 统一为顶部 `import { dialog } from 'electron'`,与同文件其余代码一致。

#### L2. SFTP 删除非空目录直接失败

- **位置:** `electron/main/ssh.ts` 第 268-274 行(`sftp:delete` 对目录仅 `rmdir`)
- **修复建议:** 提供递归删除(先 `readdir` 递归清理),或明确报错并提示先清空目录。

#### L3. 私钥选择器误用目录对话框

- **位置:** `src/components/ConnectDialog.vue` 第 36-42 行(`pickKeyFile` 调用 `store.pickDirectory`)
- **修复建议:** 新增 `store.pickFile`(主进程 `dialog.showOpenDialogSync({ properties: ['openFile'] })`),选择实际私钥文件。

#### L4. 工程化空白:无 lint、无测试、无 CI,typecheck 未接入

- **位置:** `package.json`(scripts)
- **修复建议:** 加 `eslint` + `vue-tsc` 到 `dev`/`pre-commit`;补最小冒烟测试(主进程会话管理可用 node:test);CI(Windows runner)跑 `typecheck + build`。

#### L5. 设置项未生效

- **位置:** `src/components/TerminalPane.vue` 第 29 行(`fontSize: 13` 硬编码);`electron/main/store.ts`(`settings.fontSize/fontFamily/theme` 已存储)
- **修复建议:** 创建 Terminal 时读取 `store:settings:get`,订阅变更后重建 xterm。

#### L6. uncaughtException 监听器重复注册

- **位置:** `electron/main/index.ts` 第 74-77 行(在 `createWindow` 内注册)
- **修复建议:** 移到模块顶层一次性注册(注意:该 handler 目前只打印不退出,进程可能带病运行,建议记录完整堆栈并考虑是否 `app.exit`)。

---

## 三、修复优先级路线图

| 阶段 | 范围 | 预计工作量 |
|---|---|---|
| **P0(立即)** | B1 凭据加密、B2 StringDecoder、H1 IPC sender 校验 + privateKey 改造 | 0.5-1 天 |
| **P1(本周)** | H2 切标签竞态、H3 git init + README、H4 清理残留、H5 CSP + 本地字体 | 1 天 |
| **P2(两周内)** | M1-M9 全部功能缺陷(状态栏真实化、快捷键、单实例、会话回收、去重、上限、keepalive、titleBar 二选一) | 2-3 天 |
| **P3(后续)** | L1-L6 整洁度;补充 lint/测试/CI;`asar: true` + `npmRebuild` 正确化以支持正式分发 | 持续 |

---

## 四、附加说明

- **`asar: false` + `npmRebuild: false`(`electron-builder.yml`)**:为规避 `@homebridge/node-pty-prebuilt-multiarch` 在 ASAR 中的路径解析问题而设(见 `CODELY.md` 记录)。代价是打包产物全部源码明文、无法增量更新;正式分发前应改为 `asar: true` 并用 `asarUnpack` 只解包 native 模块,`npmRebuild` 开启或提供各平台预编译产物。
- **架构亮点(建议保留)**:主进程持有会话 + 16ms 批量 flush + 512KB 上限的 pausedBuffer、`create` 幂等 + `resume` 回放缓冲的设计是正确且可扩展的,修复上述竞态后即为可靠的会话生命周期模型。
- **字体与主题**:琥珀荧光主题与 `IBM Plex Mono` 组合观感一致,但依赖远程字体;本地化后体验更稳定。
- 本报告未运行项目、未执行任何构建/测试;所有问题均基于静态代码阅读,标注「需运行确认」的条目建议在实际环境中复核。
