import { app, BrowserWindow, ipcMain, shell, nativeTheme, Menu } from 'electron'
import { join, dirname } from 'path'
import * as fs from 'fs'
import { registerPtyHandlers, cleanupPtySessions, setMainWindowRef as setPtyRef } from './pty'
import { registerSshHandlers, cleanupSshSessions, setMainWindowRef as setSshRef } from './ssh'
import { registerStoreHandlers, setMainWindowRef as setStoreRef, getStoredSettings } from './store'
import { getWindowStateOptions, trackWindowState, type WindowToggles } from './windowState'
import { isValidSender, setMainWindowRef as setSecurityRef } from './security'

let mainWindow: BrowserWindow | null = null

nativeTheme.themeSource = 'dark'

// 移除默认菜单: 避免其加速键 (Ctrl+=/-/0 缩放网页、Ctrl+R 重载、F11) 与应用快捷键冲突
Menu.setApplicationMenu(null)

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

// 记录自身所在目录, 供 NSIS 安装包覆盖升级时定位 (免安装版没有注册表记录)
function recordInstallPath() {
  if (!app.isPackaged) return
  try {
    fs.writeFileSync(
      join(app.getPath('userData'), 'install-path.txt'),
      dirname(app.getPath('exe')),
      'utf8'
    )
  } catch { /* 忽略: 仅用于安装器定位, 失败不影响运行 */ }
}

// H1: 窗口控制 IPC — 顶层注册一次 + sender 校验 (复用 security 模块)
ipcMain.on('win:minimize', (e) => { if (isValidSender(e)) mainWindow?.minimize() })
ipcMain.on('win:close', (e) => { if (isValidSender(e)) mainWindow?.close() })
ipcMain.on('win:toggle-maximize', (e) => {
  if (!isValidSender(e) || !mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
// 窗口标题跟随活动标签
ipcMain.on('win:set-title', (e, title: unknown) => {
  if (!isValidSender(e) || !mainWindow) return
  const text = typeof title === 'string' ? title.slice(0, 120) : 'ShellDesk'
  mainWindow.setTitle(text || 'ShellDesk')
})
// F11 全屏
ipcMain.on('win:toggle-fullscreen', (e) => {
  if (!isValidSender(e) || !mainWindow) return
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
})
// 应用版本 (标题栏展示, 用于确认更新是否生效)
ipcMain.handle('app:get-version', (e) => {
  if (BrowserWindow.fromWebContents(e.sender) !== mainWindow) return ''
  return app.getVersion()
})

/** 当前设置里的窗口记忆开关 (主进程实时读取, 渲染进程改设置后立即生效) */
function currentWindowToggles(): WindowToggles {
  const s = getStoredSettings() || ({} as ReturnType<typeof getStoredSettings>)
  return {
    rememberSize: s.rememberWindowSize !== false,
    rememberPosition: s.rememberWindowPosition !== false
  }
}

function createWindow() {
  const { bounds, maximized } = getWindowStateOptions(currentWindowToggles())

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false, // 等 ready-to-show, 避免恢复尺寸/最大化时闪跳
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

  // 窗口状态记忆 (位置/大小/最大化)
  trackWindowState(mainWindow, currentWindowToggles)

  // H1: 同步 mainWindow 引用给各 handler 模块
  setPtyRef(mainWindow)
  setSshRef(mainWindow)
  setStoreRef(mainWindow)
  setSecurityRef(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (maximized) mainWindow.maximize()
    mainWindow.show()
  })

  // 默认菜单已移除, 自行保留开发者工具快捷键 (F12 / Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximized', false))
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('win:fullscreen', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('win:fullscreen', false))
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
    recordInstallPath()
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
