import { ipcMain } from 'electron'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { isValidSender, getWin, setMainWindowRef } from './security'

export { setMainWindowRef }

interface PtySession {
  process: pty.IPty
  win: import('electron').BrowserWindow
  buffer: string
  flushTimer: ReturnType<typeof setTimeout> | null
  pausedBuffer: string
  paused: boolean
  exited: boolean
  exitCode: number
}

const sessions = new Map<string, PtySession>()
const FLUSH_INTERVAL = 16
const MAX_PAUSED_BUFFER = 512 * 1024

// H1: shell 白名单
const ALLOWED_SHELLS = new Set(['pwsh.exe', 'powershell.exe', 'cmd.exe'])

function scheduleFlush(id: string, session: PtySession) {
  if (session.flushTimer) return
  session.flushTimer = setTimeout(() => {
    if (session.buffer.length > 0 && !session.win.isDestroyed()) {
      session.win.webContents.send(`pty:data:${id}`, session.buffer)
      session.buffer = ''
    }
    session.flushTimer = null
  }, FLUSH_INTERVAL)
}

function cleanupSession(id: string) {
  const session = sessions.get(id)
  if (!session) return
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
  try { session.process.kill() } catch {}
  sessions.delete(id)
}

export function registerPtyHandlers() {
  ipcMain.handle('pty:create', (e, id: string, opts: {
    shell?: string; cwd?: string; cols?: number; rows?: number
  }) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    if (sessions.has(id)) return

    // H1: shell 白名单校验
    const shellName = opts.shell || 'pwsh.exe'
    const shellLower = shellName.toLowerCase()
    if (!ALLOWED_SHELLS.has(shellLower)) {
      throw new Error(`不允许的 shell: ${shellName}`)
    }

    const cwd = opts.cwd || process.env.USERPROFILE || process.cwd()
    const cols = opts.cols || 80
    const rows = opts.rows || 24

    const ptyProcess = pty.spawn(shellLower, [], {
      name: 'xterm-256color', cols, rows, cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })

    const win = getWin(e)
    const session: PtySession = {
      process: ptyProcess, win, buffer: '', flushTimer: null,
      pausedBuffer: '', paused: false, exited: false, exitCode: 0
    }
    sessions.set(id, session)

    ptyProcess.onData(data => {
      if (session.paused) {
        session.pausedBuffer += data
        if (session.pausedBuffer.length > MAX_PAUSED_BUFFER) {
          session.pausedBuffer = session.pausedBuffer.slice(-MAX_PAUSED_BUFFER)
        }
      } else {
        session.buffer += data
        scheduleFlush(id, session)
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
      if (!session.paused) {
        if (session.buffer.length > 0 && !win.isDestroyed()) {
          win.webContents.send(`pty:data:${id}`, session.buffer)
          session.buffer = ''
        }
        if (!win.isDestroyed()) win.webContents.send(`pty:exit:${id}`, exitCode)
        sessions.delete(id)
      }
    })
  })

  // H2: pause — 先置 paused, 残留 buffer 写入 pausedBuffer
  ipcMain.on('pty:pause', (e, id: string) => {
    if (!isValidSender(e)) return
    const session = sessions.get(id)
    if (!session) return
    if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
    // H2 修复: 残留数据写入 pausedBuffer 而非 IPC 发送 (避免 listener 已移除)
    if (session.buffer.length > 0) {
      session.pausedBuffer += session.buffer
      session.buffer = ''
    }
    session.paused = true
  })

  // M4: resume 时若已退出则清理
  ipcMain.handle('pty:resume', (e, id: string, cols: number, rows: number) => {
    if (!isValidSender(e)) return null
    const session = sessions.get(id)
    if (!session) return null
    try { session.process.resize(cols, rows) } catch {}
    session.paused = false
    const buffered = session.pausedBuffer
    session.pausedBuffer = ''
    if (session.exited) {
      setTimeout(() => cleanupSession(id), 100)
      return { buffered, exited: true, exitCode: session.exitCode }
    }
    return { buffered, exited: false, exitCode: 0 }
  })

  ipcMain.on('pty:write', (e, id: string, data: string) => {
    if (!isValidSender(e)) return
    sessions.get(id)?.process.write(data)
  })

  ipcMain.on('pty:resize', (e, id: string, cols: number, rows: number) => {
    if (!isValidSender(e)) return
    try { sessions.get(id)?.process.resize(cols, rows) } catch {}
  })

  ipcMain.on('pty:kill', (e, id: string) => {
    if (!isValidSender(e)) return
    cleanupSession(id)
  })

  ipcMain.handle('pty:exec', (e, id: string, command: string) => {
    if (!isValidSender(e)) return
    sessions.get(id)?.process.write(command + '\r')
  })
}

export function cleanupPtySessions() {
  for (const [id] of sessions) cleanupSession(id)
  sessions.clear()
}
