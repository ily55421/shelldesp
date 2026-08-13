<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-title">SSH 连接</div>

      <div class="form-group">
        <label class="form-label">名称 (可选)</label>
        <input class="input" v-model="form.name" placeholder="我的服务器" />
      </div>

      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">主机</label>
          <input class="input" v-model="form.host" placeholder="192.168.1.100" />
        </div>
        <div class="form-group" style="width: 80px;">
          <label class="form-label">端口</label>
          <input class="input" v-model.number="form.port" type="number" />
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">用户名</label>
        <input class="input" v-model="form.username" placeholder="root" />
      </div>

      <div class="form-group">
        <label class="form-label">密码</label>
        <input class="input" v-model="form.password" type="password" placeholder="留空则使用密钥" />
      </div>

      <div class="form-group">
        <label class="form-label">私钥路径 (可选, 仅限 ~/.ssh 目录)</label>
        <div style="display: flex; gap: 4px;">
          <input class="input" v-model="form.privateKey" placeholder="C:\Users\xxx\.ssh\id_rsa" />
          <button class="btn" @click="pickKeyFile">浏览</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" v-model="saveHost" />
          保存此连接到列表 (密码将加密存储)
        </label>
      </div>

      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>

      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" @click="connect" :disabled="connecting">
          {{ connecting ? '连接中...' : '连接' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import type { SshConfig } from '../types'

const emit = defineEmits<{ close: [] }>()
const tabsStore = useTabsStore()

const form = ref({
  name: '',
  host: '',
  port: 22,
  username: 'root',
  password: '',
  privateKey: ''
})
const saveHost = ref(true)
const connecting = ref(false)
const errorMsg = ref('')

// L3: 用 pickFile 选择私钥文件
async function pickKeyFile() {
  const file = await window.api.store.pickFile()
  if (file) form.value.privateKey = file
}

async function connect() {
  if (!form.value.host || !form.value.username) {
    errorMsg.value = '请填写主机和用户名'
    return
  }
  // L7: 端口范围校验
  const port = Number(form.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errorMsg.value = '端口范围 1-65535'
    return
  }

  connecting.value = true
  errorMsg.value = ''

  const config: SshConfig = {
    host: form.value.host,
    port: form.value.port,
    username: form.value.username,
    password: form.value.password || undefined,
    privateKey: form.value.privateKey || undefined
  }

  const name = form.value.name || `${form.value.username}@${form.value.host}`

  tabsStore.createSshTab(name, config)

  // M5: 保存时去重 + 更新已存在主机的配置
  if (saveHost.value) {
    const hosts = await window.api.store.sshHosts.get()
    const existingIdx = hosts.findIndex(h =>
      h.config.host === config.host &&
      h.config.port === config.port &&
      h.config.username === config.username
    )
    if (existingIdx >= 0) {
      // 更新已有条目的配置 (密码/密钥可能已变更)
      hosts[existingIdx].config = config
      hosts[existingIdx].name = name
    } else {
      hosts.push({ id: `ssh-${Date.now()}`, name, config })
    }
    await window.api.store.sshHosts.set(JSON.parse(JSON.stringify(hosts)))
    window.dispatchEvent(new CustomEvent('ssh-hosts-updated'))
  }

  connecting.value = false
  emit('close')
}
</script>

<style scoped>
.form-row { display: flex; gap: 8px; }
.flex-1 { flex: 1; }
.form-check {
  display: flex; align-items: center; gap: 6px;
  cursor: pointer; font-size: 12px; color: var(--tx-1);
}
.error-msg {
  color: var(--red); font-size: 12px; margin-top: 8px;
  padding: 8px; background: rgba(248, 113, 113, 0.1); border-radius: 4px;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
