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
        :class="{ active: tab.id === activeTabId }"
        @click="tabsStore.setActive(tab.id)"
        @contextmenu.prevent="closeTab(tab.id)"
      >
        <span class="t-ic">{{ tab.type === 'ssh' ? '⛓' : (tab.shell?.includes('pwsh') ? '▸' : '▮') }}</span>
        <span class="t-title">{{ tab.title }}</span>
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
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useTabsStore } from '../stores/tabs'
import { useToast } from '../composables/useToast'

const tabsStore = useTabsStore()
const { tabs, activeTabId } = storeToRefs(tabsStore)
const showNewMenu = ref(false)
const { show: showToast } = useToast()

const scrollRef = ref<HTMLDivElement>()
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

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

function closeTab(id: string) {
  tabsStore.closeTab(id)
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
</style>
