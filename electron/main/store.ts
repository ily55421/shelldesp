import { ipcMain, app, safeStorage, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import Store from 'electron-store'
import type { SshHostEntry } from '../../src/types'
import { isValidSender, setMainWindowRef } from './security'

export { setMainWindowRef }
interface StoreSchema {
  shortcuts: import('../../src/types').ShortcutCommand[]
  quickPaths: import('../../src/types').QuickPath[]
  sshHosts: SshHostEntry[]
  settings: {
    defaultShell: string
    fontSize: number
    fontFamily: string
    theme: string
    confirmClose: boolean
    autoReconnect: boolean
    lastTabs?: any[]
  }
}

const store = new Store<StoreSchema>({
  name: 'config',
  cwd: join(app.getPath('userData'), 'config'),
  defaults: {
    shortcuts: [],
    quickPaths: [],
    sshHosts: [],
    settings: {
      defaultShell: 'pwsh.exe',
      fontSize: 13,
      fontFamily: 'IBM Plex Mono, Cascadia Code, Consolas, "Courier New", monospace',
      theme: 'amber',
      confirmClose: false,
      autoReconnect: false
    }
  }
})

// B1: 加密/解密密码
function encryptPassword(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) return plain // 降级: 无法加密时明文
  const buf = safeStorage.encryptString(plain)
  return 'enc:' + buf.toString('base64')
}

function decryptPassword(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith('enc:')) return stored // 兼容旧明文数据
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    const buf = Buffer.from(stored.slice(4), 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

// H1: sender 校验 — store handler 用 ipcMain.handle, 参数是 IpcMainInvokeEvent
// 直接用 WebContents 做 BrowserWindow 查找, 避免 fakeEvent cast
function isFromMainWindow(sender: Electron.WebContents): boolean {
  const win = BrowserWindow.fromWebContents(sender)
  return !!win && isValidSender({ sender } as Parameters<typeof isValidSender>[0])
}

export function registerStoreHandlers() {
  // --- 快捷指令 ---
  ipcMain.handle('store:shortcuts:get', (e) => {
    if (!isFromMainWindow(e.sender)) return []
    return store.get('shortcuts')
  })
  ipcMain.handle('store:shortcuts:set', (e, shortcuts: StoreSchema['shortcuts']) => {
    if (!isFromMainWindow(e.sender)) return
    store.set('shortcuts', shortcuts)
  })

  // --- 快捷路径 ---
  ipcMain.handle('store:quickPaths:get', (e) => {
    if (!isFromMainWindow(e.sender)) return []
    return store.get('quickPaths')
  })
  ipcMain.handle('store:quickPaths:set', (e, paths: StoreSchema['quickPaths']) => {
    if (!isFromMainWindow(e.sender)) return
    store.set('quickPaths', paths)
  })

  // --- SSH 主机 (B1: 密码加密) ---
  ipcMain.handle('store:sshHosts:get', (e) => {
    if (!isFromMainWindow(e.sender)) return []
    const hosts = store.get('sshHosts')
    // 解密密码
    return hosts.map(h => ({
      ...h,
      config: {
        ...h.config,
        password: h.config.password ? decryptPassword(h.config.password) : undefined
      }
    }))
  })
  ipcMain.handle('store:sshHosts:set', (e, hosts: SshHostEntry[]) => {
    if (!isFromMainWindow(e.sender)) return
    // M5: 去重 + 加密密码
    const seen = new Set<string>()
    const deduped: SshHostEntry[] = []
    for (const h of hosts) {
      const key = `${h.config.host}:${h.config.port}:${h.config.username}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push({
        ...h,
        config: {
          ...h.config,
          password: h.config.password ? encryptPassword(h.config.password) : undefined
        }
      })
    }
    store.set('sshHosts', deduped)
  })

  // --- 设置 ---
  ipcMain.handle('store:settings:get', (e) => {
    if (!isFromMainWindow(e.sender)) return null
    return store.get('settings')
  })
  ipcMain.handle('store:settings:set', (e, settings: Partial<StoreSchema['settings']>) => {
    if (!isFromMainWindow(e.sender)) return
    store.set('settings', { ...store.get('settings'), ...settings })
  })

  // --- 选择文件夹 (L1: 用顶部 import) ---
  ipcMain.handle('store:pickDirectory', (e) => {
    if (!isFromMainWindow(e.sender)) return null
    const result = dialog.showOpenDialogSync({ properties: ['openDirectory'] })
    return result?.[0] || null
  })

  // L3: 选择文件 (私钥等)
  ipcMain.handle('store:pickFile', (e) => {
    if (!isFromMainWindow(e.sender)) return null
    const result = dialog.showOpenDialogSync({ properties: ['openFile'] })
    return result?.[0] || null
  })

  ipcMain.handle('store:getConfigPath', (e) => {
    if (!isFromMainWindow(e.sender)) return ''
    return store.path
  })
}
