<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-title">设置</div>

      <div class="form-group">
        <label class="form-label">默认终端</label>
        <select class="input" :value="settings.defaultShell" @change="update('defaultShell', ($event.target as HTMLSelectElement).value)">
          <option value="pwsh.exe">PowerShell 7 (pwsh.exe)</option>
          <option value="powershell.exe">Windows PowerShell (powershell.exe)</option>
          <option value="cmd.exe">命令提示符 (cmd.exe)</option>
        </select>
      </div>

      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">字号</label>
          <input class="input" type="number" min="8" max="32"
            :value="settings.fontSize"
            @change="update('fontSize', Math.max(8, Math.min(32, Number(($event.target as HTMLInputElement).value) || 13)))"
          />
        </div>
        <div class="form-group flex-1">
          <label class="form-label">配色主题</label>
          <select class="input" :value="settings.theme" @change="update('theme', ($event.target as HTMLSelectElement).value)">
            <option value="amber">琥珀荧光</option>
            <option value="green">深绿终端</option>
            <option value="blue">霓虹蓝</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">字体</label>
        <select class="input" :value="settings.fontFamily" @change="update('fontFamily', ($event.target as HTMLSelectElement).value)">
          <option value='IBM Plex Mono, Cascadia Code, Consolas, "Courier New", monospace'>IBM Plex Mono</option>
          <option value='Cascadia Code, Consolas, "Courier New", monospace'>Cascadia Code</option>
          <option value='Consolas, "Courier New", monospace'>Consolas</option>
          <option value='"Courier New", monospace'>Courier New</option>
          <option value='ui-monospace, monospace'>系统默认</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" :checked="settings.autoReconnect" @change="update('autoReconnect', ($event.target as HTMLInputElement).checked)" />
          SSH 断线自动重连 (指数退避)
        </label>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" :checked="settings.confirmClose" @change="update('confirmClose', ($event.target as HTMLInputElement).checked)" />
          关闭标签页时确认
        </label>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" :checked="settings.rememberWindowSize" @change="update('rememberWindowSize', ($event.target as HTMLInputElement).checked)" />
          记住窗口大小 (含最大化状态)
        </label>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" :checked="settings.rememberWindowPosition" @change="update('rememberWindowPosition', ($event.target as HTMLInputElement).checked)" />
          记住窗口位置
        </label>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" :checked="settings.showSystemStatus" @change="update('showSystemStatus', ($event.target as HTMLInputElement).checked)" />
          显示服务器状态面板 (SSH 标签下采集远端 CPU / 内存 / 磁盘 / 网络)
        </label>
      </div>

      <div class="form-group">
        <label class="form-label">快捷键</label>
        <div class="shortcut-hint">
          <span>Ctrl+T 新建终端</span>
          <span>Ctrl+Shift+W 关闭标签</span>
          <span>Ctrl+Tab / Ctrl+Shift+Tab 切换标签</span>
          <span>Ctrl+1~9 跳转标签</span>
          <span>Ctrl+= / Ctrl+- / Ctrl+0 字号</span>
          <span>Ctrl+Alt+B 收起侧栏</span>
          <span>Ctrl+Shift+F 终端搜索</span>
          <span>F11 全屏</span>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useSettingsStore, type AppSettings } from '../stores/settings'

defineEmits<{ close: [] }>()

const store = useSettingsStore()
const { settings } = storeToRefs(store)

function update(key: keyof AppSettings, value: string | number | boolean) {
  store.update({ [key]: value } as Partial<AppSettings>)
}
</script>

<style scoped>
select.input {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239aa1b2' stroke-width='1.2' fill='none'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

.shortcut-hint {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  font-size: 11px;
  color: var(--tx-2);
}
</style>
