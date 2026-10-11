/**
 * 测试用 SSH 服务端 (基于 ssh2 的 Server 实现)。
 *
 * 为什么自己起服务端: 本机没有 sshd, 而端到端验证必须要有真实的握手对端。
 * 这个服务端刻意做成可控的, 以便验证客户端在不同服务器行为下的表现:
 * - 可指定接受哪种认证 (公钥 / 密码 / 键盘交互)
 * - 可拒绝 exec 通道 (验证探测失败时的降级)
 * - 可返回指定的 uname/os-release 输出 (验证 OS 探测解析)
 *
 * 只监听 127.0.0.1, 仅用于本地测试。
 */

// ssh2 是 CommonJS 模块, 具名导出在 ESM 下不可靠, 走 default 再解构
import ssh2 from 'ssh2'

const { Server, utils } = ssh2

/**
 * 生成主机密钥 (OpenSSH 私钥字符串)。
 * 用 ssh2 自带的 generateKeyPairSync: node:crypto 导出的 PKCS8 PEM
 * 在 ssh2 的 parseKey 里是 "Unsupported key format"。
 * Server 的 hostKeys 要原始密钥字符串, 不是 ParsedKey。
 */
export function generateHostKey() {
  const { private: privateKey } = utils.generateKeyPairSync('ed25519')
  return privateKey
}

/** 生成客户端私钥 (用于公钥认证) */
export function generateClientKey() {
  const { private: privateKey } = utils.generateKeyPairSync('ed25519')
  return { privateKey }
}

/**
 * 启动一个测试服务端。
 *
 * options:
 * - acceptPublicKey: 是否接受公钥认证 (默认 true)
 * - acceptPassword: 是否接受密码认证 (默认 false)
 * - password: 接受密码认证时的正确密码
 * - acceptKeyboard: 是否接受键盘交互认证
 * - allowExec: 是否允许 exec 通道 (默认 true); 关掉可验证探测的降级
 * - probeOutput: `uname -s; cat /etc/os-release` 的输出
 * - shellBanner: shell 建立后打印的内容
 *
 * 返回 { port, close(), connections, rejectedExec }
 */
export function startTestServer(options = {}) {
  const {
    acceptPublicKey = true,
    acceptPassword = false,
    password = 'correct-password',
    acceptKeyboard = false,
    allowExec = true,
    probeOutput = 'Linux\nID=ubuntu\nID_LIKE=debian\n',
    windowsProbeOutput = 'Microsoft Windows [Version 10.0.19045.4291]\n',
    shellBanner = 'welcome\r\n$ '
  } = options

  const state = {
    connections: 0,
    authAttempts: { publickey: 0, password: 0, 'keyboard-interactive': 0, none: 0 },
    execs: [],
    rejectedExec: 0,
    ptyRequests: 0,
    shellRequests: 0,
    resizes: [],
    /** 记录客户端提交的公钥, 便于断言 */
    offeredKeys: []
  }

  const server = new Server({
    hostKeys: [generateHostKey()]
  }, (client) => {
    state.connections++

    client.on('authentication', (ctx) => {
      const method = ctx.method
      state.authAttempts[method] = (state.authAttempts[method] || 0) + 1

      if (method === 'none') {
        // 服务器不接受免认证
        return ctx.reject(['publickey', 'password'])
      }
      if (method === 'publickey') {
        if (!acceptPublicKey) return ctx.reject(['password'])
        state.offeredKeys.push(ctx.key.algo)
        return ctx.accept()
      }
      if (method === 'password') {
        if (!acceptPassword) return ctx.reject(['publickey'])
        if (ctx.password === password) return ctx.accept()
        return ctx.reject(['publickey', 'password'])
      }
      if (method === 'keyboard-interactive') {
        if (!acceptKeyboard) return ctx.reject(['publickey'])
        // 回一个需要回答的提问
        if (ctx.prompt) return ctx.prompt([{ prompt: 'Verification code: ', echo: false }], (answers) => {
          if (answers && answers[0] === '123456') ctx.accept()
          else ctx.reject(['publickey'])
        })
        return ctx.accept()
      }
      return ctx.reject(['publickey'])
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        session.on('pty', (acceptPty) => {
          state.ptyRequests++
          acceptPty?.()
        })

        session.on('window-change', (acceptResize, _reject, info) => {
          state.resizes.push({ cols: info.cols, rows: info.rows })
          acceptResize?.()
        })

        session.on('shell', (acceptShell) => {
          state.shellRequests++
          const stream = acceptShell()
          stream.write(shellBanner)
          stream.on('data', (d) => {
            // 回显, 便于验证终端写入通路
            stream.write(d)
          })
        })

        session.on('exec', (acceptExec, rejectExec, info) => {
          const command = info.command
          state.execs.push(command)
          if (!allowExec) {
            state.rejectedExec++
            rejectExec()
            return
          }
          const stream = acceptExec()
          if (command.includes('uname')) {
            stream.write(probeOutput)
          } else if (command.includes('ver')) {
            stream.write(windowsProbeOutput)
          } else if (command === 'true' || command === 'ver') {
            // 延迟测量用: 无输出
          } else {
            stream.write(`ran: ${command}\n`)
          }
          stream.exit(0)
          stream.end()
        })
      })
    })

    client.on('error', () => { /* 测试中忽略连接层错误 */ })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        state,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}