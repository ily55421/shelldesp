<template>
  <div class="statusbar">
    <div class="cell">
      <span class="dot" :class="connected ? 'g' : ''"></span>
      {{ connected ? '已连接' : (activeTab ? '连接中' : '未连接') }}
    </div>
    <div class="cell" title="Shell 类型">
      {{ shellLabel }}
    </div>
    <div class="cell accent" :title="cwd">
      {{ cwdShort }}
    </div>
    <div class="spacer"></div>
    <div class="cell">UTF-8</div>
    <div class="cell">CRLF</div>
    <div class="cell">{{ fontSize }}px</div>
    <div class="cell" :style="{ color: latency > 100 ? 'var(--red)' : 'var(--green)' }">
      {{ latency > 0 ? latency + 'ms' : '—' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useTabsStore } from '../stores/tabs'

const tabsStore = useTabsStore()
const activeTab = computed(() => tabsStore.activeTab)

// M1: 从 store.settings 读取真实字号
const fontSize = ref(13)
const latency = ref(0)

// H3: 从 tab.status 读取真实连接状态
const connected = computed(() => activeTab.value?.status === 'connected')

const shellLabel = computed(() => {
  const tab = activeTab.value
  if (!tab) return '—'
  if (tab.type === 'ssh') return '⛓ SSH'
  const shell = tab.shell || ''
  if (shell.includes('pwsh')) return '▸ pwsh'
  if (shell.includes('cmd')) return '▮ cmd'
  if (shell.includes('powershell')) return '▸ PS'
  return '—'
})

const cwd = computed(() => {
  const tab = activeTab.value
  if (!tab) return '—'
  if (tab.type === 'ssh') return tab.ssh?.host || '—'
  return tab.cwd || '—'
})

const cwdShort = computed(() => {
  const c = cwd.value
  if (c.length > 40) return '...' + c.slice(-37)
  return c
})

// 加载设置
let settingsLoaded = false
async function loadSettings() {
  if (settingsLoaded) return
  settingsLoaded = true
  try {
    const s = await window.api.store.settings.get()
    if (s?.fontSize) fontSize.value = s.fontSize
  } catch {}
}

onMounted(() => { loadSettings() })
onUnmounted(() => {})
</script>

<style scoped>
.statusbar {
  height: var(--statusbar-height); flex: none;
  display: flex; align-items: center;
  background: var(--bg-1); border-top: 1px solid var(--line);
  font-size: 11px; color: var(--tx-1); padding: 0 4px; user-select: none;
}
.cell {
  display: flex; align-items: center; gap: 6px;
  padding: 0 10px; height: 100%;
  border-right: 1px solid var(--line-soft); white-space: nowrap;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tx-2); }
.dot.g { background: var(--green); box-shadow: 0 0 6px rgba(74,222,128,0.7); }
.spacer { flex: 1; border: 0; }
.accent { color: var(--amber); }
</style>
