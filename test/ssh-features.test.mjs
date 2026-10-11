import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * SSH 新增能力的单元测试 (导入真实源码, 非复刻逻辑)
 *
 * 覆盖:
 * - 远端系统探测解析 (借鉴 shell-rs 的 HostOsProbe)
 * - SSH 错误翻译 (借鉴 shell-rs 的 describe_login_error)
 *
 * 这些模块不依赖 Electron, 因此可以被 scripts/build-test-modules.mjs 编译后导入。
 * 走编译产物而非 .ts, 是为了避开 node 加载 TS 所需的实验性 flag
 * (--experimental-strip-types 在 Node 22.0~22.5 不存在, 会让 CI 失败)。
 */

import { moduleUrl } from './helpers/modules.mjs'

const {
  parseProbe, parseWindowsProbe, osLabel, osGlyph,
  PROBE_COMMAND, WINDOWS_PROBE_COMMAND
} = await import(moduleUrl('remoteOs'))

const { describeSshError } = await import(moduleUrl('sshErrors'))

/** 造一个 ssh2 风格的错误对象 */
function err(message, extra = {}) {
  const e = new Error(message)
  Object.assign(e, extra)
  return e
}

/** 错误翻译的默认入参 */
function explain(error, overrides = {}) {
  return describeSshError({
    error,
    auth: 'password',
    hasPassword: true,
    hasKey: false,
    hasPassphrase: false,
    triedKeyboard: false,
    ...overrides
  })
}

describe('远端系统探测 — POSIX', () => {
  it('识别 Ubuntu (读 ID=)', () => {
    const output = 'Linux\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nID_LIKE=debian\n'
    assert.equal(parseProbe(output), 'ubuntu')
  })

  it('识别带引号的 ID', () => {
    const output = 'Linux\nNAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n'
    assert.equal(parseProbe(output), 'rocky')
  })

  it('衍生版回退到 ID_LIKE (Linux Mint → Ubuntu)', () => {
    const output = 'Linux\nNAME="Linux Mint"\nID=linuxmint\nID_LIKE=ubuntu\n'
    assert.equal(parseProbe(output), 'ubuntu')
  })

  it('ID 已知时不受 ID_LIKE 干扰', () => {
    // Rocky 的 ID_LIKE 含 rhel, 但自身认识 rocky, 不应被判成 Red Hat
    const output = 'Linux\nID=rocky\nID_LIKE=rhel centos fedora\n'
    assert.equal(parseProbe(output), 'rocky')
  })

  it('不认识的发行版仍归为 Linux', () => {
    const output = 'Linux\nNAME="Something New"\nID=somethingnew\n'
    assert.equal(parseProbe(output), 'linux')
  })

  it('没有 os-release 的 Linux 仍归为 Linux', () => {
    assert.equal(parseProbe('Linux\n'), 'linux')
  })

  it('识别 macOS 与 BSD', () => {
    assert.equal(parseProbe('Darwin\n'), 'macos')
    assert.equal(parseProbe('FreeBSD\n'), 'freebsd')
    assert.equal(parseProbe('OpenBSD\n'), 'openbsd')
    assert.equal(parseProbe('NetBSD\n'), 'netbsd')
  })

  it('跳过前置空行', () => {
    assert.equal(parseProbe('\n\n  Darwin  \n'), 'macos')
  })

  it('无有效输出时返回 null (应转向 Windows 追问)', () => {
    assert.equal(parseProbe(''), null)
    assert.equal(parseProbe('\n \n'), null)
    assert.equal(parseProbe("'uname' is not recognized\n"), null)
  })

  it('Windows 追问靠 ver 输出识别', () => {
    assert.equal(
      parseWindowsProbe('Microsoft Windows [Version 10.0.19045.4291]\n'),
      'windows'
    )
    assert.equal(parseWindowsProbe(''), null)
  })

  it('探测命令与 shell-rs 一致', () => {
    assert.equal(PROBE_COMMAND, 'uname -s; cat /etc/os-release 2>/dev/null')
    assert.equal(WINDOWS_PROBE_COMMAND, 'cmd /c ver')
  })

  it('每种系统都有可读名称与徽标字符', () => {
    const all = ['ubuntu', 'debian', 'fedora', 'redhat', 'centos', 'rocky', 'alma',
      'arch', 'alpine', 'suse', 'gentoo', 'kali', 'manjaro', 'raspbian',
      'linux', 'macos', 'freebsd', 'openbsd', 'netbsd', 'windows']
    for (const os of all) {
      assert.ok(osLabel(os), `${os} 缺少名称`)
      assert.equal(typeof osGlyph(os), 'string', `${os} 缺少徽标`)
    }
  })
})

describe('SSH 错误翻译 — 认证失败', () => {
  it('密码错误', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    assert.equal(explain(e), '用户名或密码错误')
  })

  it('密码未填写 (与密码错误区分)', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    assert.equal(explain(e, { hasPassword: false }), '未填写密码')
  })

  it('私钥被拒且未填口令', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    assert.equal(
      explain(e, { auth: 'key', hasKey: true, hasPassword: false }),
      '服务器未接受该私钥, 请确认公钥已加入服务器的 authorized_keys'
    )
  })

  it('私钥被拒且填了口令 → 提示口令可能错误', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    assert.equal(
      explain(e, { auth: 'key', hasKey: true, hasPassphrase: true, hasPassword: false }),
      '服务器未接受该私钥, 请检查私钥口令是否正确'
    )
  })

  it('密钥方式未选文件', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    assert.equal(explain(e, { auth: 'key', hasKey: false, hasPassword: false }), '未选择私钥文件')
  })

  it('无密码模式遇到要密码的服务器 → 指引改用其他方式', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    const text = explain(e, { auth: 'nopassword', hasPassword: false })
    assert.match(text, /无密码/)
    assert.match(text, /密码|密钥/)
  })

  it('SSH Agent 不可用', () => {
    const e = err('All configured authentication methods failed', { level: 'client-authentication' })
    const text = explain(e, { auth: 'agent', hasPassword: false })
    assert.match(text, /Agent/)
    assert.match(text, /ssh-add/)
  })
})

describe('SSH 错误翻译 — 网络层', () => {
  it('连接被拒', () => {
    assert.equal(explain(err('connect ECONNREFUSED', { code: 'ECONNREFUSED' })),
      '连接被拒绝, 该端口上没有服务在监听')
  })

  it('超时', () => {
    assert.equal(explain(err('Timed out while waiting for handshake')),
      '连接超时, 请检查地址与端口, 或确认防火墙是否放行')
  })

  it('主机不可达', () => {
    assert.equal(explain(err('no route', { code: 'EHOSTUNREACH' })),
      '主机不可达, 请检查网络连通性')
  })

  it('域名解析失败', () => {
    assert.equal(explain(err('getaddrinfo ENOTFOUND bad.host')),
      '无法解析主机名, 请检查地址是否拼写正确')
  })

  it('连接被重置', () => {
    assert.equal(explain(err('read ECONNRESET', { code: 'ECONNRESET' })),
      '连接被对方重置, 可能是服务器中断或中间设备拦截')
  })
})

describe('SSH 错误翻译 — 密钥与协议', () => {
  it('私钥格式无法识别', () => {
    assert.equal(explain(err('Cannot parse privateKey: unsupported')),
      '私钥格式无法识别, 请确认是 OpenSSH 或 PEM 格式的私钥')
  })

  it('私钥口令错误', () => {
    assert.equal(explain(err('Cannot parse privateKey: bad passphrase')),
      '私钥口令错误')
  })

  it('私钥已加密但未填口令', () => {
    assert.equal(
      explain(err('Cannot parse privateKey: no key found'), { hasKey: true, hasPassphrase: false }),
      '私钥已加密, 请填写私钥口令'
    )
  })

  it('算法协商失败', () => {
    assert.equal(explain(err('Handshake failed: no matching kex algorithm')),
      '与服务器没有共同支持的加密算法, 连接无法建立')
  })

  it('服务器拒绝打开通道', () => {
    assert.equal(explain(err('Channel open failure: administratively prohibited')),
      '服务器拒绝打开会话通道, 可能已达连接数上限或策略限制')
  })

  it('提示启用键盘交互', () => {
    const text = explain(err('keyboard-interactive authentication required'), { triedKeyboard: false })
    assert.match(text, /键盘交互/)
  })
})

describe('SSH 错误翻译 — 兜底', () => {
  it('无法归类的错误保留原文, 不吞掉技术细节', () => {
    const raw = 'Something unusual happened at line 42'
    assert.equal(explain(err(raw)), raw)
  })

  it('认证失败判定不受 level 字段限制', () => {
    // 有些服务器/库只给文案不给 level
    const e = err('All configured authentication methods failed')
    assert.equal(explain(e), '用户名或密码错误')
  })
})
