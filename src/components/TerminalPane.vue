<template>
  <div ref="containerRef" class="terminal-pane">
    <div class="scanlines"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Tab } from '../types'

const props = defineProps<{
  tab: Tab
}>()

const containerRef = ref<HTMLDivElement>()
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null

function initTerminal() {
  if (!containerRef.value) return

  term = new Terminal({
    fontSize: 13,
    fontFamily: 'IBM Plex Mono, Cascadia Code, Consolas, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 2000,
    allowTransparency: false,
    theme: {
      background: '#0c0d10',
      foreground: '#d3d7e0',
      cursor: '#ffb000',
      selectionBackground: 'rgba(255, 176, 0, 0.2)',
      black: '#0c0d10',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#ffb000',
      blue: '#67e8f9',
      magenta: '#c792ea',
      cyan: '#67e8f9',
      white: '#e8eaf0',
      brightBlack: '#5c6373',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#ffb000',
      brightBlue: '#67e8f9',
      brightMagenta: '#c792ea',
      brightCyan: '#67e8f9',
      brightWhite: '#e8eaf0'
    }
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(containerRef.value)
  fitAddon.fit()

  // 输入 → 写入
  term.onData(data => {
    if (props.tab.type === 'local') {
      window.api.pty.write(props.tab.id, data)
    } else if (props.tab.type === 'ssh') {
      window.api.ssh.write(props.tab.id, data)
    }
  })

  // 监听实时输出 (必须在 create/resume 之前注册)
  if (props.tab.type === 'local') {
    window.api.pty.onData(props.tab.id, (data: string) => {
      term?.write(data)
    })
    window.api.pty.onExit(props.tab.id, () => {
      term?.write('\r\n\x1b[33m[进程已退出]\x1b[0m\r\n')
    })
  } else if (props.tab.type === 'ssh') {
    window.api.ssh.onData(props.tab.id, (data: string) => {
      term?.write(data)
    })
    window.api.ssh.onExit(props.tab.id, () => {
      term?.write('\r\n\x1b[33m[SSH 连接已断开]\x1b[0m\r\n')
    })
  }

  const { cols, rows } = getDims()

  if (props.tab.type === 'local') {
    // 先 create (幂等: 已存在则跳过), 再 resume (获取缓冲数据)
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
      }
    })
  } else if (props.tab.type === 'ssh' && props.tab.ssh) {
    // SSH: 先 resume 检查是否已有连接
    window.api.ssh.resume(props.tab.id, cols, rows).then(result => {
      if (result?.buffered) {
        term?.write(result.buffered)
      }
      if (result?.exited) {
        term?.write('\r\n\x1b[33m[SSH 连接已断开]\x1b[0m\r\n')
      }
      // resume 返回 null = 首次连接
      if (!result) {
        window.api.ssh.connect(props.tab.id, props.tab.ssh!).then(() => {
          return window.api.ssh.shell(props.tab.id, { cols, rows })
        }).catch(err => {
          term?.write(`\x1b[31m[连接失败: ${err.message}]\x1b[0m\r\n`)
        })
      }
    })
  }

  // 监听容器大小变化 (防抖)
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
  if (props.tab.type === 'local') {
    window.api.pty.pause(props.tab.id)
    window.api.pty.removeListeners(props.tab.id)
  } else if (props.tab.type === 'ssh') {
    window.api.ssh.pause(props.tab.id)
    window.api.ssh.removeListeners(props.tab.id)
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
</style>
