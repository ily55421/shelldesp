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
}

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
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
