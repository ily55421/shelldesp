# ShellDesk 性能优化方案

- 制定时间:2026-08-13
- 目标:交互零卡顿(切换标签、高吞吐输出、大文件场景)、低内存占用、快速启动
- 原则:先测量再优化;所有优化必须有可量化的验收标准;优化不改变功能语义

---

## 〇、性能基线(先测量)

**建议先加测量设施(0.5 天),后续优化以此为准:**

1. **主进程吞吐计数器**:每个会话统计 `bytes/16ms`、flush 次数、单次 flush 最大字节(debug 模式打印,或暴露到 StatusBar debug 位)
2. **渲染层帧耗时**:`requestAnimationFrame` 循环统计平均/峰值帧时间,切标签时打点
3. **启动耗时**:`performance.now()` 打点(窗口创建→Vue mount→首个 PTY spawn→首帧输出)
4. **`--perf` 启动开关**:打印上述全部指标到主进程 stdout,便于压测复现

**典型压测场景(验收基准):**
- A. 持续输出:`pwsh -c "1..100000 | %{ $_ }"`(或 `yes`)→ 终端滚动无卡顿,帧率 ≥ 30fps
- B. 高频切换:10 个标签来回切换 ×20 次,单次切换耗时 < 80ms,无白屏
- C. 大块粘贴:粘贴 5MB 文本,UI 无冻结(冻结 < 500ms)
- D. 启动:冷启动到可输入 < 2s
- E. 内存:8 标签空闲 30 分钟,内存增量 < 20%

---

## 一、渲染层优化(收益最大,优先级最高)

### P1-1. xterm 实例 keep-alive,切标签不销毁重建(★★★★★)

- **现状:** `TerminalPane` 以 `:key="activeTab.id"` 挂在激活标签上,每次切标签 = 组件销毁 + xterm 重建 + fit + 会话 resume。xterm 的 canvas 初始化、DOM 挂载、滚动缓冲重建开销约 100–300ms,是**当前最大的交互卡顿来源**。
- **方案(推荐 A):** 所有标签的 `TerminalPane` 常驻渲染,非激活标签用 CSS `display:none`(或 `visibility:hidden` + 脱离布局);每个 pane 的 xterm 实例与 DOM 保持存活。切标签只切换显隐,`onData`/resize 照常工作。
  - 代价:内存随标签数线性增长(xterm 每实例 DOM+canvas+滚动缓冲,单个约 2–5MB),12 标签上限下可接受。
  - 注意:xterm 在 `display:none` 下 canvas 尺寸失真,激活时需重新 `fit()`(现有 ResizeObserver 可复用)。
- **方案 B(省内存):** 保持单实例,但把 xterm 的 `Terminal` 对象与 DOM 缓存池化,切回时复用旧实例。实现更复杂,收益与 A 接近。
- **验收:** 场景 B 单次切换 < 80ms。

### P1-2. 大输出分块写入,避免单次巨型 `write` 卡顿(★★★★)

- **现状:** 主进程 16ms 内累积的 buffer 一次性 `send` → 渲染层一次性 `term.write(largeString)`。高吞吐输出(场景 A)下,单次 write 可达数百 KB~MB 级,xterm 解析 + 布局 + canvas 绘制同步执行,卡顿明显。
- **方案:**
  1. 渲染层 `onData` 收到数据后,若 > 64KB 则切片(64KB/片),用 `setTimeout(0)`/`requestAnimationFrame` 队列逐片 `term.write`,避免单帧长任务;
  2. 主进程同步做「自适应 flush」:buffer ≥ 32KB 立即 flush(不等 16ms),同时每片裁剪到 ≤ 64KB 再 send,双重保险。
- **验收:** 场景 A 帧率 ≥ 30fps;单帧 JS 长任务 < 50ms(DevTools Performance 验证)。

### P1-3. 输入通道微批(★★)

- **现状:** 每个按键一次 `ipcRenderer.send('pty:write')`。频率低(人速),但粘贴大段文本时 `term.onData` 会以字符块连发。
- **方案:** `onData` 回调内做微任务合并(同帧内的多次 write 拼成一个 IPC 包)。实现简单,收益中等,可作为顺手项。

### P1-4. 渲染层其他(★)

- 扫描线 `.scanlines` 为纯静态背景,确保 `pointer-events:none`(已有)+ 不触发重绘;若 DevTools 显示合成开销,改为 `::before` 单层或降低透明度。
- 非激活标签的 ResizeObserver 在 `display:none` 下不触发,无需额外处理。
- `WebLinksAddon` 保持全局(单实例成本极低)。
- 大滚动缓冲:scrollback 2000 行已是合理值;如用户长会话需要更多,做成设置项(2000/5000/10000),默认 2000 控内存。

---

## 二、主进程优化

### P2-1. buffer 用数组累加替代字符串 `+=`(★★★)

- **现状:** `session.buffer += data` 与 `pausedBuffer += text`。高吞吐下(场景 A)16ms 窗口内数十~数百次拼接,字符串 `+=` 的最坏复杂度 O(n²)。
- **方案:** buffer 改为 `string[]`,flush 时 `join('')`。同时**立即截断**:flush 后若数组仍超限(异常积压)丢弃最旧。
- **验收:** 场景 A 主进程 CPU 占用下降(目标 < 20% 单核);无内存线性增长。

### P2-2. 自适应 flush(★★★)

- **现状:** 固定 16ms 定时 flush,无论 buffer 多大。
- **方案:** 双阈值——
  - `buffer.length ≥ 32KB` → 立即 flush(不再等定时器);
  - 否则 16ms 定时兜底(空闲时无定时器,现状已如此)。
- 收益:高吞吐时延迟降低、积压减少;低吞吐行为不变。
- 可选:把间隔从 16ms 提到 32ms(IPC 次数减半,感知延迟仍 < 33ms,人眼无感),可显著降低连续输出时的 IPC 开销。

### P2-3. 后台会话资源策略(★★★)

- **现状:** 标签切后台只暂停输出,PTY 进程/SSH 连接照常运行;`pausedBuffer` 无上限之外的治理(已有 512KB 截断)。
- **方案:**
  1. 保持 512KB pausedBuffer 截断(已有),增加配置项「后台标签超时回收」:如 SSH 后台 > N 分钟无活动且 buffer 接近上限 → 发 `ssh:closed` 语义提示并断开(可配);PTY 不做(用户本地进程,不该被杀);
  2. 标签数 12 上限保留(进程数红线),1.2 增加「标签页过多」引导提示;
  3. 可选:长时间后台的 PTY 显示「内存占用」提示。
- **验收:** 12 标签满载 + 3 个高吞吐会话,总内存 < 1.2GB;无 OOM。

### P2-4. electron-store 写合并(★★)

- **现状:** `shortcuts.ts` 每次 add/update/remove 立即 `set`(且不 await),高频编辑时多次整表写入。
- **方案:** 渲染层 debounce 500ms 合并写;主进程侧已按 key 覆盖写,无需改动。
- **验收:** 连点 20 次指令编辑,配置文件只写 1–2 次(可观测 `getConfigPath` 文件 mtime)。

---

## 三、启动与资源

### P3-1. 启动链路优化(★★★)

- **现状:** `app.whenReady → createWindow → loadURL/loadFile → Vue mount → 默认 pwsh 标签立即 spawn`。pwsh 冷启动 300–800ms,期间窗口可能无响应感。
- **方案:**
  1. 窗口先显:`show: true` 提前,首个标签**延迟 300ms** 或用户首次点击时再 spawn(若启动恢复上次标签,则按恢复列表逐个惰性 spawn);
  2. 渲染层 `shortcuts.load()` 与 UI 首帧并行(已基本如此),失败不阻塞;
  3. 主进程侧:node-pty 模块 `require` 已为 ESM/CJS 混用,确认无同步 IO 阻塞(原生模块加载一次即可)。
- **验收:** 场景 D 冷启动到可输入 < 2s;首标签输出 < 600ms。

### P3-2. 内存治理(★★)

- xterm 实例 keep-alive(P1-1)会提高常驻内存 —— 用「单实例上限 12 + 后台超时回收(P2-3)+ scrollback 设置」平衡。
- 检查 `ssh2` 会话:断开路径已清理(client.end + sessions.delete),确认无 `sftp` 句柄泄漏(cleanupSession 已 end sftp)。
- `pausedBuffer` 512KB/会话上限保留。

---

## 四、网络与 SSH

### P4-1. SSH 延迟与稳定性(★★)

- keepalive 已有(10s/3 次);1.2 增加指数退避自动重连(0.5s/2s/8s/30s,上限 5 次),断线期间输入进队列(复用 M2 缓冲机制)。
- 测量 latency:连接建立后定时 `ssh.exec('echo ping')`(或 channel-level ping),StatusBar 显示真实值(替换当前占位「—」)。
- SFTP(排入 v1.3):fastGet/fastPut 已流式;多文件队列并发上限 3,避免句柄/带宽打满。

---

## 五、优化优先级总表与验收

| 优先级 | 项 | 收益 | 工作量 | 验收 |
|---|---|---|---|---|
| P0 | P1-1 xterm keep-alive | 切标签卡顿消除(最大感知项) | 1 天 | 场景 B < 80ms/次 |
| P0 | P1-2 分块写入 | 高吞吐不卡 UI | 0.5 天 | 场景 A ≥ 30fps |
| P0 | P2-1 buffer 数组化 | 主进程 CPU/内存 | 0.5 天 | 场景 A CPU < 20% |
| P0 | P2-2 自适应 flush | 吞吐/延迟 | 0.5 天 | 场景 A 无积压 |
| P1 | P3-1 启动链路 | 启动 < 2s | 1 天 | 场景 D |
| P1 | P2-3 后台回收 | 长跑内存红线 | 1 天 | 场景 E |
| P1 | P4-1 重连+延迟 | SSH 可靠性/真实指标 | 1 天 | 断网恢复自动回连 |
| P2 | P1-3 输入微批 / P2-4 写合并 / P3-2 内存治理 | 顺滑度/IO | 1 天 | 场景 B/C 无异常 |

**实施节奏建议:** 与迭代规划联动 —— P0 四项进 v1.3 的 3.8「性能专项」(2 天);P1 随 v1.2(2.3 重连、2.6 latency)自然落地;测量设施(§〇)先于一切,至少提前 1 天搭好。

---

## 六、预期收益(量化目标)

| 指标 | 当前(估) | 目标 |
|---|---|---|
| 标签切换耗时 | 100–300ms(重建) | < 80ms(keep-alive) |
| 高吞吐输出帧率 | 可能 < 15fps | ≥ 30fps |
| 冷启动到可输入 | 2–4s | < 2s |
| 12 标签满载内存 | 未知(待基线) | < 1.2GB |
| 单帧长任务 | 可能 > 200ms(巨型 write) | < 50ms |
