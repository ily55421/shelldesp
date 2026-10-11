import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import { useToast } from './useToast'

/**
 * 应用级快捷键 (窗口 / 标签 / 布局 / 缩放)
 * - 终端聚焦时也生效: TerminalPane 的 attachCustomKeyEventHandler 会先问这里
 * - 返回 true 表示已消费, 终端不应再把该按键发送给 shell
 */

const FONT_MIN = 8
const FONT_MAX = 32
const FONT_DEFAULT = 13
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 264

/** 焦点是否在表单控件内 — xterm 的隐藏输入框除外, 它必须让应用快捷键生效 */
export function isFormField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (isFromTerminal(el)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true
}

/** 事件是否来自终端 (xterm 隐藏输入框) */
function isFromTerminal(el: HTMLElement | null): boolean {
  return !!el?.classList?.contains('xterm-helper-textarea')
}

/** 设置里的默认终端 → shellId */
export function defaultShellId(): string {
  const settingsStore = useSettingsStore()
  const shell = settingsStore.settings.defaultShell
  return shell === 'cmd.exe' ? 'cmd' : shell === 'powershell.exe' ? 'powershell5' : 'pwsh7'
}

/** 默认终端 shellId → 新建本地标签 (各处共用, 含上限提示) */
export function createDefaultLocalTab(cwd?: string): string | null {
  const tabsStore = useTabsStore()
  const { show } = useToast()
  const id = tabsStore.createLocalTab(defaultShellId(), cwd)
  if (!id) {
    show('标签页已达上限 (12)')
    return null
  }
  show('新建终端')
  return id
}

/** 关闭标签 (统一走 confirmClose 确认) */
export async function closeTabWithConfirm(id: string): Promise<void> {
  const tabsStore = useTabsStore()
  const settingsStore = useSettingsStore()
  if (settingsStore.settings.confirmClose) {
    const ok = await window.api.store.confirm('确认关闭此标签页?')
    if (!ok) return
  }
  tabsStore.closeTab(id)
}

/** 字号缩放; delta=0 复位到默认 */
export function zoomFont(delta: number): void {
  const settingsStore = useSettingsStore()
  const { show } = useToast()
  const cur = settingsStore.settings.fontSize
  const next = delta === 0
    ? FONT_DEFAULT
    : Math.max(FONT_MIN, Math.min(FONT_MAX, cur + delta))
  if (next === cur) {
    show(`字号 ${cur}px 已达${delta > 0 ? '上限' : '下限'}`)
    return
  }
  settingsStore.update({ fontSize: next })
  show(`字号 ${next}px`)
}

/** Ctrl+Tab 循环切换标签 */
function cycleTab(dir: 1 | -1): void {
  const tabsStore = useTabsStore()
  const list = tabsStore.tabs
  if (list.length < 2) return
  const idx = list.findIndex(t => t.id === tabsStore.activeTabId)
  const next = (idx + dir + list.length) % list.length
  tabsStore.setActive(list[next].id)
}

export function handleAppShortcut(e: KeyboardEvent): boolean {
  const tabsStore = useTabsStore()
  const settingsStore = useSettingsStore()
  const { show } = useToast()
  const key = e.key.toLowerCase()
  const fromTerminal = isFromTerminal(e.target as HTMLElement | null)
  let handled = true

  if (e.key === 'F11') {
    // 全屏切换
    window.api.win.toggleFullscreen()
  } else if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
    // Ctrl+Tab / Ctrl+Shift+Tab 环绕切换
    cycleTab(e.shiftKey ? -1 : 1)
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
    // Ctrl+1~8 跳转标签, Ctrl+9 末个标签
    const list = tabsStore.tabs
    const idx = e.key === '9' ? list.length - 1 : Number(e.key) - 1
    if (list[idx]) tabsStore.setActive(list[idx].id)
  } else if (e.ctrlKey && !e.altKey && (key === '=' || key === '+' || key === '-')) {
    zoomFont(key === '-' ? -1 : 1)
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && key === '0') {
    zoomFont(0)
  } else if (e.ctrlKey && e.altKey && key === 'b') {
    // Ctrl+Alt+B: 避免与 PSReadLine 的 Ctrl+B (后移光标) / Ctrl+W 冲突
    const next = !settingsStore.settings.sidebarVisible
    settingsStore.update({ sidebarVisible: next })
    show(next ? '侧栏已显示 (Ctrl+Alt+B)' : '侧栏已隐藏 (Ctrl+Alt+B)')
  } else if (e.ctrlKey && e.shiftKey && key === 'w') {
    // 全局关闭标签 (终端内也可用)
    if (tabsStore.activeTabId) void closeTabWithConfirm(tabsStore.activeTabId)
  } else if (e.ctrlKey && !e.shiftKey && key === 'w') {
    // 终端内保留 shell 的 Ctrl+W (删词), 仅非终端焦点时关闭标签
    if (fromTerminal) handled = false
    else if (tabsStore.activeTabId) void closeTabWithConfirm(tabsStore.activeTabId)
  } else if (e.ctrlKey && !e.shiftKey && key === 't') {
    createDefaultLocalTab()
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'd') {
    window.dispatchEvent(new CustomEvent('open-path-dialog'))
  } else {
    handled = false
  }

  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
  return handled
}