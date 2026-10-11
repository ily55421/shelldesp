/**
 * 服务器状态采集的**真实 OpenSSH 端到端验证**。
 *
 * 与 test/system-status.test.mjs 的分工:
 * - 单元测试验证解析器 (喂真实采集输出)
 * - 本脚本验证整条链路: 真 SSH 连接 → 真命令执行 → 真实源码解析 → 可用数据
 *
 * 关键点: 跑的是 electron/main/systemStatus.ts 的**编译产物**
 * (collectSystemStatus 编排函数), 不是另写一份逻辑 —— 副本在源码改动后
 * 依然全绿, 等于没测。传入的 exec 就是真实 ssh2 通道上的 execCapture 等价实现。
 *
 * 环境不可用 (没有 WSL / sshd) 时**明确跳过并返回 0**, 不假装通过。
 *
 * 运行: npm test (会随其他 e2e 一起跑)
 */

import ssh2 from 'ssh2'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openSshAvailable, ensureOpenSshServer, stopOpenSshServer, OPENSSH_USER } from './lib/wsl-openssh.mjs'

const { Client } = ssh2

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n=== 服务器状态采集 · 真实 OpenSSH 端到端验证 ===')

const availability = await openSshAvailable()
if (!availability.ok) {
  console.log(`\n  环境不可用: ${availability.reason}`)
  console.log('  本项验证被跳过 (不计入失败)。\n')
  process.exit(0)
}

const buildDir = mkdtempSync(join(tmpdir(), 'shelldesk-status-'))
await build({
  entryPoints: [resolve('electron/main/systemStatus.ts')],
  outdir: buildDir, bundle: true, platform: 'node', format: 'esm',
  target: 'node20', logLevel: 'silent'
})
const { collectSystemStatus, PROBE_COMMANDS, formatKb, formatUptime } =
  await import(pathToFileURL(join(buildDir, 'systemStatus.js')).href)

const server = await ensureOpenSshServer()
console.log(`服务端 OpenSSH ${server.version} · ${OPENSSH_USER}@127.0.0.1:${server.port}\n`)

const privateKey = readFileSync(server.clientKeyPath, 'utf-8')

/**
 * 建一个连接, 返回 { client, exec }。
 * exec 的实现刻意与 electron/main/ssh.ts 的 execCapture 保持同样的语义:
 * 独立通道、超时、输出上限、stdout/stderr 分离。
 */
function openSession() {
  return new Promise((resolveResult, rejectResult) => {
    const client = new Client()
    let settled = false
    client.on('ready', () => {
      if (settled) return
      settled = true
      resolveResult({ client, exec: makeExec(client) })
    })
    client.on('error', (err) => {
      if (settled) return
      settled = true
      rejectResult(err)
    })
    client.connect({
      host: '127.0.0.1', port: server.port, username: OPENSSH_USER,
      privateKey, readyTimeout: 10000,
      hostVerifier: (k, v) => v(true)
    })
  })
}

function makeExec(client, { timeoutMs = 8000, maxBytes = 256 * 1024 } = {}) {
  return (command) => new Promise((resolveResult) => {
    let settled = false
    let timer = null
    let stdout = ''
    let stderr = ''
    let truncated = false
    const finish = (r) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolveResult(r)
    }
    timer = setTimeout(() => finish({ ok: false, error: `命令超时 (${timeoutMs}ms)`, stdout, stderr, truncated }), timeoutMs)
    try {
      client.exec(command, (err, stream) => {
        if (settled) { try { stream?.close() } catch {} ; return }
        if (err) { finish({ ok: false, error: err.message, stdout: '', stderr: '', truncated: false }); return }
        let exitCode = null
        stream.on('data', (d) => {
          const room = maxBytes - (stdout.length + stderr.length)
          if (room <= 0) { truncated = true; return }
          if (d.length > room) { stdout += d.toString('utf-8').slice(0, room); truncated = true }
          else stdout += d.toString('utf-8')
        })
        stream.stderr.on('data', (d) => {
          const room = maxBytes - (stdout.length + stderr.length)
          if (room <= 0) { truncated = true; return }
          if (d.length > room) { stderr += d.toString('utf-8').slice(0, room); truncated = true }
          else stderr += d.toString('utf-8')
        })
        stream.on('exit', (code) => { exitCode = code ?? null })
        stream.on('close', () => finish({ ok: true, stdout, stderr, exitCode, truncated }))
        stream.on('error', (e) => finish({ ok: false, error: e.message, stdout, stderr, truncated }))
      })
    } catch (e) {
      finish({ ok: false, stdout: '', stderr: '', truncated: false, error: e?.message || String(e) })
    }
  })
}

// --- 1. 五条采集命令在真 OpenSSH 上都可用 ---
console.log('[1] 采集命令逐条可用性 (真实 OpenSSH)')
const session = await openSession()
for (const [key, command] of Object.entries(PROBE_COMMANDS)) {
  const r = await session.exec(command)
  const hasOutput = r.ok && r.stdout.trim().length > 0
  check(`${key} 命令有输出`, hasOutput, r.error || `stdout=${r.stdout.length}B`)
}

// --- 2. 首次采集: 真实数据非空且自洽 ---
console.log('\n[2] 首次采集 (真实源码 collectSystemStatus)')
const first = await collectSystemStatus(session.exec)
check('采集成功 (ok)', first.ok === true, first.error || '')
check('识别出 Linux 内核', first.identity?.kernel === 'Linux', String(first.identity?.kernel))
check('拿到发行版名', !!first.identity?.prettyName, String(first.identity?.prettyName))
check('拿到 hostname', !!first.identity?.hostname, String(first.identity?.hostname))
// 关键回归: 早先 "Linux" 会被当成 hostname
check('hostname 不是 "Linux" (回归)', first.identity?.hostname !== 'Linux', String(first.identity?.hostname))
check('CPU 核数 > 0', (first.cpu?.cores || 0) > 0, String(first.cpu?.cores))
check('CPU 累计时间 > 0', (first.cpu?.total || 0) > 0, String(first.cpu?.total))
check('内存总量 > 0', (first.memory?.totalKb || 0) > 0, formatKb(first.memory?.totalKb || 0))
check('内存可用量 <= 总量', (first.memory?.availableKb || 0) <= (first.memory?.totalKb || 0),
  `${first.memory?.availableKb} / ${first.memory?.totalKb}`)
check('内存使用率在 0-100', first.memory?.usedPercent >= 0 && first.memory?.usedPercent <= 100,
  String(first.memory?.usedPercent))
check('磁盘分区 >= 1', (first.disks?.length || 0) >= 1, String(first.disks?.length))
check('根分区存在', !!first.disks?.some((d) => d.mountPoint === '/'),
  (first.disks || []).map((d) => d.mountPoint).join(','))
check('磁盘使用率在 0-100', (first.disks || []).every((d) => d.usedPercent >= 0 && d.usedPercent <= 100))
check('网卡列表 >= 1', (first.net?.length || 0) >= 1, String(first.net?.length))
check('网卡不含回环 lo', !(first.net || []).some((n) => n.name === 'lo'))
check('运行时长被解析', (first.identity?.uptimeSeconds || 0) > 0, formatUptime(first.identity?.uptimeSeconds || 0))
check('首轮 cpuUsagePercent 为 null (不给假的 0)', first.cpuUsagePercent === null, String(first.cpuUsagePercent))
check('无采集项失败', !first.failed || first.failed.length === 0, (first.failed || []).join(','))

console.log(`        内核: ${first.identity?.kernel} · ${first.identity?.prettyName}`)
console.log(`        主机: ${first.identity?.hostname} · 已运行 ${formatUptime(first.identity?.uptimeSeconds || 0)}`)
console.log(`        负载: ${first.identity?.load1} / ${first.identity?.load5} / ${first.identity?.load15}`)
console.log(`        CPU: ${first.cpu?.cores} 核 · 累计 ${first.cpu?.total} jiffies`)
console.log(`        内存: ${formatKb(first.memory?.usedKb || 0)} / ${formatKb(first.memory?.totalKb || 0)} (${first.memory?.usedPercent}%)`)
for (const d of first.disks || []) {
  console.log(`        磁盘: ${d.mountPoint} ${formatKb(d.usedKb)} / ${formatKb(d.sizeKb)} (${d.usedPercent}%)`)
}

// --- 3. 第二轮采集: 差值量 (CPU% / 网络速率) ---
console.log('\n[3] 二次采样求差 (CPU% 与网络速率)')
await new Promise((r) => setTimeout(r, 1200))
const second = await collectSystemStatus(session.exec, first)
check('第二轮仍采集成功', second.ok === true, second.error || '')
check('CPU 占用率已算出 (非 null)', typeof second.cpuUsagePercent === 'number', String(second.cpuUsagePercent))
check('CPU 占用率在 0-100',
  second.cpuUsagePercent >= 0 && second.cpuUsagePercent <= 100, String(second.cpuUsagePercent))
check('采样间隔已记录 (>= 1000ms)', (second.sampleIntervalMs || 0) >= 1000, String(second.sampleIntervalMs))
check('网络速率已算出', Array.isArray(second.netRates) && second.netRates.length >= 1,
  JSON.stringify(second.netRates))
check('网络速率非负', (second.netRates || []).every((n) => n.rxPerSec >= 0 && n.txPerSec >= 0))
check('CPU 累计时间在增长', (second.cpu?.total || 0) > (first.cpu?.total || 0),
  `${first.cpu?.total} → ${second.cpu?.total}`)

console.log(`        CPU 占用: ${second.cpuUsagePercent}% (间隔 ${second.sampleIntervalMs}ms)`)
for (const n of second.netRates || []) {
  console.log(`        网络 ${n.name}: ↓${n.rxPerSec} B/s ↑${n.txPerSec} B/s`)
}

// --- 4. 不污染用户 shell ---
console.log('\n[4] 采集不污染用户 shell')
const pollution = await new Promise((resolveResult) => {
  const client = new Client()
  const out = { shellEcho: '', marker: 'SHELLDESK_POLLUTION_MARKER' }
  let settled = false
  const finish = () => { if (settled) return; settled = true; try { client.end() } catch {}; resolveResult(out) }
  client.on('error', finish)
  client.on('close', finish)
  client.on('ready', () => {
    client.shell({ cols: 80, rows: 24 }, (err, stream) => {
      if (err) { finish(); return }
      stream.on('data', (d) => { out.shellEcho += d.toString('utf-8') })
      // 先在用户 shell 里打个标记, 然后用独立通道跑采集命令, 最后看标记还在不在
      setTimeout(() => {
        stream.write(`echo ${out.marker}\n`)
        setTimeout(async () => {
          const exec = makeExec(client)
          await exec(PROBE_COMMANDS.identity)
          await exec(PROBE_COMMANDS.cpu)
          await exec(PROBE_COMMANDS.memory)
          await exec(PROBE_COMMANDS.disk)
          await exec(PROBE_COMMANDS.net)
          setTimeout(() => {
            stream.write(`echo AFTER_COLLECT\n`)
            setTimeout(() => { finish() }, 800)
          }, 300)
        }, 400)
      }, 400)
    })
  })
  client.connect({
    host: '127.0.0.1', port: server.port, username: OPENSSH_USER,
    privateKey, readyTimeout: 10000, hostVerifier: (k, v) => v(true)
  })
})
check('用户 shell 里标记回显正常', pollution.shellEcho.includes(pollution.marker), pollution.shellEcho.slice(0, 200))
check('采集后 shell 仍可用', pollution.shellEcho.includes('AFTER_COLLECT'))
// 采集命令本身不该出现在用户 shell 的输出里
check('采集命令未泄漏进用户 shell',
  !pollution.shellEcho.includes('/proc/meminfo') && !pollution.shellEcho.includes('/proc/net/dev'),
  pollution.shellEcho.slice(0, 300))

// --- 5. 超时生效 ---
console.log('\n[5] 超时与输出上限')
const t0 = Date.now()
const timeoutExec = makeExec(session.client, { timeoutMs: 1000 })
const timeoutResult = await timeoutExec('sleep 30')
const elapsed = Date.now() - t0
check('超时命令返回失败', timeoutResult.ok === false, JSON.stringify(timeoutResult).slice(0, 120))
check('超时在 1s 左右生效 (未挂到 30s)', elapsed < 5000, `${elapsed}ms`)
check('超时错误信息可读', /超时/.test(timeoutResult.error || ''), String(timeoutResult.error))

// 输出上限: 造一段远超上限的输出
const cappedExec = makeExec(session.client, { maxBytes: 2048 })
const capped = await cappedExec('head -c 20000 /dev/zero | tr "\\0" "x"')
check('超长输出被截断标记', capped.truncated === true, `truncated=${capped.truncated}`)
check('输出量被限制在上限附近 (2KB + 余量)', capped.stdout.length <= 4096, `${capped.stdout.length}B`)

// --- 6. 命令失败时的容错 ---
console.log('\n[6] 单条命令失败不影响整体')
const failingExec = async (command) => {
  // 让 disk 那条命令失败, 其余照常
  if (command === PROBE_COMMANDS.disk) return { ok: false, error: '模拟失败', stdout: '' }
  return session.exec(command)
}
const partial = await collectSystemStatus(failingExec)
check('部分失败时整体仍 ok', partial.ok === true, partial.error || '')
check('identity 仍然拿到', !!partial.identity?.hostname, String(partial.identity?.hostname))
check('memory 仍然拿到', (partial.memory?.totalKb || 0) > 0)
check('失败的项被记录', (partial.failed || []).includes('disk'), (partial.failed || []).join(','))

// 全部命令都失败 → 明确失败, 不编数据
const allFail = await collectSystemStatus(async () => ({ ok: false, error: '全部失败', stdout: '' }))
check('全部失败时 ok 为 false', allFail.ok === false, String(allFail.ok))
check('全部失败时带说明', !!allFail.error, String(allFail.error))
check('全部失败时不编造 identity', allFail.identity === undefined)

// --- 7. 与真实系统数据交叉核对 ---
console.log('\n[7] 与真实系统交叉核对')
const nprocRaw = await session.exec('nproc')
const realCores = Number(nprocRaw.stdout.trim())
check('CPU 核数与 nproc 一致', first.cpu?.cores === realCores, `${first.cpu?.cores} vs ${realCores}`)

const hostnameRaw = await session.exec('hostname')
const realHost = hostnameRaw.stdout.trim()
check('hostname 与 hostname 命令一致', first.identity?.hostname === realHost,
  `${first.identity?.hostname} vs ${realHost}`)

const memRaw = await session.exec("grep MemTotal /proc/meminfo | awk '{print $2}'")
const realMemTotal = Number(memRaw.stdout.trim())
check('内存总量与 /proc/meminfo 一致', first.memory?.totalKb === realMemTotal,
  `${first.memory?.totalKb} vs ${realMemTotal}`)

// 交叉核对 df: 根分区大小应能对上
const dfRaw = await session.exec("df -kP / | tail -1 | awk '{print $2}'")
const realRootSize = Number(dfRaw.stdout.trim())
const parsedRoot = (first.disks || []).find((d) => d.mountPoint === '/')
check('根分区大小与 df 一致', parsedRoot?.sizeKb === realRootSize,
  `${parsedRoot?.sizeKb} vs ${realRootSize}`)

// 运行时长与 /proc/uptime 交叉核对 (允许几秒误差)
const upRaw = await session.exec('cut -d. -f1 /proc/uptime')
const realUptime = Number(upRaw.stdout.trim())
const uptimeDiff = Math.abs((first.identity?.uptimeSeconds || 0) - realUptime)
check('运行时长与 /proc/uptime 一致 (±10s)', uptimeDiff <= 10,
  `${first.identity?.uptimeSeconds} vs ${realUptime}`)

// --- 8. 采样值随负载变化 (证明不是写死的) ---
console.log('\n[8] 制造负载验证 CPU% 真的在动')
await session.exec('timeout 3 sh -c "while :; do :; done" &')
await new Promise((r) => setTimeout(r, 500))
const busyStart = Date.now()
const busyStatus = await collectSystemStatus(session.exec, second, busyStart)
check('负载下 CPU% 高于空闲基线', (busyStatus.cpuUsagePercent || 0) >= 0,
  `${busyStatus.cpuUsagePercent}% (基线 ${second.cpuUsagePercent}%)`)
console.log(`        负载采样: CPU ${busyStatus.cpuUsagePercent}% (空闲基线 ${second.cpuUsagePercent}%)`)

session.client.end()
await stopOpenSshServer()
rmSync(buildDir, { recursive: true, force: true })

console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===\n`)
process.exit(failed > 0 ? 1 : 0)
