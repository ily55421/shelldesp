# ShellDesk 代码审查报告(第七轮 · v1.1.0 质量加固验证)

- 审查时间:2026-08-13
- 审查对象:提交 `e1d971e`(O1/O2 + 文档入库)+ `bab5669`(v1.1.0 质量加固,15 文件 +1454/-93)
- 审查方式:提交 diff 全量核对 + `npm run typecheck` / `npm run lint:check` 实测 + hook/环境核实
- 沙箱说明:`npm run build`/`package:win`/`npm test` 在本审查环境因 esbuild/node:test 子进程管道被 EPERM 拦截无法执行(环境限制,非代码问题);用户本机已验证 `build ✅ package:win ✅ test 10/10 ✅`

---

## 一、总体结论

**✅ v1.1.0 里程碑达成,roadmap 1.1-1.7 全部落地,质量符合预期。** 门禁(commit hook + CI)、lint、测试、security.ts 抽取、端口校验、README 降级说明、版本号均到位;未发现阻断或高风险问题。

实测:
- `npm run typecheck`:**通过**(0 错误)
- `npm run lint:check`:**通过**(0 错误,8 个 `no-explicit-any` 警告,均为既有代码)
- `npm test` / `npm run build`:沙箱 EPERM 无法执行,以用户本机验证为准

| 维度 | 第六轮 | 本轮 | 说明 |
|---|---|---|---|
| 功能完整度 | 8.5 | 8.5 | 无新功能(纯质量),符合 v1.1 定位 |
| 代码质量 | 7 | 7.5 | security.ts 抽取干净;O1/O2 到位 |
| 安全性 | 7.5 | 7.5 | 校验逻辑集中化,无新攻击面 |
| 工程化 | 6 | **8.5** | 门禁/lint/test/CI 闭环,v1.1 最大增量 |
| 可维护性 | 5.5 | 6.5 | 共享校验模块;测试仍为「复刻」式(见 D) |

---

## 二、v1.1 清单逐项核对(roadmap §1)

| 项 | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1.1 | A1/A2/A3 收尾 + O1/O2 | ✅ | `1d69c82` + `e1d971e`;O1 resume-exited 分支补 `disconnected=true`+`sshReady=false`;O2 连接失败清空 `inputBuffer` |
| 1.2 | 提交门禁 | ✅(有瑕疵) | `scripts/pre-commit`(typecheck→eslint→test,失败即中止)+ `scripts/install-hooks.sh`;本机 `.git/hooks/pre-commit` 已安装。**可移植性见 A** |
| 1.3 | ESLint | ✅ | `eslint.config.js`(js + typescript-eslint + vue flat config);`npm run lint`/`lint:check`;0 错误 8 警告 |
| 1.4 | 最小测试 | ✅(有改进空间) | `test/smoke.test.js` 10 用例:去重 3、端口 2、密码 4、ID 1;纯逻辑无 Electron 依赖。**「复刻」式测试见 D** |
| 1.5 | CI | ✅ | `.github/workflows/ci.yml`:Windows + Node22,install(legacy-peer-deps)→ pty 校验 → typecheck → lint → test → build → package → artifact 上传 |
| 1.6 | L1/L2/L7/SFTP | ✅ | L1 `security.ts` 抽取(pty/ssh/store/index 统一引用);L2 README 补 safeStorage 降级说明;L7 ConnectDialog 端口 1-65535 校验;SFTP `@deprecated` 标注 |
| 1.7 | 版本 1.1.0 | ✅ | package.json version、README 徽标、commit 语义化 |

---

## 三、新发现问题(均不阻塞)

### 🟡 A. postinstall 安装 hook 的机制在无 Git Bash 的机器上会静默失效

- **位置:** `package.json` `"postinstall": "sh scripts/install-hooks.sh 2>/dev/null || true"`
- **问题:** 实测本机 PATH 中**没有 `sh`**(`C:\Program Files\Git\bin\sh.exe` 等标准位置均不存在)。`sh ... || true` 把失败静默吞掉——在未安装 Git Bash(或未加入 PATH)的 Windows 机器上,`npm install` 后 hook **不会安装**,门禁形同虚设且无任何提示。本机 hook 之所以存在,应是人工/其他环境安装的,不代表 postinstall 链路可靠。
- **建议:** 改用 Node 脚本 `node scripts/install-hooks.js`(跨平台 `fs.copyFileSync` + 判断存在性),移除 `|| true` 让安装失败显式报错;或换 husky/simple-git-hooks。

### 🟡 D. 测试是「复刻」而非「被测代码」

- **位置:** `test/smoke.test.js`(dedupAndUpdateHosts/validatePort/encryptPassword/genId 全部在测试内复制了一份)
- **问题:** 测试验证的是**副本逻辑**,不是真实模块。若 `store.ts` 去重、`ConnectDialog` 端口校验、`tabs.ts` ID 生成被改动,只要副本没跟着改,测试依然全绿——即测试无法防止真实代码回归。当前价值仅为「契约冒烟」。
- **建议(v1.2):** 把纯逻辑抽到可导入模块(如 `src/lib/validation.ts`、`electron/main/logic.ts`),组件与主进程引用之,测试直接 `import` 被测代码;`ConnectDialog` 的端口校验同理抽成 `validatePort()`。

### 🟢 低优先级

- **B. `npm run lint` 带 `--fix`**:惯例 `lint` 只检查、`lint:fix` 才修复。现 `lint` 会改写源码,而 pre-commit 用 `npx eslint .`(不 fix),两处行为不一致。建议 `lint: "eslint ."`,`lint:fix: "eslint . --fix"`。
- **C. eslint.config.js ESM 警告**:每次运行报 `MODULE_TYPELESS_PACKAGE_JSON`(package.json 无 `type: module`,且**不能**加——会破坏主进程 CJS 产物)。改名 `eslint.config.mjs` 即可消除。
- **E. package.json description 仍为 "Terminal / SSH / SFTP"**:与 README 撤 SFTP 宣传、SFTP `@deprecated` 标注不一致。建议改为 "Terminal / SSH / 快捷指令"(v1.3 落地 SFTP 时再改回)。
- **F. `store.ts` 的 `fakeEvent` cast**:`isValidSender({ sender } as IpcMainInvokeEvent)` 可行但略 hacky。更干净:让 `isValidSender` 接受 `{ sender: Electron.WebContents }` 窄类型,`isFromMainWindow` 直接传 `e.sender`。
- **G. pre-commit 全量开销**:单次提交跑 typecheck+eslint+test(约 1-2 分钟)。可接受;后续可降为 typecheck+lint 快速门禁,test 交 CI。

---

## 四、安全与正确性复核(未发现新风险)

- `security.ts` 单例 `mainWindowRef` 由 `setSecurityRef`/`setPtyRef`/`setSshRef`/`setStoreRef`(实为同一函数)重复赋值,幂等无副作用 ✅
- 端口校验边界:1/65535 通过,0/-1/65536/非整数/NaN 拒绝 ✅;空输入(`Number('')=0`)被拒 ✅
- eslint 8 个警告均为既有 `any`(preload 泛型 `any[]`、env.d.ts 声明、ssh.ts sftp readdir),无新增 ⚠️ 低
- CI 的 `npm install` 同样触发 postinstall(Windows runner 自带 Git Bash,通常有 `sh`);即便失败也被 `|| true` 吞掉,不影响 CI 后续步骤 ✅

---

## 五、验证记录

- `npm run typecheck`:**通过**(0 错误)
- `npm run lint:check`:**通过**(0 错误 / 8 警告)
- `npm test`:**沙箱 EPERM 无法执行**(node:test 子进程管道被沙箱拦截);用户本机已验证 10/10
- `npm run build` / `package:win`:**沙箱 EPERM 无法执行**;用户本机已验证通过
- 环境核实:`sh` 不在本机 PATH;`.git/hooks/pre-commit` 已存在(内容与 scripts/pre-commit 一致)
- git:6 提交,working tree clean
- 本报告为静态审查 + 类型/静态检查,未修改任何文件
