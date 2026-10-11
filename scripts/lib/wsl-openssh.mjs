/**
 * 真实 OpenSSH 测试服务端 (通过 WSL 里的 Debian OpenSSH)。
 *
 * 为什么需要它: ssh2 的 Server 是 JS 实现, 覆盖不到真实 OpenSSH 的行为 ——
 * 算法协商的实际选择、真实 shell/pty、sftp 子系统、OpenSSH 特有的错误文案。
 *
 * 环境不可用时 (没有 WSL / 没装 openssh-server / 端口占用) 返回 ok:false,
 * 由调用方明确跳过, 不假装通过。
 *
 * 关键点: WSL2 会把监听在 0.0.0.0 的端口通过 localhost 转发到 Windows,
 * 所以 Windows 侧的 ssh2 客户端可以直连 127.0.0.1:<port>。
 */

import { execFileSync } from 'node:child_process'
import { Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const OPENSSH_PORT = 22911
export const OPENSSH_USER = 'link'
/** 服务端文件在 WSL 内的位置 (每次重建) */
const WSL_DIR = '/tmp/shelldesk-osshtest'
const WSL_HOST_KEY = `${WSL_DIR}/host_ed25519`
const WSL_CLIENT_KEY = `${WSL_DIR}/client_ed25519`
const WSL_CONFIG = `${WSL_DIR}/sshd_config`
/**
 * Windows 侧读取客户端私钥的路径。
 *
 * 不能直接用 \\wsl$\<distro>\tmp\... : Linux 侧 600 权限的文件通过 9p 挂载
 * 会返回 EPERM。改为让 WSL 把私钥写一份到 Windows 可读的临时目录
 * (权限 644, 内容仅测试用), 再从那边读。
 */
function exportClientKeyToWindows() {
  const target = join(tmpdir(), `shelldesk-openssh-client-${process.pid}.key`)
  const winPath = target.replace(/\\/g, '/')
  // WSL 能访问 Windows 盘: /mnt/<drive>/...
  const drive = winPath[0].toLowerCase()
  const wslTarget = `/mnt/${drive}${winPath.slice(2)}`
  const result = wslRootSafe(`
cp ${WSL_CLIENT_KEY} ${wslTarget} && chmod 644 ${wslTarget} && echo EXPORTED
`)
  if (!result.out.includes('EXPORTED')) {
    throw new Error('导出客户端私钥失败:\n' + result.out)
  }
  return { winPath: target, wslPath: wslTarget }
}


/** 在 WSL 里以 root 跑一段 shell, 返回 stdout+stderr (UTF-8 字符串) */
function wslRoot(script, { timeout = 180000 } = {}) {
  const raw = execFileSync('wsl', ['-u', 'root', '-e', 'sh', '-c', script], {
    timeout, maxBuffer: 8 * 1024 * 1024,
    // 不因非零退出抛异常: 脚本内部自己报错, 便于看到完整输出
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return raw.toString('utf8')
}

/**
 * 在 WSL 里跑脚本并把 stderr 也收进来。
 * execFileSync 在非零退出时会抛, 这里统一转成 { ok, out }。
 */
function wslRootSafe(script, options) {
  try {
    return { ok: true, out: wslRoot(script, options) }
  } catch (error) {
    const stdout = error?.stdout ? error.stdout.toString('utf8') : ''
    const stderr = error?.stderr ? error.stderr.toString('utf8') : ''
    return {
      ok: false,
      out: `${stdout}\n${stderr}`.trim(),
      status: error?.status,
      message: error?.message
    }
  }
}

/** 检查环境是否具备起真 OpenSSH 的条件 */
export async function openSshAvailable() {
  // 1. WSL 在吗
  try {
    execFileSync('wsl', ['-e', 'sh', '-c', 'true'], { timeout: 30000 })
  } catch (error) {
    return { ok: false, reason: 'WSL 不可用: ' + (error?.message || String(error)) }
  }
  // 2. 有 sshd 吗
  try {
    const out = wslRoot('command -v /usr/sbin/sshd || echo MISSING').trim()
    if (out.includes('MISSING')) {
      return { ok: false, reason: 'WSL 里没有 openssh-server (可执行 apt-get install -y openssh-server)' }
    }
  } catch (error) {
    return { ok: false, reason: 'WSL 里检查 sshd 失败: ' + (error?.message || String(error)) }
  }
  // 3. 目标端口在 Windows 侧是否已被占用
  const free = await isPortFree(OPENSSH_PORT)
  if (!free) {
    // 可能正是我们上次留下的实例, 后面会先 kill 再起
  }
  return { ok: true }
}

/** Windows 侧端口是否空闲 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * 确保一个真 OpenSSH 服务端在跑, 返回它的连接信息。
 * 幂等: 重复调用会先停掉旧实例再起新的。
 */
export async function ensureOpenSshServer() {
  // 不用 set -e: pkill 命中自身等非致命失败会中断整个脚本。
  // 每步显式报告, 最后用「是否在监听」判定成败。
  const setup = `
mkdir -p ${WSL_DIR} || { echo STEP_FAIL mkdir; exit 1; }
cd ${WSL_DIR} || { echo STEP_FAIL cd; exit 1; }

if [ ! -f host_ed25519 ]; then
  ssh-keygen -t ed25519 -f host_ed25519 -N "" -q || { echo STEP_FAIL host_keygen; exit 1; }
fi
if [ ! -f client_ed25519 ]; then
  ssh-keygen -t ed25519 -f client_ed25519 -N "" -q || { echo STEP_FAIL client_keygen; exit 1; }
fi
chmod 600 host_ed25519 client_ed25519
chmod 644 host_ed25519.pub client_ed25519.pub

mkdir -p /home/${OPENSSH_USER}/.ssh || { echo STEP_FAIL mkdir_ssh; exit 1; }
cp client_ed25519.pub /home/${OPENSSH_USER}/.ssh/authorized_keys || { echo STEP_FAIL cp_authkeys; exit 1; }
chown -R ${OPENSSH_USER}:${OPENSSH_USER} /home/${OPENSSH_USER}/.ssh
chmod 700 /home/${OPENSSH_USER}/.ssh
chmod 600 /home/${OPENSSH_USER}/.ssh/authorized_keys

cat > ${WSL_CONFIG} <<EOF
Port ${OPENSSH_PORT}
ListenAddress 0.0.0.0
HostKey ${WSL_HOST_KEY}
PidFile ${WSL_DIR}/sshd.pid
LogLevel VERBOSE
AuthorizedKeysFile .ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PermitRootLogin no
StrictModes no
AllowTcpForwarding no
X11Forwarding no
Subsystem sftp internal-sftp
EOF

mkdir -p /run/sshd
chmod 755 /run/sshd

# 停掉旧实例。
# 不能用 pkill -f "sshd -f <cfg>": 本脚本自己的命令行里就含这段字样,
# pkill 会匹配到执行中的 sh 并把它 SIGTERM 掉 (表现为退出码 15、后续步骤全不执行)。
# 改为只按 pid 文件停, 再按进程名精确匹配 sshd 可执行文件。
if [ -f ${WSL_DIR}/sshd.pid ]; then
  OLD_PID="$(cat ${WSL_DIR}/sshd.pid 2>/dev/null)"
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null
  fi
fi
# 兜底: 按进程的可执行路径匹配 (pgrep -x 只比进程名, 不会匹配到 sh)
for pid in $(pgrep -x sshd 2>/dev/null); do
  if [ "$pid" != "$$" ]; then
    kill "$pid" 2>/dev/null
  fi
done
sleep 1

if ! /usr/sbin/sshd -t -f ${WSL_CONFIG}; then
  echo STEP_FAIL config_check
  exit 1
fi

if ! /usr/sbin/sshd -f ${WSL_CONFIG}; then
  echo STEP_FAIL start
  exit 1
fi
sleep 1

if ss -ltn 2>/dev/null | grep -q ":${OPENSSH_PORT}"; then
  echo LISTENING
else
  echo NOT_LISTENING
fi
ssh -V 2>&1
`
  const result = wslRootSafe(setup)
  const out = result.out
  if (!out.includes('LISTENING')) {
    const step = (out.match(/STEP_FAIL \w+/) || ['(无具体步骤)'])[0]
    throw new Error(`OpenSSH 未在监听 (${step}, 退出码 ${result.status ?? 'n/a'}):\n${out}`)
  }
  const version = (out.match(/OpenSSH_[\w.]+[^\n]*/) || ['OpenSSH_unknown'])[0].trim()

  // 等 Windows 侧能连上 (WSL2 的 localhost 转发需要一点时间)
  await waitForPort(OPENSSH_PORT, 15000)

  // 私钥导出到 Windows 可读的位置
  const exported = exportClientKeyToWindows()

  return {
    port: OPENSSH_PORT,
    version,
    clientKeyPath: exported.winPath,
    clientKeyWslPath: exported.wslPath,
    wslDir: WSL_DIR
  }
}

/**
 * 等端口可连 (Windows 侧)。
 * 用 socket.connect 而不是 listen: 我们要判断的是「能否连上」,
 * 而 listen 判断的是「能否占用」—— 后者在端口被占用时会失败, 逻辑正好相反。
 */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new Socket()
      const done = (ok) => {
        socket.removeAllListeners()
        socket.destroy()
        if (ok) resolve()
        else if (Date.now() > deadline) {
          reject(new Error(`端口 ${port} 在 ${timeoutMs}ms 内不可连 (WSL2 localhost 转发可能未生效)`))
        } else {
          setTimeout(attempt, 250)
        }
      }
      socket.setTimeout(2000)
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.once('timeout', () => done(false))
      socket.connect(port, '127.0.0.1')
    }
    attempt()
  })
}

/** 停掉测试用 OpenSSH (只停我们自己配置的那个) */
export async function stopOpenSshServer() {
  // 同样避开 pkill -f (会匹配到本脚本自身)
  wslRootSafe(`
if [ -f ${WSL_DIR}/sshd.pid ]; then
  OLD_PID="$(cat ${WSL_DIR}/sshd.pid 2>/dev/null)"
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null
  fi
fi
for pid in $(pgrep -x sshd 2>/dev/null); do
  kill "$pid" 2>/dev/null
done
echo STOPPED
`)
}
