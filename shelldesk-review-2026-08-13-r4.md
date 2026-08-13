# ShellDesk 代码审查报告(第六轮 · A 系列收尾验证)

- 审查时间:2026-08-13
- 审查对象:提交 `7a477df`(主修复)+ `1d69c82`(A 系列收尾),当前 working tree clean(仅 4 个未跟踪文档)
- 审查方式:提交 diff 核对 + `npm run typecheck`(node/web 双侧)实测
- 相对第五轮(`shelldesk-review-2026-08-13-r3.md`):新增 1 个收尾提交,验证 A1/A2/A3

---

## 一、总体结论

**✅ 第五轮提出的 3 个连带缺陷(A1/A2/A3)全部修复,方案简洁正确;`npm run typecheck` 双侧实测全绿。**

- `1d69c82` 用单一 `disconnected` 布尔标志去重,一次提交 17 行解决三处双写问题,无过度设计。
- 连同 `7a477df`(typecheck/安全/连接状态/健壮性),**第四轮以来 20 个编译错误、2 个安全漏洞、3 个高优功能缺陷已全部清零**。

| 维度 | 第五轮 | 本轮 | 说明 |
|---|---|---|---|
| 功能完整度 | 8 | 8.5 | 连接状态全链路真实化、断连提示干净 |
| 代码质量 | 6.5 | 7 | A 系列收尾干净;残留低优项见 §三 |
| 安全性 | 7 | 7.5 | privateKey 白名单、win IPC 校验均生效 |
| 工程化 | 6 | 6 | 已形成提交-审查闭环;仍无 lint/test/CI 门禁 |
| 可维护性 | 5.5 | 5.5 | L1 三份校验重复、SFTP 死代码仍在 |

---

## 二、A 系列修复核对

| 编号 | 修复方式 | 状态 |
|---|---|---|
| **A1** SSH 断开双消息 | `disconnected` 标志:首个事件(`ssh:exit` 或 `ssh:closed`)置位并写一行,后续事件直接 return | ✅ 修复 |
| **A2** 初始连接失败双错误 | `onError` 写错误并置位;`.catch` 见标志已置位则不再写「连接失败」 | ✅ 修复 |
| **A3** 本地 PTY 状态卡死 | resume 成功(`result && !result.exited`)时补 `updateStatus('connected')` | ✅ 修复 |

**验证过的路径:**
- 连接失败:onError 先到 → 写一行 → .catch 跳过 ✓
- 建立后断开:ssh:exit 先到 → 写一行 → ssh:closed 跳过 ✓
- keepalive 失败:ssh:error → 写一行 → closed/exit 均跳过 ✓
- 切标签往返:组件随 `v-if/:key` 重建,`disconnected` 每次实例化重置为 false,不污染下次连接 ✓
- 本地 PTY 退出→切回重建:resume 成功 → 状态复位 connected ✓

---

## 三、遗留项(全部低优先级,不阻塞)

1. **M6 设置面板未落地**——TerminalPane `fontSize/fontFamily/theme` 仍硬编码(`TerminalPane.vue:29-31`),齿轮按钮仍「开发中」。**建议 v1.2 首个事项**(roadmap 2.1)。
2. **L1** sender 校验三份重复(pty/ssh/store)→ 抽 `electron/main/security.ts`。
3. **L4** `shortcuts.ts` 保存 fire-and-forget,快速编辑可能丢更新 → debounce 500ms。
4. **L5** 无 lint/test/CI,typecheck 未接入提交门禁(本次两轮修复均为「先改后验」,强烈建议补 pre-commit)。
5. **L6** `asar: false` + `npmRebuild: false`,正式分发前处理。
6. **L7** ConnectDialog port 无范围校验。
7. **L2** README 未说明 safeStorage 降级明文路径。
8. **SFTP 死代码** ~90 行(ssh.ts + preload + types),零调用——排 v1.3 或清理。

### 🟢 两个可选打磨点(1 行级)

- **O1**:SSH resume 返回 `exited` 的分支(后台断开后切回)未置 `disconnected` 标志。当前主进程 stream-close 与 client-close 间隔极小,双写概率极低;若想彻底,在该分支加 `disconnected = true` 即可。
- **O2**:连接失败/断开后 `inputBuffer` 未清空(仅组件销毁时释放),失败路径加 `inputBuffer = []` 顺手清掉。

---

## 四、提交与文档状态

- 代码:2 个修复提交已入库,working tree 干净 ✓
- 文档:`shelldesk-review-2026-08-13*.md` ×3、`shelldesk-roadmap-2026-08-13.md`、`shelldesk-perf-plan-2026-08-13.md` 未跟踪。建议提交为 `docs:` 提交,或按项目习惯保留在 `docs/` 目录。

---

## 五、验证记录

- `npm run typecheck:node`:**通过**(0 错误)
- `npm run typecheck:web`:**通过**(0 错误)
- git:4 提交,working tree clean(仅 4 个未跟踪文档)
- `npm run build` 仍因沙箱限制(esbuild 子进程管道 EPERM)未执行;typecheck 全绿 + 渲染层必挂点已消除,判定构建可过,建议提交后本地复跑 `npm run build` 与 `npm run package:win` 各一次
- 本报告为静态审查 + 类型检查,未运行项目、未修改任何文件
