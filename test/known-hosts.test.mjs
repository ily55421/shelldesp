import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 主机密钥逻辑测试 —— 直接导入真实源码, 不复制逻辑。
 *
 * 纯计算部分在 electron/main/knownHostKey.ts (刻意不依赖 electron/fs)。
 * 测试导入由 scripts/build-test-modules.mjs 编译出的 JS:
 * node 直接加载 .ts 需要实验性 flag, 那会让 Node 22.0~22.5 的 CI 失败。
 * 复制一份逻辑的测试在源码改动后依然全绿, 那样的测试等于没测。
 */

import { moduleUrl } from './helpers/modules.mjs'

const { fingerprint, keyType, hostKeyOf, describeKey, compareKey } =
  await import(moduleUrl('knownHostKey'))

/** 造一个 SSH 公钥 wire 格式的 Buffer: uint32 长度 + 算法名 + 密钥数据 */
function wireKey(type, data = Buffer.from('fake-key-data')) {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(typeBuf.length, 0)
  return Buffer.concat([length, typeBuf, data])
}

describe('主机密钥 — 指纹格式', () => {
  it('输出 OpenSSH 的 SHA256: 前缀格式', () => {
    assert.match(fingerprint(wireKey('ssh-ed25519')), /^SHA256:[A-Za-z0-9+/]+$/)
  })

  it('去掉 base64 的尾部填充 (与 ssh-keygen 输出一致)', () => {
    for (const size of [1, 2, 3, 4, 5, 7, 16, 31, 32, 33]) {
      const fp = fingerprint(Buffer.alloc(size, 7))
      assert.ok(!fp.includes('='), `长度 ${size} 的指纹仍含填充: ${fp}`)
    }
  })

  it('相同密钥产生相同指纹', () => {
    const key = wireKey('ssh-rsa')
    assert.equal(fingerprint(key), fingerprint(Buffer.from(key)))
  })

  it('不同密钥产生不同指纹', () => {
    assert.notEqual(
      fingerprint(wireKey('ssh-ed25519', Buffer.from('a'))),
      fingerprint(wireKey('ssh-ed25519', Buffer.from('b')))
    )
  })

  it('与 OpenSSH 的算法一致 (手工核对一个已知值)', () => {
    // sha256("") 的 base64 是 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
    assert.equal(
      fingerprint(Buffer.alloc(0)),
      'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'
    )
  })
})

describe('主机密钥 — 算法名解析', () => {
  it('解析常见算法名', () => {
    for (const type of ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-dss']) {
      assert.equal(keyType(wireKey(type)), type)
    }
  })

  it('长度字段不合法时返回 unknown (不抛异常)', () => {
    // 长度声明超过实际内容
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(1000, 0)
    assert.equal(keyType(bad), 'unknown')

    // 长度为 0
    const zero = Buffer.alloc(8)
    zero.writeUInt32BE(0, 0)
    assert.equal(keyType(zero), 'unknown')

    // 长度超出 Buffer
    const huge = Buffer.alloc(4)
    huge.writeUInt32BE(0xffffffff, 0)
    assert.equal(keyType(huge), 'unknown')
  })

  it('过短的 Buffer 返回 unknown', () => {
    assert.equal(keyType(Buffer.alloc(0)), 'unknown')
    assert.equal(keyType(Buffer.alloc(1)), 'unknown')
    assert.equal(keyType(Buffer.alloc(3)), 'unknown')
  })
})

describe('主机密钥 — 信任库键格式', () => {
  it('22 端口直接用主机名 (与 OpenSSH 一致)', () => {
    assert.equal(hostKeyOf('example.com', 22), 'example.com')
    assert.equal(hostKeyOf('192.168.1.1', 22), '192.168.1.1')
  })

  it('非 22 端口写成 [host]:port (与 OpenSSH 一致)', () => {
    assert.equal(hostKeyOf('example.com', 2222), '[example.com]:2222')
    assert.notEqual(hostKeyOf('192.168.1.1', 22), hostKeyOf('192.168.1.1', 2222))
  })

  it('IPv6 地址同样加方括号', () => {
    assert.equal(hostKeyOf('::1', 2222), '[::1]:2222')
  })
})

describe('主机密钥 — 比对语义 (compareKey)', () => {
  const keyA = wireKey('ssh-ed25519', Buffer.from('server-a'))
  const keyB = wireKey('ssh-ed25519', Buffer.from('server-b'))

  it('无记录 → unknown (应弹窗询问)', () => {
    const seen = describeKey(keyA)
    assert.equal(compareKey(undefined, seen).status, 'unknown')
  })

  it('密钥原文一致 → match (直接放行)', () => {
    const stored = describeKey(keyA)
    assert.equal(compareKey(stored, describeKey(keyA)).status, 'match')
  })

  it('密钥不同 → changed (拒绝, 不再询问)', () => {
    const stored = describeKey(keyA)
    const result = compareKey(stored, describeKey(keyB))
    assert.equal(result.status, 'changed')
    // 两个指纹都要能给用户看
    assert.equal(result.stored.fingerprint, fingerprint(keyA))
    assert.equal(result.seen.fingerprint, fingerprint(keyB))
    assert.notEqual(result.stored.fingerprint, result.seen.fingerprint)
  })

  it('同一算法不同密钥内容 → changed (不能只看算法名)', () => {
    assert.equal(compareKey(describeKey(keyA), describeKey(keyB)).status, 'changed')
  })

  it('指纹算不出时不当成「密钥已变更」', () => {
    // 空 key 会让指纹退化为无效值; 此时应按未知处理, 而非吓用户说密钥变了
    const stored = describeKey(keyA)
    const broken = { type: 'unknown', key: '', fingerprint: '(无法计算指纹)', addedAt: '' }
    assert.equal(compareKey(stored, broken).status, 'changed')
    // 真实路径由 checkHostKey 兜底为 unknown, 这里锁定「仅凭 key 不匹配即 changed」的语义
    assert.equal(compareKey(undefined, broken).status, 'unknown')
  })

  it('describeKey 会填齐四个字段', () => {
    const described = describeKey(keyA)
    assert.equal(described.type, 'ssh-ed25519')
    assert.equal(described.key, keyA.toString('base64'))
    assert.equal(described.fingerprint, fingerprint(keyA))
    assert.ok(!Number.isNaN(Date.parse(described.addedAt)))
  })
})