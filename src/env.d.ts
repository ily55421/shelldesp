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
      shell: (id: string, opts: { cols: number; rows: number }) => Promise<void>
      write: (id: string, data: string) => void
      resize: (id: string, cols: number, rows: number) => void
      exec: (id: string, command: string) => Promise<void>
      disconnect: (id: string) => void
      pause: (id: string) => void
      resume: (id: string, cols: number, rows: number) => Promise<{ buffered: string; exited: boolean } | null>
      onConnected: (id: string, cb: () => void) => void
      onError: (id: string, cb: (msg: string) => void) => void
      onClosed: (id: string, cb: () => void) => void
      onData: (id: string, cb: (data: string) => void) => void
      onExit: (id: string, cb: () => void) => void
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
    }
    win: {
      minimize: () => void
      close: () => void
      toggleMaximize: () => void
      onMaximized: (cb: (maximized: boolean) => void) => void
    }
  }
}
