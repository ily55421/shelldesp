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
    connect: (id: string, config: import('../src/types').SshConfig) =>
      ipcRenderer.invoke('ssh:connect', id, config),
    shell: (id: string, opts: { cols: number; rows: number }) =>
      ipcRenderer.invoke('ssh:shell', id, opts),
    write: (id: string, data: string) =>
      ipcRenderer.send('ssh:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('ssh:resize', id, cols, rows),
    exec: (id: string, command: string) =>
      ipcRenderer.invoke('ssh:exec', id, command),
    disconnect: (id: string) =>
      ipcRenderer.send('ssh:disconnect', id),
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
    removeListeners: (id: string) => {
      ipcRenderer.removeAllListeners(`ssh:connected:${id}`)
      ipcRenderer.removeAllListeners(`ssh:error:${id}`)
      ipcRenderer.removeAllListeners(`ssh:closed:${id}`)
      ipcRenderer.removeAllListeners(`ssh:data:${id}`)
      ipcRenderer.removeAllListeners(`ssh:exit:${id}`)
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
    getConfigPath: () => ipcRenderer.invoke('store:getConfigPath')
  },

  // --- 窗口控制 ---
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    close: () => ipcRenderer.send('win:close'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    onMaximized: (cb: (maximized: boolean) => void) =>
      ipcRenderer.on('win:maximized', (_e, v) => cb(v))
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
