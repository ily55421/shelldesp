# ShellDesk 代码审查报告(第五轮 · 修复验证)

- 审查时间:2026-08-13
- 审查对象:`E:\code\ai\shelldesp` 当前工作树(2 提交 + 12 个未提交修改文件 + 3 个未提交文档)
- 审查方式:全量 diff 核对 + `npm run typecheck`(node/web 双侧)实测 + 静态代码阅读;未修改任何文件
- 背景:第三轮(`shelldesk-review-2026-08-13.md`)/第四轮(`shelldesk-review-2026-08-13-r2.md`)提出 2 阻断 + 3 高 + 6 中 + 7 低;本轮验证修复结果

---

## 一、总体结论

**上一轮全部阻断项与大部分高中级问题已修复,`npm run typecheck` 双侧实测全绿。** 本轮修复质量整体很高,方向正确,且没有引入大的新问题;仅发现 3 个由本次修复**连带产生的小缺陷**(重复消息/状态未复位),均为 10 行内的收尾问题。

实测:

- `npm run typecheck:node`:**通过**(0 错误)
- `npm run typecheck:web`:**通过**(0 错误)

| 维度 | 第四轮 | 本轮 | 变化与依据 |
|---|---|---|---|
| 功能完整度 | 7.5 | 8 | sshHost 指令、真实连接状态、断连详情、输入缓冲全部落地 |
| 代码质量 | 5 | 6.5 | 类型全绿;但新增 SSH 重复消息、本地状态未复位 2 处小缺陷 |
| 安全性 | 6 | 7 | privateKey 白名单修复生效;win IPC 补校验 |
| 工程化 | 6 | 6 | 仍无 lint/test/CI,修复未提交(应尽快 commit) |
| 可维护性 | 5 | 5.5 | L1 三份校验重复仍在;SFTP 死代码未清理 |

---

## 二、修复核对(第三/四轮问题逐项)

### ✅ 已修复(12 项)

| 编号 | 问题 | 修复证据 |
|---|---|---|
| B1(N1+N2) | typecheck 全挂(20 错误) | `App.vue` 删 `onKeyDown`;`pty.ts`/`ssh.ts` 事件类型改 `IpcMainEvent \| IpcMainInvokeEvent`;`PseudoTty → ClientChannel`;preload 路径 `'../../src/types'`。实测双侧 0 错误 |
| B2(N3) | privateKey 白名单绕过 | `ssh.ts:73` 改为 `!resolved.startsWith(path.resolve(sshDir) + path.sep)`。绝对路径不再短路放行;`~/.ssh2` 这类前缀攻击也被 `path.sep` 封死 |
| H1(N5) | `win:*` IPC 无校验+重复注册 | `index.ts` 顶层注册一次 + `isValidWinSender`(注释与实现一致) |
| H2(M7) | sshHost 快捷指令残缺 | `App.vue` 新增分支:按 host 匹配 SSH 标签→激活→执行;未找到 toast 提示 |
| H3(N4) | 状态栏/侧边栏假连接 | `Tab.status`('connecting'/'connected'/'disconnected')贯通:`tabs.ts` 初始化 + `updateStatus`;StatusBar 读真实状态;Sidebar `.dot.on` 按真实连接;`sessionCount` 统计真实活动会话 |
| M1 | 本地分支无 `.catch` | `TerminalPane` 补 catch,失败写红色提示 + 状态置 disconnected |
| M2 | SSH 连接期输入丢弃 | `sshReady` + `inputBuffer`,connect+shell 完成后回放 |
| M3 | error/closed 无监听 | 注册 `onError`/`onClosed`,展示错误详情与断开提示(见 A1/A2 缺陷) |
| M4 | SFTP 无 UI | 已采取「撤宣传」方案:README 移除 SFTP 声明;但主进程/preload/types 的 ~90 行 SFTP 代码仍保留(建议移入 v1.3 里程碑或清理,见 §四) |
| M5 | 保存主机不更新配置 | `ConnectDialog` 改为「已存在则更新 config+name,否则新增」 |
| N9 | onUnmounted 顺序 | 改为先 `removeListeners` 再 `pause` |
| N10 | git 未提交 | 本轮修复全部已改在磁盘,但**尚未提交**(见 §五) |

### ⚠️ 部分处理(1 项)

| 编号 | 问题 | 现状 |
|---|---|---|
| M6 | 设置项未生效 | TerminalPane `fontSize/fontFamily/theme` 仍硬编码(`TerminalPane.vue:29-31`);齿轮按钮仍是「设置功能开发中…」。StatusBar 虽读字号但终端本体不读。**未修,建议排入 v1.2 设置面板** |

### ❌ 未修复(7 项,均低优先级)

| 编号 | 问题 |
|---|---|
| L1 | sender 校验三份重复(pty/ssh/store)→ 抽 `security.ts` |
| L2 | safeStorage 降级明文未在 README 文档化 |
| L4 | `shortcuts.ts` add/update/remove 不 await save,快速编辑可能丢更新 |
| L5 | 无 lint/test/CI,typecheck 未接入提交门禁(本轮修复再次证明:修复都是「先改后查」) |
| L6 | `asar: false` + `npmRebuild: false`(正式分发前处理) |
| L7 | ConnectDialog port 无范围校验 |

---

## 三、本轮新发现(由本次修复连带产生)

### 🟡 A1. SSH 断开时双重「连接已断开」消息

- **位置:** `TerminalPane.vue` SSH 分支 `onExit`(第 197-201 行)+ `onClosed`(第 188-192 行)
- **成因:** 主进程断开时**两个事件都会发**:stream `close` → `ssh:exit`;client `close` → `ssh:closed`。两个监听器各自写一行 `[SSH 连接已断开]` → 终端里连续两行重复提示。
- **修复(2 行):** 二选一——删除 `onClosed` 中的消息写入(只更新状态),或主进程 `ssh:closed` 与 `ssh:exit` 只保留其一。

### 🟡 A2. 初始连接失败时双重错误消息

- **位置:** `TerminalPane.vue` `onError`(第 182-185 行)+ `.catch`(第 216-220 行)
- **成因:** 主进程 `client.on('error')` **既** `send('ssh:error')` **又** `reject(err)`。渲染层 `onError` 写 `[SSH 错误: ...]`,invoke 的 `.catch` 又写 `[连接失败: ...]` → 两行错误。
- **修复(2 行):** 保留 `.catch` 的「连接失败」提示,`onError` 改为仅 `updateStatus('disconnected')`;或主进程区分 ready 前/后,ready 前只 reject、ready 后才发事件。

### 🟡 A3. 本地标签进程退出→切回重建后,状态栏永久「未连接」

- **位置:** `TerminalPane.vue` 本地分支 resume 成功路径(第 163-171 行)
- **成因:** PTY 退出 → `onExit` 置 `disconnected`;用户切走再切回,`create`(新会话)+ `resume` 返回 `exited:false`(新进程已起),但**该路径没有 `updateStatus('connected')`** → 终端在跑,状态栏却永远显示「未连接」。SSH 分支的 resume 成功路径(第 203-206 行)已正确复位,本地分支漏了。
- **修复(2 行):** resume 成功(`result && !result.exited`)时 `tabsStore.updateStatus(props.tab.id, 'connected')`。

### 🟢 A4. 其余小项

- `ssh.onConnected` 注册了空 handler(`TerminalPane.vue:178-180`)——死代码,可删或真正用于状态流转。
- SSH `resume` 返回 `exited` 后无「重连」入口:用户只能关标签重开。建议排入 v1.2(重连按钮)。
- 连接失败后 `inputBuffer` 未清空,组件存续期内滞留内存(低危,失败路径顺手 `inputBuffer = []` 即可)。

---

## 四、遗留技术债(建议纳入迭代规划)

1. **SFTP 死代码**:`ssh.ts` 8 个 sftp handler + preload 6 个 API + `SftpEntry` 类型,当前零调用。二选一:排入 v1.3 做 SFTP 面板,或本轮删除并记录在 git 历史(v1.3 需要时从历史恢复)。
2. **L1 三份重复校验**:抽 `electron/main/security.ts` 导出 `isValidSender(getWin)`。
3. **L2 文档**:README「SSH 密码加密存储」应补充「safeStorage 不可用时降级明文」说明。
4. **L5 工程门禁**:eslint + pre-commit typecheck(本次修复再次证明缺门禁的代价)。

---

## 五、提交建议

当前 12 个修改文件 + 3 个 review/方案文档均未提交。建议:

1. 先修 A1/A2/A3(合计约 6 行);
2. `git add -A && git commit -m "fix: 修复 SSH 重复消息与本地标签状态复位 (r5)"`;
3. 再提交文档(`docs: 添加第五轮审查与迭代/性能方案`)。

---

## 六、验证记录

- `npm run typecheck:node`:**通过**(0 错误)
- `npm run typecheck:web`:**通过**(0 错误)
- 本轮审查基于工作区未提交 diff(12 文件,+135/-47 行),非 git 提交
- `npm run build` 因沙箱限制(esbuild 子进程管道 EPERM)未重跑;渲染层此前唯一必挂点 `onKeyDown` 已删除,类型全绿,判定 build 可过,正式提交后请本地复跑一次
- 本报告为静态审查 + 类型检查,未运行项目、未修改任何文件
