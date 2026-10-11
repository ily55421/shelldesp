/**
 * systemStatus.ts 解析器单元测试。
 *
 * 夹具全部取自真实 OpenSSH 会话的实际输出 (Debian 11 / WSL),
 * 不是手写臆测的样本 —— 之前正是靠真实输出才发现 "Linux" 被当成 hostname 的 bug。
 *
 * 被测模块是 electron/main/systemStatus.ts 的编译产物 (scripts/run-tests.mjs 编译),
 * 不是复制品: 源码改了这里就会红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moduleUrl } from './helpers/modules.mjs'

const {
  PROBE_COMMANDS,
  parseIdentity,
  parseCpu,
  cpuUsagePercent,
  parseMemory,
  parseDisk,
  parseNet,
  netRates,
  parseSnapshot,
  withRates,
  formatBytes,
  formatKb,
  formatUptime
} = await import(moduleUrl('systemStatus'))

// --- 真实采集输出 (WSL Debian 11, 2026-10-11) ---

const REAL_IDENTITY = [
  'Linux',
  'PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"',
  'NAME="Debian GNU/Linux"',
  'VERSION_ID="11"',
  'VERSION="11 (bullseye)"',
  'VERSION_CODENAME=bullseye',
  'ID=debian',
  'HOME_URL="https://www.debian.org/"',
  'SUPPORT_URL="https://www.debian.org/support"',
  'BUG_REPORT_URL="https://bugs.debian.org/"',
  'linKe',
  '3.24 49.53',
  '0.00 0.00 0.00 3/247 27'
].join('\n')

const REAL_CPU = '20\ncpu  71 0 234 8471 58 0 61 0 0 0'

const REAL_MEMORY = [
  'MemTotal:       32735796 kB',
  'MemFree:        32088316 kB',
  'MemAvailable:   32042332 kB',
  'Buffers:           15828 kB',
  'Cached:           237428 kB',
  'SwapCached:            0 kB',
  'Active:            31628 kB',
  'Inactive:         249028 kB',
  'SwapTotal:       8388604 kB',
  'SwapFree:        8388604 kB'
].join('\n')

const REAL_DISK = [
  'Filesystem     1024-blocks       Used Available Capacity Mounted on',
  'drivers          419430396  371011720  48418676      89% /usr/lib/wsl/drivers',
  '/dev/sdd         263112772    2486908 247187708       1% /',
  'rootfs            16363464       3352  16360112       1% /init',
  'C:\\              419430396  371011720  48418676      89% /mnt/c',
  'D:\\              579326972  513408500  65918472      89% /mnt/d',
  'E:\\             1953513468 1664973588 288539880      86% /mnt/e'
].join('\n')

const REAL_NET = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0',
  '  eth0:       0       0    0    0    0     0          0         0      266       3    0    0    0     0       0          0'
].join('\n')

// --- parseIdentity ---

test('parseIdentity: 真实输出里 kernel 与 hostname 不混淆', () => {
  const info = parseIdentity(REAL_IDENTITY)
  assert.equal(info.kernel, 'Linux')
  // 关键回归: 早先 "Linux" 会被当成 hostname
  assert.equal(info.hostname, 'linKe')
  assert.notEqual(info.hostname, 'Linux')
})

test('parseIdentity: 发行版与 uptime/loadavg 正确', () => {
  const info = parseIdentity(REAL_IDENTITY)
  assert.equal(info.prettyName, 'Debian GNU/Linux 11 (bullseye)')
  assert.equal(info.distroId, 'debian')
  assert.equal(info.uptimeSeconds, 3)
  assert.equal(info.load1, 0)
  assert.equal(info.load5, 0)
  assert.equal(info.load15, 0)
})

test('parseIdentity: 有负载时三个值都取到', () => {
  const info = parseIdentity(['Linux', 'myhost', '100.5 200.25', '1.50 0.75 0.25 2/300 999'].join('\n'))
  assert.equal(info.hostname, 'myhost')
  assert.equal(info.uptimeSeconds, 100)
  assert.equal(info.load1, 1.5)
  assert.equal(info.load5, 0.75)
  assert.equal(info.load15, 0.25)
})

test('parseIdentity: NAME 在没有 PRETTY_NAME 时兜底', () => {
  const info = parseIdentity(['Linux', 'NAME="Alpine Linux"', 'ID=alpine', 'h1'].join('\n'))
  assert.equal(info.prettyName, 'Alpine Linux')
  assert.equal(info.distroId, 'alpine')
})

test('parseIdentity: 空输入返回 null', () => {
  assert.equal(parseIdentity(''), null)
})

test('parseIdentity: 只有 kernel 也不崩', () => {
  const info = parseIdentity('Linux')
  assert.equal(info.kernel, 'Linux')
  assert.equal(info.hostname, '')
})

test('parseIdentity: 纯数字行不会被当 hostname', () => {
  const info = parseIdentity(['Linux', '12345', 'h9'].join('\n'))
  assert.equal(info.hostname, 'h9')
})

// --- parseCpu / cpuUsagePercent ---

test('parseCpu: 真实输出解析核数与累计时间', () => {
  const cpu = parseCpu(REAL_CPU)
  assert.equal(cpu.cores, 20)
  // 71+0+234+8471+58+0+61+0+0+0 = 8895
  assert.equal(cpu.total, 8895)
  // idle + iowait = 8471 + 58
  assert.equal(cpu.idle, 8529)
})

test('parseCpu: 空输入返回 null', () => {
  assert.equal(parseCpu(''), null)
})

test('cpuUsagePercent: 两次采样求差', () => {
  // 前: total 1000, idle 800; 后: total 1100, idle 850
  // 增量 100, 其中 idle 50 → 占用 50%
  const pct = cpuUsagePercent({ cores: 4, total: 1000, idle: 800 }, { cores: 4, total: 1100, idle: 850 })
  assert.equal(pct, 50)
})

test('cpuUsagePercent: 无变化时不算除零', () => {
  const pct = cpuUsagePercent({ cores: 4, total: 1000, idle: 800 }, { cores: 4, total: 1000, idle: 800 })
  assert.equal(pct, null)
})

test('cpuUsagePercent: 缺少任一次采样返回 null (首轮不给 0)', () => {
  assert.equal(cpuUsagePercent(undefined, { cores: 4, total: 1100, idle: 850 }), null)
  assert.equal(cpuUsagePercent({ cores: 4, total: 1000, idle: 800 }, undefined), null)
})

test('cpuUsagePercent: 结果被夹在 0-100', () => {
  const pct = cpuUsagePercent({ cores: 4, total: 0, idle: 0 }, { cores: 4, total: 100, idle: 0 })
  assert.equal(pct, 100)
})

// --- parseMemory ---

test('parseMemory: 真实输出解析内存与交换', () => {
  const mem = parseMemory(REAL_MEMORY)
  assert.equal(mem.totalKb, 32735796)
  assert.equal(mem.availableKb, 32042332)
  assert.equal(mem.usedKb, 32735796 - 32042332)
  assert.equal(mem.swapTotalKb, 8388604)
  assert.equal(mem.swapUsedKb, 0)
  assert.equal(mem.cachedKb, 237428)
})

test('parseMemory: 缺 MemAvailable 时退化用 free+buffers+cached', () => {
  const mem = parseMemory(['MemTotal: 1000 kB', 'MemFree: 200 kB', 'Buffers: 50 kB', 'Cached: 150 kB'].join('\n'))
  assert.equal(mem.availableKb, 400)
  assert.equal(mem.usedKb, 600)
})

test('parseMemory: 没有 MemTotal 返回 null', () => {
  assert.equal(parseMemory('MemFree: 100 kB'), null)
})

test('parseMemory: 使用率基于 total - available', () => {
  const mem = parseMemory(['MemTotal: 1000 kB', 'MemAvailable: 250 kB'].join('\n'))
  assert.equal(mem.usedPercent, 75)
})

// --- parseDisk ---

test('parseDisk: 真实输出解析全部分区', () => {
  const disks = parseDisk(REAL_DISK)
  assert.equal(disks.length, 6)
  const root = disks.find((d) => d.mountPoint === '/')
  assert.equal(root.filesystem, '/dev/sdd')
  assert.equal(root.usedPercent, 1)
  assert.equal(root.sizeKb, 263112772)
})

test('parseDisk: 表头行被跳过', () => {
  const disks = parseDisk(REAL_DISK)
  assert.equal(disks.some((d) => d.filesystem === 'Filesystem'), false)
})

test('parseDisk: 挂载点含空格时并回完整路径', () => {
  const disks = parseDisk('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 50 50 50% /mnt/my data')
  assert.equal(disks[0].mountPoint, '/mnt/my data')
})

test('parseDisk: 非数字行被忽略', () => {
  const disks = parseDisk('Filesystem 1024-blocks Used Available Capacity Mounted on\nbroken line here')
  assert.equal(disks.length, 0)
})

test('parseDisk: 空输入返回空数组', () => {
  assert.deepEqual(parseDisk(''), [])
})

test('parseDisk: 缺 Capacity 列时按 size 计算', () => {
  const disks = parseDisk('/dev/sda 1000 250 750 - /data')
  assert.equal(disks[0].usedPercent, 25)
})

// --- parseNet / netRates ---

test('parseNet: 真实输出过滤回环', () => {
  const net = parseNet(REAL_NET)
  assert.equal(net.length, 1)
  assert.equal(net[0].name, 'eth0')
  assert.equal(net[0].rxBytes, 0)
  assert.equal(net[0].txBytes, 266)
})

test('parseNet: 表头行不被当成接口', () => {
  const net = parseNet(REAL_NET)
  assert.equal(net.some((n) => n.name.includes('Inter')), false)
})

test('parseNet: 空输入返回空数组', () => {
  assert.deepEqual(parseNet(''), [])
})

test('netRates: 两次采样求速率', () => {
  const prev = [{ name: 'eth0', rxBytes: 1000, txBytes: 2000 }]
  const next = [{ name: 'eth0', rxBytes: 3000, txBytes: 4000 }]
  // 2 秒间隔: rx 增加 2000 → 1000 B/s; tx 增加 2000 → 1000 B/s
  const rates = netRates(prev, next, 2000)
  assert.equal(rates[0].rxPerSec, 1000)
  assert.equal(rates[0].txPerSec, 1000)
})

test('netRates: 计数器回绕按 0 处理 (不出负数)', () => {
  const prev = [{ name: 'eth0', rxBytes: 5000, txBytes: 5000 }]
  const next = [{ name: 'eth0', rxBytes: 100, txBytes: 100 }]
  const rates = netRates(prev, next, 1000)
  assert.equal(rates[0].rxPerSec, 0)
  assert.equal(rates[0].txPerSec, 0)
})

test('netRates: 新接口无上次数据时跳过', () => {
  const rates = netRates([{ name: 'eth0', rxBytes: 1, txBytes: 1 }], [{ name: 'wlan0', rxBytes: 9, txBytes: 9 }], 1000)
  assert.equal(rates.length, 0)
})

test('netRates: 缺采样或间隔非法返回 null', () => {
  assert.equal(netRates(undefined, [{ name: 'e', rxBytes: 1, txBytes: 1 }], 1000), null)
  assert.equal(netRates([{ name: 'e', rxBytes: 1, txBytes: 1 }], undefined, 1000), null)
  assert.equal(netRates([{ name: 'e', rxBytes: 1, txBytes: 1 }], [{ name: 'e', rxBytes: 2, txBytes: 2 }], 0), null)
})

// --- parseSnapshot ---

test('parseSnapshot: 真实五路输出整合成一次快照', () => {
  const status = parseSnapshot({
    identity: REAL_IDENTITY, cpu: REAL_CPU, memory: REAL_MEMORY, disk: REAL_DISK, net: REAL_NET
  }, 1700000000000)
  assert.equal(status.ok, true)
  assert.equal(status.at, 1700000000000)
  assert.equal(status.identity.hostname, 'linKe')
  assert.equal(status.cpu.cores, 20)
  assert.equal(status.memory.totalKb, 32735796)
  assert.equal(status.disks.length, 6)
  assert.equal(status.net.length, 1)
  assert.equal(status.failed, undefined)
})

test('parseSnapshot: 单条命令失败不影响其余项', () => {
  const status = parseSnapshot({ identity: REAL_IDENTITY, memory: REAL_MEMORY })
  assert.equal(status.ok, true)
  assert.equal(status.identity.hostname, 'linKe')
  assert.equal(status.memory.totalKb, 32735796)
  assert.equal(status.cpu, undefined)
  assert.deepEqual(status.failed.sort(), ['cpu', 'disk', 'net'])
})

test('parseSnapshot: identity 失败则 ok 为 false 并带说明', () => {
  const status = parseSnapshot({})
  assert.equal(status.ok, false)
  assert.ok(status.error)
})

test('parseSnapshot: 垃圾输入不崩且标记失败', () => {
  const status = parseSnapshot({ identity: '', cpu: 'garbage', memory: 'garbage', disk: 'garbage', net: 'garbage' })
  assert.equal(status.ok, false)
  assert.equal(status.cpu, undefined)
})

test('parseSnapshot: df 全被过滤时不算失败', () => {
  const status = parseSnapshot({ identity: REAL_IDENTITY, disk: '' })
  assert.equal(status.disks, undefined)
  // disk 为空字符串走 failed 分支, 有内容但解析不出才不算失败
  assert.ok(status.failed.includes('disk'))
})

// --- withRates ---

test('withRates: 首轮无上次采样时 cpuUsagePercent 为 null', () => {
  const cur = parseSnapshot({ identity: REAL_IDENTITY, cpu: REAL_CPU }, 1000)
  const out = withRates(cur, undefined)
  assert.equal(out.cpuUsagePercent, null)
  assert.equal(out.netRates, undefined)
})

test('withRates: 第二轮算出 CPU% 与网络速率', () => {
  const prev = parseSnapshot({
    identity: REAL_IDENTITY,
    cpu: '4\ncpu  100 0 100 800 0 0 0 0 0 0',
    net: '  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0'
  }, 1000)
  const cur = parseSnapshot({
    identity: REAL_IDENTITY,
    cpu: '4\ncpu  150 0 150 850 0 0 0 0 0 0',
    net: '  eth0: 3000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0'
  }, 3000)
  const out = withRates(cur, prev)
  // total 增量 150 (1000 → 1150), idle 增量 50 (800 → 850) → 1 - 50/150 = 66.7%
  assert.equal(out.cpuUsagePercent, 66.7)
  assert.equal(out.sampleIntervalMs, 2000)
  assert.equal(out.netRates[0].rxPerSec, 1000)
  assert.equal(out.netRates[0].txPerSec, 1000)
})

test('withRates: 不修改传入的快照 (纯函数)', () => {
  const cur = parseSnapshot({ identity: REAL_IDENTITY, cpu: REAL_CPU }, 1000)
  const snapshotCopy = JSON.parse(JSON.stringify(cur))
  withRates(cur, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(cur)), snapshotCopy)
})

// --- 格式化 ---

test('formatBytes: 各量级', () => {
  assert.equal(formatBytes(0), '0.0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB')
})

test('formatBytes: 非法输入给占位符', () => {
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(NaN), '—')
})

test('formatKb: KB 转可读', () => {
  assert.equal(formatKb(1024), '1.0 MB')
  // 32 GiB = 32768 MiB; 值 >= 100 时取整, 否则保留一位小数
  assert.equal(formatKb(32 * 1024 * 1024), '32.0 GB')
  assert.equal(formatKb(1024 * 1024), '1.0 GB')
})

test('formatUptime: 天/时/分', () => {
  assert.equal(formatUptime(0), '0分')
  assert.equal(formatUptime(59), '0分')
  assert.equal(formatUptime(60), '1分')
  assert.equal(formatUptime(3661), '1小时 1分')
  assert.equal(formatUptime(90061), '1天 1小时 1分')
})

test('formatUptime: 非法输入给占位符', () => {
  assert.equal(formatUptime(-5), '—')
  assert.equal(formatUptime(NaN), '—')
})

// --- 采集命令本身 ---

test('PROBE_COMMANDS: 五条命令齐全且只用最小依赖', () => {
  const keys = Object.keys(PROBE_COMMANDS).sort()
  assert.deepEqual(keys, ['cpu', 'disk', 'identity', 'memory', 'net'])
  for (const cmd of Object.values(PROBE_COMMANDS)) {
    assert.equal(typeof cmd, 'string')
    assert.ok(cmd.length > 0)
    // 不该依赖外部工具 (sysstat/net-tools)
    assert.equal(/\b(iostat|mpstat|sar|ifconfig|netstat)\b/.test(cmd), false)
  }
})

test('PROBE_COMMANDS: identity 带 2>/dev/null 容错', () => {
  assert.ok(PROBE_COMMANDS.identity.includes('2>/dev/null'))
})
