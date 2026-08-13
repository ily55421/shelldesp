import { app, BrowserWindow, ipcMain, shell, nativeTheme, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { registerPtyHandlers, cleanupPtySessions, setMainWindowRef as setPtyRef } from './pty'
import { registerSshHandlers, cleanupSshSessions, setMainWindowRef as setSshRef } from './ssh'
import { registerStoreHandlers, setMainWindowRef as setStoreRef } from './store'

let mainWindow: BrowserWindow | null = null

nativeTheme.themeSource = 'dark'

// L6: 顶层注册一次 uncaughtException
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.stack || err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

// 清理残留锁文件 (仅在拿到单实例锁后执行)
function cleanStaleLocks() {
  const ud = app.getPath('userData')
  for (const f of ['DevToolsActivePort']) {
    try {
      const p = join(ud, f)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch { /* 忽略 */ }
  }
}

// H1: 窗口控制 IPC — 顶层注册一次 + sender 校验
function isValidWinSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(e.sender)
  return !!win && !!mainWindow && win.id === mainWindow.id
}
ipcMain.on('win:minimize', (e) => { if (isValidWinSender(e)) mainWindow?.minimize() })
ipcMain.on('win:close', (e) => { if (isValidWinSender(e)) mainWindow?.close() })
ipcMain.on('win:toggle-maximize', (e) => {
  if (!isValidWinSender(e) || !mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: true,
    icon: join(__dirname, '../../assets/icons/icon-256.png'),
    title: 'ShellDesk',
    backgroundColor: '#0c0d10',
    frame: false,  // M6: 完全自定义标题栏, 不用 overlay
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
      spellcheck: false
    }
  })

  // H1: 同步 mainWindow 引用给各 handler 模块
  setPtyRef(mainWindow)
  setSshRef(mainWindow)
  setStoreRef(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximized', false))
}

// M3: 单实例锁
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    cleanStaleLocks()
    registerPtyHandlers()
    registerSshHandlers()
    registerStoreHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  cleanupPtySessions()
  cleanupSshSessions()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cleanupPtySessions()
  cleanupSshSessions()
})
