<template>
  <div class="sidebar">
    <div class="side-head">快捷面板</div>

    <div class="side-body">
      <!-- 快捷路径 -->
      <div class="section" :class="{ collapsed: collapsed.paths }">
        <div class="section-title" @click="toggleSection('paths')">
          <span class="label">快捷路径</span>
          <span class="chev" :class="{ open: !collapsed.paths }">▸</span>
          <button class="add-btn" @click.stop="showPathDialog = true" title="添加常用目录 (Ctrl+D)">+</button>
        </div>
        <div class="section-body">
          <div class="section-inner">
            <div class="item" v-for="qp in quickPaths" :key="qp.id"
              draggable="true"
              @dragstart="onPathDragStart($event, qp.id)"
              @dragover.prevent="onPathDragOver($event, qp.id)"
              @drop="onPathDrop($event, qp.id)"
              @click="cdToPath(qp)"
              @contextmenu.prevent="editPath(qp)"
            >
              <span class="ic">{{ qp.icon || '📁' }}</span>
              <div class="meta">
                <div class="name">{{ qp.name }}</div>
                <div class="sub">{{ qp.path }}</div>
              </div>
              <div class="acts">
                <span title="在终端打开">▸</span>
                <span title="移除" @click.stop="removePath(qp.id)">✕</span>
              </div>
            </div>
            <div v-if="quickPaths.length === 0" class="empty" @click="showPathDialog = true">
              <span class="plus">＋</span>
              添加常用目录
            </div>
          </div>
        </div>
      </div>

      <!-- 连接 -->
      <div class="section" :class="{ collapsed: collapsed.conns }">
        <div class="section-title" @click="toggleSection('conns')">
          <span class="label">连接</span>
          <span class="chev" :class="{ open: !collapsed.conns }">▸</span>
        </div>
        <div class="section-body">
          <div class="section-inner">
            <div class="item" @click="newLocalTab('pwsh7')">
              <span class="ic" style="color: var(--cyan)">▸</span>
              <div class="meta">
                <div class="name">PowerShell 7</div>
                <div class="sub">pwsh · 本地</div>
              </div>
              <span class="badge">默认</span>
            </div>
            <div class="item" @click="newLocalTab('cmd')">
              <span class="ic">▮</span>
              <div class="meta">
                <div class="name">命令提示符</div>
                <div class="sub">cmd · 本地</div>
              </div>
              <span class="dot"></span>
            </div>
            <div class="item" v-for="host in sshHosts" :key="host.id"
              @click="connectSsh(host)"
              @contextmenu.prevent="openHostMenu($event, host)"
            >
              <span class="ic" style="color: var(--green)">⛓</span>
              <div class="meta">
                <div class="name">{{ host.name }}</div>
                <div class="sub">{{ host.config.username }}@{{ host.config.host }}</div>
              </div>
              <span class="dot" :class="{ on: isHostConnected(host) }"></span>
            </div>
            <div class="item" @click="openConnectDialog">
              <span class="ic">＋</span>
              <div class="meta">
                <div class="name">新建 SSH 连接</div>
                <div class="sub">host · port · 密钥</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 指令列表 -->
      <div class="section" :class="{ collapsed: collapsed.cmds }">
        <div class="section-title" @click="toggleSection('cmds')">
          <span class="label">指令列表</span>
          <span class="chev" :class="{ open: !collapsed.cmds }">▸</span>
          <button class="add-btn" @click.stop="openAddShortcut" title="添加快捷指令">+</button>
        </div>
        <div class="section-body">
          <div class="section-inner">
            <div class="item" v-for="sc in shortcuts" :key="sc.id"
              draggable="true"
              @dragstart="onScDragStart($event, sc.id)"
              @dragover.prevent="onScDragOver($event, sc.id)"
              @drop="onScDrop($event, sc.id)"
              @click="executeShortcut(sc)"
              @contextmenu.prevent="editShortcut(sc)"
            >
              <span class="ic">{{ sc.icon || '⌥' }}</span>
              <div class="meta">
                <div class="name">
                  {{ sc.name }}
                  <span v-if="sc.steps && sc.steps.length > 1" class="badge">{{ sc.steps.length }}步</span>
                </div>
                <div class="sub">{{ formatCommand(sc) }}</div>
              </div>
              <div class="acts">
                <span title="执行" @click.stop="executeShortcut(sc)">▸</span>
                <span title="编辑" @click.stop="editShortcut(sc)">✎</span>
              </div>
            </div>
            <div v-if="shortcuts.length === 0" class="empty" @click="openAddShortcut">
              <span class="plus">＋</span>
              添加快捷指令
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部:设置 -->
    <div class="side-foot">
      <div class="avatar">{{ sessionCount }}</div>
      <div class="who">活动会话<small>{{ sessionCount }} 个终端运行中</small></div>
      <button class="gear" title="设置" @click="openSettings">⚙</button>
    </div>

    <!-- SSH 主机右键菜单 (替代原「右键即删除」的危险交互) -->
    <div
      v-if="hostMenu.visible"
      class="ctx-menu"
      :style="{ left: hostMenu.x + 'px', top: hostMenu.y + 'px' }"
      @mouseleave="hostMenu.visible = false"
    >
      <div class="ctx-item" @click="hostMenuAction('connect')">▸ 连接</div>
      <div class="ctx-item" @click="hostMenuAction('test')">⟳ 测试连接</div>
      <div class="ctx-item" @click="hostMenuAction('edit')">✎ 编辑</div>
      <div class="ctx-divider"></div>
      <div class="ctx-item danger" @click="hostMenuAction('remove')">✕ 从列表移除</div>
    </div>

    <!-- 快捷路径编辑对话框 -->
    <div v-if="showPathDialog || editingPath" class="modal-overlay" @click.self="closePathDialog">
      <div class="modal">
        <div class="modal-title">{{ editingPath ? '编辑路径' : '添加快捷路径' }}</div>
        <div class="form-group">
          <label class="form-label">图标</label>
          <input class="input" v-model="pathDialogData.icon" placeholder="📁" maxlength="4" />
        </div>
        <div class="form-group">
          <label class="form-label">名称</label>
          <input class="input" v-model="pathDialogData.name" placeholder="项目目录" />
        </div>
        <div class="form-group">
          <label class="form-label">目录路径</label>
          <div style="display: flex; gap: 4px;">
            <input class="input" v-model="pathDialogData.path" placeholder="E:\project\myapp" />
            <button class="btn" @click="pickDirectoryForPath">浏览</button>
          </div>
        </div>
        <div class="modal-actions">
          <button v-if="editingPath" class="btn btn-danger" @click="deletePath">删除</button>
          <div style="flex: 1"></div>
          <button class="btn" @click="closePathDialog">取消</button>
          <button class="btn btn-primary" @click="savePath">保存</button>
        </div>
      </div>
    </div>

    <!-- 快捷指令编辑对话框 -->
    <div v-if="showAddDialog || editingShortcut" class="modal-overlay" @click.self="closeDialog">
      <div class="modal modal-wide">
        <div class="modal-title">{{ editingShortcut ? '编辑指令' : '添加快捷指令' }}</div>
        <div class="form-row">
          <div class="form-group" style="width: 60px;">
            <label class="form-label">图标</label>
            <input class="input" v-model="dialogData.icon" placeholder="🚀" maxlength="4" />
          </div>
          <div class="form-group flex-1">
            <label class="form-label">名称</label>
            <input class="input" v-model="dialogData.name" placeholder="启动开发服务器" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">执行模式</label>
          <div class="mode-tabs">
            <button class="mode-tab" :class="{ active: !dialogData.useSteps }" @click="dialogData.useSteps = false">单条命令</button>
            <button class="mode-tab" :class="{ active: dialogData.useSteps }" @click="dialogData.useSteps = true">组合指令 (多步)</button>
          </div>
        </div>
        <div v-if="!dialogData.useSteps">
          <div class="form-group">
            <label class="form-label">命令</label>
            <textarea class="input" v-model="dialogData.command" placeholder="npm run dev"></textarea>
          </div>
        </div>
        <div v-else>
          <div class="form-group">
            <label class="form-label">执行步骤</label>
            <div class="steps-container">
              <div v-for="(step, idx) in dialogData.steps" :key="idx" class="step-row">
                <span class="step-num">{{ idx + 1 }}</span>
                <input class="input step-cmd" v-model="step.command" :placeholder="`步骤 ${idx + 1} 命令`" />
                <input class="input step-delay" type="number" v-model.number="step.delayMs" placeholder="延迟ms" title="执行后等待毫秒" />
                <button class="btn btn-icon btn-danger" @click="removeStep(idx)">✕</button>
              </div>
              <button class="btn btn-add-step" @click="addStep">＋ 添加步骤</button>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">工作目录 (可选, 执行前先 cd)</label>
          <div style="display: flex; gap: 4px;">
            <input class="input" v-model="dialogData.cwd" placeholder="留空则在当前目录执行" />
            <button class="btn" @click="pickDirectoryForShortcut">浏览</button>
          </div>
          <div v-if="quickPaths.length > 0" class="quick-pick-paths">
            <span class="quick-pick-label">快速选择:</span>
            <button v-for="qp in quickPaths" :key="qp.id" class="btn btn-icon quick-pick-btn" @click="dialogData.cwd = qp.path" :title="qp.path">{{ qp.icon || '📁' }} {{ qp.name }}</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-check">
            <input type="checkbox" v-model="dialogData.newTab" />
            在新标签页打开
          </label>
        </div>
        <div class="modal-actions">
          <button v-if="editingShortcut" class="btn btn-danger" @click="deleteShortcut">删除</button>
          <div style="flex: 1"></div>
          <button class="btn" @click="closeDialog">取消</button>
          <button class="btn btn-primary" @click="saveShortcut">保存</button>
        </div>
      </div>
    </div>

    <ConnectDialog
      v-if="showConnectDialog"
      :editing="editingHost"
      @close="showConnectDialog = false; editingHost = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useShortcutsStore } from '../stores/shortcuts'
import { useTabsStore } from '../stores/tabs'
import { useToast } from '../composables/useToast'
import ConnectDialog from './ConnectDialog.vue'
import type { ShortcutCommand, QuickPath, SshHostEntry, CommandStep } from '../types'

const emit = defineEmits<{
  execute: [shortcut: ShortcutCommand]
  cdToPath: [path: string]
}>()

const shortcutsStore = useShortcutsStore()
const tabsStore = useTabsStore()
const { shortcuts, quickPaths } = storeToRefs(shortcutsStore)
const { show: showToast } = useToast()

// H3: 真实连接状态
const activeSessionCount = computed(() =>
  tabsStore.tabs.filter(t => t.status === 'connected' || t.status === 'connecting').length
)
function isHostConnected(host: SshHostEntry): boolean {
  return tabsStore.tabs.some(t =>
    t.type === 'ssh' && t.ssh?.host === host.config.host && t.status === 'connected'
  )
}

// 侧栏分区折叠状态（默认折叠）
const collapsed = ref({ paths: true, conns: true, cmds: true })
function toggleSection(key: 'paths' | 'conns' | 'cmds') {
  collapsed.value[key] = !collapsed.value[key]
}

const showAddDialog = ref(false)
const editingShortcut = ref<ShortcutCommand | null>(null)
const showConnectDialog = ref(false)
/** 正在编辑的 SSH 主机 (null 表示新建) */
const editingHost = ref<SshHostEntry | null>(null)
const showPathDialog = ref(false)
const editingPath = ref<QuickPath | null>(null)
const sshHosts = ref<SshHostEntry[]>([])

const sessionCount = computed(() => activeSessionCount.value)

const dialogData = ref<{
  icon: string; name: string; command: string;
  steps: CommandStep[]; useSteps: boolean; cwd: string; newTab: boolean
}>({
  icon: '', name: '', command: '', steps: [], useSteps: false, cwd: '', newTab: false
})

const pathDialogData = ref({ icon: '', name: '', path: '' })

let dragId = ''
let dragPathId = ''

async function loadSshHosts() { sshHosts.value = await window.api.store.sshHosts.get() }

function newLocalTab(shellId?: string) {
  const id = tabsStore.createLocalTab(shellId)
  if (!id) { showToast('标签页已达上限 (12)'); return }
  showToast('新建终端')
}

function openConnectDialog() { showConnectDialog.value = true }
function openSettings() { window.dispatchEvent(new CustomEvent('open-settings')) }

async function connectSsh(host: SshHostEntry) {
  tabsStore.createSshTab(host.name, host.config)
  showToast('连接 ' + host.name)
}

// --- SSH 主机右键菜单 ---
const hostMenu = ref({ visible: false, x: 0, y: 0, hostId: '' })

function openHostMenu(e: MouseEvent, host: SshHostEntry) {
  hostMenu.value = { visible: true, x: e.clientX, y: e.clientY, hostId: host.id }
}

function hostMenuAction(action: 'connect' | 'test' | 'edit' | 'remove') {
  const id = hostMenu.value.hostId
  hostMenu.value.visible = false
  const host = sshHosts.value.find(h => h.id === id)
  if (!host) return
  switch (action) {
    case 'connect':
      connectSsh(host)
      break
    case 'test':
      void testHost(host)
      break
    case 'edit':
      editSshHost(host)
      break
    case 'remove':
      void removeSshHost(id)
      break
  }
}

/** 测试连接: 真登录一次, 把结果与指纹显示给用户 (借鉴 shell-rs 的「测试连接」) */
async function testHost(host: SshHostEntry) {
  showToast('正在测试 ' + host.name + ' ...', 60000)
  try {
    // host.config 是 reactive 代理, 必须转成普通对象再交给 IPC
    // (否则结构化克隆失败: An object could not be cloned.)
    const result = await window.api.ssh.test(JSON.parse(JSON.stringify(host.config)))
    if (result.ok) {
      const os = result.remoteOs ? ` · ${result.remoteOs}` : ''
      showToast(`连接成功${os}`, 4000)
    } else {
      showToast('连接失败: ' + (result.reason || '未知原因'), 8000)
    }
  } catch (err) {
    showToast('测试失败: ' + (err as Error).message, 8000)
  }
}

// 菜单点击后本身已关闭, 这里只需处理「点了菜单之外的地方」
function onGlobalClick() {
  if (hostMenu.value.visible) hostMenu.value.visible = false
}

onMounted(() => {
  window.addEventListener('click', onGlobalClick)
})

onUnmounted(() => {
  window.removeEventListener('click', onGlobalClick)
})

/** 编辑主机: 复用连接对话框, 预填已有配置 */
function editSshHost(host: SshHostEntry) {
  editingHost.value = host
  showConnectDialog.value = true
}

async function removeSshHost(id: string) {
  sshHosts.value = sshHosts.value.filter(h => h.id !== id)
  await window.api.store.sshHosts.set(JSON.parse(JSON.stringify(sshHosts.value)))
  showToast('已移除 SSH 主机')
}

function cdToPath(qp: QuickPath) {
  emit('cdToPath', qp.path)
}

function editPath(qp: QuickPath) {
  editingPath.value = qp
  pathDialogData.value = { icon: qp.icon || '', name: qp.name, path: qp.path }
}

function closePathDialog() {
  showPathDialog.value = false
  editingPath.value = null
  pathDialogData.value = { icon: '', name: '', path: '' }
}

async function pickDirectoryForPath() {
  const dir = await window.api.store.pickDirectory()
  if (dir) {
    pathDialogData.value.path = dir
    if (!pathDialogData.value.name) pathDialogData.value.name = dir.split('\\').pop() || dir
  }
}

function savePath() {
  const data = { ...pathDialogData.value }
  if (editingPath.value) shortcutsStore.updatePath(editingPath.value.id, data)
  else shortcutsStore.addPath(data)
  closePathDialog()
  showToast('路径已保存')
}

function deletePath() {
  if (editingPath.value) {
    shortcutsStore.removePath(editingPath.value.id)
    closePathDialog()
    showToast('已删除路径')
  }
}

function onPathDragStart(e: DragEvent, id: string) { dragPathId = id; e.dataTransfer?.setData('text/plain', id) }
function onPathDragOver(e: DragEvent, _id: string) { e.preventDefault() }
function onPathDrop(e: DragEvent, id: string) { e.preventDefault(); if (dragPathId && dragPathId !== id) shortcutsStore.reorderPaths(dragPathId, id); dragPathId = '' }

async function removePath(id: string) {
  shortcutsStore.removePath(id)
  showToast('已删除路径')
}

function formatCommand(sc: ShortcutCommand): string {
  if (sc.steps && sc.steps.length > 0) return sc.steps.map(s => s.command).join(' → ')
  return sc.command
}

function executeShortcut(sc: ShortcutCommand) { emit('execute', sc) }

function openAddShortcut() {
  showAddDialog.value = true
  dialogData.value = { icon: '', name: '', command: '', steps: [{ command: '', delayMs: 300 }], useSteps: false, cwd: '', newTab: false }
}

function editShortcut(sc: ShortcutCommand) {
  editingShortcut.value = sc
  const useSteps = !!(sc.steps && sc.steps.length > 0)
  dialogData.value = {
    icon: sc.icon || '', name: sc.name, command: sc.command || '',
    steps: useSteps ? sc.steps!.map(s => ({ ...s })) : [{ command: '', delayMs: 300 }],
    useSteps, cwd: sc.cwd || '', newTab: sc.newTab
  }
}

function closeDialog() {
  showAddDialog.value = false
  editingShortcut.value = null
  dialogData.value = { icon: '', name: '', command: '', steps: [], useSteps: false, cwd: '', newTab: false }
}

async function pickDirectoryForShortcut() {
  const dir = await window.api.store.pickDirectory()
  if (dir) dialogData.value.cwd = dir
}

function addStep() { dialogData.value.steps.push({ command: '', delayMs: 300 }) }
function removeStep(idx: number) { dialogData.value.steps.splice(idx, 1) }

function saveShortcut() {
  const d = dialogData.value
  if (d.useSteps) {
    const steps = d.steps.filter(s => s.command.trim())
    if (steps.length === 0) return
    const data = { icon: d.icon, name: d.name, command: '', steps, cwd: d.cwd, newTab: d.newTab }
    if (editingShortcut.value) shortcutsStore.update(editingShortcut.value.id, data)
    else shortcutsStore.add(data)
  } else {
    if (!d.command.trim()) return
    const data = { icon: d.icon, name: d.name, command: d.command, steps: undefined, cwd: d.cwd, newTab: d.newTab }
    if (editingShortcut.value) shortcutsStore.update(editingShortcut.value.id, data)
    else shortcutsStore.add(data)
  }
  closeDialog()
  showToast('指令已保存')
}

function deleteShortcut() {
  if (editingShortcut.value) {
    shortcutsStore.remove(editingShortcut.value.id)
    closeDialog()
    showToast('已删除指令')
  }
}

function onScDragStart(e: DragEvent, id: string) { dragId = id; e.dataTransfer?.setData('text/plain', id) }
function onScDragOver(e: DragEvent, _id: string) { e.preventDefault() }
function onScDrop(e: DragEvent, id: string) { e.preventDefault(); if (dragId && dragId !== id) shortcutsStore.reorder(dragId, id); dragId = '' }

window.addEventListener('open-connect-dialog', () => { showConnectDialog.value = true })
window.addEventListener('open-path-dialog', () => { showPathDialog.value = true })

onMounted(async () => {
  await loadSshHosts()
  window.addEventListener('ssh-hosts-updated', loadSshHosts)
})
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* SSH 主机右键菜单 */
.ctx-menu {
  position: fixed;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 4px 0;
  min-width: 150px;
  z-index: 200;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}
.ctx-item {
  padding: 7px 16px;
  cursor: pointer;
  font-size: 12px;
  color: var(--tx-0);
  transition: background 0.1s;
}
.ctx-item:hover { background: var(--bg-3); color: var(--amber); }
.ctx-item.danger:hover { color: var(--red); }
.ctx-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 8px;
}

.side-head {
  padding: 14px 16px 10px;
  font-family: var(--disp);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--tx-2);
  text-transform: uppercase;
}

.side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.section { margin-bottom: 4px; }

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--tx-1);
  letter-spacing: 0.05em;
  cursor: pointer;
  user-select: none;
}

.section-title .chev {
  margin-left: auto;
  flex: none;
  font-size: 9px;
  color: var(--tx-2);
  transition: transform 0.22s ease, color 0.22s ease;
}
.section-title .chev.open {
  transform: rotate(90deg);
  color: var(--amber);
}

/* 折叠动画: grid-template-rows 1fr <-> 0fr */
.section-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s ease;
}
.section-body > .section-inner { min-height: 0; overflow: hidden; }
.section.collapsed .section-body { grid-template-rows: 0fr; }
.section.collapsed .section-title .label::before { opacity: 0.35; }

.section-title .label {
  display: flex;
  align-items: center;
  gap: 7px;
  transition: color 0.15s;
}
.section-title:hover .label { color: var(--amber); }
.section-title .label::before {
  content: "";
  width: 3px;
  height: 10px;
  border-radius: 2px;
  background: var(--amber);
  opacity: 0.85;
  transition: opacity 0.22s ease;
}

.add-btn {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--tx-2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  display: grid;
  place-items: center;
  transition: all 0.15s;
}
.add-btn:hover {
  background: var(--amber-dim);
  color: var(--amber);
  border-color: rgba(255, 176, 0, 0.35);
}

/* 列表项 */
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 8px;
  padding: 8px 10px;
  border-radius: var(--r);
  color: var(--tx-1);
  font-size: 12.5px;
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
  transition: all 0.12s;
  animation: itemIn 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.item:hover {
  background: var(--bg-2);
  color: var(--tx-0);
  border-color: var(--line-soft);
}
.item:active { transform: scale(0.985); }

.item .ic {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-size: 13px;
  background: var(--bg-2);
  border: 1px solid var(--line-soft);
  color: var(--tx-1);
  transition: all 0.15s;
}
.item:hover .ic {
  border-color: rgba(255, 176, 0, 0.35);
  color: var(--amber);
}

.item .meta { min-width: 0; flex: 1; }
.item .meta .name {
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 4px;
}
.item .meta .sub {
  font-size: 10.5px;
  color: var(--tx-2);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item .badge {
  flex: none;
  font-size: 9.5px;
  padding: 2px 7px;
  border-radius: 99px;
  background: var(--amber-dim);
  color: var(--amber);
  letter-spacing: 0.04em;
}

.item .dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tx-2);
}
.item .dot.on {
  background: var(--green);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* hover 浮现操作 */
.item .acts {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: none;
  gap: 4px;
}
.item:hover .acts { display: flex; }
.item:hover .badge, .item:hover .dot { display: none; }

.acts span {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: var(--bg-3);
  border: 1px solid var(--line);
  color: var(--tx-1);
  font-size: 10px;
  transition: all 0.12s;
}
.acts span:hover {
  color: var(--amber);
  border-color: rgba(255, 176, 0, 0.4);
}

/* 空状态 */
.empty {
  margin: 4px 12px 8px;
  padding: 16px 12px;
  border: 1px dashed var(--line);
  border-radius: var(--r);
  text-align: center;
  color: var(--tx-2);
  font-size: 11.5px;
  line-height: 1.7;
  transition: all 0.15s;
  cursor: pointer;
}
.empty:hover {
  border-color: rgba(255, 176, 0, 0.4);
  color: var(--tx-1);
  background: rgba(255, 176, 0, 0.03);
}
.empty .plus {
  font-size: 16px;
  display: block;
  margin-bottom: 4px;
  color: var(--amber);
}

/* 底部 */
.side-foot {
  margin-top: auto;
  flex: none;
  border-top: 1px solid var(--line);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.side-foot .avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, #2a2f3c, #171a21);
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  color: var(--amber);
  font-size: 12px;
  font-weight: 600;
}
.side-foot .who { font-size: 12px; color: var(--tx-1); }
.side-foot .who small { display: block; font-size: 10px; color: var(--tx-2); }
.side-foot .gear {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: var(--tx-2);
  cursor: pointer;
  font-size: 14px;
  display: grid;
  place-items: center;
  transition: all 0.15s;
}
.side-foot .gear:hover {
  background: var(--bg-3);
  color: var(--tx-0);
  transform: rotate(40deg);
}

/* 模式切换 */
.mode-tabs { display: flex; gap: 4px; }
.mode-tab {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg-0);
  color: var(--tx-1);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--mono);
  transition: all 0.15s;
}
.mode-tab.active {
  background: var(--amber-dim);
  color: var(--amber);
  border-color: rgba(255, 176, 0, 0.35);
}

/* 步骤编辑器 */
.steps-container { display: flex; flex-direction: column; gap: 6px; }
.step-row { display: flex; align-items: center; gap: 6px; }
.step-num {
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--bg-3); color: var(--tx-0);
  font-size: 10px; display: grid; place-items: center;
  flex-shrink: 0; font-weight: 600;
}
.step-cmd { flex: 1; font-family: var(--mono); }
.step-delay { width: 80px; font-size: 11px; }
.btn-add-step { width: 100%; justify-content: center; border-style: dashed; margin-top: 4px; }

.quick-pick-paths { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
.quick-pick-label { font-size: 10px; color: var(--tx-2); }
.quick-pick-btn { font-size: 10px; padding: 3px 6px; }
</style>
