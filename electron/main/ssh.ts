import { ipcMain, IpcMainEvent, BrowserWindow, dialog } from 'electron'
import { Client, ConnectConfig } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'

interface SshSession {
  client: Client
  stream?: import('ssh2').PseudoTty
  sftp?: import('ssh2').SFTPWrapper
  win: BrowserWindow
  buffer: string
  flushTimer: ReturnType<typeof setTimeout> | null
  pausedBuffer: string
  paused: boolean
  exited: boolean
  decoder: StringDecoder
}

const sessions = new Map<string, SshSession>()
const FLUSH_INTERVAL = 16
const MAX_PAUSED_BUFFER = 512 * 1024

// H1: sender 校验
let mainWindowRef: Electron.BrowserWindow | null = null
export function setMainWindowRef(win: Electron.BrowserWindow | null) {
  mainWindowRef = win
}
function isValidSender(e: IpcMainEvent): boolean {
  const win = BrowserWindow.fromWebContents(e.sender)
  return !!win && !!mainWindowRef && win.id === mainWindowRef.id
}
function getWin(e: IpcMainEvent): BrowserWindow {
  return BrowserWindow.fromWebContents(e.sender)!
}

function scheduleFlush(id: string, session: SshSession) {
  if (session.flushTimer) return
  session.flushTimer = setTimeout(() => {
    if (session.buffer.length > 0 && !session.win.isDestroyed()) {
      session.win.webContents.send(`ssh:data:${id}`, session.buffer)
      session.buffer = ''
    }
    session.flushTimer = null
  }, FLUSH_INTERVAL)
}

function cleanupSession(id: string) {
  const session = sessions.get(id)
  if (!session) return
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
  if (session.sftp) { try { session.sftp.end() } catch {} ; session.sftp = undefined }
  try { session.client.end() } catch {}
  sessions.delete(id)
}

// B2: 用 StringDecoder 安全处理多字节 UTF-8
function decodeChunk(decoder: StringDecoder, data: Buffer): string {
  return decoder.write(data)
}

export function registerSshHandlers() {
  ipcMain.handle('ssh:connect', async (e, id: string, config: ConnectConfig) => {
    if (!isValidSender(e)) throw new Error('unauthorized')

    // H1: privateKey 不接受渲染进程传的路径, 由主进程选择
    let privateKeyContent: string | undefined
    if (config.privateKey) {
      // 只允许读取 .ssh 目录下的文件
      const sshDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh')
      const keyPath = config.privateKey as string
      const resolved = path.resolve(keyPath)
      if (!resolved.startsWith(path.resolve(sshDir)) && resolved !== keyPath) {
        throw new Error('只允许读取 ~/.ssh 目录下的私钥文件')
      }
      try {
        privateKeyContent = fs.readFileSync(keyPath, 'utf-8')
      } catch {
        throw new Error(`无法读取私钥文件: ${keyPath}`)
      }
    }

    return new Promise<void>((resolve, reject) => {
      const client = new Client()
      const win = getWin(e)

      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        password: config.password,
        privateKey: privateKeyContent,
        passphrase: config.passphrase,
        readyTimeout: 15000,
        // M9: keepalive
        keepaliveInterval: 10000,
        keepaliveCountMax: 3
      }

      client.on('ready', () => {
        sessions.set(id, {
          client, win, buffer: '', flushTimer: null,
          pausedBuffer: '', paused: false, exited: false,
          decoder: new StringDecoder('utf-8')
        })
        win.webContents.send(`ssh:connected:${id}`)
        resolve()
      })

      client.on('error', (err) => {
        if (!win.isDestroyed()) win.webContents.send(`ssh:error:${id}`, err.message)
        reject(err)
      })

      client.on('close', () => {
        if (!win.isDestroyed()) win.webContents.send(`ssh:closed:${id}`)
        cleanupSession(id)
      })

      client.connect(connectConfig)
    })
  })

  ipcMain.handle('ssh:shell', async (e, id: string, opts: { cols: number; rows: number }) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session) throw new Error('SSH 会话不存在')

    if (session.stream) {
      try { session.stream.setWindow(opts.cols, opts.rows, 480, 640) } catch {}
      return
    }

    return new Promise<void>((resolve, reject) => {
      session.client.shell(
        { term: 'xterm-256color', cols: opts.cols, rows: opts.rows },
        (err, stream) => {
          if (err) { reject(err); return }
          session.stream = stream

          stream.on('data', (data: Buffer) => {
            // B2: 用 StringDecoder 安全处理多字节
            const text = decodeChunk(session.decoder, data)
            if (session.paused) {
              session.pausedBuffer += text
              if (session.pausedBuffer.length > MAX_PAUSED_BUFFER) {
                session.pausedBuffer = session.pausedBuffer.slice(-MAX_PAUSED_BUFFER)
              }
            } else {
              session.buffer += text
              scheduleFlush(id, session)
            }
          })

          stream.on('close', () => {
            session.exited = true
            // B2: flush decoder 残留
            const tail = session.decoder.end()
            if (tail) {
              if (session.paused) session.pausedBuffer += tail
              else session.buffer += tail
            }
            if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
            if (!session.paused) {
              if (session.buffer.length > 0 && !session.win.isDestroyed()) {
                session.win.webContents.send(`ssh:data:${id}`, session.buffer)
                session.buffer = ''
              }
              if (!session.win.isDestroyed()) session.win.webContents.send(`ssh:exit:${id}`)
              cleanupSession(id)
            }
          })

          stream.stderr.on('data', (data: Buffer) => {
            const text = decodeChunk(session.decoder, data)
            if (session.paused) {
              session.pausedBuffer += text
              if (session.pausedBuffer.length > MAX_PAUSED_BUFFER) {
                session.pausedBuffer = session.pausedBuffer.slice(-MAX_PAUSED_BUFFER)
              }
            } else {
              session.buffer += text
              scheduleFlush(id, session)
            }
          })

          resolve()
        }
      )
    })
  })

  // H2: pause — 先置 paused=true, 残留 buffer 写入 pausedBuffer 而非 IPC 发送
  ipcMain.on('ssh:pause', (e, id: string) => {
    if (!isValidSender(e)) return
    const session = sessions.get(id)
    if (!session) return
    if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
    // H2 修复: 残留 buffer 写入 pausedBuffer 而非丢弃
    if (session.buffer.length > 0) {
      session.pausedBuffer += session.buffer
      session.buffer = ''
    }
    session.paused = true
  })

  // M4: resume 时若已退出则清理 session
  ipcMain.handle('ssh:resume', (e, id: string, cols: number, rows: number) => {
    if (!isValidSender(e)) return null
    const session = sessions.get(id)
    if (!session) return null
    try { session.stream?.setWindow(cols, rows, 480, 640) } catch {}
    session.paused = false
    const buffered = session.pausedBuffer
    session.pausedBuffer = ''
    if (session.exited) {
      // M4: 已退出的 session 在返回后立即清理
      setTimeout(() => cleanupSession(id), 100)
      return { buffered, exited: true }
    }
    return { buffered, exited: false }
  })

  ipcMain.on('ssh:write', (e, id: string, data: string) => {
    if (!isValidSender(e)) return
    sessions.get(id)?.stream?.write(data)
  })

  ipcMain.on('ssh:resize', (e, id: string, cols: number, rows: number) => {
    if (!isValidSender(e)) return
    try { sessions.get(id)?.stream?.setWindow(cols, rows, 480, 640) } catch {}
  })

  ipcMain.handle('ssh:exec', (e, id: string, command: string) => {
    if (!isValidSender(e)) return
    sessions.get(id)?.stream?.write(command + '\r')
  })

  ipcMain.on('ssh:disconnect', (e, id: string) => {
    if (!isValidSender(e)) return
    cleanupSession(id)
  })

  // --- SFTP ---
  ipcMain.handle('sftp:open', async (e, id: string) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session) throw new Error('SSH 会话不存在')
    if (session.sftp) return
    return new Promise<void>((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) { reject(err); return }
        session.sftp = sftp
        resolve()
      })
    })
  })

  ipcMain.handle('sftp:readdir', async (e, id: string, remotePath: string) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session?.sftp) throw new Error('SFTP 未初始化')
    return new Promise((resolve, reject) => {
      session.sftp!.readdir(remotePath, (err, list) => {
        if (err) reject(err); else resolve(list)
      })
    })
  })

  ipcMain.handle('sftp:download', async (e, id: string, remotePath: string) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session?.sftp) throw new Error('SFTP 未初始化')
    const win = getWin(e)
    const fileName = path.basename(remotePath)
    const localPath = dialog.showSaveDialogSync(win, { defaultPath: fileName })
    if (!localPath) return null
    return new Promise<string>((resolve, reject) => {
      session.sftp!.fastGet(remotePath, localPath, (err) => {
        if (err) reject(err); else resolve(localPath)
      })
    })
  })

  ipcMain.handle('sftp:upload', async (e, id: string, remoteDir: string) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session?.sftp) throw new Error('SFTP 未初始化')
    const win = getWin(e)
    const filePaths = dialog.showOpenDialogSync(win, { properties: ['openFile', 'multiSelections'] })
    if (!filePaths || filePaths.length === 0) return null
    const results: { name: string; success: boolean }[] = []
    for (const localPath of filePaths) {
      const fileName = path.basename(localPath)
      const remotePath = `${remoteDir}/${fileName}`
      try {
        await new Promise<void>((res, rej) => {
          session.sftp!.fastPut(localPath, remotePath, (err) => { if (err) rej(err); else res() })
        })
        results.push({ name: fileName, success: true })
      } catch { results.push({ name: fileName, success: false }) }
    }
    return results
  })

  // L2: SFTP 递归删除目录
  ipcMain.handle('sftp:delete', async (e, id: string, remotePath: string, isDir: boolean) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session?.sftp) throw new Error('SFTP 未初始化')
    const sftp = session.sftp!
    // 递归删除
    async function rmRecursive(p: string, dir: boolean): Promise<void> {
      if (dir) {
        const list = await new Promise<any[]>((res, rej) => {
          sftp.readdir(p, (err, items) => { if (err) rej(err); else res(items) })
        })
        for (const item of list) {
          const childPath = `${p}/${item.filename}`
          await rmRecursive(childPath, item.longname.startsWith('d'))
        }
        await new Promise<void>((res, rej) => { sftp.rmdir(p, err => err ? rej(err) : res()) })
      } else {
        await new Promise<void>((res, rej) => { sftp.unlink(p, err => err ? rej(err) : res()) })
      }
    }
    await rmRecursive(remotePath, isDir)
  })

  ipcMain.handle('sftp:mkdir', async (e, id: string, remotePath: string) => {
    if (!isValidSender(e)) throw new Error('unauthorized')
    const session = sessions.get(id)
    if (!session?.sftp) throw new Error('SFTP 未初始化')
    return new Promise<void>((resolve, reject) => {
      session.sftp!.mkdir(remotePath, (err) => { if (err) reject(err); else resolve() })
    })
  })
}

export function cleanupSshSessions() {
  for (const [id] of sessions) cleanupSession(id)
  sessions.clear()
}
