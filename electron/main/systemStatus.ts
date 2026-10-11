/**
 * 服务器状态采集与解析。
 *
 * 设计要点:
 * - 只做「命令 → 结构化数据」的纯计算, 不碰 SSH / electron, 便于直接测。
 * - 采集命令刻意选最小依赖的: /proc 与 df, 不要求装 sysstat / net-tools。
 * - 每条命令单独容错: 某条失败 (例如没装 docker) 只让那一项为空,
 *   不影响其余项 —— 服务器差异很大, 不能因为一个命令失败就整块空掉。
 *
 * 目前针对 Linux (与 shell-rs 一致); 非 Linux 会明确说明不支持。
 */
import type {
  SystemCpuInfo as CpuInfo,
  SystemMemoryInfo as MemoryInfo,
  SystemDiskEntry as DiskEntry,
  SystemNetEntry as NetEntry,
  SystemIdentity as IdentityInfo,
  SystemStatus
} from '../../src/types'

// 类型统一放在 src/types (渲染层与主进程共用一份, 避免两处定义漂移)
export type { CpuInfo, MemoryInfo, DiskEntry, NetEntry, IdentityInfo, SystemStatus }

/** 采集用的命令。分开跑, 便于定位是哪条失败。 */
export const PROBE_COMMANDS = {
  /** 内核名 / 发行版 / 主机名 / 运行时长 / 负载 */
  identity: 'uname -s; cat /etc/os-release 2>/dev/null; hostname; cat /proc/uptime; cat /proc/loadavg',
  /** CPU 核数与累计时间 (两次采样求差得到占用率) */
  cpu: 'nproc; grep "^cpu " /proc/stat',
  /** 内存与交换 */
  memory: 'cat /proc/meminfo',
  /** 磁盘用量 */
  disk: 'df -kP 2>/dev/null | grep -vE "^(tmpfs|devtmpfs|overlay|shm|none)"',
  /** 网卡累计字节数 (两次采样求差得到速率) */
  net: 'cat /proc/net/dev'
} as const

/** 一次采集的原始输出 */
export interface RawSnapshot {
  identity?: string
  cpu?: string
  memory?: string
  disk?: string
  net?: string
}

/** 执行一条采集命令的返回值 (与 ExecCaptureResult 的结构子集兼容) */
export interface ProbeExecResult {
  ok: boolean
  stdout?: string
}

/**
 * 采集并解析一次系统状态。
 *
 * 编排逻辑放在这里 (而不是埋在 ssh.ts 的 IPC handler 里) 是为了能直接测:
 * 传入一个假的 exec 就能覆盖「某条命令失败」「输出为空」等分支,
 * 传入真实 SSH 的 exec 就是端到端验证 —— 同一份实现, 不是副本。
 *
 * @param exec   跑一条命令并取回 stdout
 * @param prev   上一次快照 (用于算 CPU% 与网络速率); 首轮传 undefined
 * @param at     本次采样时刻 (测试可固定)
 */
export async function collectSystemStatus(
  exec: (command: string) => Promise<ProbeExecResult>,
  prev?: SystemStatus,
  at: number = Date.now()
): Promise<SystemStatus> {
  const entries = Object.entries(PROBE_COMMANDS) as [keyof RawSnapshot, string][]
  const results = await Promise.all(
    entries.map(async ([key, command]) => [key, await exec(command)] as const)
  )

  const raw: RawSnapshot = {}
  const failed: string[] = []
  for (const [key, r] of results) {
    // 命令不存在 / 无权限时退出码非 0, 但 stdout 仍可能有内容
    // (例如 identity 里的 os-release 成功、后半段失败) —— 有输出就用
    if (r.ok && typeof r.stdout === 'string' && r.stdout.trim().length > 0) {
      raw[key] = r.stdout
    } else {
      failed.push(key)
    }
  }

  const snapshot = parseSnapshot(raw, at)
  if (failed.length > 0) snapshot.failed = failed

  // 非 Linux 内核 (例如 BSD) 的 /proc 结构不同: 给出说明, 但已解析到的字段照常返回
  if (snapshot.identity && !/^linux$/i.test(snapshot.identity.kernel)) {
    snapshot.error = `远端内核为 ${snapshot.identity.kernel}, 采集命令按 Linux 编写, 数据可能不完整`
  }

  return withRates(snapshot, prev)
}


/** 解析内核名 / os-release / hostname / uptime / loadavg */
export function parseIdentity(raw: string): IdentityInfo | null {
  const lines = raw.split('\n').map((l) => l.trim())
  if (lines.length === 0) return null
  const kernel = lines[0]
  if (!kernel) return null

  let prettyName = ''
  let distroId = ''
  let hostname = ''
  let uptimeSeconds = 0
  let load1 = 0
  let load5 = 0
  let load15 = 0

  // 第 0 行是 uname -s 的输出 (Linux/Darwin), 其余字段从第 1 行起找。
  // 早先从第 0 行开始扫, 结果 "Linux" 本身被 hostname 分支抢走 —— 真机上
  // hostname 会显示成 "Linux"。拿真实 OpenSSH 输出核对时才发现。
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.startsWith('PRETTY_NAME=')) { prettyName = unquote(line.slice(12)); continue }
    if (line.startsWith('ID=')) { distroId = unquote(line.slice(3)); continue }
    if (line.startsWith('NAME=') && !prettyName) { prettyName = unquote(line.slice(5)); continue }
    // /proc/uptime: "12345.67 8901.23"
    const upMatch = line.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/)
    if (upMatch) {
      if (uptimeSeconds === 0) uptimeSeconds = Math.floor(Number(upMatch[1]))
      continue
    }
    // /proc/loadavg: "0.00 0.00 0.00 1/287 50"
    const loadMatch = line.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+\d+\/\d+/)
    if (loadMatch) {
      load1 = Number(loadMatch[1]) || 0
      load5 = Number(loadMatch[2]) || 0
      load15 = Number(loadMatch[3]) || 0
      continue
    }
    // hostname: 单独一行, 无空格无等号, 且不是纯数字
    if (!hostname && !line.includes('=') && !line.includes(' ') && !/^\d+$/.test(line)) {
      hostname = line
    }
  }

  return { kernel, prettyName, distroId, hostname, uptimeSeconds, load1, load5, load15 }
}

/** `/etc/os-release` 的值可能带引号 */
function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

/** 解析 "nproc" + `/proc/stat` 的 cpu 行 */
export function parseCpu(raw: string): CpuInfo | null {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  let cores = 0
  let total = 0
  let idle = 0
  for (const line of lines) {
    const coreMatch = line.match(/^(\d+)$/)
    if (coreMatch) { cores = Number(coreMatch[1]); continue }
    if (line.startsWith('cpu ')) {
      const parts = line.slice(4).trim().split(/\s+/).map(Number)
      if (parts.length >= 4 && parts.every((n) => Number.isFinite(n))) {
        // user nice system idle iowait irq softirq steal ...
        total = parts.reduce((a, b) => a + b, 0)
        idle = (parts[3] || 0) + (parts[4] || 0) // idle + iowait
      }
    }
  }
  if (cores === 0 && total === 0) return null
  return { cores: cores || 1, total, idle }
}

/** 由两次采样算 CPU 占用率 (0-100); 采样无效时返回 null */
export function cpuUsagePercent(prev: CpuInfo | undefined, next: CpuInfo | undefined): number | null {
  if (!prev || !next) return null
  const totalDiff = next.total - prev.total
  const idleDiff = next.idle - prev.idle
  if (!Number.isFinite(totalDiff) || totalDiff <= 0) return null
  if (!Number.isFinite(idleDiff) || idleDiff < 0) return null
  const usage = (1 - idleDiff / totalDiff) * 100
  return Math.min(100, Math.max(0, Number(usage.toFixed(1))))
}

/** 解析 `/proc/meminfo` */
export function parseMemory(raw: string): MemoryInfo | null {
  const map = new Map<string, number>()
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/)
    if (m) map.set(m[1], Number(m[2]))
  }
  const totalKb = map.get('MemTotal') || 0
  if (totalKb === 0) return null
  const freeKb = map.get('MemFree') || 0
  const buffersKb = map.get('Buffers') || 0
  const cachedKb = (map.get('Cached') || 0) + (map.get('SReclaimable') || 0)
  // MemAvailable 缺失时 (很老的内核) 退化用 free+buffers+cached
  const availableKb = map.get('MemAvailable') ?? (freeKb + buffersKb + cachedKb)
  const usedKb = Math.max(0, totalKb - availableKb)
  const swapTotalKb = map.get('SwapTotal') || 0
  const swapFreeKb = map.get('SwapFree') || 0
  return {
    totalKb, availableKb, usedKb, freeKb, buffersKb, cachedKb,
    swapTotalKb, swapFreeKb,
    swapUsedKb: Math.max(0, swapTotalKb - swapFreeKb),
    usedPercent: totalKb > 0 ? Number(((usedKb / totalKb) * 100).toFixed(1)) : 0
  }
}

/** 解析 `df -kP` 输出 (POSIX 格式: Filesystem 1024-blocks Used Available Capacity Mounted on) */
export function parseDisk(raw: string): DiskEntry[] {
  const out: DiskEntry[] = []
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (/^Filesystem\s/i.test(line)) continue
    // 用空白切分, 但挂载点可能含空格 —— 前 5 列固定, 其余并回挂载点
    const parts = line.split(/\s+/)
    if (parts.length < 6) continue
    const sizeKb = Number(parts[1])
    const usedKb = Number(parts[2])
    const availableKb = Number(parts[3])
    if (!Number.isFinite(sizeKb) || !Number.isFinite(usedKb) || !Number.isFinite(availableKb)) continue
    const pctMatch = parts[4].match(/^(\d+)%$/)
    out.push({
      filesystem: parts[0],
      sizeKb, usedKb, availableKb,
      usedPercent: pctMatch ? Number(pctMatch[1])
        : (sizeKb > 0 ? Number(((usedKb / sizeKb) * 100).toFixed(1)) : 0),
      mountPoint: parts.slice(5).join(' ')
    })
  }
  return out
}

/** 解析 `/proc/net/dev` */
export function parseNet(raw: string): NetEntry[] {
  const out: NetEntry[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.+)$/)
    if (!m) continue
    const name = m[1].trim()
    if (name === 'lo') continue // 回环不计入速率
    const nums = m[2].trim().split(/\s+/).map(Number)
    if (nums.length < 9) continue
    const rxBytes = nums[0]
    const txBytes = nums[8]
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    out.push({ name, rxBytes, txBytes })
  }
  return out
}

/** 由两次采样算网络速率 (字节/秒); 采样无效时返回 null */
export function netRates(
  prev: NetEntry[] | undefined,
  next: NetEntry[] | undefined,
  intervalMs: number
): { name: string; rxPerSec: number; txPerSec: number }[] | null {
  if (!prev || !next || intervalMs <= 0) return null
  const prevMap = new Map(prev.map((n) => [n.name, n]))
  const out: { name: string; rxPerSec: number; txPerSec: number }[] = []
  for (const n of next) {
    const p = prevMap.get(n.name)
    if (!p) continue
    const rxDiff = n.rxBytes - p.rxBytes
    const txDiff = n.txBytes - p.txBytes
    // 计数器回绕或接口重置: 负数按 0 处理
    out.push({
      name: n.name,
      rxPerSec: rxDiff > 0 ? Number((rxDiff / (intervalMs / 1000)).toFixed(1)) : 0,
      txPerSec: txDiff > 0 ? Number((txDiff / (intervalMs / 1000)).toFixed(1)) : 0
    })
  }
  return out
}

/** 把原始输出解析成一次快照 */
export function parseSnapshot(raw: RawSnapshot, at = Date.now()): SystemStatus {
  const failed: string[] = []
  const status: SystemStatus = { ok: false, at }

  if (!raw.identity) {
    failed.push('identity')
  } else {
    const identity = parseIdentity(raw.identity)
    if (identity) status.identity = identity
    else failed.push('identity')
  }

  if (raw.cpu) {
    const cpu = parseCpu(raw.cpu)
    if (cpu) status.cpu = cpu
    else failed.push('cpu')
  } else failed.push('cpu')

  if (raw.memory) {
    const memory = parseMemory(raw.memory)
    if (memory) status.memory = memory
    else failed.push('memory')
  } else failed.push('memory')

  if (raw.disk) {
    const disks = parseDisk(raw.disk)
    // df 没输出不算错 (可能全是 tmpfs 被过滤了)
    if (disks.length > 0) status.disks = disks
  } else failed.push('disk')

  if (raw.net) {
    const net = parseNet(raw.net)
    if (net.length > 0) status.net = net
  } else failed.push('net')

  status.ok = !!status.identity
  if (!status.ok) status.error = '无法识别远端系统信息'
  if (failed.length > 0) status.failed = failed
  return status
}

/**
 * 用上一次快照补齐「差分量」: CPU 占用率与网络速率。
 *
 * 这两个值必须由两次采样求差才能得到 (与 top 同理), 单次采集拿不到,
 * 所以单独成一个函数: parseSnapshot 保持「单次输入 → 单次输出」的纯粹性,
 * 差值逻辑在这里叠加, 也便于单测直接构造前后两份快照。
 *
 * 没有上一次快照 (首轮) 时, cpuUsagePercent 为 null、netRates 缺省 ——
 * 而不是给 0, 否则界面上会显示成「CPU 空闲」, 与事实不符。
 */
export function withRates(current: SystemStatus, prev: SystemStatus | undefined): SystemStatus {
  const out: SystemStatus = { ...current }
  if (!prev) {
    out.cpuUsagePercent = null
    return out
  }
  out.cpuUsagePercent = cpuUsagePercent(prev.cpu, current.cpu)
  const intervalMs = current.at - prev.at
  const rates = netRates(prev.net, current.net, intervalMs)
  if (rates) {
    out.netRates = rates
    out.sampleIntervalMs = intervalMs
  }
  return out
}

/** 字节数转人类可读 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** KB 转人类可读 */
export function formatKb(kb: number): string {
  return formatBytes(kb * 1024)
}

/** 秒转 "3天 4小时 5分" */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0 || d > 0) parts.push(`${h}小时`)
  parts.push(`${m}分`)
  return parts.join(' ')
}
