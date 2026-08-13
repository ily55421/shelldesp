import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface AppSettings {
  defaultShell: string
  fontSize: number
  fontFamily: string
  theme: string
  confirmClose: boolean
  autoReconnect: boolean
}

const DEFAULTS: AppSettings = {
  defaultShell: 'pwsh.exe',
  fontSize: 13,
  fontFamily: 'IBM Plex Mono, Cascadia Code, Consolas, "Courier New", monospace',
  theme: 'amber',
  confirmClose: false,
  autoReconnect: false
}

export const THEME_PRESETS: Record<string, Record<string, string>> = {
  amber: {
    background: '#0c0d10', foreground: '#d3d7e0', cursor: '#ffb000',
    selectionBackground: 'rgba(255, 176, 0, 0.2)',
    black: '#0c0d10', red: '#f87171', green: '#4ade80', yellow: '#ffb000',
    blue: '#7dc4ff', magenta: '#c792ea', cyan: '#4fd6be', white: '#e8eaf0',
    brightBlack: '#5c6373', brightRed: '#ff7b72', brightGreen: '#7ee787',
    brightYellow: '#ffc44d', brightBlue: '#8fc8ff', brightMagenta: '#d2a8ff',
    brightCyan: '#7ff0d8', brightWhite: '#ffffff'
  },
  green: {
    background: '#0a0e0a', foreground: '#c8d8c8', cursor: '#4ade80',
    selectionBackground: 'rgba(74, 222, 128, 0.2)',
    black: '#0a0e0a', red: '#f87171', green: '#4ade80', yellow: '#a3e635',
    blue: '#7dc4ff', magenta: '#c792ea', cyan: '#4fd6be', white: '#d8e8d8',
    brightBlack: '#4a534a', brightRed: '#ff7b72', brightGreen: '#7ee787',
    brightYellow: '#bef264', brightBlue: '#8fc8ff', brightMagenta: '#d2a8ff',
    brightCyan: '#7ff0d8', brightWhite: '#ffffff'
  },
  blue: {
    background: '#0d1018', foreground: '#c8d0e0', cursor: '#7dc4ff',
    selectionBackground: 'rgba(125, 196, 255, 0.2)',
    black: '#0d1018', red: '#f87171', green: '#4ade80', yellow: '#ffb000',
    blue: '#7dc4ff', magenta: '#c792ea', cyan: '#4fd6be', white: '#d8e0f0',
    brightBlack: '#4a5060', brightRed: '#ff7b72', brightGreen: '#7ee787',
    brightYellow: '#ffc44d', brightBlue: '#8fc8ff', brightMagenta: '#d2a8ff',
    brightCyan: '#7ff0d8', brightWhite: '#ffffff'
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULTS })
  const loaded = ref(false)

  async function load() {
    if (loaded.value) return
    try {
      const s = await window.api.store.settings.get()
      if (s) {
        settings.value = { ...DEFAULTS, ...s }
      }
    } catch {}
    loaded.value = true
  }

  async function save() {
    try {
      await window.api.store.settings.set(JSON.parse(JSON.stringify(settings.value)))
    } catch {}
  }

  function update(patch: Partial<AppSettings>) {
    settings.value = { ...settings.value, ...patch }
    save()
  }

  return { settings, loaded, load, save, update }
})
