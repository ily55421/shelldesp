/**
 * ShellDesk 内存占用实测。
 *
 * 测什么:
 * 1. 进程树分解 (主进程 / 渲染 / GPU / utility) —— Electron 是多进程架构,
 *    只说一个总数说明不了问题在哪
 * 2. 空闲基线 (1 个本地标签)
 * 3. 多标签扩展成本 (本地标签 + SSH 标签各加到 N 个)
 * 4. 渲染层 JS 堆 / DOM 节点 / xterm 实例数
 *
 * 为什么用 CDP 而不是只看任务管理器: 需要把「渲染进程 JS 堆」与
 * 「原生内存」分开看, 前者能通过代码优化, 后者主要是 Electron 固定开销。
 *
 * 用法: node scripts/mem-profile.mjs   (需先 npm run build)
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openSshAvailable, ensureOpenSshServer, stopOpenSshServer, OPENSSH_USER } from './lib/wsl-openssh.mjs'

const MB = 1024 * 1024
const fmt = (bytes) => (bytes / MB).toFixed(1)

/** 找一个空闲端口 */
async function freePort() {
  const net = await import('node:net')
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => res(p))
    })
  })
}

/** 取整棵进程树的内存 (Win32 用 WorkingSetSize) */
function processTree(rootPid) {
  const ps = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize',
    '$tree = New-Object System.Collections.ArrayList',
    '$queue = New-Object System.Collections.Queue',
    `$queue.Enqueue(${rootPid})`,
    'while ($queue.Count -gt 0) {',
    '  $cur = $queue.Dequeue()',
    '  $kids = $all | Where-Object { $_.ParentProcessId -eq $cur }',
    '  foreach ($k in $kids) { [void]$tree.Add($k); $queue.Enqueue($k.ProcessId) }',
    '}',
    '$tree | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.WorkingSetSize)" }'
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf-8' })
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [pid, name, ws] = line.trim().split('|')
      return { pid: Number(pid), name, ws: Number(ws) }
    })
  } catch {
    return []
  }
}

console.log('\n=== ShellDesk 内存占用实测 ===\n')

// --- 准备 SSH 测试服务端 ---
const avail = await openSshAvailable()
let server = null
if (avail.ok) {
  server = await ensureOpenSshServer()
  console.log(`OpenSSH 就绪: ${OPENSSH_USER}@127.0.0.1:${server.port}\n`)
} else {
  console.log(`WSL OpenSSH 不可用 (${avail.reason}) — SSH 标签部分将跳过\n`)
}

const port = await freePort()
const userDataDir = mkdtempSync(join(tmpdir(), 'shelldesk-mem-'))
const sshDir = join(process.env.USERPROFILE || '', '.ssh')
mkdirSync(sshDir, { recursive: true })
let uiKeyPath = null

if (server) {
  uiKeyPath = join(sshDir, 'shelldesk-mem.key')
  writeFileSync(uiKeyPath, readFileSync(server.clientKeyPath, 'utf-8'))
  // 预置主机密钥信任, 免去原生对话框 (CDP 操作不到 OS 级窗口)
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
}

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
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 300))
}
if (!wsUrl) {
  console.log('CDP 连接失败')
  child.kill()
  process.exit(1)
}

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
  setTimeout(() => {
    if (pending.has(myId)) { pending.delete(myId); rej(new Error(`timeout ${method}`)) }
  }, 30000)
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err')
  return r.result.value
}
await send('Runtime.enable')
await new Promise((r) => setTimeout(r, 4500))

/** 通过 CDP 拿渲染层的堆与 DOM 指标 */
async function rendererMetrics() {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const p = performance.memory || {}
      return {
        jsHeapUsed: p.usedJSHeapSize || 0,
        jsHeapTotal: p.totalJSHeapSize || 0,
        domNodes: document.getElementsByTagName('*').length,
        xtermCount: document.querySelectorAll('.xterm').length,
        tabs: document.querySelectorAll('.tab').length
      }
    })()`,
    returnByValue: true
  })
  return r.result.value
}

/** 采集一次快照 */
async function snapshot(label) {
  const procs = processTree(mainPid)
  const byRole = {}
  for (const p of procs) {
    const role = p.name.replace(/\.exe$/i, '')
    byRole[role] = byRole[role] || { count: 0, ws: 0 }
    byRole[role].count++
    byRole[role].ws += p.ws
  }
  const metrics = await rendererMetrics()
  const total = procs.reduce((s, p) => s + p.ws, 0)
  return { label, total, byRole, procs, metrics }
}

function printSnapshot(s, prev) {
  const d = (v, p) => {
    if (p === undefined || p === null) return ''
    const delta = v - p
    return `  (${delta > 0 ? '+' : ''}${fmt(delta)} MB)`
  }
  console.log(`【${s.label}】`)
  console.log(`  进程树总计   : ${fmt(s.total)} MB${d(s.total, prev?.total)}`)
  for (const [role, v] of Object.entries(s.byRole)) {
    const dp = prev?.byRole[role]?.ws
    console.log(`    ${role.padEnd(9)} ${String(v.count).padStart(2)} 个  ${fmt(v.ws).padStart(7)} MB${d(v.ws, dp)}`)
  }
  const m = s.metrics
  const hd = prev ? `  (${m.jsHeapUsed - prev.metrics.jsHeapUsed > 0 ? '+' : ''}${fmt(m.jsHeapUsed - prev.metrics.jsHeapUsed)} MB)` : ''
  console.log(`  渲染 JS 堆   : ${fmt(m.jsHeapUsed)} MB 已用 / ${fmt(m.jsHeapTotal)} MB 上限${hd}`)
  console.log(`  DOM 节点     : ${m.domNodes}`)
  console.log(`  xterm 实例   : ${m.xtermCount}  (标签 ${m.tabs})`)
  console.log('')
}

/** 通过加号菜单新建 n 个本地标签 */
async function openLocal(n) {
  await evaluate(`(async () => {
    for (let i = 0; i < ${n}; i++) {
      document.querySelector('.tab-new').click()
      await new Promise(r => setTimeout(r, 120))
      const item = [...document.querySelectorAll('.new-menu .menu-item')].find(x => /PowerShell/.test(x.innerText))
      if (item) item.click()
      await new Promise(r => setTimeout(r, 900))
    }
    return document.querySelectorAll('.tab').length
  })()`)
}

/** 新建一个 SSH 标签并连上 */
async function openSshOne() {
  await evaluate(`(() => { document.querySelector('.tab-new').click(); return true })()`)
  await new Promise((r) => setTimeout(r, 250))
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.new-menu .menu-item')].find(x => /SSH/.test(x.innerText))
    if (item) item.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  await evaluate(`(() => {
    const d = document.querySelector('.modal')
    if (!d) return false
    const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})) }
    const inputs = [...d.querySelectorAll('input.input')]
    setVal(inputs[0], 'MEM'); setVal(inputs[1], '127.0.0.1')
    setVal(inputs[2], '${server.port}'); setVal(inputs[3], '${OPENSSH_USER}')
    const kt = [...d.querySelectorAll('.auth-tab')].find(t => t.innerText.trim() === '密钥')
    if (kt) kt.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  await evaluate(`(() => {
    const d = document.querySelector('.modal')
    const ki = [...d.querySelectorAll('input.input')].find(i => i.placeholder && i.placeholder.includes('.ssh'))
    if (ki) { ki.value = ${JSON.stringify(uiKeyPath)}; ki.dispatchEvent(new Event('input',{bubbles:true})) }
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal-actions .btn')].find(b => b.innerText.trim() === '连接')
    if (btn) btn.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 4500))
}

// --- 1. 启动基线 ---
const s0 = await snapshot('刚启动 (1 个默认本地标签)')
printSnapshot(s0)

// --- 2. 6 个本地标签 ---
await openLocal(5)
await new Promise((r) => setTimeout(r, 3000))
const s1 = await snapshot('6 个本地标签')
printSnapshot(s1, s0)

// --- 3. 12 个本地标签 (上限) ---
await openLocal(6)
await new Promise((r) => setTimeout(r, 4000))
const s2 = await snapshot('12 个本地标签 (上限)')
printSnapshot(s2, s1)

// --- 4. SSH 标签 ---
let s3 = null
let s3a = null
if (server && uiKeyPath) {
  // 关掉 6 个本地标签给 SSH 腾位置
  await evaluate(`(() => {
    const closes = [...document.querySelectorAll('.tab .t-close')]
    for (let i = 0; i < 6 && i < closes.length - 1; i++) closes[i].click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 3000))
  s3a = await snapshot('关到 6 个本地标签')
  printSnapshot(s3a, s2)

  for (let i = 0; i < 3; i++) await openSshOne()
  await new Promise((r) => setTimeout(r, 2000))
  s3 = await snapshot('6 本地 + 3 SSH 标签')
  printSnapshot(s3, s3a)
}

// --- 5. 汇总 ---
console.log('=== 汇总 ===')
console.log(`  启动基线          : ${fmt(s0.total)} MB  (渲染 JS 堆 ${fmt(s0.metrics.jsHeapUsed)} MB)`)
console.log(`  12 个本地标签     : ${fmt(s2.total)} MB  (渲染 JS 堆 ${fmt(s2.metrics.jsHeapUsed)} MB)`)
console.log(`  净增 (11 个标签)  : ${fmt(s2.total - s0.total)} MB`)
console.log(`  每标签边际成本    : ${fmt((s2.total - s0.total) / 11)} MB`)
if (s3 && s3a) {
  console.log(`  3 个 SSH 标签     : ${fmt(s3.total - s3a.total)} MB  (每个约 ${fmt((s3.total - s3a.total) / 3)} MB)`)
}
console.log('')

ws.close()
child.kill()
await new Promise((r) => setTimeout(r, 1500))
rmSync(userDataDir, { recursive: true, force: true })
if (uiKeyPath) { try { rmSync(uiKeyPath, { force: true }) } catch { /* 忽略 */ } }
await stopOpenSshServer()
process.exit(0)
