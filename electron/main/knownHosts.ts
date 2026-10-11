import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import {
  describeKey, hostKeyOf, compareKey,
  type KnownHostKey, type KeyCheckResult, type KeyCheckStatus
} from './knownHostKey'
/**
 * 主机密钥信任库的读写 (借鉴 shell-rs 的 known_hosts)
 *
 * - 应用自有的信任库, 不写入用户的 ~/.ssh/known_hosts
 * - 首次连接记录指纹, 之后每次连接比对; 不一致一律拒绝, 不再询问
 * - 指纹用 OpenSSH 的 SHA256 格式, 便于用户与 ssh-keygen -lf 的结果核对
 *
 * 纯计算逻辑在 knownHostKey.ts (不依赖 electron, 可被测试直接导入)。
 */

export type { KnownHostKey, KeyCheckResult, KeyCheckStatus }
export { fingerprint, keyType, hostKeyOf, describeKey } from './knownHostKey'

type KnownHostsFile = Record<string, KnownHostKey>

let cache: KnownHostsFile | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'config', 'known_hosts.json')
}

function load(): KnownHostsFile {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    cache = parsed && typeof parsed === 'object' ? (parsed as KnownHostsFile) : {}
  } catch {
    // 文件不存在或损坏: 当作空库, 重新学习
    cache = {}
  }
  return cache
}

function persist(data: KnownHostsFile): void {
  try {
    const path = storePath()
    fs.mkdirSync(join(app.getPath('userData'), 'config'), { recursive: true })
    // 先写临时文件再改名, 避免写入中途崩溃留下半截文件
    const temporary = `${path}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(temporary, path)
  } catch {
    // 保存失败只影响下次校验, 不阻断当前连接
  }
}

/**
 * 比对本次连接的主机密钥与信任库。
 * 任何内部异常 (读库失败、指纹算不出) 都按「未知主机」处理 ——
 * 让用户有机会核对指纹, 而不是让连接直接崩掉。
 */
export function checkHostKey(host: string, port: number, key: Buffer): KeyCheckResult {
  let seen: KnownHostKey
  try {
    seen = describeKey(key)
  } catch {
    seen = {
      type: 'unknown', key: '', addedAt: new Date().toISOString(),
      fingerprint: '(无法计算指纹)'
    }
  }
  try {
    return compareKey(load()[hostKeyOf(host, port)], seen)
  } catch {
    return { status: 'unknown', seen }
  }
}

/**
 * 该主机是否已记录过密钥。
 * 连接前调用: 未知主机要弹窗询问用户, 握手超时应放宽, 否则用户思考期间连接就超时了。
 */
export function hasKnownKey(host: string, port: number): boolean {
  try {
    return !!load()[hostKeyOf(host, port)]
  } catch {
    return false
  }
}

/** 记下信任的主机密钥 (覆盖同名条目) */
export function learnHostKey(host: string, port: number, key: Buffer): void {
  const data = load()
  data[hostKeyOf(host, port)] = describeKey(key)
  persist(data)
}

/** 信任库文件路径 (设置面板展示用) */
export function knownHostsPath(): string {
  return storePath()
}

/** 已记录的主机数 (设置面板展示用) */
export function knownHostsCount(): number {
  return Object.keys(load()).length
}