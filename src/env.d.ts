/// <reference types="vite/client" />

interface Window {
  api: {
    pty: {
      create: (id: string, opts: { shell?: string; cwd?: string; cols?: number; rows?: number }) => Promise<void>
      write: (id: string, data: string) => void
      resize: (id: string, cols: number, rows: number) => void
      kill: (id: string) => void
      exec: (id: string, command: string) => Promise<void>
      pause: (id: string) => void
      resume: (id: string, cols: number, rows: number) => Promise<{ buffered: string; exited: boolean; exitCode?: number } | null>
      onData: (id: string, cb: (data: string) => void) => void
      onExit: (id: string, cb: (code: number) => void) => void
      removeListeners: (id: string) => void
    }
    ssh: {
      connect: (id: string, config: import('../src/types').SshConfig) => Promise<void>
      /** 连接测试: 真登录一次, 报告失败原因与主机密钥指纹 */
      test: (config: import('../src/types').SshConfig) => Promise<import('../src/types').SshTestResult>
      /** 信任库信息 (路径与已记录主机数) */
      knownHosts: () => Promise<{ path: string; count: number }>
      shell: (id: string, opts: { cols: number; rows: number }) => Promise<void>
      write: (id: string, data: string) => void
      resize: (id: string, cols: number, rows: number) => void
      exec: (id: string, command: string) => Promise<void>
      /** 独立通道执行命令并取回输出 (不污染用户 shell) */
      execCapture: (id: string, command: string, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<import('./types').ExecCaptureResult>
      /** 采集远端服务器状态; 首次采样 cpuUsagePercent 为 null */
      systemStatus: (id: string) => Promise<import('./types').SystemStatus>
      disconnect: (id: string) => void
      ping: (id: string) => Promise<number>
      pause: (id: string) => void
      resume: (id: string, cols: number, rows: number) => Promise<{ buffered: string; exited: boolean } | null>
      onConnected: (id: string, cb: () => void) => void
      onError: (id: string, cb: (msg: string) => void) => void
      onClosed: (id: string, cb: () => void) => void
      onData: (id: string, cb: (data: string) => void) => void
      onExit: (id: string, cb: () => void) => void
      /** 远端系统探测结果 */
      onRemoteOs: (id: string, cb: (info: { os: string; label: string; glyph: string }) => void) => void
      /** 主机密钥与已保存的不一致 */
      onHostKeyMismatch: (id: string, cb: (info: { stored: string; seen: string; keyType: string }) => void) => void
      removeListeners: (id: string) => void
    }
    sftp: {
      open: (id: string) => Promise<void>
      readdir: (id: string, remotePath: string) => Promise<any[]>
      download: (id: string, remotePath: string) => Promise<string | null>
      upload: (id: string, remoteDir: string) => Promise<{ name: string; success: boolean }[] | null>
      delete: (id: string, remotePath: string, isDir: boolean) => Promise<void>
      mkdir: (id: string, remotePath: string) => Promise<void>
    }
    store: {
      shortcuts: {
        get: () => Promise<import('../src/types').ShortcutCommand[]>
        set: (shortcuts: import('../src/types').ShortcutCommand[]) => Promise<void>
      }
      quickPaths: {
        get: () => Promise<import('../src/types').QuickPath[]>
        set: (paths: import('../src/types').QuickPath[]) => Promise<void>
      }
      sshHosts: {
        get: () => Promise<import('../src/types').SshHostEntry[]>
        set: (hosts: import('../src/types').SshHostEntry[]) => Promise<void>
      }
      settings: {
        get: () => Promise<any>
        set: (settings: any) => Promise<void>
      }
      pickDirectory: () => Promise<string | null>
      pickFile: () => Promise<string | null>
      getConfigPath: () => Promise<string>
      confirm: (message: string) => Promise<boolean>
    }
    app: {
      getVersion: () => Promise<string>
    }
    win: {
      minimize: () => void
      close: () => void
      toggleMaximize: () => void
      toggleFullscreen: () => void
      setTitle: (title: string) => void
      onMaximized: (cb: (maximized: boolean) => void) => void
      onFullscreen: (cb: (fullscreen: boolean) => void) => void
    }
  }
}
