<template>
  <div class="app-container">
    <TitleBar />
    <div class="body">
      <Sidebar @execute="handleExecute" @cdToPath="handleCdToPath" />
      <div class="main-area">
        <TabBar />
        <div class="terminal-area">
          <TerminalPane v-if="activeTab" :key="activeTab.id" :tab="activeTab" />
          <div v-if="tabs.length === 0" class="empty-state">
            <div class="empty-card" @click="newLocalTab">
              <span class="plus">＋</span>
              <p>新建 PowerShell 7 终端</p>
              <small>Ctrl+T</small>
            </div>
          </div>
        </div>
        <StatusBar />
      </div>
    </div>
    <div class="toast-container">
      <div v-for="t in toasts" :key="t.id" class="toast show">{{ t.msg }}</div>
    </div>
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTabsStore } from './stores/tabs'
import { useShortcutsStore } from './stores/shortcuts'
import { useSettingsStore } from './stores/settings'
import { useToast } from './composables/useToast'
import Sidebar from './components/Sidebar.vue'
import TabBar from './components/TabBar.vue'
import TerminalPane from './components/TerminalPane.vue'
import StatusBar from './components/StatusBar.vue'
import TitleBar from './components/TitleBar.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import type { ShortcutCommand, CommandStep } from './types'

const tabsStore = useTabsStore()
const shortcutsStore = useShortcutsStore()
const settingsStore = useSettingsStore()
const { tabs, activeTabId, activeTab } = storeToRefs(tabsStore)
const { toasts, show: showToast } = useToast()
const showSettings = ref(false)

// F1: defaultShell 设置 → shellId 映射
function defaultShellId(): string {
  const shell = settingsStore.settings.defaultShell
  if (shell === 'cmd.exe') return 'cmd'
  return 'pwsh7'
}

function newLocalTab() {
  const id = tabsStore.createLocalTab(defaultShellId())
  if (!id) showToast('标签页已达上限 (12)')
  else showToast('新建终端')
}

function ensureLocalTab(): string | null {
  const active = tabsStore.activeTab
  if (active && active.type === 'local') return active.id
  const localTab = tabs.value.find(t => t.type === 'local')
  if (localTab) return localTab.id
  return tabsStore.createLocalTab(defaultShellId())
}

function execCommand(tabId: string, command: string, isSsh: boolean) {
  if (isSsh) window.api.ssh.exec(tabId, command)
  else window.api.pty.exec(tabId, command)
}

// F2: confirmClose 设置 — 关闭标签前确认
function confirmCloseTab(id: string) {
  if (settingsStore.settings.confirmClose) {
    if (!window.confirm('确认关闭此标签页?')) return
  }
  tabsStore.closeTab(id)
}

function handleExecute(shortcut: ShortcutCommand) {
  const isSsh = !!(shortcut.sshHost)
  const steps = resolveSteps(shortcut)

  // H2: sshHost 快捷指令 — 在匹配的 SSH 标签上执行
  if (isSsh && shortcut.sshHost) {
    const sshTab = tabs.value.find(t =>
      t.type === 'ssh' && t.ssh?.host === shortcut.sshHost
    )
    if (!sshTab) {
      showToast('未找到 SSH 会话: ' + shortcut.sshHost)
      return
    }
    tabsStore.setActive(sshTab.id)
    const id = sshTab.id
    if (shortcut.cwd) {
      execCommand(id, `cd "${shortcut.cwd}"`, true)
      setTimeout(() => runSteps(id, steps, 0, true), 300)
    } else {
      runSteps(id, steps, 0, true)
    }
    showToast('已执行: ' + shortcut.name)
    return
  }

  if (shortcut.newTab || activeTabId.value === null) {
    const id = tabsStore.createLocalTab(defaultShellId(), shortcut.cwd || undefined)
    if (!id) { showToast('标签页已达上限'); return }
    setTimeout(() => {
      if (shortcut.cwd) {
        execCommand(id, `cd "${shortcut.cwd}"`, false)
        setTimeout(() => runSteps(id, steps, 0, false), 300)
      } else {
        runSteps(id, steps, 0, false)
      }
    }, 600)
  } else {
    const id = activeTabId.value!
    if (shortcut.cwd) {
      execCommand(id, `cd "${shortcut.cwd}"`, isSsh)
      setTimeout(() => runSteps(id, steps, 0, isSsh), 300)
    } else {
      runSteps(id, steps, 0, isSsh)
    }
  }
  showToast('已执行: ' + shortcut.name)
}

function resolveSteps(sc: ShortcutCommand): CommandStep[] {
  if (sc.steps && sc.steps.length > 0) return sc.steps
  return [{ command: sc.command, delayMs: 0 }]
}

function runSteps(tabId: string, steps: CommandStep[], index: number, isSsh: boolean) {
  if (index >= steps.length) return
  const step = steps[index]
  execCommand(tabId, step.command, isSsh)
  const delay = step.delayMs ?? 300
  if (index + 1 < steps.length) {
    setTimeout(() => runSteps(tabId, steps, index + 1, isSsh), delay)
  }
}

function handleCdToPath(path: string) {
  const id = ensureLocalTab()
  if (!id) { showToast('标签页已达上限'); return }
  tabsStore.setActive(id)
  setTimeout(() => execCommand(id, `cd "${path}"`, false), 100)
  showToast('已跳转到 ' + path)
}

// M2: 全局快捷键
function onKeydown(e: KeyboardEvent) {
  // 不在输入框中
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
  if (e.ctrlKey) {
    if (e.key === 't') { e.preventDefault(); newLocalTab() }
    else if (e.key === 'w') {
      e.preventDefault()
      if (activeTabId.value) confirmCloseTab(activeTabId.value)
    }
    else if (e.key === 'd') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('open-path-dialog'))
    }
  }
}

watch(tabs, (newTabs, oldTabs) => {
  if (!oldTabs) return
  const removed = oldTabs.filter(t => !newTabs.find(nt => nt.id === t.id))
  for (const tab of removed) {
    if (tab.type === 'local') window.api.pty.kill(tab.id)
    else if (tab.type === 'ssh') window.api.ssh.disconnect(tab.id)
  }
}, { deep: true })

onMounted(async () => {
  await Promise.all([shortcutsStore.load(), settingsStore.load()])
  if (tabs.value.length === 0) tabsStore.createLocalTab(defaultShellId())
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('open-settings', () => { showSettings.value = true })
})

onUnmounted(() => {
  for (const tab of tabs.value) {
    if (tab.type === 'local') window.api.pty.kill(tab.id)
    else if (tab.type === 'ssh') window.api.ssh.disconnect(tab.id)
  }
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.app-container { display: flex; flex-direction: column; height: 100%; }
.body { flex: 1; display: flex; min-height: 0; }
.main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.terminal-area { flex: 1; position: relative; overflow: hidden; background: var(--bg-0); }
.empty-state { display: flex; align-items: center; justify-content: center; height: 100%; }
.empty-card {
  border: 1px dashed var(--line); border-radius: var(--r);
  text-align: center; color: var(--tx-2); font-size: 12px;
  padding: 24px 32px; cursor: pointer; transition: all 0.15s;
}
.empty-card:hover { border-color: rgba(255,176,0,0.4); color: var(--tx-1); background: rgba(255,176,0,0.03); }
.empty-card .plus { font-size: 24px; display: block; margin-bottom: 6px; color: var(--amber); }
.empty-card small { display: block; margin-top: 4px; font-size: 10px; color: var(--tx-2); }
</style>
