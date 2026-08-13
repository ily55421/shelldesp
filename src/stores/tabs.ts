import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Tab } from '../types'

let tabCounter = 0
function genId() {
  return `tab-${++tabCounter}-${Date.now()}`
}

export type LocalShell = 'pwsh7' | 'cmd'

export interface LocalShellOption {
  id: LocalShell
  label: string
  exe: string
  icon: string
}

export const LOCAL_SHELLS: LocalShellOption[] = [
  { id: 'pwsh7', label: 'PowerShell 7', exe: 'pwsh.exe', icon: '⬛' },
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

  return { tabs, activeTabId, activeTab, canCreateTab, createLocalTab, createSshTab, closeTab, setActive, updateTitle, updateStatus }
})
