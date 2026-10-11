<template>
  <header class="titlebar">
    <div class="logo">
      <img :src="logoUrl" alt="ShellDesk" class="logo-img" />
      <span class="logo-text">ShellDesk</span>
      <span v-if="version" class="ver">v{{ version }}</span>
    </div>
    <div class="drag"></div>
    <div class="win-controls">
      <button class="win-btn" title="最小化" @click="minimize">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
      </button>
      <button class="win-btn" :title="maxBtnTitle" @click="onMaxClick">
        <svg v-if="!maximized && !fullscreen" width="12" height="12" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12"><rect x="2.5" y="4" width="5" height="5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.5 4V2.5h5V7.5H8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
      </button>
      <button class="win-btn close" title="关闭" @click="close">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

import logoUrl from '../assets/shelldesk-logo.svg'
const maximized = ref(false)
const fullscreen = ref(false)
const version = ref('')

const maxBtnTitle = computed(() =>
  fullscreen.value ? '退出全屏 (F11)' : maximized.value ? '还原' : '最大化'
)

function minimize() { window.api.win.minimize() }
function close() { window.api.win.close() }
function toggleMaximize() { window.api.win.toggleMaximize() }
function onMaxClick() {
  if (fullscreen.value) window.api.win.toggleFullscreen()
  else toggleMaximize()
}

onMounted(() => {
  window.api.app.getVersion().then(v => { version.value = v }).catch(() => {})
  window.api.win.onMaximized((v: boolean) => {
    maximized.value = v
  })
  window.api.win.onFullscreen((v: boolean) => {
    fullscreen.value = v
  })
  // 双击标题栏切换最大化 (全屏时先退出全屏)
  const titlebar = document.querySelector('.titlebar')
  titlebar?.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.win-controls')) return
    onMaxClick()
  })
})
</script>

<style scoped>
.titlebar {
  height: 42px;
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 0 0 14px;
  background: linear-gradient(180deg, #14161c, #101218);
  border-bottom: 1px solid var(--line);
  user-select: none;
  -webkit-app-region: drag;
}

.logo {
  display: flex;
  align-items: center;
  gap: 9px;
  font-family: var(--disp);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.06em;
  color: var(--tx-0);
}

.logo-img {
  width: 20px;
  height: 20px;
  pointer-events: none;
}

.ver {
  font-family: var(--mono);
  font-weight: 400;
  font-size: 10px;
  color: var(--tx-2);
  margin-left: 2px;
}

.drag {
  flex: 1;
  height: 100%;
}

.win-controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.win-btn {
  width: 46px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--tx-1);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.15s, color 0.15s;
}

.win-btn:hover {
  background: var(--bg-3);
  color: var(--tx-0);
}

.win-btn.close:hover {
  background: #c42b1c;
  color: #fff;
}
</style>
