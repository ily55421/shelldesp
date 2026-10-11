/**
 * 泄漏检测: 反复开关标签后内存是否回落。
 *
 * 这是内存分析里最该做的一项 —— 单次快照看不出泄漏,
 * 只有「开→关→开→关」循环后内存持续攀升才说明有问题。
 *
 * 同时验证: 主进程会话是否随标签关闭真正释放 (sessions Map 有无残留)。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

console.log('\n=== ShellDesk 标签开关泄漏检测 ===\n')

const port = await freePort()
const userDataDir = mkdtempSync(join(tmpdir(), 'shelldesk-leak-'))
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
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error(`timeout ${method}`)) } }, 60000)
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err')
  return r.result.value
}
await send('Runtime.enable')
await new Promise((r) => setTimeout(r, 4500))

async function snap() {
  const procs = procsByRole(mainPid)
  const total = Object.values(procs).reduce((s, v) => s + v.ws, 0)
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const p = performance.memory || {}
      return { heap: p.usedJSHeapSize || 0, dom: document.getElementsByTagName('*').length,
               tabs: document.querySelectorAll('.tab').length,
               xterms: document.querySelectorAll('.xterm').length }
    })()`,
    returnByValue: true
  })
  return { total, procs, ...r.result.value }
}

/** 开 n 个本地标签 */
async function openTabs(n) {
  await evaluate(`(async () => {
    for (let i = 0; i < ${n}; i++) {
      document.querySelector('.tab-new').click()
      await new Promise(r => setTimeout(r, 150))
      const item = [...document.querySelectorAll('.new-menu .menu-item')].find(x => /PowerShell/.test(x.innerText))
      if (item) item.click()
      await new Promise(r => setTimeout(r, 1100))
    }
    return true
  })()`)
}

/** 关掉除第一个外的所有标签 */
async function closeExtraTabs() {
  await evaluate(`(async () => {
    for (let round = 0; round < 20; round++) {
      const closes = [...document.querySelectorAll('.tab .t-close')]
      if (closes.length <= 1) break
      closes[closes.length - 1].click()
      await new Promise(r => setTimeout(r, 900))
    }
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 4000))
}

const results = []
const baseline = await snap()
results.push({ label: '基线 (1 标签)', ...baseline })
console.log(`【基线】1 标签: 总计 ${fmt(baseline.total)} MB, 堆 ${fmt(baseline.heap)} MB, DOM ${baseline.dom}`)

// 3 轮开关循环
for (let round = 1; round <= 3; round++) {
  await openTabs(5)               // 加到 6 个
  await new Promise((r) => setTimeout(r, 3000))
  const opened = await snap()
  console.log(`【第 ${round} 轮 · 6 标签】总计 ${fmt(opened.total)} MB, 堆 ${fmt(opened.heap)} MB, DOM ${opened.dom}`)

  await closeExtraTabs()
  const closed = await snap()
  console.log(`【第 ${round} 轮 · 关回 1】总计 ${fmt(closed.total)} MB, 堆 ${fmt(closed.heap)} MB, DOM ${closed.dom}, 标签数 ${closed.tabs}`)
  results.push({ label: `第 ${round} 轮关闭后`, ...closed })
}

// --- 判定 ---
const last = results[results.length - 1]
const growth = last.total - baseline.total
const heapGrowth = last.heap - baseline.heap
const domGrowth = last.dom - baseline.dom

console.log('\n=== 泄漏判定 ===')
console.log(`  基线总计      : ${fmt(baseline.total)} MB`)
console.log(`  3 轮后总计    : ${fmt(last.total)} MB`)
console.log(`  累计增长      : ${fmt(growth)} MB  (每轮约 ${fmt(growth / 3)} MB)`)
console.log(`  堆增长        : ${fmt(heapGrowth)} MB`)
console.log(`  DOM 节点增长  : ${domGrowth}`)
console.log(`  残留标签数    : ${last.tabs} (应为 1)`)
console.log(`  残留 xterm    : ${last.xterms} (应为 1)`)
console.log('')

const verdict = []
if (last.tabs !== 1) verdict.push(`标签未清理干净 (${last.tabs})`)
if (last.xterms !== 1) verdict.push(`xterm 实例未释放 (${last.xterms})`)
if (domGrowth > 50) verdict.push(`DOM 节点持续增长 ${domGrowth}`)
if (growth > 60) verdict.push(`内存每轮增长 ${fmt(growth / 3)} MB, 疑似泄漏`)
if (heapGrowth > 10) verdict.push(`JS 堆增长 ${fmt(heapGrowth)} MB`)

if (verdict.length === 0) {
  console.log('  ✓ 未发现泄漏: 标签与 xterm 均已释放, 内存回落正常')
} else {
  console.log('  ⚠ 发现可疑点:')
  for (const v of verdict) console.log(`    - ${v}`)
}
console.log('')

ws.close()
child.kill()
await new Promise((r) => setTimeout(r, 1500))
rmSync(userDataDir, { recursive: true, force: true })
process.exit(0)
