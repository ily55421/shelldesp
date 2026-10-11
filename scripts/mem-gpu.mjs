/**
 * 验证 GPU 进程内存构成, 判断是否有优化空间。
 *
 * 背景: 实测 GPU 进程占 79~121 MB, 是 Electron 里第二大块。
 * 需要判断它是「固定开销」还是「可削减的」。
 *
 * 做法: 对比两种启动参数下的内存
 * - 默认 (硬件加速开)
 * - --disable-gpu (软件渲染)
 * 若禁用后总量显著下降且渲染层堆不变, 说明 GPU 进程开销可换空间。
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

/** 启动一次, 等稳定后采样 */
async function measure(extraArgs, label) {
  const port = await freePort()
  const userDataDir = mkdtempSync(join(tmpdir(), 'shelldesk-gpu-'))
  const child = spawn(resolve('node_modules/electron/dist/electron.exe'),
    ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${userDataDir}`, ...extraArgs],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })

  let wsUrl = null
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && /renderer/.test(t.url))
      if (p) { wsUrl = p.webSocketDebuggerUrl; break }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!wsUrl) {
    child.kill()
    return null
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
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout')) } }, 30000)
  })
  await send('Runtime.enable')
  await new Promise((r) => setTimeout(r, 6000))

  const procs = procsByRole(child.pid)
  const total = Object.values(procs).reduce((s, v) => s + v.ws, 0)
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const p = performance.memory || {}
      return { heap: p.usedJSHeapSize || 0, dom: document.getElementsByTagName('*').length }
    })()`,
    returnByValue: true
  })

  ws.close()
  child.kill()
  await new Promise((r) => setTimeout(r, 1500))
  rmSync(userDataDir, { recursive: true, force: true })

  return { label, total, procs, ...r.result.value }
}

console.log('\n=== GPU 进程内存构成验证 ===\n')

const withGpu = await measure([], '默认 (硬件加速)')
if (withGpu) {
  console.log(`【${withGpu.label}】`)
  console.log(`  总计 : ${fmt(withGpu.total)} MB`)
  for (const [role, v] of Object.entries(withGpu.procs)) {
    console.log(`    ${role.padEnd(10)} ${String(v.count).padStart(2)} 个  ${fmt(v.ws).padStart(7)} MB`)
  }
  console.log(`  堆 ${fmt(withGpu.heap)} MB · DOM ${withGpu.dom}`)
  console.log('')
}

const noGpu = await measure(['--disable-gpu'], '--disable-gpu (软件渲染)')
if (noGpu) {
  console.log(`【${noGpu.label}】`)
  console.log(`  总计 : ${fmt(noGpu.total)} MB`)
  for (const [role, v] of Object.entries(noGpu.procs)) {
    console.log(`    ${role.padEnd(10)} ${String(v.count).padStart(2)} 个  ${fmt(v.ws).padStart(7)} MB`)
  }
  console.log(`  堆 ${fmt(noGpu.heap)} MB · DOM ${noGpu.dom}`)
  console.log('')
}

const noGpuComp = await measure(['--disable-gpu-compositing'], '--disable-gpu-compositing')
if (noGpuComp) {
  console.log(`【${noGpuComp.label}】`)
  console.log(`  总计 : ${fmt(noGpuComp.total)} MB`)
  for (const [role, v] of Object.entries(noGpuComp.procs)) {
    console.log(`    ${role.padEnd(10)} ${String(v.count).padStart(2)} 个  ${fmt(v.ws).padStart(7)} MB`)
  }
  console.log('')
}

if (withGpu && noGpu) {
  console.log('=== 对比 ===')
  console.log(`  硬件加速   : ${fmt(withGpu.total)} MB`)
  console.log(`  禁用 GPU   : ${fmt(noGpu.total)} MB  (${noGpu.total - withGpu.total > 0 ? '+' : ''}${fmt(noGpu.total - withGpu.total)} MB)`)
  if (noGpuComp) {
    console.log(`  仅禁合成   : ${fmt(noGpuComp.total)} MB  (${noGpuComp.total - withGpu.total > 0 ? '+' : ''}${fmt(noGpuComp.total - withGpu.total)} MB)`)
  }
  console.log('')
}

process.exit(0)
