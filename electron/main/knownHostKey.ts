import { createHash } from 'crypto'

/**
 * 主机密钥的纯计算逻辑 (借鉴 shell-rs 的 known_hosts)
 *
 * 刻意不依赖 electron / fs: 这样测试能直接导入真实实现,
 * 而不是复制一份逻辑 —— 复制品在源码改动后仍然全绿, 等于没测。
 * 落盘与信任库读写在 knownHosts.ts。
 */

/** 已记录的主机密钥 */
export interface KnownHostKey {
  /** 密钥算法, 如 ssh-ed25519 */
  type: string
  /** base64 编码的公钥原文 */
  key: string
  /** SHA256 指纹, 形如 SHA256:xxxx */
  fingerprint: string
  /** 首次记录时间 (ISO 8601) */
  addedAt: string
}

/** 未知主机 / 密钥变更 的判定结果 */
export type KeyCheckStatus = 'match' | 'unknown' | 'changed'

export interface KeyCheckResult {
  status: KeyCheckStatus
  /** 已保存的密钥 (status 为 match/changed 时有值) */
  stored?: KnownHostKey
  /** 本次连接看到的密钥 */
  seen: KnownHostKey
}

/** SSH 公钥的 SHA256 指纹, OpenSSH 格式 (去掉 base64 尾部填充) */
export function fingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/** 从 SSH 公钥 wire 格式解析算法名: uint32 长度 + 名称 */
export function keyType(key: Buffer): string {
  try {
    if (key.length < 4) return 'unknown'
    const length = key.readUInt32BE(0)
    if (length <= 0 || 4 + length > key.length) return 'unknown'
    return key.subarray(4, 4 + length).toString('ascii')
  } catch {
    return 'unknown'
  }
}

/** 信任库的键: 非 22 端口按 OpenSSH 惯例写成 [host]:port */
export function hostKeyOf(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** 把本次连接看到的公钥整理成待比对的记录 */
export function describeKey(key: Buffer): KnownHostKey {
  return {
    type: keyType(key),
    key: key.toString('base64'),
    fingerprint: fingerprint(key),
    addedAt: new Date().toISOString()
  }
}

/**
 * 把本次连接看到的主机密钥与信任库中的记录比对。
 * 只做纯计算, 不碰存储 —— 调用方负责读库并处理异常。
 *
 * 判定规则:
 * - 无记录 → unknown (问用户是否信任)
 * - 密钥原文一致 → match (放行)
 * - 记录存在但密钥不同 → changed (拒绝, 不再询问)
 */
export function compareKey(
  stored: KnownHostKey | undefined,
  seen: KnownHostKey
): KeyCheckResult {
  if (!stored) return { status: 'unknown', seen }
  // 指纹算不出时宁可当未知, 也不误判为「密钥已变更」而惊吓用户
  if (seen.fingerprint.startsWith('SHA256:') && stored.key === seen.key) {
    return { status: 'match', stored, seen }
  }
  return { status: 'changed', stored, seen }
}