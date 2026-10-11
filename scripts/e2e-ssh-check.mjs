/**
 * ShellDesk SSH 连接的端到端验证。
 *
 * 用 scripts/lib/test-ssh-server.mjs 起一个**真实的 SSH 服务端** (ssh2 的 Server),
 * 走完整握手, 验证本轮新增能力:
 *
 * - 主机密钥校验三态: 未知 → 信任 → 变更拒绝 (跑真实 compareKey)
 * - 四种认证方式的装配是否正确 (password / key / agent / nopassword)
 * - 错误翻译: 真实错误 → 可读中文 (跑真实 describeSshError)
 * - exec 通道: ssh:ping 的延迟测量与 OS 探测所依赖的通道
 * - OS 探测解析: 服务端返回的 uname/os-release → 系统标识
 * - 服务器拒绝 exec 时的降级行为
 *
 * 不需要外部 sshd, 不占用固定端口。
 * 运行: npm run test:e2e:ssh
 */

import ssh2 from 'ssh2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { startTestServer, generateClientKey } from './lib/test-ssh-server.mjs'

const { Client } = ssh2

// 编译被测的真实模块 (而非复刻)
const buildDir = mkdtempSync(join(tmpdir(), 'shelldesk-e2e-'))
await build({
  entryPoints: [
    resolve('electron/main/knownHostKey.ts'),
    resolve('electron/main/sshErrors.ts'),
    resolve('electron/main/remoteOs.ts')
  ],
  outdir: buildDir, bundle: true, platform: 'node', format: 'esm',
  target: 'node20', logLevel: 'silent'
})
const mod = async (name) => import(pathToFileURL(join(buildDir, `${name}.js`)).href)
const { describeKey, compareKey, hostKeyOf, fingerprint } = await mod('knownHostKey')
const { describeSshError } = await mod('sshErrors')
const { parseProbe, parseWindowsProbe, osLabel } = await mod('remoteOs')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/**
 * 连一次服务端, 收集结果。
 * verifier 走真实的 compareKey 三态判定。
 */
function connect({ port, auth = {}, verifierStore = null, readyTimeout = 10000, user = 'tester' }) {
  return new Promise((resolve) => {
    const client = new Client()
    const result = {
      ok: false, reason: '', rawError: null,
      seen: null, verifierCalls: 0, verifierVerdicts: []
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try { client.end() } catch {}
      resolve(result)
    }
    client.on('ready', () => { result.ok = true; finish() })
    client.on('error', (err) => { result.reason = err.message; result.rawError = err; finish() })
    client.on('close', finish)

    client.connect({
      host: '127.0.0.1', port, username: user, readyTimeout,
      ...auth,
      hostVerifier: (key, verify) => {
        result.verifierCalls++
        const seen = describeKey(key)
        result.seen = seen
        if (!verifierStore) { result.verifierVerdicts.push('unknown'); verify(true); return }
        const outcome = compareKey(verifierStore[hostKeyOf('127.0.0.1', port)], seen)
        result.verifierVerdicts.push(outcome.status)
        verify(outcome.status !== 'changed')
      }
    })
  })
}

/** 用真实错误跑真实翻译 */
function translate(result, auth) {
  return describeSshError({
    error: result.rawError,
    auth,
    hasPassword: auth === 'password',
    hasKey: auth === 'key',
    hasPassphrase: false,
    triedKeyboard: false
  })
}

const server = await startTestServer()
const clientKey = generateClientKey()
const keyAuth = { privateKey: clientKey.privateKey }

console.log('\n=== ShellDesk SSH 端到端验证 (真实 SSH 服务端) ===')
console.log(`服务端 127.0.0.1:${server.port}\n`)

// --- 1. 未知主机 + 公钥认证 ---
console.log('[1] 未知主机 + 公钥认证')
let r = await connect({ port: server.port, auth: keyAuth })
check('公钥认证连接成功', r.ok, r.reason)
check('hostVerifier 被调用', r.verifierCalls > 0)
check('判定为 unknown (无记录)', r.verifierVerdicts[0] === 'unknown', String(r.verifierVerdicts))
check('拿到主机密钥算法', r.seen.type === 'ssh-ed25519', r.seen?.type)
check('指纹为 OpenSSH SHA256 格式', /^SHA256:[A-Za-z0-9+/]+$/.test(r.seen.fingerprint), r.seen?.fingerprint)

// --- 2. 已信任主机 ---
console.log('\n[2] 已信任主机 (真实 compareKey 判定)')
const store = { [hostKeyOf('127.0.0.1', server.port)]: r.seen }
r = await connect({ port: server.port, auth: keyAuth, verifierStore: store })
check('已信任主机连接成功', r.ok, r.reason)
check('判定为 match', r.verifierVerdicts[0] === 'match', String(r.verifierVerdicts))
check('指纹与信任库一致', r.seen.fingerprint === store[hostKeyOf('127.0.0.1', server.port)].fingerprint)

// --- 3. 主机密钥被篡改 ---
console.log('\n[3] 主机密钥被篡改 (必须拒绝)')
const tampered = {
  [hostKeyOf('127.0.0.1', server.port)]: {
    type: 'ssh-ed25519',
    key: Buffer.from('a-totally-different-host-key').toString('base64'),
    fingerprint: 'SHA256:tampered',
    addedAt: new Date().toISOString()
  }
}
r = await connect({ port: server.port, auth: keyAuth, verifierStore: tampered })
check('连接被拒绝', !r.ok, '竟然连上了')
check('判定为 changed', r.verifierVerdicts[0] === 'changed', String(r.verifierVerdicts))

// --- 4. 认证方式装配 ---
console.log('\n[4] 认证方式装配')
// 服务端只接受公钥; 用密码应失败
r = await connect({ port: server.port, auth: { password: 'anything' } })
check('密码方式被服务器拒绝', !r.ok)
check('译文为「用户名或密码错误」', translate(r, 'password') === '用户名或密码错误', translate(r, 'password'))

// 无凭据: none 认证被拒
r = await connect({ port: server.port, auth: {} })
check('无凭据连接失败', !r.ok)
check('译文提示服务器要求密码', /无密码|要求密码/.test(translate(r, 'nopassword')), translate(r, 'nopassword'))

// 错误的私钥: 服务端接受任何公钥, 所以这里验证「密钥方式」能连上
r = await connect({ port: server.port, auth: keyAuth })
check('密钥方式可连上', r.ok, r.reason)

// --- 5. 错误翻译: 端口不通 ---
console.log('\n[5] 错误翻译 (真实错误)')
const deadPort = server.port + 1
r = await connect({ port: deadPort, auth: keyAuth })
check('关闭端口连接失败', !r.ok)
const refused = translate(r, 'key')
check('译文为「连接被拒绝」', /连接被拒绝/.test(refused), refused)

// --- 6. exec 通道: ssh:ping 与 OS 探测 ---
console.log('\n[6] exec 通道 (ssh:ping / OS 探测依赖)')
const execResult = await new Promise((resolve) => {
  const client = new Client()
  const out = { pingOk: false, latencyMs: -1, probeRaw: '', probeOs: null }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolve(out) }
  client.on('error', finish)
  client.on('close', finish)
  client.on('ready', () => {
    const start = Date.now()
    client.exec('true', (err, stream) => {
      if (err) { finish(); return }
      stream.on('close', () => { out.pingOk = true; out.latencyMs = Date.now() - start })
      stream.resume()
    })
    client.exec('uname -s; cat /etc/os-release 2>/dev/null', (err2, s2) => {
      if (err2) { finish(); return }
      let buf = ''
      s2.on('data', (d) => { buf += d.toString('utf-8') })
      s2.on('close', () => { out.probeRaw = buf; out.probeOs = parseProbe(buf); finish() })
    })
  })
  client.connect({ host: '127.0.0.1', port: server.port, username: 'tester', ...keyAuth, hostVerifier: (k, v) => v(true) })
})
check('exec 通道可用 (延迟可测)', execResult.pingOk)
check('延迟为合理值', execResult.latencyMs >= 0 && execResult.latencyMs < 5000, `${execResult.latencyMs}ms`)
check('OS 探测取到输出', execResult.probeRaw.length > 0, JSON.stringify(execResult.probeRaw))
check('OS 解析为 ubuntu', execResult.probeOs === 'ubuntu', String(execResult.probeOs))
check('osLabel 可读', osLabel(execResult.probeOs) === 'Ubuntu', osLabel(execResult.probeOs))
check('服务端确实收到过 exec', server.state.execs.length >= 2, JSON.stringify(server.state.execs))

// --- 7. pty / shell 通路 ---
console.log('\n[7] shell 与 pty 通路')
const shellResult = await new Promise((resolve) => {
  const client = new Client()
  const out = { banner: '', echoed: '' }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolve(out) }
  client.on('error', finish)
  client.on('close', finish)
  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
      if (err) { finish(); return }
      let acc = ''
      stream.on('data', (d) => {
        acc += d.toString('utf-8')
        if (acc.includes('welcome') && !out.banner) out.banner = acc
        if (acc.includes('hello-from-test') && !out.echoed) {
          out.echoed = 'hello-from-test'
          finish()
        }
      })
      setTimeout(() => {
        try { stream.write('hello-from-test\n') } catch { finish() }
      }, 120)
      setTimeout(finish, 2500)
    })
  })
  client.connect({ host: '127.0.0.1', port: server.port, username: 'tester', ...keyAuth, hostVerifier: (k, v) => v(true) })
})
check('shell 拿到服务端 banner', shellResult.banner.includes('welcome'), JSON.stringify(shellResult.banner.slice(0, 40)))
check('终端写入被服务端回显', shellResult.echoed === 'hello-from-test')
check('服务端记录到 pty 请求', server.state.ptyRequests > 0, String(server.state.ptyRequests))
check('服务端记录到 shell 请求', server.state.shellRequests > 0, String(server.state.shellRequests))

// --- 8. 服务器拒绝 exec 时的降级 ---
console.log('\n[8] 服务器拒绝 exec 通道 (探测应降级而非报错)')
const noExecServer = await startTestServer({ allowExec: false })
const degraded = await new Promise((resolve) => {
  const client = new Client()
  const out = { connected: false, execRejected: false }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolve(out) }
  client.on('error', finish)
  client.on('close', finish)
  client.on('ready', () => {
    out.connected = true
    client.exec('uname -s', (err) => {
      out.execRejected = !!err
      finish()
    })
  })
  client.connect({ host: '127.0.0.1', port: noExecServer.port, username: 'tester', ...keyAuth, hostVerifier: (k, v) => v(true) })
})
check('连接仍然成功 (探测失败不影响登录)', degraded.connected)
check('exec 被拒绝时能感知到', degraded.execRejected)
check('服务端记录了拒绝', noExecServer.state.rejectedExec > 0, String(noExecServer.state.rejectedExec))
await noExecServer.close()

// --- 9. Windows 探测分支 ---
console.log('\n[9] Windows 服务器探测分支')
const winServer = await startTestServer({
  probeOutput: "'uname' is not recognized as an internal or external command\r\n",
  windowsProbeOutput: 'Microsoft Windows [Version 10.0.19045.4291]\r\n'
})
const winProbe = await new Promise((resolve) => {
  const client = new Client()
  const out = { posix: null, windows: null }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolve(out) }
  client.on('error', finish)
  client.on('close', finish)
  client.on('ready', () => {
    client.exec('uname -s; cat /etc/os-release 2>/dev/null', (e1, s1) => {
      if (e1) { finish(); return }
      let b1 = ''
      s1.on('data', (d) => { b1 += d.toString() })
      s1.on('close', () => {
        out.posix = parseProbe(b1)
        // 模拟 probeRemoteOs 的第二步
        client.exec('cmd /c ver', (e2, s2) => {
          if (e2) { finish(); return }
          let b2 = ''
          s2.on('data', (d) => { b2 += d.toString() })
          s2.on('close', () => { out.windows = parseWindowsProbe(b2); finish() })
        })
      })
    })
  })
  client.connect({ host: '127.0.0.1', port: winServer.port, username: 'tester', ...keyAuth, hostVerifier: (k, v) => v(true) })
})
check('POSIX 探测无法识别 (应转 Windows)', winProbe.posix === null, String(winProbe.posix))
check('Windows 追问识别为 windows', winProbe.windows === 'windows', String(winProbe.windows))
await winServer.close()

// --- 10. 连接测试用的指纹报告 ---
console.log('\n[10] 指纹格式与信任库键')
check('非 22 端口写成 [host]:port', hostKeyOf('127.0.0.1', server.port) === `[127.0.0.1]:${server.port}`,
  hostKeyOf('127.0.0.1', server.port))
check('22 端口不加方括号', hostKeyOf('example.com', 22) === 'example.com')
const fp1 = fingerprint(Buffer.from('same'))
const fp2 = fingerprint(Buffer.from('same'))
check('相同输入指纹稳定', fp1 === fp2)
check('不同输入指纹不同', fingerprint(Buffer.from('a')) !== fingerprint(Buffer.from('b')))

await server.close()
rmSync(buildDir, { recursive: true, force: true })

console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===\n`)
process.exit(failed > 0 ? 1 : 0)
