<template>
  <div class="status-panel">
    <div class="head">
      <span class="title">服务器状态</span>
      <span v-if="lastUpdated" class="time">{{ lastUpdated }}</span>
      <button
        class="refresh"
        :class="{ spinning: loading }"
        :disabled="loading || !isSsh"
        :title="refreshTitle"
        @click="refreshNow"
      >
        ⟳
      </button>
    </div>

    <!-- 非 SSH 标签: 明确说明, 不显示假数据 -->
    <div v-if="!isSsh" class="hint">本地终端无远端状态</div>

    <!-- SSH 未连接 -->
    <div v-else-if="!connected" class="hint">等待连接…</div>

    <!-- 采集失败 -->
    <div v-else-if="status && !status.ok" class="hint err">{{ status.error || '采集失败' }}</div>

    <template v-else-if="status">
      <!-- 系统标识 -->
      <div v-if="status.identity" class="block">
        <div class="row main">
          <span class="label">{{ status.identity.hostname || '未知主机' }}</span>
          <span class="badge">{{ status.identity.distroId || status.identity.kernel }}</span>
        </div>
        <div class="row dim" :title="status.identity.prettyName">
          {{ status.identity.prettyName || status.identity.kernel }}
        </div>
        <div class="row dim">
          已运行 {{ formatUptime(status.identity.uptimeSeconds) }}
          · 负载 {{ status.identity.load1 }} / {{ status.identity.load5 }} / {{ status.identity.load15 }}
        </div>
      </div>

      <!-- CPU -->
      <div v-if="status.cpu" class="block">
        <div class="row">
          <span class="label">CPU</span>
          <span class="value">{{ cpuText }}</span>
        </div>
        <div class="bar">
          <i :style="{ width: (status.cpuUsagePercent || 0) + '%', background: usageColor(status.cpuUsagePercent) }"></i>
        </div>
      </div>

      <!-- 内存 -->
      <div v-if="status.memory" class="block">
        <div class="row">
          <span class="label">内存</span>
          <span class="value">
            {{ formatKb(status.memory.usedKb) }} / {{ formatKb(status.memory.totalKb) }} · {{ status.memory.usedPercent }}%
          </span>
        </div>
        <div class="bar">
          <i :style="{ width: status.memory.usedPercent + '%', background: usageColor(status.memory.usedPercent) }"></i>
        </div>
        <div v-if="status.memory.swapTotalKb > 0" class="row dim">
          交换 {{ formatKb(status.memory.swapUsedKb) }} / {{ formatKb(status.memory.swapTotalKb) }}
        </div>
      </div>

      <!-- 磁盘 (取用量最高的前几项) -->
      <div v-if="topDisks.length > 0" class="block">
        <div class="row">
          <span class="label">磁盘</span>
          <span class="value dim">{{ diskCount }} 个分区</span>
        </div>
        <div v-for="d in topDisks" :key="d.mountPoint" class="disk">
          <div class="row tight">
            <span class="mount" :title="d.filesystem + ' → ' + d.mountPoint">{{ d.mountPoint }}</span>
            <span class="value dim">{{ formatKb(d.usedKb) }} / {{ formatKb(d.sizeKb) }} · {{ d.usedPercent }}%</span>
          </div>
          <div class="bar thin">
            <i :style="{ width: d.usedPercent + '%', background: usageColor(d.usedPercent) }"></i>
          </div>
        </div>
      </div>

      <!-- 网络速率 (需两次采样) -->
      <div v-if="netRates.length > 0" class="block">
        <div class="row">
          <span class="label">网络</span>
          <span class="value dim">间隔 {{ ((status.sampleIntervalMs || 0) / 1000).toFixed(1) }}s</span>
        </div>
        <div v-for="n in netRates" :key="n.name" class="row dim tight">
          <span class="mount">{{ n.name }}</span>
          <span class="value">↓ {{ formatBytes(n.rxPerSec) }}/s ↑ {{ formatBytes(n.txPerSec) }}/s</span>
        </div>
      </div>

      <!-- 部分采集项失败时说明, 不静默 -->
      <div v-if="failedItems.length > 0" class="row dim small">
        未采集: {{ failedItems.join(', ') }}
      </div>
    </template>

    <!-- 首次采集中 -->
    <div v-else-if="connected" class="hint">采集中…</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 服务器状态面板。
 *
 * 数据来自主进程的 ssh:system-status (独立通道采集, 不污染用户 shell)。
 * 刷新策略:
 * - SSH 标签连上后自动开始轮询 (默认 5s)
 * - 切换标签时立即刷新一次
 * - 标签断开或组件卸载时停掉定时器 (避免泄漏)
 *
 * CPU% 与网络速率需要两次采样, 所以首次采集只显示累计值 (CPU 显示「采样中」),
 * 第二轮起才有百分比 —— 不给假的 0。
 */
import { computed, ref, watch, onUnmounted } from 'vue'
import { useTabsStore } from '../stores/tabs'
import type { SystemStatus } from '../types'

const props = withDefaults(defineProps<{ tabId?: string; intervalMs?: number }>(), {
  tabId: '',
  intervalMs: 5000
})

const tabsStore = useTabsStore()

/** 当前要展示状态的标签: 显式传入优先, 否则跟随活动标签 */
const tab = computed(() => {
  if (props.tabId) return tabsStore.tabs.find((t) => t.id === props.tabId) || null
  return tabsStore.activeTab
})

const isSsh = computed(() => tab.value?.type === 'ssh')
const connected = computed(() => tab.value?.status === 'connected')

const status = ref<SystemStatus | null>(null)
const loading = ref(false)
const lastUpdated = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const diskCount = computed(() => status.value?.disks?.length || 0)
const netRates = computed(() => status.value?.netRates || [])
const failedItems = computed(() => status.value?.failed || [])

/** 磁盘按用量从高到低取前 3 项, 避免长列表把面板撑开 */
const topDisks = computed(() => {
  const disks = status.value?.disks || []
  return [...disks].sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 3)
})

const cpuText = computed(() => {
  const pct = status.value?.cpuUsagePercent
  const cores = status.value?.cpu?.cores
  // 首轮还没算出百分比: 明确显示「采样中」而不是 0%
  if (pct === null || pct === undefined) return `${cores ?? '?'} 核 · 采样中`
  return `${pct}% · ${cores ?? '?'} 核`
})

const refreshTitle = computed(() => {
  if (!isSsh.value) return '本地终端无远端状态'
  if (!connected.value) return '尚未连接'
  return `刷新 (每 ${(props.intervalMs / 1000).toFixed(0)} 秒自动)`
})

async function refreshNow() {
  const t = tab.value
  if (!t || t.type !== 'ssh' || t.status !== 'connected') return
  if (loading.value) return
  loading.value = true
  try {
    const result = await window.api.ssh.systemStatus(t.id)
    // 期间可能切走了标签: 结果只写回同一个标签, 避免张冠李戴
    if (tab.value?.id === t.id) {
      status.value = result
      if (result.ok) {
        const d = new Date()
        lastUpdated.value = [
          String(d.getHours()).padStart(2, '0'),
          String(d.getMinutes()).padStart(2, '0'),
          String(d.getSeconds()).padStart(2, '0')
        ].join(':')
      }
    }
  } catch {
    // 采集失败不弹错: 面板上已有明确说明, 下轮重试
  } finally {
    loading.value = false
  }
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

function startTimer() {
  stopTimer()
  timer = setInterval(refreshNow, props.intervalMs)
}

// 切换标签: 清空旧数据并立即刷新 (否则会短暂显示上一个服务器的数据)
watch(
  () => tab.value?.id,
  () => {
    status.value = null
    lastUpdated.value = ''
    stopTimer()
    if (isSsh.value && connected.value) {
      refreshNow()
      startTimer()
    }
  },
  { immediate: true }
)

// 连接状态变化: 连上才开始轮询, 断开就停
watch(connected, (now) => {
  if (now && isSsh.value) {
    refreshNow()
    startTimer()
  } else {
    stopTimer()
    status.value = null
  }
})

onUnmounted(stopTimer)

// --- 展示用格式化 (与主进程同口径, 避免两处不一致) ---

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function formatKb(kb: number): string {
  return formatBytes(kb * 1024)
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0 || d > 0) parts.push(`${h}小时`)
  parts.push(`${m}分`)
  return parts.join(' ')
}

/** 用量配色: 高用量醒目, 但不用刺眼的红铺满 */
function usageColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'var(--tx-2)'
  if (pct >= 90) return 'var(--red)'
  if (pct >= 70) return 'var(--amber)'
  return 'var(--green)'
}
</script>

<style scoped>
.status-panel {
  flex: none; padding: 8px 10px 10px;
  background: var(--bg-1); border-top: 1px solid var(--line);
  font-size: 11px; color: var(--tx-1); user-select: none;
  max-height: 42vh; overflow-y: auto;
}
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.title { color: var(--tx-0); font-weight: 600; }
.time { color: var(--tx-2); font-variant-numeric: tabular-nums; }
.refresh {
  margin-left: auto; background: transparent; border: 1px solid var(--line);
  color: var(--tx-1); border-radius: 3px; cursor: pointer;
  width: 20px; height: 20px; line-height: 1; font-size: 12px; padding: 0;
}
.refresh:hover:not(:disabled) { background: var(--bg-3); color: var(--amber); }
.refresh:disabled { opacity: 0.4; cursor: default; }
.refresh.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.hint { color: var(--tx-2); padding: 4px 0; }
.hint.err { color: var(--red); }

.block { margin-bottom: 8px; }
.row { display: flex; align-items: baseline; gap: 8px; }
.row.tight { margin-top: 2px; }
.row.main { color: var(--tx-0); }
.row.dim { color: var(--tx-2); }
.row.small { font-size: 10px; }
.label { color: var(--tx-0); flex: none; }
.value { margin-left: auto; text-align: right; font-variant-numeric: tabular-nums; }
.mount {
  max-width: 45%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; direction: rtl; text-align: left;
}
.badge {
  margin-left: auto; padding: 0 5px; border-radius: 3px;
  background: var(--amber-dim); color: var(--amber); font-size: 10px;
}
.bar { height: 4px; background: var(--bg-3); border-radius: 2px; overflow: hidden; margin-top: 3px; }
.bar.thin { height: 3px; }
.bar > i { display: block; height: 100%; transition: width 0.3s ease; }
.disk { margin-top: 4px; }
</style>
