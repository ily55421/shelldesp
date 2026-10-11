/**
 * SSH 失败原因的中文翻译 (借鉴 shell-rs 的 describe_login_error)
 *
 * 目的: 「连接失败」这类笼统提示无法指导用户修复。
 * 这里把 ssh2 / Node 的底层错误归类成一句能直接照着做的话。
 */

/** 认证方式, 与 UI 上的选项一一对应 */
export type AuthKind = 'password' | 'key' | 'agent' | 'nopassword'

export interface SshErrorInput {
  /** ssh2 抛出的原始错误 */
  error: Error & { level?: string; code?: string }
  /** 本次连接使用的认证方式 */
  auth: AuthKind
  /** 是否填了密码 (用于区分「密码错」与「没填密码」) */
  hasPassword: boolean
  /** 是否填了私钥 */
  hasKey: boolean
  /** 是否填了私钥口令 */
  hasPassphrase: boolean
  /** 是否启用了键盘交互 */
  triedKeyboard: boolean
}

/** 错误信息中是否出现任一关键字 (大小写不敏感) */
function mentions(text: string, ...needles: string[]): boolean {
  const lower = text.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase()))
}

/**
 * 把 SSH 错误翻译成中文说明。
 * 无法归类的错误保留原文, 便于检索, 不吞掉技术细节。
 */
export function describeSshError(input: SshErrorInput): string {
  const { error, auth, hasPassword, hasKey, hasPassphrase, triedKeyboard } = input
  const raw = error.message || String(error)
  const code = error.code || ''
  const level = error.level || ''

  // --- 认证被拒 (client-authentication 级别, 或明确的认证失败文案) ---
  const authenticationFailed =
    level === 'client-authentication' ||
    mentions(raw, 'All configured authentication methods failed', 'authentication failed')

  if (authenticationFailed) {
    if (auth === 'key') {
      if (!hasKey) return '未选择私钥文件'
      return hasPassphrase ? '服务器未接受该私钥, 请检查私钥口令是否正确' : '服务器未接受该私钥, 请确认公钥已加入服务器的 authorized_keys'
    }
    if (auth === 'agent') {
      return 'SSH Agent 未提供可用的密钥, 请先 ssh-add 添加, 或确认服务器接受公钥登录'
    }
    if (auth === 'nopassword') {
      return '服务器要求密码, 「无密码」模式不会询问; 请改用「密码」或「使用密钥」'
    }
    if (!hasPassword) return '未填写密码'
    return '用户名或密码错误'
  }

  // --- 网络层 ---
  if (code === 'ECONNREFUSED' || mentions(raw, 'ECONNREFUSED')) {
    return '连接被拒绝, 该端口上没有服务在监听'
  }
  if (code === 'ETIMEDOUT' || mentions(raw, 'Timed out while waiting', 'ETIMEDOUT')) {
    return '连接超时, 请检查地址与端口, 或确认防火墙是否放行'
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || mentions(raw, 'EHOSTUNREACH', 'ENETUNREACH')) {
    return '主机不可达, 请检查网络连通性'
  }
  if (code === 'ENOTFOUND' || mentions(raw, 'getaddrinfo', 'ENOTFOUND')) {
    return '无法解析主机名, 请检查地址是否拼写正确'
  }
  if (code === 'ECONNRESET' || mentions(raw, 'ECONNRESET', 'socket hang up')) {
    return '连接被对方重置, 可能是服务器中断或中间设备拦截'
  }
  if (code === 'EPIPE') {
    return '连接已断开, 无法写入数据'
  }

  // --- 密钥格式 ---
  if (mentions(raw, 'Cannot parse privateKey', 'no key found', 'invalid format', 'bad passphrase', 'bad decrypt')) {
    if (mentions(raw, 'bad passphrase', 'bad decrypt')) return '私钥口令错误'
    if (hasKey && !hasPassphrase) return '私钥已加密, 请填写私钥口令'
    return '私钥格式无法识别, 请确认是 OpenSSH 或 PEM 格式的私钥'
  }

  // --- 握手 / 算法协商 ---
  if (mentions(raw, 'Handshake failed', 'no matching', 'no common algorithm', 'kex')) {
    return '与服务器没有共同支持的加密算法, 连接无法建立'
  }
  if (mentions(raw, 'Host denied', 'host key verification failed')) {
    return '主机密钥校验未通过'
  }

  // --- 协议层 ---
  if (mentions(raw, 'Client is not authenticated')) {
    return '认证尚未完成, 无法打开会话'
  }
  if (mentions(raw, 'Channel open failure')) {
    return '服务器拒绝打开会话通道, 可能已达连接数上限或策略限制'
  }
  if (mentions(raw, 'pty-req', 'pty request')) {
    return '服务器拒绝分配伪终端, 可能不允许交互式登录'
  }

  // --- 键盘交互提示 (ssh2 在需要但未启用时给出) ---
  if (mentions(raw, 'keyboard-interactive') && !triedKeyboard) {
    return '服务器要求键盘交互认证, 请启用「键盘交互」选项后重试'
  }

  // 无法归类: 保留原文, 不丢失技术细节
  return raw
}
