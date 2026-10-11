import { contextBridge, ipcRenderer } from 'electron'

const api = {
  pty: {
    create: (id: string, opts: { shell?: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('pty:create', id, opts),
    write: (id: string, data: string) =>
      ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) =>
      ipcRenderer.send('pty:kill', id),
    exec: (id: string, command: string) =>
      ipcRenderer.invoke('pty:exec', id, command),
    pause: (id: string) =>
      ipcRenderer.send('pty:pause', id),
    resume: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resume', id, cols, rows),
    onData: (id: string, cb: (data: string) => void) =>
      ipcRenderer.on(`pty:data:${id}`, (_e, data) => cb(data)),
    onExit: (id: string, cb: (code: number) => void) =>
      ipcRenderer.on(`pty:exit:${id}`, (_e, code) => cb(code)),
    removeListeners: (id: string) => {
      ipcRenderer.removeAllListeners(`pty:data:${id}`)
      ipcRenderer.removeAllListeners(`pty:exit:${id}`)
    }
  },

  ssh: {
    connect: (id: string, config: import('../../src/types').SshConfig) =>
      ipcRenderer.invoke('ssh:connect', id, config),
    /** 连接测试: 真登录一次, 报告失败原因与主机密钥指纹 */
    test: (config: import('../../src/types').SshConfig) =>
      ipcRenderer.invoke('ssh:test', config) as Promise<import('../../src/types').SshTestResult>,
    /** 信任库信息 (路径与已记录主机数) */
    knownHosts: () =>
      ipcRenderer.invoke('ssh:known-hosts') as Promise<{ path: string; count: number }>,
    shell: (id: string, opts: { cols: number; rows: number }) =>
      ipcRenderer.invoke('ssh:shell', id, opts),
    write: (id: string, data: string) =>
      ipcRenderer.send('ssh:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('ssh:resize', id, cols, rows),
    exec: (id: string, command: string) =>
      ipcRenderer.invoke('ssh:exec', id, command),
    /**
     * 在独立通道上跑命令并取回输出 (不污染用户 shell)。
     * 供服务器状态采集与自定义命令使用。
     */
    execCapture: (id: string, command: string, opts?: { timeoutMs?: number; maxBytes?: number }) =>
      ipcRenderer.invoke('ssh:exec-capture', id, command, opts) as Promise<import('../../src/types').ExecCaptureResult>,
    /** 采集远端服务器状态 (Linux); 首次调用 cpuUsagePercent 为 null */
    systemStatus: (id: string) =>
      ipcRenderer.invoke('ssh:system-status', id) as Promise<import('../../src/types').SystemStatus>,
    disconnect: (id: string) =>
      ipcRenderer.send('ssh:disconnect', id),
    ping: (id: string) =>
      ipcRenderer.invoke('ssh:ping', id),
    pause: (id: string) =>
      ipcRenderer.send('ssh:pause', id),
    resume: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('ssh:resume', id, cols, rows),
    onConnected: (id: string, cb: () => void) =>
      ipcRenderer.on(`ssh:connected:${id}`, () => cb()),
    onError: (id: string, cb: (msg: string) => void) =>
      ipcRenderer.on(`ssh:error:${id}`, (_e, msg) => cb(msg)),
    onClosed: (id: string, cb: () => void) =>
      ipcRenderer.on(`ssh:closed:${id}`, () => cb()),
    onData: (id: string, cb: (data: string) => void) =>
      ipcRenderer.on(`ssh:data:${id}`, (_e, data) => cb(data)),
    onExit: (id: string, cb: () => void) =>
      ipcRenderer.on(`ssh:exit:${id}`, () => cb()),
    /** 远端系统探测结果 */
    onRemoteOs: (id: string, cb: (info: { os: string; label: string; glyph: string }) => void) =>
      ipcRenderer.on(`ssh:os:${id}`, (_e, info) => cb(info)),
    /** 主机密钥与已保存的不一致 */
    onHostKeyMismatch: (id: string, cb: (info: { stored: string; seen: string; keyType: string }) => void) =>
      ipcRenderer.on(`ssh:hostkey-mismatch:${id}`, (_e, info) => cb(info)),
    removeListeners: (id: string) => {
      ipcRenderer.removeAllListeners(`ssh:connected:${id}`)
      ipcRenderer.removeAllListeners(`ssh:error:${id}`)
      ipcRenderer.removeAllListeners(`ssh:closed:${id}`)
      ipcRenderer.removeAllListeners(`ssh:data:${id}`)
      ipcRenderer.removeAllListeners(`ssh:exit:${id}`)
      ipcRenderer.removeAllListeners(`ssh:os:${id}`)
      ipcRenderer.removeAllListeners(`ssh:hostkey-mismatch:${id}`)
    }
  },

  sftp: {
    open: (id: string) =>
      ipcRenderer.invoke('sftp:open', id),
    readdir: (id: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:readdir', id, remotePath),
    download: (id: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:download', id, remotePath),
    upload: (id: string, remoteDir: string) =>
      ipcRenderer.invoke('sftp:upload', id, remoteDir),
    delete: (id: string, remotePath: string, isDir: boolean) =>
      ipcRenderer.invoke('sftp:delete', id, remotePath, isDir),
    mkdir: (id: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:mkdir', id, remotePath)
  },

  store: {
    shortcuts: {
      get: () => ipcRenderer.invoke('store:shortcuts:get'),
      set: (shortcuts: any[]) => ipcRenderer.invoke('store:shortcuts:set', shortcuts)
    },
    quickPaths: {
      get: () => ipcRenderer.invoke('store:quickPaths:get'),
      set: (paths: any[]) => ipcRenderer.invoke('store:quickPaths:set', paths)
    },
    sshHosts: {
      get: () => ipcRenderer.invoke('store:sshHosts:get'),
      set: (hosts: any[]) => ipcRenderer.invoke('store:sshHosts:set', hosts)
    },
    settings: {
      get: () => ipcRenderer.invoke('store:settings:get'),
      set: (settings: any) => ipcRenderer.invoke('store:settings:set', settings)
    },
    pickDirectory: () => ipcRenderer.invoke('store:pickDirectory'),
    pickFile: () => ipcRenderer.invoke('store:pickFile'),
    getConfigPath: () => ipcRenderer.invoke('store:getConfigPath'),
    confirm: (message: string) => ipcRenderer.invoke('store:confirm', message)
  },

  // --- 应用信息 ---
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version')
  },

  // --- 窗口控制 ---
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    close: () => ipcRenderer.send('win:close'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    toggleFullscreen: () => ipcRenderer.send('win:toggle-fullscreen'),
    setTitle: (title: string) => ipcRenderer.send('win:set-title', title),
    onMaximized: (cb: (maximized: boolean) => void) =>
      ipcRenderer.on('win:maximized', (_e, v) => cb(v)),
    onFullscreen: (cb: (fullscreen: boolean) => void) =>
      ipcRenderer.on('win:fullscreen', (_e, v) => cb(v))
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
