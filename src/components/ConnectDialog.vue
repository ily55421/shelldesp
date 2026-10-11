<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-title">{{ editing ? '编辑 SSH 连接' : 'SSH 连接' }}</div>

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

      <!-- 认证方式 (借鉴 shell-rs 的 LoginMethod) -->
      <div class="form-group">
        <label class="form-label">认证方式</label>
        <div class="auth-tabs">
          <button
            v-for="opt in AUTH_OPTIONS"
            :key="opt.id"
            class="auth-tab"
            :class="{ active: form.authKind === opt.id }"
            :title="opt.hint"
            @click="form.authKind = opt.id"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="auth-hint">{{ authHint }}</div>
      </div>

      <!-- 密码 -->
      <div v-if="form.authKind === 'password'" class="form-group">
        <label class="form-label">密码</label>
        <input class="input" v-model="form.password" type="password" placeholder="留空则连接时询问" />
      </div>

      <!-- 私钥 -->
      <template v-if="form.authKind === 'key'">
        <div class="form-group">
          <label class="form-label">私钥路径 (仅限 ~/.ssh 目录)</label>
          <div style="display: flex; gap: 4px;">
            <input class="input" v-model="form.privateKey" placeholder="C:\Users\xxx\.ssh\id_rsa" />
            <button class="btn" @click="pickKeyFile">浏览</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">私钥口令 (私钥加密时填写)</label>
          <input class="input" v-model="form.passphrase" type="password" placeholder="留空表示私钥未加密" />
        </div>
      </template>

      <!-- SSH Agent -->
      <div v-if="form.authKind === 'agent' || form.authKind === 'nopassword'" class="form-group">
        <label class="form-label">SSH Agent 套接字 (可选)</label>
        <input class="input" v-model="form.agentSocket" :placeholder="agentPlaceholder" />
      </div>

      <!-- 键盘交互 (密码方式下的二次验证) -->
      <div v-if="form.authKind === 'password'" class="form-group">
        <label class="form-check">
          <input type="checkbox" v-model="form.tryKeyboard" />
          启用键盘交互认证 (服务器要求二次验证 / 一次性口令时)
        </label>
      </div>

      <div class="form-group">
        <label class="form-check">
          <input type="checkbox" v-model="saveHost" />
          保存此连接到列表 (密码将加密存储)
        </label>
      </div>

      <!-- 连接测试结果 (借鉴 shell-rs 的「测试连接」) -->
      <div v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
        <div class="tr-line">
          <strong>{{ testResult.ok ? '连接成功' : '连接失败' }}</strong>
          <span v-if="testResult.ok && testResult.remoteOs" class="tr-os">远端系统: {{ testResult.remoteOs }}</span>
        </div>
        <div v-if="!testResult.ok" class="tr-reason">{{ testResult.reason }}</div>
        <div v-if="testResult.hostKeyFingerprint" class="tr-finger">
          主机密钥 ({{ testResult.hostKeyType }}): {{ testResult.hostKeyFingerprint }}
        </div>
      </div>

      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>

      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn" @click="testConnection" :disabled="connecting || testing">
          {{ testing ? '测试中...' : '测试连接' }}
        </button>
        <button class="btn btn-primary" @click="connect" :disabled="connecting || testing">
          {{ connecting ? '连接中...' : '连接' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTabsStore } from '../stores/tabs'
import type { SshConfig, SshAuthKind, SshTestResult, SshHostEntry } from '../types'

const props = defineProps<{
  /** 传入已有主机则为编辑模式 (预填配置, 保存时覆盖该条目) */
  editing?: SshHostEntry | null
}>()

const emit = defineEmits<{ close: [] }>()
const tabsStore = useTabsStore()

/** 四种认证方式 (与 shell-rs 的 LoginMethod 对应) */
const AUTH_OPTIONS: Array<{ id: SshAuthKind; label: string; hint: string }> = [
  { id: 'password', label: '密码', hint: '用账号密码登录, 可另开键盘交互应对二次验证' },
  { id: 'key', label: '密钥', hint: '用私钥文件登录, 私钥有口令时一并填写' },
  { id: 'agent', label: 'SSH Agent', hint: '由本机 SSH Agent 提供密钥, 不在应用里保存任何凭据' },
  { id: 'nopassword', label: '无密码', hint: '不输入任何凭据: 先试服务器的免认证, 再试 SSH Agent' }
]

const form = ref({
  name: props.editing?.name || '',
  host: props.editing?.config.host || '',
  port: props.editing?.config.port || 22,
  username: props.editing?.config.username || 'root',
  password: props.editing?.config.password || '',
  privateKey: props.editing?.config.privateKey || '',
  passphrase: props.editing?.config.passphrase || '',
  authKind: (props.editing?.config.authKind
    || (props.editing?.config.privateKey ? 'key' : props.editing?.config.password ? 'password' : 'password')) as SshAuthKind,
  tryKeyboard: props.editing?.config.tryKeyboard === true,
  agentSocket: props.editing?.config.agentSocket || ''
})
const saveHost = ref(true)
const connecting = ref(false)
const testing = ref(false)
const errorMsg = ref('')
const testResult = ref<SshTestResult | null>(null)

const authHint = computed(() =>
  AUTH_OPTIONS.find(o => o.id === form.value.authKind)?.hint || ''
)

const agentPlaceholder = computed(() =>
  window.navigator.platform.startsWith('Win')
    ? '留空使用 Pageant (pageant)'
    : '留空使用 $SSH_AUTH_SOCK'
)

/** 表单 → 连接配置 (测试与连接共用, 保证测的就是连的) */
function buildConfig(): SshConfig {
  return {
    host: form.value.host,
    port: form.value.port,
    username: form.value.username,
    authKind: form.value.authKind,
    password: form.value.authKind === 'password' ? (form.value.password || undefined) : undefined,
    privateKey: form.value.authKind === 'key' ? (form.value.privateKey || undefined) : undefined,
    passphrase: form.value.authKind === 'key' ? (form.value.passphrase || undefined) : undefined,
    tryKeyboard: form.value.tryKeyboard || undefined,
    agentSocket: form.value.agentSocket || undefined
  }
}

/** 端口与必填项校验; 通过返回 null, 否则返回错误文案 */
function validate(): string | null {
  if (!form.value.host || !form.value.username) return '请填写主机和用户名'
  const port = Number(form.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口范围 1-65535'
  if (form.value.authKind === 'key' && !form.value.privateKey) return '密钥方式需要选择私钥文件'
  return null
}

// L3: 用 pickFile 选择私钥文件
async function pickKeyFile() {
  const file = await window.api.store.pickFile()
  if (file) form.value.privateKey = file
}

/** 连接测试: 真登录一次并报告原因与主机密钥指纹 */
async function testConnection() {
  const problem = validate()
  if (problem) { errorMsg.value = problem; return }
  testing.value = true
  errorMsg.value = ''
  testResult.value = null
  try {
    testResult.value = await window.api.ssh.test(buildConfig())
  } catch (err) {
    testResult.value = { ok: false, reason: (err as Error).message }
  } finally {
    testing.value = false
  }
}

async function connect() {
  const problem = validate()
  if (problem) { errorMsg.value = problem; return }

  connecting.value = true
  errorMsg.value = ''

  const config = buildConfig()
  const name = form.value.name || `${form.value.username}@${form.value.host}`

  const tabId = tabsStore.createSshTab(name, config)
  if (!tabId) {
    errorMsg.value = '标签页已达上限 (12)'
    connecting.value = false
    return
  }

  // M5: 保存时去重 + 更新已存在主机的配置
  if (saveHost.value) {
    const hosts = await window.api.store.sshHosts.get()
    if (props.editing) {
      // 编辑模式: 按 id 就地覆盖, 保留用户改过的名字
      const idx = hosts.findIndex(h => h.id === props.editing!.id)
      const entry = { id: props.editing.id, name, config }
      if (idx >= 0) hosts[idx] = entry
      else hosts.push(entry)
    } else {
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

/* 认证方式选择 */
.auth-tabs { display: flex; gap: 4px; }
.auth-tab {
  flex: 1; padding: 6px 4px; font-size: 12px; cursor: pointer;
  background: var(--bg-0); color: var(--tx-1);
  border: 1px solid var(--line); border-radius: 4px;
  transition: all 0.12s;
}
.auth-tab:hover { color: var(--tx-0); border-color: var(--line-soft); }
.auth-tab.active {
  background: var(--amber-dim); color: var(--amber); border-color: var(--amber);
}
.auth-hint { font-size: 11px; color: var(--tx-2); margin-top: 5px; line-height: 1.5; }

/* 连接测试结果 */
.test-result {
  margin-top: 10px; padding: 8px 10px; border-radius: 4px;
  font-size: 12px; line-height: 1.6;
}
.test-result.ok { background: rgba(74, 222, 128, 0.1); color: var(--green); }
.test-result.fail { background: rgba(248, 113, 113, 0.1); color: var(--red); }
.tr-line { display: flex; justify-content: space-between; gap: 8px; }
.tr-os { color: var(--tx-1); font-size: 11px; }
.tr-reason { margin-top: 4px; color: var(--tx-0); white-space: pre-wrap; }
.tr-finger {
  margin-top: 4px; font-family: var(--mono); font-size: 10px;
  color: var(--tx-2); word-break: break-all;
}
</style>
