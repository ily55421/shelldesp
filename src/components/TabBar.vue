<template>
  <div class="tabbar">
    <button
      v-if="canScrollLeft"
      class="scroll-btn left"
      @click="scrollLeft"
      title="向左滚动"
    >
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2L3 5l4 3" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
    </button>
    <div ref="scrollRef" class="tabs-scroll" @wheel="onWheel" @scroll="updateScrollState">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeTabId, dragging: dragId === tab.id }"
        draggable="true"
        @click="tabsStore.setActive(tab.id)"
        @dblclick="startRename(tab.id, tab.title)"
        @auxclick="onAuxClick($event, tab.id)"
        @contextmenu.prevent="openContextMenu($event, tab.id)"
        @dragstart="onDragStart($event, tab.id)"
        @dragover.prevent="onDragOver($event, tab.id)"
        @drop="onDrop($event, tab.id)"
        @dragend="dragId = ''"
      >
        <span class="t-ic">{{ tab.type === 'ssh' ? '⛓' : (tab.shell?.includes('pwsh') ? '▸' : '▮') }}</span>
        <!-- 连接状态点: 借鉴 shell-rs 的状态图标 (连接中/已连接/已断开) -->
        <span class="t-status" :class="tab.status" :title="statusLabel(tab.status)"></span>
        <!-- 远端系统徽标: 探测成功后显示 (借鉴 shell-rs 的 HostMark) -->
        <span v-if="tab.remoteOs" class="t-os" :title="tab.remoteOs.label">{{ tab.remoteOs.glyph }}</span>
        <input
          v-if="renamingId === tab.id"
          ref="renameInputRef"
          class="t-rename-input"
          v-model="renameValue"
          @blur="finishRename"
          @keydown.enter="finishRename"
          @keydown.esc="cancelRename"
        />
        <span v-else class="t-title">{{ tab.title }}</span>
        <!-- SSH 延迟: 三色阈值 (借鉴 shell-rs 的 LatencyLabel) -->
        <span v-if="tab.type === 'ssh' && latencyOf(tab.id) !== null" class="t-latency" :class="latencyLevel(latencyOf(tab.id)!)" :title="latencyTitle(latencyOf(tab.id)!)">
          {{ latencyOf(tab.id) }}ms
        </span>
        <button class="t-close" @click.stop="closeTab(tab.id)" title="关闭">✕</button>
      </div>
      <button class="tab-new" @click="showNewMenu = !showNewMenu" title="新建标签 (Ctrl+T)">+</button>
    </div>
    <button
      v-if="canScrollRight"
      class="scroll-btn right"
      @click="scrollRight"
      title="向右滚动"
    >
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
    </button>

    <div v-if="showNewMenu" class="new-menu" @mouseleave="showNewMenu = false">
      <div class="menu-group-label">本地终端</div>
      <div class="menu-item" @click="newLocal('pwsh7')">
        <span class="menu-icon">▸</span>
        <span>PowerShell 7</span>
      </div>
      <div class="menu-item" @click="newLocal('cmd')">
        <span class="menu-icon">▮</span>
        <span>命令提示符</span>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="newSsh">
        <span class="menu-icon">⛓</span>
        <span>SSH 连接</span>
      </div>
    </div>

    <!-- 2.2: 右键菜单 -->
    <div
      v-if="contextMenu.visible"
      class="ctx-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @mouseleave="contextMenu.visible = false"
    >
      <div class="menu-item" @click="ctxAction('rename')">✎ 重命名</div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="ctxAction('close')">✕ 关闭</div>
      <div
        class="menu-item"
        :class="{ disabled: !canCloseSide(contextMenu.tabId, 'left') }"
        @click="canCloseSide(contextMenu.tabId, 'left') && ctxAction('closeLeft')"
      >
        ⇤ 关闭左侧标签
      </div>
      <div
        class="menu-item"
        :class="{ disabled: !canCloseSide(contextMenu.tabId, 'right') }"
        @click="canCloseSide(contextMenu.tabId, 'right') && ctxAction('closeRight')"
      >
        ⇥ 关闭右侧标签
      </div>
      <div
        class="menu-item"
        :class="{ disabled: tabs.length <= 1 }"
        @click="tabs.length > 1 && ctxAction('closeOthers')"
      >
        ☒ 关闭其他
      </div>
      <div class="menu-item" @click="ctxAction('closeAll')">⬚ 全部关闭</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useTabsStore } from '../stores/tabs'
import { useToast } from '../composables/useToast'
import { closeTabWithConfirm } from '../composables/useAppShortcuts'

const tabsStore = useTabsStore()
const { tabs, activeTabId } = storeToRefs(tabsStore)
const showNewMenu = ref(false)
const { show: showToast } = useToast()

const scrollRef = ref<HTMLDivElement>()
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

// 2.2: 拖拽排序
let dragId = ''
function onDragStart(e: DragEvent, id: string) {
  dragId = id
  e.dataTransfer?.setData('text/plain', id)
}
function onDragOver(e: DragEvent, _id: string) { e.preventDefault() }
function onDrop(e: DragEvent, id: string) {
  e.preventDefault()
  if (dragId && dragId !== id) tabsStore.reorder(dragId, id)
  dragId = ''
}

// 2.2: 双击重命名
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameInputRef = ref<HTMLInputElement[]>([])
function startRename(id: string, title: string) {
  renamingId.value = id
  renameValue.value = title
  nextTick(() => {
    const input = renameInputRef.value?.[0]
    if (input) { input.focus(); input.select() }
  })
}
function finishRename() {
  if (renamingId.value && renameValue.value.trim()) {
    tabsStore.updateTitle(renamingId.value, renameValue.value.trim())
  }
  renamingId.value = null
}
function cancelRename() { renamingId.value = null }

// 2.2: 中键关闭
function onAuxClick(e: MouseEvent, id: string) {
  if (e.button === 1) { e.preventDefault(); closeTab(id) }
}

// 2.2: 右键菜单
const contextMenu = ref({ visible: false, x: 0, y: 0, tabId: '' })
function openContextMenu(e: MouseEvent, id: string) {
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, tabId: id }
}
function ctxAction(action: string) {
  const id = contextMenu.value.tabId
  contextMenu.value.visible = false
  switch (action) {
    case 'rename': startRename(id, tabs.value.find(t => t.id === id)?.title || ''); break
    case 'close': closeTab(id); break
    case 'closeLeft': {
      const n = tabsStore.closeSide(id, 'left')
      if (n > 0) showToast(`已关闭左侧 ${n} 个标签`)
      break
    }
    case 'closeRight': {
      const n = tabsStore.closeSide(id, 'right')
      if (n > 0) showToast(`已关闭右侧 ${n} 个标签`)
      break
    }
    case 'closeOthers': tabsStore.closeOthers(id); break
    case 'closeAll': tabsStore.closeAll(); break
  }
}

/** 该侧是否有关闭对象 (无对象则菜单项置灰, 借鉴 shell-rs 的 menu_with_disabled) */
function canCloseSide(id: string, side: 'left' | 'right'): boolean {
  const idx = tabs.value.findIndex(t => t.id === id)
  if (idx === -1) return false
  return side === 'left' ? idx > 0 : idx < tabs.value.length - 1
}

// --- 标签状态与延迟显示 (借鉴 shell-rs 的 LatencyLabel) ---

function statusLabel(status: string): string {
  return status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : '已断开'
}

/** 每个 SSH 标签的最近一次延迟 (ms); 无值表示未测量 */
const latencies = ref<Record<string, number>>({})
let latencyTimer: ReturnType<typeof setInterval> | null = null

function latencyOf(id: string): number | null {
  const v = latencies.value[id]
  return typeof v === 'number' && v > 0 ? v : null
}

/** 三色阈值: <100 良好, 100~200 一般, >200 差 */
function latencyLevel(ms: number): 'good' | 'fair' | 'poor' {
  if (ms < 100) return 'good'
  if (ms <= 200) return 'fair'
  return 'poor'
}

function latencyTitle(ms: number): string {
  const level = latencyLevel(ms)
  const word = level === 'good' ? '良好' : level === 'fair' ? '一般' : '较差'
  return `SSH 往返延迟 ${ms}ms (${word})`
}

/** 轮询活动 SSH 标签的延迟; 借鉴 shell-rs 的 LATENCY_INTERVAL = 5s */
function pollLatency() {
  const tab = tabs.value.find(t => t.id === activeTabId.value)
  if (!tab || tab.type !== 'ssh' || tab.status !== 'connected') return
  window.api.ssh.ping(tab.id).then((ms: number) => {
    // -1 表示测量失败: 保留上一次读数, 避免闪烁成「—」
    if (typeof ms === 'number' && ms >= 0) {
      latencies.value = { ...latencies.value, [tab.id]: ms }
    }
  }).catch(() => {})
}

/** 标签关闭后清掉它的延迟读数, 否则 Map 随开关标签无限增长 */
function pruneLatencies(ids: string[]) {
  const live = new Set(ids)
  let changed = false
  const next: Record<string, number> = {}
  for (const [id, ms] of Object.entries(latencies.value)) {
    if (live.has(id)) next[id] = ms
    else changed = true
  }
  if (changed) latencies.value = next
}

// 标签集合变化时清理残留读数
watch(() => tabs.value.map(t => t.id).join('|'), () => {
  pruneLatencies(tabs.value.map(t => t.id))
})

// F3: 右键菜单外部点击关闭
// 注意: 必须排除「加号按钮」与「新建菜单」自身。
// 按钮的 @click 先把 showNewMenu 置 true, 事件随后继续冒泡到 window,
// 若这里无条件关闭, 菜单会立刻被关掉 —— 表现就是「点加号没反应」。
function onGlobalClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const fromNewButton = !!target?.closest('.tab-new')
  const fromNewMenu = !!target?.closest('.new-menu')
  if (contextMenu.value.visible) contextMenu.value.visible = false
  if (showNewMenu.value && !fromNewButton && !fromNewMenu) showNewMenu.value = false
}

onMounted(() => {
  window.addEventListener('click', onGlobalClick)
  latencyTimer = setInterval(pollLatency, 5000)
  pollLatency()
})
onUnmounted(() => {
  window.removeEventListener('click', onGlobalClick)
  if (latencyTimer) clearInterval(latencyTimer)
})

function updateScrollState() {
  const el = scrollRef.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 4
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}

function scrollLeft() {
  const el = scrollRef.value
  if (!el) return
  el.scrollBy({ left: -200, behavior: 'smooth' })
  setTimeout(updateScrollState, 300)
}

function scrollRight() {
  const el = scrollRef.value
  if (!el) return
  el.scrollBy({ left: 200, behavior: 'smooth' })
  setTimeout(updateScrollState, 300)
}

function onWheel(e: WheelEvent) {
  const el = scrollRef.value
  if (!el) return
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault()
    el.scrollBy({ left: e.deltaY * 1.5 })
  }
}

// 切换标签时自动滚动到可见位置
watch(activeTabId, () => {
  nextTick(() => {
    const el = scrollRef.value
    if (!el) return
    const activeEl = el.querySelector('.tab.active') as HTMLElement
    if (!activeEl) return
    const elRect = el.getBoundingClientRect()
    const tabRect = activeEl.getBoundingClientRect()
    if (tabRect.left < elRect.left) {
      el.scrollTo({ left: el.scrollLeft - (elRect.left - tabRect.left) - 8, behavior: 'smooth' })
    } else if (tabRect.right > elRect.right) {
      el.scrollTo({ left: el.scrollLeft + (tabRect.right - elRect.right) + 8, behavior: 'smooth' })
    }
    updateScrollState()
  })
})

// 标签数量变化时更新滚动状态
watch(tabs, () => {
  nextTick(updateScrollState)
}, { flush: 'post' })

function newLocal(shellId: string) {
  const id = tabsStore.createLocalTab(shellId)
  if (!id) { showToast('标签页已达上限 (12)'); return }
  showNewMenu.value = false
  showToast('新建 ' + (shellId === 'pwsh7' ? 'PowerShell 7' : '命令提示符'))
}

function newSsh() {
  showNewMenu.value = false
  window.dispatchEvent(new CustomEvent('open-connect-dialog'))
}

// F2: confirmClose — 统一走 useAppShortcuts.closeTabWithConfirm (Electron dialog)
function closeTab(id: string) {
  void closeTabWithConfirm(id)
}
</script>

<style scoped>
.tabbar {
  height: var(--tabbar-height);
  flex: none;
  display: flex;
  align-items: flex-end;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  position: relative;
}

.tabs-scroll {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 0 8px;
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
}
.tabs-scroll::-webkit-scrollbar { display: none; }

.scroll-btn {
  flex: none;
  width: 24px;
  height: 33px;
  border: 0;
  background: var(--bg-1);
  color: var(--tx-2);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all 0.12s;
  border-bottom: 1px solid var(--line);
}
.scroll-btn:hover {
  background: var(--bg-3);
  color: var(--amber);
}
.scroll-btn.left { border-right: 1px solid var(--line-soft); }
.scroll-btn.right { border-left: 1px solid var(--line-soft); }

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 33px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--tx-1);
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  white-space: nowrap;
  position: relative;
  transition: all 0.15s;
  flex: none;
}
.tab:hover {
  color: var(--tx-0);
  background: rgba(255, 255, 255, 0.03);
}
.tab.active {
  background: var(--bg-0);
  color: var(--tx-0);
  border-color: var(--line);
}
.tab.active::before {
  content: "";
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  height: 2px;
  background: var(--amber);
  border-radius: 0 0 3px 3px;
  box-shadow: 0 0 10px rgba(255, 176, 0, 0.55);
}

.t-ic {
  font-size: 11px;
  color: var(--tx-2);
}
.tab.active .t-ic { color: var(--amber); }

/* 连接状态点: 借鉴 shell-rs 的状态图标 */
.t-status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--tx-2);
}
.t-status.connected { background: var(--green); box-shadow: 0 0 5px rgba(74, 222, 128, 0.6); }
.t-status.connecting {
  background: var(--amber);
  animation: tab-pulse 1.1s ease-in-out infinite;
}
.t-status.disconnected { background: var(--red); }

@keyframes tab-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

/* 远端系统徽标: 借鉴 shell-rs 的 HostMark */
.t-os {
  flex: none;
  font-size: 9px;
  font-family: var(--disp);
  font-weight: 700;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 3px;
  background: var(--bg-3);
  color: var(--tx-1);
}
.tab.active .t-os { background: var(--amber-dim); color: var(--amber); }

/* SSH 延迟: 三色阈值 (借鉴 shell-rs 的 LatencyLabel) */
.t-latency {
  flex: none;
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 700;
  /* 固定最小宽度, 数字变化时右侧按钮不跳动 */
  min-width: 38px;
  text-align: right;
}
.t-latency.good { color: var(--green); }
.t-latency.fair { color: var(--amber); }
.t-latency.poor { color: var(--red); }

.t-title {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.t-close {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 0;
  background: transparent;
  color: var(--tx-2);
  font-size: 11px;
  cursor: pointer;
  display: grid;
  place-items: center;
  opacity: 0;
  transition: all 0.15s;
}
.tab:hover .t-close { opacity: 1; }
.t-close:hover {
  background: rgba(248, 113, 113, 0.15);
  color: var(--red);
}

.tab-new {
  width: 28px;
  height: 28px;
  flex: none;
  margin-bottom: 3px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: var(--tx-2);
  cursor: pointer;
  font-size: 15px;
  display: grid;
  place-items: center;
  transition: all 0.15s;
}
.tab-new:hover {
  background: var(--amber-dim);
  color: var(--amber);
}

.new-menu {
  position: absolute;
  top: var(--tabbar-height);
  left: 8px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 4px 0;
  min-width: 160px;
  z-index: 100;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}

.menu-group-label {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--tx-2);
  padding: 4px 12px 2px;
  letter-spacing: 0.1em;
  font-family: var(--disp);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--tx-0);
  transition: all 0.12s;
}
.menu-item:hover { background: var(--bg-3); }
/* 无关闭对象时置灰 (借鉴 shell-rs 的 menu_with_disabled) */
.menu-item.disabled {
  opacity: 0.38;
  cursor: default;
}
.menu-item.disabled:hover { background: transparent; }

.menu-icon {
  font-size: 11px;
  color: var(--tx-2);
  width: 14px;
  text-align: center;
}

.menu-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 8px;
}

/* 2.2: 拖拽 */
.tab.dragging { opacity: 0.4; }

/* 2.2: 重命名输入框 */
.t-rename-input {
  font-size: 12px;
  color: var(--tx-0);
  background: var(--bg-0);
  border: 1px solid var(--amber);
  border-radius: 3px;
  padding: 0 4px;
  outline: none;
  max-width: 120px;
  font-family: var(--mono);
}

/* 2.2: 右键菜单 */
.ctx-menu {
  position: fixed;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 4px 0;
  min-width: 140px;
  z-index: 200;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}
</style>
