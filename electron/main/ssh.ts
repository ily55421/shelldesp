import { ipcMain, BrowserWindow, dialog } from 'electron'
import { Client, ConnectConfig } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import { isValidSender, getWin, setMainWindowRef } from './security'
import { checkHostKey, learnHostKey, hasKnownKey, knownHostsPath, knownHostsCount } from './knownHosts'
import { describeSshError, type AuthKind } from './sshErrors'
import {
  PROBE_COMMAND, WINDOWS_PROBE_COMMAND, MAX_PROBE_OUTPUT,
  parseProbe, parseWindowsProbe, osLabel, osGlyph, type RemoteOs
} from './remoteOs'
import { collectSystemStatus, type SystemStatus } from './systemStatus'

export { setMainWindowRef }

/** 连接配置: 在 ssh2 的 ConnectConfig 之上带认证方式与探测结果 */
export interface ShellDeskSshConfig extends ConnectConfig {
  authKind?: AuthKind
  tryKeyboard?: boolean
  agentSocket?: string
}

interface SshSession {
  client: Client
  stream?: import('ssh2').ClientChannel
  /** @deprecated SFTP UI 待 v1.3 实现, 当前无渲染层调用 */
  sftp?: import('ssh2').SFTPWrapper
  win: BrowserWindow
  buffer: string
  flushTimer: ReturnType<typeof setTimeout> | null
  pausedBuffer: string
  paused: boolean
  exited: boolean
  decoder: StringDecoder
  /** 连接配置 (重连与探测复用) */
  config: ShellDeskSshConfig
  /** 远端系统 (探测成功后有值) */
  remoteOs?: RemoteOs
  /** 上一次系统状态采样 (用于算 CPU% 与网络速率) */
  prevStatus?: SystemStatus
}

const sessions = new Map<string, SshSession>()
const FLUSH_INTERVAL = 16
/** ssh:system-status 的单条命令超时与输出上限 (采集命令都很短, 不用留太长) */
const STATUS_PROBE_TIMEOUT_MS = 8000
const STATUS_PROBE_MAX_BYTES = 256 * 1024
const MAX_PAUSED_BUFFER = 512 * 1024

/** ssh:exec-capture 的默认超时与输出上限 */
const EXEC_CAPTURE_TIMEOUT_MS = 10000
const EXEC_CAPTURE_MAX_BYTES = 512 * 1024

/** 把数值限制在 [min, max] 内; 非有限数则取默认值 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

/** 独立通道跑命令的结果 */
export interface ExecCaptureResult {
  ok: boolean
  stdout?: string
  stderr?: string
  /** 远端退出码; 服务器未提供时为 null */
  exitCode?: number | null
  /** 输出触达上限被截断 */
  truncated?: boolean
  /** ok 为 false 时的原因 */
  error?: string
}

/** 连接阶段: 用于把失败归因到具体步骤 */
type ConnectStage = 'socket' | 'handshake' | 'auth'

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

/** 远端 shell 的输出解码器 (探测用) */
function decodeUtf8(data: Buffer): string {
  return data.toString('utf-8')
}

/**
 * 在独立 exec 通道上跑一条命令并取回输出 (模块级, 供 IPC 与状态采集共用)。
 *
 * 为什么不能复用 ssh:exec: 那个把命令写进用户正在用的 shell, 既污染终端
 * 又拿不到输出。这里开自己的通道, 用户看不见, 能拿到 stdout/stderr/退出码。
 *
 * 防护: 超时 (不把 promise 挂着) + 输出总量上限 (避免海量输出拖垮主进程)。
 */
function execCapture(
  client: Client,
  command: string,
  timeoutMs: number,
  maxBytes: number
): Promise<ExecCaptureResult> {
  return new Promise<ExecCaptureResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let stdout = ''
    let stderr = ''
    let truncated = false

    const finish = (result: ExecCaptureResult) => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      resolve(result)
    }

    // 超时不把 promise 挂着
    timer = setTimeout(() => {
      finish({ ok: false, error: `命令超时 (${timeoutMs}ms)`, stdout, stderr, truncated })
    }, timeoutMs)

    try {
      client.exec(command, (err, stream) => {
        if (settled) { try { stream?.close() } catch {} ; return }
        if (err) {
          finish({ ok: false, error: err.message, stdout: '', stderr: '', truncated: false })
          return
        }

        let exitCode: number | null = null

        stream.on('data', (data: Buffer) => {
          const room = maxBytes - (stdout.length + stderr.length)
          if (room <= 0) { truncated = true; return }
          if (data.length > room) { stdout += decodeUtf8(data.subarray(0, room)); truncated = true }
          else stdout += decodeUtf8(data)
        })
        stream.stderr.on('data', (data: Buffer) => {
          const room = maxBytes - (stdout.length + stderr.length)
          if (room <= 0) { truncated = true; return }
          if (data.length > room) { stderr += decodeUtf8(data.subarray(0, room)); truncated = true }
          else stderr += decodeUtf8(data)
        })
        stream.on('exit', (code: number | null) => { exitCode = code ?? null })
        stream.on('close', () => {
          finish({ ok: true, stdout, stderr, exitCode, truncated })
        })
        stream.on('error', (streamErr: Error) => {
          finish({ ok: false, error: streamErr.message, stdout, stderr, truncated })
        })
      })
    } catch (error) {
      finish({
        ok: false, stdout: '', stderr: '', truncated: false,
        error: (error as Error)?.message || String(error)
      })
    }
  })
}

/**
 * 登录成功后探测远端系统 (借鉴 shell-rs 的两步探测)。
 * 用独立 exec 通道, 不碰用户的 shell; 失败就保持未知, 不影响使用。
 */
function probeRemoteOs(
  client: Client,
  config: ShellDeskSshConfig,
  onDetected: (os: RemoteOs) => void
): void {
  const runStep = (command: string, second: boolean) => {
    let output = ''
    try {
      client.exec(command, (err, stream) => {
        if (err) { if (second) return; runStep(WINDOWS_PROBE_COMMAND, true); return }
        stream.on('data', (data: Buffer) => {
          if (output.length < MAX_PROBE_OUTPUT) output += decodeUtf8(data)
        })
        // stderr 故意不收集: Windows 上只有 shell 抱怨 uname 不存在
        stream.on('close', () => {
          const os = second ? parseWindowsProbe(output) : parseProbe(output)
          if (os) onDetected(os)
          else if (!second) runStep(WINDOWS_PROBE_COMMAND, true)
        })
        stream.on('error', () => { if (!second) runStep(WINDOWS_PROBE_COMMAND, true) })
      })
    } catch {
      // 探测是尽力而为, 主机拒绝 exec 通道就保持未标记
    }
  }
  runStep(PROBE_COMMAND, false)
}

/**
 * 解析 SSH Agent 位置。
 * Windows 走 Pageant (ssh2 的内置支持); 其他平台用 $SSH_AUTH_SOCK。
 * 环境变量缺失时返回 undefined —— 此时 ssh2 会报「找不到 agent」,
 * 比静默连上一个不存在的 socket 更容易排查。
 */
function resolveAgent(configured?: string): string | undefined {
  if (configured) return configured
  return process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK
}

/** 认证方式: 按用户选择装配凭据 (缺省按旧数据推断, 保证向后兼容) */
function resolveAuthKind(config: {
  authKind?: AuthKind
  privateKey?: string
  password?: string
}): AuthKind {
  return config.authKind || (config.privateKey ? 'key' : config.password ? 'password' : 'nopassword')
}

export function registerSshHandlers() {
  ipcMain.handle('ssh:connect', async (e, id: string, config: ShellDeskSshConfig) => {
    if (!isValidSender(e)) throw new Error('unauthorized')

    // H1: privateKey 不接受渲染进程传的路径, 由主进程选择
    let privateKeyContent: string | undefined
    if (config.privateKey) {
      // 只允许读取 .ssh 目录下的文件
      const sshDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh')
      const keyPath = config.privateKey as string
      const resolved = path.resolve(keyPath)
      if (!resolved.startsWith(path.resolve(sshDir) + path.sep)) {
        throw new Error('只允许读取 ~/.ssh 目录下的私钥文件')
      }
      try {
        privateKeyContent = fs.readFileSync(keyPath, 'utf-8')
      } catch {
        throw new Error(`无法读取私钥文件: ${keyPath}`)
      }
    }

    const auth = resolveAuthKind({ ...config, privateKey: privateKeyContent })
    const host = config.host || ''
    const port = config.port || 22

    return new Promise<void>((resolve, reject) => {
      const client = new Client()
      const win = getWin(e)
      let stage: ConnectStage = 'socket'
      // 主机密钥被拒时记录原因, 供错误翻译使用
      let hostKeyProblem: 'changed' | 'declined' | null = null
      let mismatch: { stored: string; seen: string; keyType: string } | null = null

      const session: SshSession = {
        client, win, buffer: '', flushTimer: null,
        pausedBuffer: '', paused: false, exited: false,
        decoder: new StringDecoder('utf-8'), config
      }

      // 未知主机要弹窗等用户核对指纹。ssh2 的 readyTimeout 从连接开始计时，
      // 用户思考期间它会照常到期 —— 所以这里先探明是否已知主机：
      // 未知则放宽超时，让用户有时间看清指纹再决定。
      const known = hasKnownKey(host, port)
      const connectConfig: ConnectConfig = {
        host,
        port,
        username: config.username,
        readyTimeout: known ? 15000 : 120000,
        // M9: keepalive
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        // 主机密钥校验: 未知主机问一次, 变更一律拒绝
        // 用异步 verify 回调, 避免 showMessageBoxSync 阻塞主进程事件循环
        // (同步阻塞会让窗口在这段时间内完全无响应)
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          // 任何一步抛异常都必须调 verify, 否则 ssh2 会一直等下去
          try {
            stage = 'auth'
            const check = checkHostKey(host, port, key)
            if (check.status === 'match') { verify(true); return }
            if (check.status === 'changed') {
              hostKeyProblem = 'changed'
              mismatch = {
                stored: check.stored?.fingerprint || '',
                seen: check.seen.fingerprint,
                keyType: check.seen.type
              }
              verify(false)
              return
            }
            // 未知主机: 异步弹窗询问, 不阻塞事件循环
            dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['信任并继续', '取消'],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
              title: '未知的主机密钥',
              message: `首次连接 ${host}:${port}`,
              detail:
                `主机密钥指纹 (${check.seen.type}):\n${check.seen.fingerprint}\n\n` +
                '请与服务器管理员核对指纹后再继续。信任后该主机会被记录, 下次连接不再询问。'
            }).then(({ response }) => {
              if (response === 0) {
                learnHostKey(host, port, key)
                verify(true)
              } else {
                hostKeyProblem = 'declined'
                verify(false)
              }
            }).catch(() => {
              hostKeyProblem = 'declined'
              verify(false)
            })
          } catch {
            hostKeyProblem = 'declined'
            verify(false)
          }
        }
      }

      // 认证方式: 按所选方式装配凭据
      if (auth === 'password') {
        connectConfig.password = config.password
        connectConfig.tryKeyboard = config.tryKeyboard === true
      } else if (auth === 'key') {
        connectConfig.privateKey = privateKeyContent
        connectConfig.passphrase = config.passphrase
      } else if (auth === 'agent') {
        const agent = resolveAgent(config.agentSocket)
        if (agent) connectConfig.agent = agent
      } else {
        // 无密码: 先试服务器的 none 认证, 再试 SSH Agent
        connectConfig.authHandler = ['none', 'agent']
        const agent = resolveAgent(config.agentSocket)
        if (agent) connectConfig.agent = agent
      }

      client.on('ready', () => {
        sessions.set(id, session)
        win.webContents.send(`ssh:connected:${id}`)
        // 连接成功后探测远端系统 (独立通道, 尽力而为)
        probeRemoteOs(client, config, (os) => {
          session.remoteOs = os
          if (!win.isDestroyed()) {
            win.webContents.send(`ssh:os:${id}`, { os, label: osLabel(os), glyph: osGlyph(os) })
          }
        })
        resolve()
      })

      client.on('error', (err: Error & { level?: string; code?: string }) => {
        // 主机密钥问题优先于底层错误文案
        let message: string
        if (hostKeyProblem === 'changed' && mismatch) {
          message = `主机密钥与已保存的不一致, 连接已中止\n已保存: ${mismatch.stored}\n本次:   ${mismatch.seen}`
        } else if (hostKeyProblem === 'declined') {
          message = '未信任该主机的密钥, 连接已取消'
        } else {
          message = describeSshError({
            error: err,
            auth,
            hasPassword: !!config.password,
            hasKey: !!privateKeyContent,
            hasPassphrase: !!config.passphrase,
            triedKeyboard: config.tryKeyboard === true
          })
        }
        // 带上失败阶段, 便于定位 (socket=建立连接, auth=握手/认证)
        const stageLabel = stage === 'socket' ? '建立连接' : '握手/认证'
        const detail = `${message} (失败于${stageLabel}阶段)`
        if (!win.isDestroyed()) {
          win.webContents.send(`ssh:error:${id}`, detail)
          if (mismatch) win.webContents.send(`ssh:hostkey-mismatch:${id}`, mismatch)
        }
        reject(new Error(detail))
      })

      client.on('close', () => {
        if (!win.isDestroyed()) win.webContents.send(`ssh:closed:${id}`)
        cleanupSession(id)
      })

      client.connect(connectConfig)
    })
  })

  /** 连接测试 (借鉴 shell-rs 的「测试连接」): 真登录一次, 立刻断开, 报告指纹 */
  ipcMain.handle('ssh:test', async (e, config: ShellDeskSshConfig) => {
    if (!isValidSender(e)) return { ok: false, reason: 'unauthorized' }

    let privateKeyContent: string | undefined
    if (config.privateKey) {
      const sshDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh')
      const keyPath = config.privateKey as string
      const resolved = path.resolve(keyPath)
      if (!resolved.startsWith(path.resolve(sshDir) + path.sep)) {
        return { ok: false, reason: '只允许读取 ~/.ssh 目录下的私钥文件' }
      }
      try {
        privateKeyContent = fs.readFileSync(keyPath, 'utf-8')
      } catch {
        return { ok: false, reason: `无法读取私钥文件: ${keyPath}` }
      }
    }

    const auth = resolveAuthKind({ ...config, privateKey: privateKeyContent })
    const host = config.host || ''
    const port = config.port || 22

    return new Promise<{ ok: boolean; reason?: string; hostKeyType?: string; hostKeyFingerprint?: string; remoteOs?: string }>((resolve) => {
      const client = new Client()
      let stage: ConnectStage = 'socket'
      let hostKeyProblem: 'changed' | 'declined' | null = null
      let seenKeyType = ''
      let seenFingerprint = ''
      let settled = false
      const finish = (result: { ok: boolean; reason?: string; remoteOs?: string }) => {
        if (settled) return
        settled = true
        try { client.end() } catch {}
        resolve({ ...result, hostKeyType: seenKeyType, hostKeyFingerprint: seenFingerprint })
      }

      const connectConfig: ConnectConfig = {
        host,
        port,
        username: config.username,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          stage = 'auth'
          const check = checkHostKey(host, port, key)
          seenKeyType = check.seen.type
          seenFingerprint = check.seen.fingerprint
          if (check.status === 'match') return true
          if (check.status === 'changed') { hostKeyProblem = 'changed'; return false }
          // 测试连接不改动信任库: 未知主机只报告指纹
          hostKeyProblem = 'declined'
          return false
        }
      }

      if (auth === 'password') {
        connectConfig.password = config.password
        connectConfig.tryKeyboard = config.tryKeyboard === true
      } else if (auth === 'key') {
        connectConfig.privateKey = privateKeyContent
        connectConfig.passphrase = config.passphrase
      } else if (auth === 'agent') {
        const agent = resolveAgent(config.agentSocket)
        if (agent) connectConfig.agent = agent
      } else {
        // 无密码: 先试服务器的 none 认证, 再试 SSH Agent
        connectConfig.authHandler = ['none', 'agent']
        const agent = resolveAgent(config.agentSocket)
        if (agent) connectConfig.agent = agent
      }

      client.on('ready', () => {
        // 登录成功: 顺手探一次系统, 让用户看到识别结果
        let output = ''
        const done = (remoteOs?: string) => finish({ ok: true, remoteOs })
        try {
          client.exec(PROBE_COMMAND, (err, stream) => {
            if (err) { done(); return }
            stream.on('data', (data: Buffer) => {
              if (output.length < MAX_PROBE_OUTPUT) output += decodeUtf8(data)
            })
            stream.on('close', () => {
              const os = parseProbe(output)
              if (os) { done(osLabel(os)); return }
              let win = ''
              client.exec(WINDOWS_PROBE_COMMAND, (e2, s2) => {
                if (e2) { done(); return }
                s2.on('data', (d: Buffer) => {
                  if (win.length < MAX_PROBE_OUTPUT) win += decodeUtf8(d)
                })
                s2.on('close', () => {
                  const w = parseWindowsProbe(win)
                  done(w ? osLabel(w) : undefined)
                })
                s2.on('error', () => done())
              })
            })
            stream.on('error', () => done())
          })
        } catch { done() }
      })

      client.on('error', (err: Error & { level?: string; code?: string }) => {
        if (hostKeyProblem === 'changed') {
          finish({ ok: false, reason: '主机密钥与已保存的不一致, 连接已中止 (请在主机列表中确认后再连接)' })
          return
        }
        if (hostKeyProblem === 'declined') {
          finish({ ok: false, reason: `未知主机密钥 (${seenKeyType}), 尚未信任。连接一次并确认指纹后即可通过测试` })
          return
        }
        finish({
          ok: false,
          reason: describeSshError({
            error: err,
            auth,
            hasPassword: !!config.password,
            hasKey: !!privateKeyContent,
            hasPassphrase: !!config.passphrase,
            triedKeyboard: config.tryKeyboard === true
          }) + (stage === 'socket' ? ' (失败于建立连接阶段)' : ' (失败于握手/认证阶段)')
        })
      })

      client.on('close', () => {
        if (!settled) finish({ ok: false, reason: '连接在认证完成前被关闭' })
      })

      try {
        client.connect(connectConfig)
      } catch (err) {
        finish({ ok: false, reason: describeSshError({
          error: err as Error,
          auth,
          hasPassword: !!config.password,
          hasKey: !!privateKeyContent,
          hasPassphrase: !!config.passphrase,
          triedKeyboard: config.tryKeyboard === true
        }) })
      }
    })
  })

  /** 信任库信息 (设置面板展示) */
  ipcMain.handle('ssh:known-hosts', (e) => {
    if (!isValidSender(e)) return { path: '', count: 0 }
    return { path: knownHostsPath(), count: knownHostsCount() }
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

  /**
   * 在独立通道上跑一条命令并取回输出。
   *
   * 与 ssh:exec 的区别: 后者把命令写进用户正在用的 shell (会污染终端,
   * 也拿不到输出); 这个开一条自己的通道, 用户看不见, 并能拿到
   * stdout / stderr / 退出码 —— 服务器状态采集就靠它。
   *
   */
  ipcMain.handle('ssh:exec-capture', async (e, id: string, command: string, opts?: { timeoutMs?: number; maxBytes?: number }) => {
    if (!isValidSender(e)) return { ok: false, error: 'unauthorized' }
    const session = sessions.get(id)
    if (!session?.client) return { ok: false, error: '会话不存在' }
    // 命令来自渲染层, 但只允许字符串; 长度设上限避免异常输入
    if (typeof command !== 'string' || command.length === 0 || command.length > 4096) {
      return { ok: false, error: '命令不合法' }
    }
    const timeoutMs = clampNumber(opts?.timeoutMs, 1000, 60000, EXEC_CAPTURE_TIMEOUT_MS)
    const maxBytes = clampNumber(opts?.maxBytes, 1024, 4 * 1024 * 1024, EXEC_CAPTURE_MAX_BYTES)
    const result = await execCapture(session.client, command, timeoutMs, maxBytes)
    // exec 失败时补上中文归因 (execCapture 只拿到原始 message)
    if (!result.ok && !result.error?.includes('超时')) {
      result.error = describeSshError({
        error: new Error(result.error || 'exec failed'),
        auth: 'password', hasPassword: false, hasKey: false,
        hasPassphrase: false, triedKeyboard: false
      })
    }
    return result
  })

  /**
   * 采集远端服务器状态 (Linux)。
   *
   * 五条命令分别采集, 每条单独容错: 服务器差异很大 (没装 docker、没有 df、
   * 极简容器没有 /proc/meminfo), 一条失败不能让整块空掉。
   *
   * CPU 占用率与网络速率必须两次采样求差, 所以把上一次快照存在会话上;
   * 首次调用只返回累计值, cpuUsagePercent 为 null (而不是 0 —— 0 会被
   * 界面显示成「CPU 空闲」, 与事实不符)。
   *
   * 非 Linux 明确返回不支持, 不编造数据。
   */
  ipcMain.handle('ssh:system-status', async (e, id: string) => {
    if (!isValidSender(e)) return { ok: false, error: 'unauthorized', at: Date.now() }
    const session = sessions.get(id)
    if (!session?.client) return { ok: false, error: '会话不存在', at: Date.now() }

    // remoteOs 是异步探测的, 首轮可能还没结果; 只在明确是 windows 时拒绝
    if (session.remoteOs === 'windows') {
      return {
        ok: false,
        error: '服务器状态采集目前只支持 Linux (Windows 无 /proc)',
        at: Date.now()
      }
    }

    // 编排逻辑在 systemStatus.collectSystemStatus 里 —— 与端到端验证共用同一份实现
    const status = await collectSystemStatus(
      (command) => execCapture(session.client, command, STATUS_PROBE_TIMEOUT_MS, STATUS_PROBE_MAX_BYTES),
      session.prevStatus
    )
    // 存「不带差值」的快照: 下次求差用的是累计值, 混入本次的百分比会算错
    session.prevStatus = { ...status, cpuUsagePercent: null, netRates: undefined, sampleIntervalMs: undefined }
    return status
  })


  ipcMain.on('ssh:disconnect', (e, id: string) => {
    if (!isValidSender(e)) return
    cleanupSession(id)
  })

  // S2: SSH 延迟测量 — 独立 exec 通道, 不污染用户 shell
  ipcMain.handle('ssh:ping', async (e, id: string) => {
    if (!isValidSender(e)) return -1
    const session = sessions.get(id)
    if (!session?.client) return -1
    // 选一个无副作用的命令来测往返。
    // remoteOs 是异步探测出来的, 首轮调用时通常还是 undefined,
    // 所以不能只按 remoteOs 选: 猜错会导致首轮延迟测不出来。
    // 做法是依次尝试, 第一个成功的即采纳 (命令本身都不产生副作用)。
    const candidates = session.remoteOs === 'windows'
      ? ['cmd /c ver', 'true']
      : ['true', 'cmd /c ver']
    const start = Date.now()
    return new Promise<number>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (value: number) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }

      const attempt = (index: number) => {
        if (settled) return
        if (index >= candidates.length) { finish(-1); return }
        try {
          session.client.exec(candidates[index], (err, stream) => {
            if (settled) return
            if (err) { attempt(index + 1); return }
            stream.on('close', () => finish(Date.now() - start))
            stream.on('error', () => { attempt(index + 1) })
            stream.resume()
          })
        } catch {
          attempt(index + 1)
        }
      }

      // 服务器不回应时不把 promise 挂着 (否则每 5s 泄漏一个)
      timer = setTimeout(() => finish(-1), 8000)
      attempt(0)
    })
  })

  // --- SFTP --- @deprecated SFTP UI 待 v1.3 实现, 当前无渲染层调用
  /** @deprecated 待 v1.3 SFTP 面板落地 */
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
