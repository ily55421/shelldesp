/** 共享类型定义 */

export type TabType = 'local' | 'ssh'
export type TabStatus = 'connecting' | 'connected' | 'disconnected'

export interface Tab {
  id: string
  title: string
  type: TabType
  status: TabStatus
  /** 本地终端: shell 名称; SSH: 远端 host */
  shell?: string
  cwd?: string
  /** SSH 连接信息 */
  ssh?: SshConfig
  /** SSH 远端系统 (探测成功后填充, 用于标签徽标) */
  remoteOs?: { os: string; label: string; glyph: string }
}

/** SSH 认证方式 (借鉴 shell-rs 的 LoginMethod) */
export type SshAuthKind =
  /** 密码: 使用 password 字段 */
  | 'password'
  /** 私钥: 使用 privateKey / passphrase 字段 */
  | 'key'
  /** SSH Agent: 由本机 agent 提供密钥 */
  | 'agent'
  /** 无密码: 先试服务器的 none 认证, 再试 SSH Agent */
  | 'nopassword'

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** 认证方式; 缺省时按 password → privateKey 的顺序推断 (兼容旧数据) */
  authKind?: SshAuthKind
  /** 启用键盘交互认证 (服务器要求二次验证时) */
  tryKeyboard?: boolean
  /** 自定义 SSH Agent 套接字; 缺省用系统默认 (Windows 为 Pageant/named pipe) */
  agentSocket?: string
}

/** 主机密钥确认请求 (首次连接未知主机时由主进程发起) */
export interface HostKeyPrompt {
  host: string
  port: number
  /** 密钥算法, 如 ssh-ed25519 */
  keyType: string
  /** SHA256 指纹 */
  fingerprint: string
}

/** 主机密钥校验失败 (密钥与已保存的不一致) */
export interface HostKeyMismatch {
  host: string
  port: number
  /** 已保存的指纹 */
  stored: string
  /** 本次连接看到的指纹 */
  seen: string
  keyType: string
}

/** 连接测试结果 (借鉴 shell-rs 的「测试连接」) */
export interface SshTestResult {
  ok: boolean
  /** 失败原因 (已翻译成中文); ok 为 true 时为空 */
  reason?: string
  /** 主机密钥算法 */
  hostKeyType?: string
  /** 主机密钥指纹 */
  hostKeyFingerprint?: string
  /** 登录成功后探测到的远端系统 (uname -s 结果, 探测失败则为空) */
  remoteOs?: string
}

/** 快捷路径 — 保存常用目录, 点击后 cd 过去 */
export interface QuickPath {
  id: string
  name: string
  path: string
  icon?: string
}

/** 快捷指令中的单步命令 */
export interface CommandStep {
  /** 命令内容 */
  command: string
  /** 执行后等待毫秒数再执行下一步 */
  delayMs?: number
}

export interface ShortcutCommand {
  id: string
  name: string
  /** 单条命令 (简单模式) */
  command: string
  /** 多步命令 (组合模式, 如果设置则忽略 command) */
  steps?: CommandStep[]
  /** 工作目录 — 执行前先 cd 到这里 */
  cwd?: string
  /** 在新标签页打开 */
  newTab: boolean
  /** 在 SSH 连接上执行 (可选, 为空则本地执行) */
  sshHost?: string
  icon?: string
}

export interface SftpEntry {
  name: string
  longname: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
  size: number
  mtime: number
  atime: number
  rights: { user: string; group: string; other: string }
  owner: string
  group: string
}

export interface SshHostEntry {
  id: string
  name: string
  config: SshConfig
}

/** 一次独立通道命令执行的结果 (对应主进程的 ssh:exec-capture) */
export interface ExecCaptureResult {
  ok: boolean
  stdout?: string
  stderr?: string
  /** 远端退出码; 服务器未提供时为 null */
  exitCode?: number | null
  /** 输出触达上限被截断 */
  truncated?: boolean
  /** ok 为 false 时的原因 */
  error?: string
}

/** 远端 CPU 累计时间 (两次采样求差得到占用率) */
export interface SystemCpuInfo {
  cores: number
  /** 累计各态时间 (jiffies) */
  total: number
  /** 空闲累计 */
  idle: number
}

export interface SystemMemoryInfo {
  totalKb: number
  availableKb: number
  usedKb: number
  freeKb: number
  buffersKb: number
  cachedKb: number
  swapTotalKb: number
  swapFreeKb: number
  swapUsedKb: number
  usedPercent: number
}

export interface SystemDiskEntry {
  filesystem: string
  sizeKb: number
  usedKb: number
  availableKb: number
  usedPercent: number
  mountPoint: string
}

export interface SystemNetEntry {
  name: string
  rxBytes: number
  txBytes: number
}

export interface SystemIdentity {
  kernel: string
  prettyName: string
  distroId: string
  hostname: string
  uptimeSeconds: number
  load1: number
  load5: number
  load15: number
}

/** 远端服务器状态快照 (对应主进程的 ssh:system-status) */
export interface SystemStatus {
  ok: boolean
  error?: string
  identity?: SystemIdentity
  cpu?: SystemCpuInfo
  memory?: SystemMemoryInfo
  disks?: SystemDiskEntry[]
  net?: SystemNetEntry[]
  /** 与上次采样求差得到的 CPU 占用率; 首次采样为 null */
  cpuUsagePercent?: number | null
  /** 与上次采样求差得到的网络速率 (字节/秒) */
  netRates?: { name: string; rxPerSec: number; txPerSec: number }[]
  sampleIntervalMs?: number
  /** 哪些采集项失败了 (例如服务器没有 df) */
  failed?: string[]
  at: number
}
