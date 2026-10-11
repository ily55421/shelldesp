import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Tab } from '../types'

let tabCounter = 0
function genId() {
  return `tab-${++tabCounter}-${Date.now()}`
}

export type LocalShell = 'pwsh7' | 'cmd' | 'powershell5'

export interface LocalShellOption {
  id: LocalShell
  label: string
  exe: string
  icon: string
}

export const LOCAL_SHELLS: LocalShellOption[] = [
  { id: 'pwsh7', label: 'PowerShell 7', exe: 'pwsh.exe', icon: '⬛' },
  { id: 'powershell5', label: 'Windows PowerShell', exe: 'powershell.exe', icon: '▸' },
  { id: 'cmd', label: '命令提示符', exe: 'cmd.exe', icon: '▶' }
]

export const MAX_TABS = 12

export function shellIdToExe(shellId?: string): string {
  if (!shellId) return LOCAL_SHELLS[0].exe
  const found = LOCAL_SHELLS.find(s => s.id === shellId)
  return found ? found.exe : shellId
}

export function shellIdToLabel(shellId?: string): string {
  const found = LOCAL_SHELLS.find(s => s.id === shellId)
  return found ? found.label : '终端'
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeTabId = ref<string | null>(null)

  const activeTab = computed(() =>
    tabs.value.find(t => t.id === activeTabId.value) || null
  )

  // M8: 上限检查收敛到 store
  function canCreateTab(): boolean {
    return tabs.value.length < MAX_TABS
  }

  function createLocalTab(shellId?: string, cwd?: string): string | null {
    if (!canCreateTab()) return null
    const id = genId()
    const exe = shellIdToExe(shellId)
    const title = shellIdToLabel(shellId)
    tabs.value.push({ id, title, type: 'local', status: 'connected', shell: exe, cwd })
    activeTabId.value = id
    return id
  }

  function createSshTab(name: string, ssh: Tab['ssh']): string | null {
    if (!canCreateTab()) return null
    const id = genId()
    tabs.value.push({ id, title: name, type: 'ssh', status: 'connecting', ssh })
    activeTabId.value = id
    return id
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex(t => t.id === id)
    if (idx === -1) return
    tabs.value.splice(idx, 1)
    // 标签被移除时断开后端连接, 并清掉它的 IPC 监听。
    // 不清监听的话, 每开关一个 SSH 标签都会在渲染进程里留下
    // 7 个永不回收的监听器 (connected/error/closed/data/exit/os/hostkey-mismatch)。
    window.api?.ssh?.removeListeners?.(id)
    window.api?.ssh?.disconnect?.(id)
    window.api?.pty?.removeListeners?.(id)
    window.api?.pty?.kill?.(id)
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value.length > 0
        ? tabs.value[Math.max(0, idx - 1)].id
        : null
    }
  }

  function setActive(id: string) { activeTabId.value = id }
  function updateTitle(id: string, title: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.title = title
  }
  function updateStatus(id: string, status: import('../types').TabStatus) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.status = status
  }
  /** 远端系统探测结果 (连接成功后由主进程推送) */
  function updateRemoteOs(id: string, info: { os: string; label: string; glyph: string }) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.remoteOs = info
  }
  /** 该主机当前是否已有活动会话 (侧栏状态点用) */
  function hasSessionFor(host: string, username: string): boolean {
    return tabs.value.some(t =>
      t.type === 'ssh' && t.ssh?.host === host && t.ssh?.username === username
    )
  }
  function reorder(fromId: string, toId: string) {
    const fromIdx = tabs.value.findIndex(t => t.id === fromId)
    const toIdx = tabs.value.findIndex(t => t.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const [item] = tabs.value.splice(fromIdx, 1)
    tabs.value.splice(toIdx, 0, item)
  }
  function closeOthers(id: string) {
    closeMany(tabs.value.filter(t => t.id !== id).map(t => t.id))
  }
  /** 关闭某一侧的全部标签 (借鉴 shell-rs 的 CloseScope::Left/Right) */
  function closeSide(id: string, side: 'left' | 'right'): number {
    const idx = tabs.value.findIndex(t => t.id === id)
    if (idx === -1) return 0
    const doomed = side === 'left' ? tabs.value.slice(0, idx) : tabs.value.slice(idx + 1)
    if (doomed.length === 0) return 0
    closeMany(doomed.map(t => t.id))
    return doomed.length
  }
  function closeAll() {
    closeMany(tabs.value.map(t => t.id))
  }

  /**
   * 批量关闭。
   * 必须逐个走 closeTab: 直接过滤数组会跳过断开连接与清理监听,
   * 造成后端会话与 IPC 监听器泄漏。closeTab 顺带修正 activeTabId,
   * 因此这里不需要另写一套激活项逻辑。
   */
  function closeMany(ids: string[]) {
    for (const id of ids) closeTab(id)
  }

  return { tabs, activeTabId, activeTab, canCreateTab, createLocalTab, createSshTab, closeTab, setActive, updateTitle, updateStatus, updateRemoteOs, hasSessionFor, reorder, closeOthers, closeSide, closeAll }
})
