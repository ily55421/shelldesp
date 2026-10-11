/**
 * 用真实 SSH 服务端产生的真实错误, 验证 describeSshError 的翻译。
 *
 * e2e-ssh-check.mjs 只断言译文「含中文」; 这里把每种失败场景的
 * 原始英文错误与最终中文并列打印出来, 便于人工核对措辞是否可操作。
 *
 * 运行: npm run test:e2e:errors
 */

import ssh2 from 'ssh2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { build } from 'esbuild'
import { startTestServer, generateClientKey } from './lib/test-ssh-server.mjs'

const { Client } = ssh2

/** 拿一个确定没人监听的端口: 先绑再立刻释放 */
function findClosedPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

const buildDir = mkdtempSync(join(tmpdir(), 'shelldesk-err-'))
await build({
  entryPoints: [resolve('electron/main/sshErrors.ts')],
  outdir: buildDir, bundle: true, platform: 'node', format: 'esm',
  target: 'node20', logLevel: 'silent'
})
const { describeSshError } = await import(pathToFileURL(join(buildDir, 'sshErrors.js')).href)

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** 连一次并拿回错误 (服务端行为可控) */
function connectForError({ port, auth = {}, readyTimeout = 8000 }) {
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    const finish = (v) => { if (settled) return; settled = true; try { client.end() } catch {}; resolve(v) }
    client.on('ready', () => finish({ ok: true }))
    client.on('error', (err) => finish({ ok: false, error: err }))
    client.on('close', () => finish({ ok: false, error: new Error('closed without error') }))
    client.connect({
      host: '127.0.0.1', port, username: 'tester', readyTimeout,
      ...auth,
      hostVerifier: (k, v) => v(true)
    })
  })
}

/** 跑一次翻译并打印对照 */
async function scenario(name, { port, auth = {}, authKind = 'password', hasPassword, hasKey, hasPassphrase = false, triedKeyboard = false }, expect) {
  const res = await connectForError({ port, auth })
  if (res.ok) { check(`${name} — 应当失败`, false, '竟然连上了'); return }
  const translated = describeSshError({
    error: res.error,
    auth: authKind,
    hasPassword: hasPassword ?? (authKind === 'password'),
    hasKey: hasKey ?? (authKind === 'key'),
    hasPassphrase,
    triedKeyboard
  })
  console.log(`\n  场景: ${name}`)
  console.log(`    原始 : ${res.error.message}`)
  console.log(`    中文 : ${translated}`)
  const isAscii = /^[\x20-\x7E]+$/.test(translated)
  check(`${name} — 已翻译`, !isAscii, `仍是英文: ${translated}`)
  if (expect) check(`${name} — 措辞正确`, expect.test(translated), `实际: ${translated}`)
}

console.log('\n=== SSH 错误翻译的端到端验证 (真实服务端产生的错误) ===')

// 服务端只接受公钥
const pubkeyOnly = await startTestServer()
const clientKey = generateClientKey()

const closedPort = await findClosedPort()

await scenario('端口未监听', {
  port: closedPort,
  auth: { privateKey: clientKey.privateKey },
  authKind: 'key'
}, /连接被拒绝|没有服务在监听/)

await scenario('服务器不接受密码 (填了密码)', {
  port: pubkeyOnly.port,
  auth: { password: 'anything' },
  authKind: 'password',
  hasPassword: true
}, /用户名或密码错误/)

await scenario('密码方式但没填密码', {
  port: pubkeyOnly.port,
  auth: {},
  authKind: 'password',
  hasPassword: false
}, /未填写密码/)

await scenario('无密码模式遇到要认证的服务器', {
  port: pubkeyOnly.port,
  auth: {},
  authKind: 'nopassword',
  hasPassword: false
}, /无密码|密码/)

await scenario('Agent 模式但无可用密钥', {
  port: pubkeyOnly.port,
  auth: {},
  authKind: 'agent',
  hasPassword: false
}, /Agent/)

await scenario('密钥方式但未选私钥', {
  port: pubkeyOnly.port,
  auth: {},
  authKind: 'key',
  hasKey: false
}, /未选择私钥|私钥/)

await scenario('主机不可达 (保留原文或给出说明)', {
  port: 1,
  auth: { privateKey: clientKey.privateKey },
  authKind: 'key'
}, null)

await pubkeyOnly.close()

// 服务端只接受密码: 验证「密钥被拒」的措辞
const passwordOnly = await startTestServer({ acceptPublicKey: false, acceptPassword: true })
await scenario('服务器不接受公钥 (用了密钥)', {
  port: passwordOnly.port,
  auth: { privateKey: clientKey.privateKey },
  authKind: 'key',
  hasKey: true
}, /未接受该私钥|authorized_keys/)
await passwordOnly.close()

rmSync(buildDir, { recursive: true, force: true })
console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===\n`)
process.exit(failed > 0 ? 1 : 0)
