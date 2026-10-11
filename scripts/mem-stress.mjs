/**
 * 内存压力测试: 大输出下的滚动缓冲占用与回收。
 *
 * 为什么单独测这个: 基线测试证明 Electron 本体只占 ~300 MB、
 * 每标签增量很小。真正可能失控的是「终端刷出大量输出」——
 * xterm 的 scrollback (渲染进程) 与主进程的 pausedBuffer 都按量增长。
 *
 * 观察点:
 * - 渲染 JS 堆增长 (xterm scrollback 在这里)
 * - 主进程 WorkingSet 增长 (pausedBuffer / 会话缓冲)
 * - 关闭标签后是否回收
 *
 * 环境不可用时明确跳过 (返回 0)。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openSshAvailable, ensureOpenSshServer, stopOpenSshServer, OPENSSH_USER } from './lib/wsl-openssh.mjs'

const MB = 1024 * 1024
const fmt = (b) => (b / MB).toFixed(1)

async function freePort() {
  const net = await import('node:net')
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)) })
  })
}

/** 按角色细分进程树内存 */
function procsByRole(rootPid) {
  const ps = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, CommandLine',
    '$out = New-Object System.Collections.ArrayList',
    '$queue = New-Object System.Collections.Queue',
    `$queue.Enqueue(${rootPid})`,
    'while ($queue.Count -gt 0) {',
    '  $cur = $queue.Dequeue()',
    '  $kids = $all | Where-Object { $_.ParentProcessId -eq $cur }',
    '  foreach ($k in $kids) {',
    '    $role = "main"',
    '    if ($k.CommandLine -match "--type=renderer") { $role = "renderer" }',
    '    elseif ($k.CommandLine -match "--type=gpu-process") { $role = "gpu" }',
    '    elseif ($k.CommandLine -match "--type=utility") { $role = "utility" }',
    '    elseif ($k.Name -notmatch "electron") { $role = $k.Name }',
    '    [void]$out.Add("$role|$($k.WorkingSetSize)")',
    '    $queue.Enqueue($k.ProcessId)',
    '  }',
    '}',
    '$out | ForEach-Object { $_ }'
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf-8' })
    const agg = {}
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [role, ws] = line.trim().split('|')
      agg[role] = agg[role] || { count: 0, ws: 0 }
      agg[role].count++
      agg[role].ws += Number(ws)
    }
    return agg
  } catch { return {} }
}

console.log('\n=== ShellDesk 大输出内存压力测试 ===\n')

const avail = await openSshAvailable()
if (!avail.ok) {
  console.log(`WSL OpenSSH 不可用 (${avail.reason}) — 跳过\n`)
  process.exit(0)
}
const server = await ensureOpenSshServer()
console.log(`OpenSSH ${server.version} · ${OPENSSH_USER}@127.0.0.1:${server.port}\n`)

const port = await freePort()
const userDataDir = mkdtempSync(join(tmpdir(), 'shelldesk-stress-'))
const sshDir = join(process.env.USERPROFILE || '', '.ssh')
mkdirSync(sshDir, { recursive: true })
const uiKeyPath = join(sshDir, 'shelldesk-stress.key')
writeFileSync(uiKeyPath, readFileSync(server.clientKeyPath, 'utf-8'))

const ssh2 = (await import('ssh2')).default
const hostKey = await new Promise((res) => {
  const c = new ssh2.Client()
  let done = false
  c.on('error', () => { if (!done) { done = true; res(null) } })
  c.connect({
    host: '127.0.0.1', port: server.port, username: OPENSSH_USER,
    privateKey: readFileSync(server.clientKeyPath, 'utf-8'), readyTimeout: 15000,
    hostVerifier: (key, verify) => {
      if (!done) {
        done = true
        const len = key.readUInt32BE(0)
        res({
          type: key.subarray(4, 4 + len).toString('ascii'),
          key: key.toString('base64'),
          fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`,
          addedAt: new Date().toISOString()
        })
      }
      verify(false)
    }
  })
})
mkdirSync(join(userDataDir, 'config'), { recursive: true })
writeFileSync(join(userDataDir, 'config', 'known_hosts.json'),
  JSON.stringify({ [`[127.0.0.1]:${server.port}`]: hostKey }, null, 2))

const child = spawn(resolve('node_modules/electron/dist/electron.exe'),
  ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userDataDir}`],
  { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
const mainPid = child.pid

let wsUrl = null
for (let i = 0; i < 150; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const p = list.find((t) => t.type === 'page' && /renderer/.test(t.url))
    if (p) { wsUrl = p.webSocketDebuggerUrl; break }
  } catch { /* 未就绪 */ }
  await new Promise((r) => setTimeout(r, 300))
}
if (!wsUrl) { console.log('CDP 失败'); child.kill(); process.exit(1) }

const ws = new WebSocket(wsUrl)
const pending = new Map()
let id = 0
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id === undefined) return
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.error) p.rej(new Error(JSON.stringify(m.error)))
  else p.res(m.result)
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const myId = ++id
  pending.set(myId, { res, rej })
  ws.send(JSON.stringify({ id: myId, method, params }))
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error(`timeout ${method}`)) } }, 180000)
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err')
  return r.result.value
}
await send('Runtime.enable')
await new Promise((r) => setTimeout(r, 4500))

async function heap() {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const p = performance.memory || {}
      return { jsHeapUsed: p.usedJSHeapSize || 0, domNodes: document.getElementsByTagName('*').length }
    })()`,
    returnByValue: true
  })
  return r.result.value
}

async function report(label, prev) {
  const procs = procsByRole(mainPid)
  const m = await heap()
  const total = Object.values(procs).reduce((s, v) => s + v.ws, 0)
  const d = (v, p) => (p === undefined || p === null) ? '' : `  (${v - p > 0 ? '+' : ''}${fmt(v - p)} MB)`
  console.log(`【${label}】`)
  console.log(`  总计          : ${fmt(total)} MB${d(total, prev?.total)}`)
  for (const [role, v] of Object.entries(procs)) {
    console.log(`    ${role.padEnd(10)} ${String(v.count).padStart(2)} 个  ${fmt(v.ws).padStart(7)} MB${d(v.ws, prev?.procs[role]?.ws)}`)
  }
  console.log(`  渲染 JS 堆    : ${fmt(m.jsHeapUsed)} MB${d(m.jsHeapUsed, prev?.m.jsHeapUsed)}`)
  console.log(`  DOM 节点      : ${m.domNodes}`)
  console.log('')
  return { total, procs, m }
}

/** 连一个 SSH 标签 (用加号菜单 + 填表) */
async function connectSsh() {
  await evaluate(`(() => { document.querySelector('.tab-new').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 300))
  await evaluate(`(() => {
    const i = [...document.querySelectorAll('.new-menu .menu-item')].find(x => /SSH/.test(x.innerText))
    if (i) i.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await evaluate(`(() => {
    const d = document.querySelector('.modal')
    if (!d) return false
    const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})) }
    const inputs = [...d.querySelectorAll('input.input')]
    setVal(inputs[0], 'STRESS'); setVal(inputs[1], '127.0.0.1')
    setVal(inputs[2], '${server.port}'); setVal(inputs[3], '${OPENSSH_USER}')
    const kt = [...d.querySelectorAll('.auth-tab')].find(t => t.innerText.trim() === '密钥')
    if (kt) kt.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  await evaluate(`(() => {
    const d = document.querySelector('.modal')
    const ki = [...d.querySelectorAll('input.input')].find(i => i.placeholder && i.placeholder.includes('.ssh'))
    if (ki) { ki.value = ${JSON.stringify(uiKeyPath)}; ki.dispatchEvent(new Event('input',{bubbles:true})) }
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.modal-actions .btn')].find(x => x.innerText.trim() === '连接')
    if (b) b.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 6000))
}

/** 在终端里敲命令并回车 (真实键盘事件) */
async function runInTerminal(cmd) {
  for (const ch of cmd) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch })
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

await connectSsh()
const base = await report('SSH 已连接 (空闲)')

// 点终端确保焦点在 xterm 上
await evaluate(`(() => { const t = document.querySelector('.xterm-helper-textarea'); if (t) t.focus(); return true })()`)

console.log('--- 刷 50000 行 ---')
await runInTerminal("seq 1 50000 | sed 's/^/SHELLDESK_STRESS_/'")
await new Promise((r) => setTimeout(r, 15000))
const s1 = await report('刷 50000 行后', base)

console.log('--- 再刷 200000 行 ---')
await runInTerminal("seq 1 200000 | sed 's/^/SHELLDESK_STRESS_/'")
await new Promise((r) => setTimeout(r, 30000))
const s2 = await report('刷 200000 行后', s1)

console.log('--- 再刷 400000 行 ---')
await runInTerminal("seq 1 400000 | sed 's/^/SHELLDESK_STRESS_/'")
await new Promise((r) => setTimeout(r, 45000))
const s3 = await report('刷 400000 行后', s2)

console.log('--- 关闭 SSH 标签, 观察回收 ---')
await evaluate(`(() => {
  const c = [...document.querySelectorAll('.tab .t-close')]
  if (c.length) c[c.length - 1].click()
  return true
})()`)
await new Promise((r) => setTimeout(r, 8000))
const s4 = await report('关闭标签后', s3)

console.log('=== 汇总 ===')
console.log(`  空闲基线         : ${fmt(base.total)} MB`)
console.log(`  刷 50000 行      : ${fmt(s1.total)} MB  (${s1.total - base.total > 0 ? '+' : ''}${fmt(s1.total - base.total)})`)
console.log(`  刷 200000 行     : ${fmt(s2.total)} MB  (${s2.total - s1.total > 0 ? '+' : ''}${fmt(s2.total - s1.total)})`)
console.log(`  刷 400000 行     : ${fmt(s3.total)} MB  (${s3.total - s2.total > 0 ? '+' : ''}${fmt(s3.total - s2.total)})`)
console.log(`  关闭标签后       : ${fmt(s4.total)} MB  (回收 ${fmt(s3.total - s4.total)} MB)`)
console.log(`  渲染堆峰值       : ${fmt(Math.max(s1.m.jsHeapUsed, s2.m.jsHeapUsed, s3.m.jsHeapUsed))} MB`)
console.log('')

ws.close()
child.kill()
await new Promise((r) => setTimeout(r, 1500))
rmSync(userDataDir, { recursive: true, force: true })
try { rmSync(uiKeyPath, { force: true }) } catch { /* 忽略 */ }
await stopOpenSshServer()
process.exit(0)
