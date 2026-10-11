/**
 * 远端操作系统探测 (借鉴 shell-rs 的 HostOsProbe)
 *
 * 在连接成功后用独立 exec 通道问一次, 用户 shell 看不到, 输出也不会混进终端。
 * 两步探测: 先 POSIX (`uname -s` + `/etc/os-release`), 无输出再问 Windows (`cmd /c ver`)。
 */

/** 远端系统标识 */
export type RemoteOs =
  | 'ubuntu' | 'debian' | 'fedora' | 'redhat' | 'centos' | 'rocky' | 'alma'
  | 'arch' | 'alpine' | 'suse' | 'gentoo' | 'kali' | 'manjaro' | 'raspbian'
  | 'linux' | 'macos' | 'freebsd' | 'openbsd' | 'netbsd' | 'windows'

/** 第一步: 内核名 + 发行版信息; stderr 丢弃 (macOS 无 os-release, Windows 两半都失败) */
export const PROBE_COMMAND = 'uname -s; cat /etc/os-release 2>/dev/null'
/** 第二步: POSIX 探测完全无输出时的追问, cmd 与 PowerShell 都认 */
export const WINDOWS_PROBE_COMMAND = 'cmd /c ver'
/** 探测输出上限: /etc/os-release 只有几百字节, 超出说明主机异常 */
export const MAX_PROBE_OUTPUT = 8 * 1024

const OS_LABELS: Record<RemoteOs, string> = {
  ubuntu: 'Ubuntu', debian: 'Debian', fedora: 'Fedora', redhat: 'Red Hat',
  centos: 'CentOS', rocky: 'Rocky Linux', alma: 'AlmaLinux', arch: 'Arch Linux',
  alpine: 'Alpine', suse: 'openSUSE', gentoo: 'Gentoo', kali: 'Kali Linux',
  manjaro: 'Manjaro', raspbian: 'Raspbian', linux: 'Linux', macos: 'macOS',
  freebsd: 'FreeBSD', openbsd: 'OpenBSD', netbsd: 'NetBSD', windows: 'Windows'
}

/** 系统对应的短徽标字符 (标签与主机树上显示) */
const OS_GLYPHS: Record<RemoteOs, string> = {
  ubuntu: 'U', debian: 'D', fedora: 'F', redhat: 'R', centos: 'C', rocky: 'R',
  alma: 'A', arch: 'A', alpine: 'A', suse: 'S', gentoo: 'G', kali: 'K',
  manjaro: 'M', raspbian: 'R', linux: 'L', macos: '', freebsd: 'B',
  openbsd: 'B', netbsd: 'B', windows: 'W'
}

/** 人类可读的系统名 */
export function osLabel(os: RemoteOs): string {
  return OS_LABELS[os] || os
}

/** 徽标短字符 */
export function osGlyph(os: RemoteOs): string {
  return OS_GLYPHS[os] ?? ''
}

/** `/etc/os-release` 的值可能带引号 */
function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

/** 发行版 ID → RemoteOs */
function distributionId(id: string): RemoteOs | null {
  switch (id) {
    case 'ubuntu': return 'ubuntu'
    case 'debian': return 'debian'
    case 'fedora': return 'fedora'
    case 'rhel': case 'redhat': return 'redhat'
    case 'centos': return 'centos'
    case 'rocky': return 'rocky'
    case 'almalinux': return 'alma'
    case 'arch': return 'arch'
    case 'alpine': return 'alpine'
    case 'opensuse': case 'opensuse-leap': case 'opensuse-tumbleweed':
    case 'sles': case 'sled': case 'suse': return 'suse'
    case 'gentoo': return 'gentoo'
    case 'kali': return 'kali'
    case 'manjaro': return 'manjaro'
    case 'raspbian': return 'raspbian'
    default: return null
  }
}

/**
 * 从 os-release 里挑发行版。
 * ID_LIKE 是衍生版的回退 (Linux Mint 显示 Ubuntu), 只在 ID 本身不认识时才用。
 */
function distribution(output: string): RemoteOs | null {
  let like: RemoteOs | null = null
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('ID=')) {
      const os = distributionId(unquote(line.slice(3)))
      if (os) return os
    } else if (line.startsWith('ID_LIKE=') && !like) {
      for (const candidate of unquote(line.slice(8)).split(/\s+/)) {
        const os = distributionId(candidate)
        if (os) { like = os; break }
      }
    }
  }
  return like
}

/** 解析 POSIX 探测输出; null 表示无法识别, 应转向 Windows 追问 */
export function parseProbe(output: string): RemoteOs | null {
  const kernel = output.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  if (!kernel) return null
  switch (kernel) {
    case 'Darwin': return 'macos'
    case 'FreeBSD': return 'freebsd'
    case 'OpenBSD': return 'openbsd'
    case 'NetBSD': return 'netbsd'
    // 没有 /etc/os-release 或 ID 不认识的 Linux 仍是 Linux
    case 'Linux': return distribution(output) || 'linux'
    default: return null
  }
}

/** 解析 Windows 追问输出 */
export function parseWindowsProbe(output: string): RemoteOs | null {
  return output.includes('Windows') ? 'windows' : null
}
