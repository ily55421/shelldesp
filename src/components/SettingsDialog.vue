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
            @change="update('fontSize', Number(($event.target as HTMLInputElement).value))"
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

      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '../stores/settings'

defineEmits<{ close: [] }>()

const store = useSettingsStore()
const { settings } = storeToRefs(store)

function update(key: string, value: unknown) {
  store.update({ [key]: value } as any)
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
</style>
