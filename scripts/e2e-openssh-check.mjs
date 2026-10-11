/**
 * 对**真实 OpenSSH 服务端**的端到端验证。
 *
 * 与 e2e-ssh-check.mjs 的区别:
 * 后者用 ssh2 的 Server (JS 实现), 本脚本对真 OpenSSH 握手,
 * 因此能覆盖 ssh2 实现覆盖不到的地方 —— 真实的算法协商、真实 shell、
 * 真实 sftp 子系统、真实 host key 类型与 kex 选择。
 *
 * 服务端由 scripts/lib/wsl-openssh.mjs 管理 (WSL 里的 Debian OpenSSH)。
 * 若环境不可用 (没有 WSL / 没有 sshd), 脚本会**明确跳过**并返回 0,
 * 而不是假装通过 —— 之前吃过这个亏。
 *
 * 运行: npm run test:e2e:openssh
 */

import ssh2 from 'ssh2'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openSshAvailable, ensureOpenSshServer, stopOpenSshServer, OPENSSH_USER } from './lib/wsl-openssh.mjs'

const { Client, utils } = ssh2

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n=== 真实 OpenSSH 端到端验证 ===')

const availability = await openSshAvailable()
if (!availability.ok) {
  console.log(`\n  环境不可用: ${availability.reason}`)
  console.log('  本项验证被跳过 (不计入失败)。\n')
  process.exit(0)
}

const buildDir = mkdtempSync(join(tmpdir(), 'shelldesk-ossl-'))
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
const { describeKey, compareKey, hostKeyOf } = await mod('knownHostKey')
const { describeSshError } = await mod('sshErrors')
const { parseProbe, osLabel } = await mod('remoteOs')

const server = await ensureOpenSshServer()
console.log(`服务端 OpenSSH ${server.version} · ${OPENSSH_USER}@127.0.0.1:${server.port}`)
console.log(`(与 ssh2 的 JS 实现不同, 这是真正的 OpenSSH)\n`)

const privateKey = readFileSync(server.clientKeyPath, 'utf-8')

/** 连一次真 OpenSSH, 收集结果 */
function connect({ auth = {}, verifierStore = null, user = OPENSSH_USER, port = server.port, readyTimeout = 10000 } = {}) {
  return new Promise((resolveResult) => {
    const client = new Client()
    const result = {
      ok: false, reason: '', rawError: null, seen: null,
      verifierVerdicts: [], remoteVer: '', algorithms: null
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try { client.end() } catch {}
      resolveResult(result)
    }
    client.on('ready', () => {
      result.ok = true
      result.remoteVer = client._remoteVer || ''
      finish()
    })
    client.on('error', (err) => { result.reason = err.message; result.rawError = err; finish() })
    client.on('close', finish)
    client.on('handshake', (negotiated) => { result.algorithms = negotiated })

    client.connect({
      host: '127.0.0.1', port, username: user, readyTimeout,
      ...auth,
      hostVerifier: (key, verify) => {
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

// --- 1. 真 OpenSSH 握手 ---
console.log('[1] 与真实 OpenSSH 建立连接')
let r = await connect({ auth: { privateKey } })
check('公钥认证连接成功', r.ok, r.reason)
check('服务端标识为 OpenSSH', /OpenSSH/i.test(r.remoteVer), r.remoteVer)
check('拿到主机密钥指纹', r.seen?.fingerprint?.startsWith('SHA256:'), r.seen?.fingerprint)
console.log(`        远端: ${r.remoteVer}`)
console.log(`        host key: ${r.seen?.type} ${r.seen?.fingerprint}`)
if (r.algorithms) {
  console.log(`        kex: ${r.algorithms.kex} · cipher: ${r.algorithms.cs?.cipher} · mac: ${r.algorithms.cs?.mac}`)
  check('协商出了 kex 算法', !!r.algorithms.kex, String(r.algorithms.kex))
  check('协商出了加密算法', !!r.algorithms.cs?.cipher, String(r.algorithms.cs?.cipher))
}

// --- 2. 主机密钥三态 (对真 OpenSSH) ---
console.log('\n[2] 主机密钥校验三态')
const store = { [hostKeyOf('127.0.0.1', server.port)]: r.seen }
r = await connect({ auth: { privateKey }, verifierStore: store })
check('已信任 → 判定 match 并连上', r.ok && r.verifierVerdicts[0] === 'match',
  `${r.ok} / ${r.verifierVerdicts}`)

const tampered = {
  [hostKeyOf('127.0.0.1', server.port)]: {
    type: 'ssh-ed25519',
    key: Buffer.from('not-the-real-host-key').toString('base64'),
    fingerprint: 'SHA256:tampered', addedAt: new Date().toISOString()
  }
}
r = await connect({ auth: { privateKey }, verifierStore: tampered })
check('密钥变更 → 判定 changed 且连接被拒', !r.ok && r.verifierVerdicts[0] === 'changed',
  `${r.ok} / ${r.verifierVerdicts}`)

// --- 3. 真实 exec: OS 探测与延迟 ---
console.log('\n[3] 真实 exec (OS 探测 / ssh:ping)')
const execOut = await new Promise((resolveResult) => {
  const client = new Client()
  const out = { pingOk: false, latencyMs: -1, probeRaw: '', probeOs: null }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolveResult(out) }
  client.on('error', finish); client.on('close', finish)
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
  client.connect({ host: '127.0.0.1', port: server.port, username: OPENSSH_USER, privateKey, hostVerifier: (k, v) => v(true) })
})
check('ping 用的 exec 通道可用', execOut.pingOk)
check('延迟为合理值', execOut.latencyMs >= 0 && execOut.latencyMs < 5000, `${execOut.latencyMs}ms`)
check('真实 os-release 解析为 debian', execOut.probeOs === 'debian', String(execOut.probeOs))
check('osLabel 可读', osLabel(execOut.probeOs) === 'Debian', osLabel(execOut.probeOs))
console.log(`        探测输出: ${JSON.stringify(execOut.probeRaw.slice(0, 70))}`)
console.log(`        解析结果: ${execOut.probeOs} (${osLabel(execOut.probeOs)}) · 延迟 ${execOut.latencyMs}ms`)

// --- 4. 真实 shell (pty) ---
console.log('\n[4] 真实 shell 与 pty')
const shellOut = await new Promise((resolveResult) => {
  const client = new Client()
  const out = { gotPrompt: false, echoed: false, sample: '' }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolveResult(out) }
  client.on('error', finish); client.on('close', finish)
  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
      if (err) { finish(); return }
      let acc = ''
      stream.on('data', (d) => {
        acc += d.toString('utf-8')
        if (!out.gotPrompt && acc.length > 0) { out.gotPrompt = true; out.sample = acc.slice(0, 80) }
        if (acc.includes('REAL_SHELL_OK')) { out.echoed = true; finish() }
      })
      setTimeout(() => { try { stream.write('echo REAL_SHELL_OK\n') } catch { finish() } }, 250)
      setTimeout(finish, 4000)
    })
  })
  client.connect({ host: '127.0.0.1', port: server.port, username: OPENSSH_USER, privateKey, hostVerifier: (k, v) => v(true) })
})
check('真实 shell 有输出 (prompt/banner)', shellOut.gotPrompt)
check('真实 shell 执行并回显了命令', shellOut.echoed)
console.log(`        shell 首段输出: ${JSON.stringify(shellOut.sample.slice(0, 60))}`)

// --- 5. 真实 sftp 子系统 ---
console.log('\n[5] 真实 sftp 子系统')
const sftpOut = await new Promise((resolveResult) => {
  const client = new Client()
  const out = { ok: false, listed: 0, err: '' }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolveResult(out) }
  client.on('error', (e) => { out.err = e.message; finish() })
  client.on('close', finish)
  client.on('ready', () => {
    client.sftp((err, sftp) => {
      if (err) { out.err = err.message; finish(); return }
      out.ok = true
      sftp.readdir('/tmp/osshtest', (err2, list) => {
        if (!err2) out.listed = list.length
        finish()
      })
    })
  })
  client.connect({ host: '127.0.0.1', port: server.port, username: OPENSSH_USER, privateKey, hostVerifier: (k, v) => v(true) })
})
check('sftp 子系统可打开 (v1.3 的 SFTP 面板前提)', sftpOut.ok, sftpOut.err)
check('sftp readdir 能列出目录', sftpOut.listed > 0, `列出 ${sftpOut.listed} 项`)

// --- 6. 错误翻译 (真 OpenSSH 的错误) ---
console.log('\n[6] 真 OpenSSH 的错误 → 中文')
// 用错误的用户
r = await connect({ auth: { privateKey }, user: 'no-such-user-xyz' })
check('不存在的用户被拒', !r.ok, '竟然连上了')
const t1 = describeSshError({
  error: r.rawError, auth: 'key', hasPassword: false, hasKey: true,
  hasPassphrase: false, triedKeyboard: false
})
check('译文为「未接受该私钥」', /未接受该私钥|authorized_keys/.test(t1), t1)
console.log(`        原始: ${r.reason}`)
console.log(`        中文: ${t1}`)

// 用无效私钥
const bogusKey = utils.generateKeyPairSync('ed25519').private
r = await connect({ auth: { privateKey: bogusKey } })
check('未授权的私钥被拒', !r.ok, '竟然连上了')
const t2 = describeSshError({
  error: r.rawError, auth: 'key', hasPassword: false, hasKey: true,
  hasPassphrase: false, triedKeyboard: false
})
check('译文可操作', /未接受该私钥|authorized_keys/.test(t2), t2)
console.log(`        原始: ${r.reason}`)
console.log(`        中文: ${t2}`)

// --- 7. 密码认证被 OpenSSH 拒绝 ---
console.log('\n[7] OpenSSH 关闭密码认证时的行为')
r = await connect({ auth: { password: 'whatever' } })
check('密码方式被拒', !r.ok, '竟然连上了')
const t3 = describeSshError({
  error: r.rawError, auth: 'password', hasPassword: true, hasKey: false,
  hasPassphrase: false, triedKeyboard: false
})
check('译文为「用户名或密码错误」', t3 === '用户名或密码错误', t3)

// --- 8. keepalive 在真 OpenSSH 上不被断开 ---
console.log('\n[8] keepalive 与长时间空闲')
const kaOut = await new Promise((resolveResult) => {
  const client = new Client()
  const out = { stayedConnected: false, elapsed: 0 }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolveResult(out) }
  client.on('error', finish); client.on('close', finish)
  client.on('ready', () => {
    const start = Date.now()
    // 空闲 6 秒, keepalive 每 2 秒发一次
    setTimeout(() => {
      out.stayedConnected = true
      out.elapsed = Date.now() - start
      finish()
    }, 6000)
  })
  client.connect({
    host: '127.0.0.1', port: server.port, username: OPENSSH_USER, privateKey,
    keepaliveInterval: 2000, keepaliveCountMax: 3,
    hostVerifier: (k, v) => v(true)
  })
})
check('空闲 6s 内 keepalive 未导致断开', kaOut.stayedConnected, `${kaOut.elapsed}ms`)

await stopOpenSshServer()
rmSync(buildDir, { recursive: true, force: true })

console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===\n`)
process.exit(failed > 0 ? 1 : 0)
