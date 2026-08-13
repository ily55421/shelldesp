<template>
  <div ref="containerRef" class="terminal-pane">
    <div class="scanlines"></div>
    <!-- 2.3: 断线重连 overlay -->
    <div v-if="showReconnect" class="reconnect-overlay">
      <div class="reconnect-card">
        <span class="rc-icon">{{ tab.type === 'ssh' ? '⛓' : '▸' }}</span>
        <p class="rc-msg">{{ tab.type === 'ssh' ? 'SSH 连接已断开' : '终端已退出' }}</p>
        <button class="btn btn-primary" @click="reconnect">{{ tab.type === 'ssh' ? '重新连接' : '重启终端' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Tab } from '../types'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore, THEME_PRESETS } from '../stores/settings'

const props = defineProps<{
  tab: Tab
}>()

const tabsStore = useTabsStore()
const settingsStore = useSettingsStore()

const containerRef = ref<HTMLDivElement>()
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let contextHandler: ((e: MouseEvent) => void) | null = null

// M2: SSH 连接期间缓冲用户输入, stream 就绪后回放
let sshReady = false
let inputBuffer: string[] = []
// A1/A2: 防止 ssh:exit + ssh:closed / onError + .catch 双写
let disconnected = false
// 2.3: 断线重连
const showReconnect = ref(false)
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// 2.3: 断开后触发
function onDisconnected() {
  showReconnect.value = true
  if (settingsStore.settings.autoReconnect && props.tab.type === 'ssh') {
    scheduleAutoReconnect()
  }
}

function scheduleAutoReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
  reconnectAttempts++
  reconnectTimer = setTimeout(() => doReconnect(), delay)
}

function reconnect() {
  reconnectAttempts = 0
  doReconnect()
}

function doReconnect() {
  showReconnect.value = false
  disconnected = false
  sshReady = false
  inputBuffer = []
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  // 清理旧 session 的 IPC 监听
  if (props.tab.type === 'local') {
    window.api.pty.removeListeners(props.tab.id)
  } else if (props.tab.type === 'ssh') {
    window.api.ssh.removeListeners(props.tab.id)
  }

  // 重新初始化终端 (重新注册事件 + 重新 create/connect)
  if (term) { term.dispose(); term = null; fitAddon = null }
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
  if (contextHandler && containerRef.value) {
    containerRef.value.removeEventListener('contextmenu', contextHandler)
    contextHandler = null
  }

  tabsStore.updateStatus(props.tab.id, props.tab.type === 'ssh' ? 'connecting' : 'connected')
  // F5: 延迟 150ms 再 init, 避免旧 session 退出事件与新 init 竞争
  setTimeout(() => initTerminal(), 150)
}

// 2.1: 响应设置变更
watch(() => settingsStore.settings.fontSize, (v) => {
  if (term) { term.options.fontSize = v; fitAddon?.fit() }
})
watch(() => settingsStore.settings.fontFamily, (v) => {
  if (term) { term.options.fontFamily = v; fitAddon?.fit() }
})
watch(() => settingsStore.settings.theme, (v) => {
  if (term) { term.options.theme = THEME_PRESETS[v] || THEME_PRESETS.amber }
})

function initTerminal() {
  if (!containerRef.value) return

  const s = settingsStore.settings
  term = new Terminal({
    fontSize: s.fontSize,
    fontFamily: s.fontFamily,
    cursorBlink: true,
    scrollback: 2000,
    allowTransparency: false,
    theme: THEME_PRESETS[s.theme] || THEME_PRESETS.amber
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(containerRef.value)
  fitAddon.fit()

  // === 剪贴板: 复制 / 粘贴 ===
  term.attachCustomKeyEventHandler((e) => {
    if (!term) return true
    if (e.type !== 'keydown') return true

    // Ctrl+C: 有选中则复制到剪贴板, 否则作为 SIGINT 发送给 shell
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
      if (term.hasSelection()) {
        const sel = term.getSelection()
        e.preventDefault() // 阻止原生复制到 textarea 造成重复
        if (sel) navigator.clipboard.writeText(sel).catch(() => {})
        term.clearSelection()
        return false // 拦截, 不发送到终端
      }
      return true // 无选中, 交给 shell (中断)
    }

    // Ctrl+V 或 Ctrl+Shift+V: 粘贴剪贴板内容
    // e.key 在按住 Shift 时为 'V' (大写), toLowerCase 已覆盖两种情况
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
      e.preventDefault() // 关键: 阻止 xterm 隐藏 textarea 收到原生粘贴导致双次
      navigator.clipboard.readText().then(text => {
        if (term && text) term.paste(text)
      }).catch(() => {})
      return false // 拦截, 不发送到终端
    }

    return true
  })

  // 右键粘贴
  contextHandler = (e: MouseEvent) => {
    e.preventDefault()
    if (term && !term.hasSelection()) {
      navigator.clipboard.readText().then(text => {
        if (term && text) term.paste(text)
      }).catch(() => {})
    }
  }
  containerRef.value.addEventListener('contextmenu', contextHandler)

  // 输入 → 写入 (M2: SSH 连接期间缓冲输入; F8: overlay 期间屏蔽)
  term.onData(data => {
    if (showReconnect.value) return
    if (props.tab.type === 'local') {
      window.api.pty.write(props.tab.id, data)
    } else if (props.tab.type === 'ssh') {
      if (sshReady) {
        window.api.ssh.write(props.tab.id, data)
      } else {
        inputBuffer.push(data)
      }
    }
  })

  // 监听实时输出 (必须在 create/resume 之前注册)
  if (props.tab.type === 'local') {
    window.api.pty.onData(props.tab.id, (data: string) => {
      term?.write(data)
    })
    window.api.pty.onExit(props.tab.id, () => {
      term?.write('\r\n\x1b[33m[进程已退出]\x1b[0m\r\n')
      tabsStore.updateStatus(props.tab.id, 'disconnected')
      onDisconnected()
    })
  } else if (props.tab.type === 'ssh') {
    // M3: 注册 error/closed 监听, 展示断连详情
    window.api.ssh.onConnected(props.tab.id, () => {
      // 连接已建立, shell 就绪在 connect+shell 完成后
    })
    window.api.ssh.onError(props.tab.id, (msg: string) => {
      if (disconnected) return
      disconnected = true
      sshReady = false
      tabsStore.updateStatus(props.tab.id, 'disconnected')
      term?.write(`\x1b[31m[SSH 错误: ${msg}]\x1b[0m\r\n`)
      onDisconnected()
    })
    window.api.ssh.onClosed(props.tab.id, () => {
      if (disconnected) return
      disconnected = true
      sshReady = false
      tabsStore.updateStatus(props.tab.id, 'disconnected')
      term?.write('\r\n\x1b[33m[SSH 连接已断开]\x1b[0m\r\n')
      onDisconnected()
    })
    window.api.ssh.onData(props.tab.id, (data: string) => {
      term?.write(data)
    })
    window.api.ssh.onExit(props.tab.id, () => {
      if (disconnected) return
      disconnected = true
      sshReady = false
      tabsStore.updateStatus(props.tab.id, 'disconnected')
      term?.write('\r\n\x1b[33m[SSH 连接已断开]\x1b[0m\r\n')
      onDisconnected()
    })
  }

  const { cols, rows } = getDims()

  if (props.tab.type === 'local') {
    // M1: 补 .catch, pwsh 缺失或白名单拒绝时给用户反馈
    window.api.pty.create(props.tab.id, {
      shell: props.tab.shell,
      cwd: props.tab.cwd,
      cols,
      rows
    }).then(() => {
      return window.api.pty.resume(props.tab.id, cols, rows)
    }).then(result => {
      if (result?.buffered) {
        term?.write(result.buffered)
      }
      if (result?.exited) {
        term?.write('\r\n\x1b[33m[进程在后台已退出, 退出码: ' + (result.exitCode ?? 0) + ']\x1b[0m\r\n')
        tabsStore.updateStatus(props.tab.id, 'disconnected')
        onDisconnected()
      } else {
        // A3: resume 成功, 标记为已连接
        tabsStore.updateStatus(props.tab.id, 'connected')
      }
    }).catch(err => {
      term?.write(`\x1b[31m[终端启动失败: ${err.message}]\x1b[0m\r\n`)
      tabsStore.updateStatus(props.tab.id, 'disconnected')
    })
  } else if (props.tab.type === 'ssh' && props.tab.ssh) {
    window.api.ssh.resume(props.tab.id, cols, rows).then(result => {
      if (result?.buffered) {
        term?.write(result.buffered)
      }
      if (result?.exited) {
        // O1: 置位 disconnected, 防止后续 ssh:closed/ssh:exit 双写
        disconnected = true
        sshReady = false
        term?.write('\r\n\x1b[33m[SSH 连接已断开]\x1b[0m\r\n')
        tabsStore.updateStatus(props.tab.id, 'disconnected')
        onDisconnected()
        return null
      }
      if (!result) {
        // 新连接: connect → shell → 就绪
        return window.api.ssh.connect(props.tab.id, props.tab.ssh!).then(() => {
          return window.api.ssh.shell(props.tab.id, { cols, rows })
        }).then(() => {
          sshReady = true
          tabsStore.updateStatus(props.tab.id, 'connected')
          // M2: 回放连接期间缓冲的输入
          for (const d of inputBuffer) {
            window.api.ssh.write(props.tab.id, d)
          }
          inputBuffer = []
        })
      } else {
        // 恢复已有会话
        sshReady = true
        tabsStore.updateStatus(props.tab.id, 'connected')
      }
      return null
    }).catch(err => {
      if (disconnected) return
      disconnected = true
      sshReady = false
      // O2: 连接失败时清空缓冲的输入
      inputBuffer = []
      tabsStore.updateStatus(props.tab.id, 'disconnected')
      term?.write(`\x1b[31m[连接失败: ${err.message}]\x1b[0m\r\n`)
    })
  }

  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      fitAddon?.fit()
      const { cols, rows } = getDims()
      if (props.tab.type === 'local') {
        window.api.pty.resize(props.tab.id, cols, rows)
      } else if (props.tab.type === 'ssh') {
        window.api.ssh.resize(props.tab.id, cols, rows)
      }
    }, 80)
  })
  resizeObserver.observe(containerRef.value)
}

function getDims() {
  if (!fitAddon || !term) return { cols: 80, rows: 24 }
  return { cols: term.cols, rows: term.rows }
}

onMounted(() => {
  initTerminal()
})

onUnmounted(() => {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (props.tab.type === 'local') {
    window.api.pty.removeListeners(props.tab.id)
    window.api.pty.pause(props.tab.id)
  } else if (props.tab.type === 'ssh') {
    window.api.ssh.removeListeners(props.tab.id)
    window.api.ssh.pause(props.tab.id)
  }
  if (contextHandler && containerRef.value) {
    containerRef.value.removeEventListener('contextmenu', contextHandler)
  }
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  term?.dispose()
  term = null
  fitAddon = null
})
</script>

<style scoped>
.terminal-pane {
  width: 100%;
  height: 100%;
  padding: 4px;
  background: #0c0d10;
  position: relative;
}

/* 扫描线纹理 — 用独立 div, z-index 置于 xterm 之下, 避免干扰 canvas */
.scanlines {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: repeating-linear-gradient(
    0deg,
    rgba(255, 255, 255, 0.015) 0 1px,
    transparent 1px 3px
  );
}

.terminal-pane :deep(.xterm) {
  height: 100%;
  position: relative;
  z-index: 1;
}

.terminal-pane :deep(.xterm-viewport) {
  overflow-y: auto;
}

/* 终端文字/选区可复制 */
.terminal-pane :deep(.xterm-screen) {
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

/* 2.3: 断线重连 overlay */
.reconnect-overlay {
  position: absolute;
  inset: 0;
  background: rgba(12, 13, 16, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.reconnect-card {
  text-align: center;
  padding: 28px 36px;
}
.rc-icon {
  font-size: 32px;
  color: var(--amber);
  display: block;
  margin-bottom: 10px;
}
.rc-msg {
  font-size: 13px;
  color: var(--tx-1);
  margin-bottom: 16px;
}
</style>