import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 冒烟测试: 纯逻辑测试, 不依赖 Electron 运行时
 * 
 * 覆盖:
 * - SSH 主机去重逻辑 (M5: 已存在条目更新而非跳过)
 * - 端口校验 (L7)
 * - 密码加密/解密往返 (B1: enc: 前缀 + base64)
 * - 标签 ID 生成唯一性
 */

// --- 模拟 sshHosts 去重 + 更新逻辑 (复刻 ConnectDialog.vue + store.ts) ---
function dedupAndUpdateHosts(existing, newConfig) {
  const idx = existing.findIndex(h =>
    h.config.host === newConfig.host &&
    h.config.port === newConfig.port &&
    h.config.username === newConfig.username
  )
  if (idx >= 0) {
    existing[idx].config = newConfig
    return existing
  }
  existing.push({ id: `ssh-${Date.now()}`, name: `${newConfig.username}@${newConfig.host}`, config: newConfig })
  return existing
}

// --- 模拟端口校验 (复刻 ConnectDialog.vue) ---
function validatePort(port) {
  const p = Number(port)
  return Number.isInteger(p) && p >= 1 && p <= 65535
}

// --- 模拟密码加密/解密 (复刻 store.ts) ---
function encryptPassword(plain) {
  if (!plain) return ''
  // 模拟: 非 enc: 前缀时明文, enc: 时 base64
  return 'enc:' + Buffer.from(plain).toString('base64')
}

function decryptPassword(stored) {
  if (!stored) return ''
  if (!stored.startsWith('enc:')) return stored
  try {
    return Buffer.from(stored.slice(4), 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

// --- 模拟标签 ID 生成 (复刻 tabs.ts) ---
let tabCounter = 0
function genId() {
  return `tab-${++tabCounter}-${Date.now()}`
}

describe('SSH 主机去重 + 更新', () => {
  it('新主机应追加到列表', () => {
    const hosts = []
    const config = { host: '10.0.0.1', port: 22, username: 'root' }
    const result = dedupAndUpdateHosts(hosts, config)
    assert.equal(result.length, 1)
    assert.equal(result[0].config.host, '10.0.0.1')
  })

  it('已存在主机应更新配置而非新增', () => {
    const hosts = [{ id: 'ssh-1', name: 'old', config: { host: '10.0.0.1', port: 22, username: 'root', password: 'old' } }]
    const newConfig = { host: '10.0.0.1', port: 22, username: 'root', password: 'new' }
    const result = dedupAndUpdateHosts(hosts, newConfig)
    assert.equal(result.length, 1)
    assert.equal(result[0].config.password, 'new')
  })

  it('不同端口应视为不同主机', () => {
    const hosts = [{ id: 'ssh-1', name: 'a', config: { host: '10.0.0.1', port: 22, username: 'root' } }]
    const newConfig = { host: '10.0.0.1', port: 2222, username: 'root' }
    const result = dedupAndUpdateHosts(hosts, newConfig)
    assert.equal(result.length, 2)
  })
})

describe('端口校验', () => {
  it('有效端口应通过', () => {
    assert.equal(validatePort(22), true)
    assert.equal(validatePort(1), true)
    assert.equal(validatePort(65535), true)
  })

  it('无效端口应拒绝', () => {
    assert.equal(validatePort(0), false)
    assert.equal(validatePort(-1), false)
    assert.equal(validatePort(65536), false)
    assert.equal(validatePort(99999), false)
    assert.equal(validatePort('abc'), false)
    assert.equal(validatePort(22.5), false)
    assert.equal(validatePort(NaN), false)
  })
})

describe('密码加密/解密往返', () => {
  it('加密后应以 enc: 前缀', () => {
    const encrypted = encryptPassword('mypassword')
    assert.ok(encrypted.startsWith('enc:'))
  })

  it('解密后应还原原文', () => {
    const plain = '复杂密码123!@#'
    const encrypted = encryptPassword(plain)
    const decrypted = decryptPassword(encrypted)
    assert.equal(decrypted, plain)
  })

  it('空字符串应原样返回', () => {
    assert.equal(encryptPassword(''), '')
    assert.equal(decryptPassword(''), '')
  })

  it('旧明文数据应兼容 (无 enc: 前缀)', () => {
    assert.equal(decryptPassword('plaintext'), 'plaintext')
  })
})

describe('标签 ID 唯一性', () => {
  beforeEach(() => { tabCounter = 0 })

  it('连续生成不应重复', () => {
    const ids = new Set()
    for (let i = 0; i < 100; i++) {
      ids.add(genId())
    }
    assert.equal(ids.size, 100)
  })
})
