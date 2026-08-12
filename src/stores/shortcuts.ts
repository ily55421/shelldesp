import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ShortcutCommand, QuickPath } from '../types'

export const useShortcutsStore = defineStore('shortcuts', () => {
  const shortcuts = ref<ShortcutCommand[]>([])
  const quickPaths = ref<QuickPath[]>([])
  const loaded = ref(false)

  async function load() {
    if (loaded.value) return
    const [sc, qp] = await Promise.all([
      window.api.store.shortcuts.get(),
      window.api.store.quickPaths.get()
    ])
    shortcuts.value = sc
    quickPaths.value = qp
    loaded.value = true
  }

  // --- 快捷指令 ---
  async function saveShortcuts() {
    await window.api.store.shortcuts.set(shortcuts.value)
  }

  function add(shortcut: Omit<ShortcutCommand, 'id'>) {
    const item: ShortcutCommand = {
      ...shortcut,
      id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }
    shortcuts.value.push(item)
    saveShortcuts()
    return item.id
  }

  function update(id: string, data: Partial<ShortcutCommand>) {
    const item = shortcuts.value.find(s => s.id === id)
    if (item) {
      Object.assign(item, data)
      saveShortcuts()
    }
  }

  function remove(id: string) {
    const idx = shortcuts.value.findIndex(s => s.id === id)
    if (idx !== -1) {
      shortcuts.value.splice(idx, 1)
      saveShortcuts()
    }
  }

  function reorder(fromId: string, toId: string) {
    const fromIdx = shortcuts.value.findIndex(s => s.id === fromId)
    const toIdx = shortcuts.value.findIndex(s => s.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const [item] = shortcuts.value.splice(fromIdx, 1)
    shortcuts.value.splice(toIdx, 0, item)
    saveShortcuts()
  }

  // --- 快捷路径 ---
  async function saveQuickPaths() {
    await window.api.store.quickPaths.set(quickPaths.value)
  }

  function addPath(path: Omit<QuickPath, 'id'>) {
    const item: QuickPath = {
      ...path,
      id: `qp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    }
    quickPaths.value.push(item)
    saveQuickPaths()
    return item.id
  }

  function updatePath(id: string, data: Partial<QuickPath>) {
    const item = quickPaths.value.find(p => p.id === id)
    if (item) {
      Object.assign(item, data)
      saveQuickPaths()
    }
  }

  function removePath(id: string) {
    const idx = quickPaths.value.findIndex(p => p.id === id)
    if (idx !== -1) {
      quickPaths.value.splice(idx, 1)
      saveQuickPaths()
    }
  }

  function reorderPaths(fromId: string, toId: string) {
    const fromIdx = quickPaths.value.findIndex(p => p.id === fromId)
    const toIdx = quickPaths.value.findIndex(p => p.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const [item] = quickPaths.value.splice(fromIdx, 1)
    quickPaths.value.splice(toIdx, 0, item)
    saveQuickPaths()
  }

  return {
    shortcuts,
    quickPaths,
    loaded,
    load,
    add,
    update,
    remove,
    reorder,
    addPath,
    updatePath,
    removePath,
    reorderPaths
  }
})
