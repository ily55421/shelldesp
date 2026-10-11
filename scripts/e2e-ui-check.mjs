/**
 * 渲染层 UI 的**真实浏览器端到端验证**。
 *
 * 做法: 启动真实的 Electron 应用 (加载构建产物 out/renderer), 通过 CDP 驱动
 * 真实的 DOM 交互 —— 点击侧栏、填连接表单、点「连接」、等系统状态面板出现数据。
 * 断言的是**真实渲染结果**, 不是 mock。
 *
 * 与 e2e-system-status.mjs 的分工:
 * - 那个验证「主进程采集链路」(真 SSH → 真解析)
 * - 本脚本验证「渲染层 UI」(真 DOM → 真 IPC → 真 SSH → 真 DOM 更新)
 *
 * 关于主机密钥: 首次连接会弹**原生对话框**询问是否信任, 那是 OS 级窗口,
 * CDP 操作不到 —— 这不是缺陷而是安全设计。所以本脚本先用一次真实握手取到
 * 服务端主机密钥, 写进应用自己的信任库 (等价于「用户已核对指纹并点了信任」),
 * 从而能验证信任之后的正常主流程。
 *
 * 环境要求:
 * - 能构建 (out/ 存在) 与启动 Electron
 * - WSL OpenSSH 可用 (不可用则明确跳过, 返回 0)
 *
 * 注意: 用独立的 --user-data-dir 启动, 不影响用户正在运行的实例
 * (应用有单实例锁, 共用 userData 会导致新实例立即退出)。
 *
 * 运行: node scripts/e2e-ui-check.mjs
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openSshAvailable, ensureOpenSshServer, stopOpenSshServer, OPENSSH_USER } from './lib/wsl-openssh.mjs'

let passed = 0
let failed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`) }
  else {
    failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 找一个确定空闲的端口 */
async function freePort() {
  const net = await import('node:net')
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => res(p))
    })
  })
}

/** 等 CDP 端点就绪 */
async function waitForCdp(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

/** 极简 CDP 会话 */
async function cdpConnect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let id = 0
  const consoleErrors = []
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP ws 连接失败')), { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined) {
      const p = pending.get(m.id)
      if (p) {
        pending.delete(m.id)
        if (m.error) p.reject(new Error(JSON.stringify(m.error)))
        else p.resolve(m.result)
      }
      return
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || 'unknown exception')
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id
    pending.set(myId, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id: myId, method, params }))
    setTimeout(() => {
      if (pending.has(myId)) { pending.delete(myId); rej(new Error(`CDP 超时: ${method}`)) }
    }, 40000)
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(`求值异常: ${r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)}`)
    }
    return r.result.value
  }
  return { send, evaluate, consoleErrors, close: () => ws.close() }
}

/** SSH 公钥的 SHA256 指纹 (OpenSSH 格式) */
function fingerprint(buf) {
  return `SHA256:${createHash('sha256').update(buf).digest('base64').replace(/=+$/, '')}`
}

/** 从 SSH 公钥 wire 格式解析算法名 */
function keyType(buf) {
  try {
    const len = buf.readUInt32BE(0)
    return buf.subarray(4, 4 + len).toString('ascii')
  } catch { return 'unknown' }
}

console.log('\n=== ShellDesk 渲染层 UI · 真实浏览器端到端验证 ===')

// --- 前置检查 ---
if (!existsSync(resolve('out/renderer/index.html'))) {
  console.log('\n  缺少构建产物 out/renderer/index.html')
  console.log('  请先 npm run build。本项验证跳过 (不计入失败)。\n')
  process.exit(0)
}
const availability = await openSshAvailable()
if (!availability.ok) {
  console.log(`\n  WSL OpenSSH 不可用: ${availability.reason}`)
  console.log('  本项验证跳过 (不计入失败)。\n')
  process.exit(0)
}

const server = await ensureOpenSshServer()
console.log(`OpenSSH ${server.version} · ${OPENSSH_USER}@127.0.0.1:${server.port}\n`)

// 私钥必须在 ~/.ssh 下 (主进程安全限制), 把测试私钥复制进去
const sshDir = join(process.env.USERPROFILE || process.env.HOME || '', '.ssh')
mkdirSync(sshDir, { recursive: true })
const uiKeyPath = join(sshDir, 'shelldesk-e2e-ui.key')
writeFileSync(uiKeyPath, readFileSync(server.clientKeyPath, 'utf-8'))

const port = await freePort()
const userDataDir = mkdtempSync(join(tmpdir(), 'shelldesk-ui-'))
const electronBin = resolve('node_modules/electron/dist/electron.exe')

/**
 * 预置主机密钥信任, 让 UI 验证能走到「连接成功」。
 * 用真实握手取指纹, 写进应用自己的信任库 (独立 userData 下)。
 */
const realHostKey = await (async () => {
  const ssh2 = (await import('ssh2')).default
  return new Promise((res, rej) => {
    const c = new ssh2.Client()
    let done = false
    c.on('error', (e) => { if (!done) { done = true; rej(e) } })
    c.connect({
      host: '127.0.0.1', port: server.port, username: OPENSSH_USER,
      privateKey: readFileSync(server.clientKeyPath, 'utf-8'),
      readyTimeout: 15000,
      hostVerifier: (key, verify) => {
        if (!done) {
          done = true
          res({
            type: keyType(key),
            key: key.toString('base64'),
            fingerprint: fingerprint(key),
            addedAt: new Date().toISOString()
          })
        }
        verify(false) // 只为取指纹, 不真的登录
      }
    })
  })
})()

const trustFile = join(userDataDir, 'config', 'known_hosts.json')
mkdirSync(join(userDataDir, 'config'), { recursive: true })
writeFileSync(trustFile, JSON.stringify({ [`[127.0.0.1]:${server.port}`]: realHostKey }, null, 2))
console.log(`[信任] 已预置主机密钥 ${realHostKey.type} ${realHostKey.fingerprint}`)

console.log(`[启动] Electron (CDP ${port}, 独立 userData)`)
const child = spawn(electronBin, [
  '.',
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${userDataDir}`
], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })

let childOut = ''
child.stdout.on('data', (d) => { childOut += d.toString() })
child.stderr.on('data', (d) => { childOut += d.toString() })

let cdp = null
try {
  const wsUrl = await waitForCdp(port)
  check('Electron 启动并暴露渲染进程页面', !!wsUrl, childOut.slice(-400))
  if (!wsUrl) throw new Error('无法连接渲染进程')

  cdp = await cdpConnect(wsUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 等 Vue 挂载
  for (let i = 0; i < 50; i++) {
    const ready = await cdp.evaluate('!!document.querySelector(".app-container")')
    if (ready) break
    await new Promise((r) => setTimeout(r, 200))
  }

  // --- 1. 页面与 preload 契约 ---
  console.log('\n[1] 页面加载与 preload API')
  const boot = await cdp.evaluate(`(() => ({
    title: document.title,
    mounted: !!document.querySelector('.app-container'),
    hasApi: typeof window.api === 'object',
    hasExecCapture: typeof window.api?.ssh?.execCapture === 'function',
    hasSystemStatus: typeof window.api?.ssh?.systemStatus === 'function',
    hasPing: typeof window.api?.ssh?.ping === 'function',
    hasConnect: typeof window.api?.ssh?.connect === 'function'
  }))()`)
  check('页面标题为 ShellDesk', boot.title === 'ShellDesk', boot.title)
  check('Vue 应用已挂载', boot.mounted === true)
  check('preload 暴露 window.api', boot.hasApi === true)
  check('暴露 ssh.execCapture', boot.hasExecCapture === true)
  check('暴露 ssh.systemStatus', boot.hasSystemStatus === true)
  check('暴露 ssh.connect / ping', boot.hasConnect === true && boot.hasPing === true)

  // --- 2. 状态面板初始态 (无 SSH 标签) ---
  console.log('\n[2] 状态面板初始态')
  const panelInitial = await cdp.evaluate(`(() => {
    const p = document.querySelector('.status-panel')
    return {
      exists: !!p,
      text: p ? p.innerText : '',
      hasRefresh: !!document.querySelector('.status-panel .refresh'),
      refreshDisabled: document.querySelector('.status-panel .refresh')?.disabled ?? null
    }
  })()`)
  check('状态面板已渲染', panelInitial.exists === true)
  check('无 SSH 标签时明确提示, 不显示假数据',
    /本地终端无远端状态|等待连接/.test(panelInitial.text), JSON.stringify(panelInitial.text))
  check('面板刷新按钮存在', panelInitial.hasRefresh === true)

  // --- 3. 打开 SSH 连接对话框 ---
  console.log('\n[3] 打开 SSH 连接对话框 (真实点击)')
  const opened = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.item')]
    const target = items.find(el => el.innerText.includes('新建 SSH 连接'))
    if (!target) return { found: false, items: items.map(i => i.innerText.trim()).slice(0, 20) }
    target.click()
    return { found: true }
  })()`)
  check('侧栏「新建 SSH 连接」可点击', opened.found === true, JSON.stringify(opened.items || []))

  await new Promise((r) => setTimeout(r, 400))
  const dialog = await cdp.evaluate(`(() => {
    const d = document.querySelector('.modal')
    return {
      exists: !!d,
      title: d?.querySelector('.modal-title')?.innerText || '',
      labels: d ? [...d.querySelectorAll('.form-label')].map(l => l.innerText.trim()) : [],
      authTabs: d ? [...d.querySelectorAll('.auth-tab')].map(t => t.innerText.trim()) : [],
      inputs: d ? d.querySelectorAll('input.input').length : 0
    }
  })()`)
  check('连接对话框已弹出', dialog.exists === true)
  check('对话框标题正确', dialog.title === 'SSH 连接', dialog.title)
  check('四种认证方式可选', dialog.authTabs.length === 4, JSON.stringify(dialog.authTabs))
  check('表单含主机/端口/用户名等输入框', dialog.inputs >= 3, String(dialog.inputs))

  // --- 4. 真实填表 (走 Vue 的 v-model) ---
  console.log('\n[4] 填写连接信息 (真实 input 事件)')
  const filled = await cdp.evaluate(`(() => {
    const d = document.querySelector('.modal')
    const setVal = (el, v) => {
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const inputs = [...d.querySelectorAll('input.input')]
    // 顺序: 名称 / 主机 / 端口 / 用户名 (认证方式默认密码)
    setVal(inputs[0], 'E2E UI 验证')
    setVal(inputs[1], '127.0.0.1')
    setVal(inputs[2], '${server.port}')
    setVal(inputs[3], '${OPENSSH_USER}')
    const keyTab = [...d.querySelectorAll('.auth-tab')].find(t => t.innerText.trim() === '密钥')
    if (!keyTab) return { ok: false, reason: '找不到密钥认证按钮' }
    keyTab.click()
    return { ok: true, values: inputs.map(i => i.value) }
  })()`)
  check('主机/端口/用户名已填入', filled.ok === true, JSON.stringify(filled))
  check('端口为测试 OpenSSH 端口', (filled.values || [])[2] === String(server.port),
    JSON.stringify(filled.values))

  await new Promise((r) => setTimeout(r, 400))
  const keyFilled = await cdp.evaluate(`(() => {
    const d = document.querySelector('.modal')
    const labels = [...d.querySelectorAll('.form-label')].map(l => l.innerText.trim())
    const keyInput = [...d.querySelectorAll('input.input')].find(i => i.placeholder && i.placeholder.includes('.ssh'))
    if (!keyInput) return { found: false, labels }
    keyInput.value = ${JSON.stringify(uiKeyPath)}
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    return { found: true, value: keyInput.value }
  })()`)
  check('密钥认证方式下出现私钥路径输入框', keyFilled.found === true, JSON.stringify(keyFilled.labels))
  check('私钥路径已填入', keyFilled.value === uiKeyPath, String(keyFilled.value))

  // --- 5. 真实「测试连接」 ---
  console.log('\n[5] 点「测试连接」(真实 IPC → 真实 SSH)')
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal-actions .btn')].find(b => b.innerText.includes('测试连接'))
    btn.click(); return true
  })()`)
  let testResult = null
  for (let i = 0; i < 60; i++) {
    testResult = await cdp.evaluate(`(() => {
      const el = document.querySelector('.test-result')
      if (!el) return null
      return { text: el.innerText, ok: el.classList.contains('ok') }
    })()`)
    if (testResult) break
    await new Promise((r) => setTimeout(r, 400))
  }
  check('测试连接返回了结果', !!testResult, '超时未出现结果')
  check('测试连接成功 (真实 OpenSSH 握手)', testResult?.ok === true, testResult?.text || '')
  check('结果里显示了主机密钥指纹', /SHA256:/.test(testResult?.text || ''), testResult?.text || '')
  console.log(`        ${(testResult?.text || '').replace(/\n/g, ' | ')}`)

  // --- 6. 点「连接」并等待标签与面板数据 ---
  console.log('\n[6] 点「连接」→ 等待系统状态面板出真实数据')
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal-actions .btn')].find(b => b.innerText.trim() === '连接')
    if (!btn) return false
    btn.click(); return true
  })()`)

  let tabState = null
  for (let i = 0; i < 90; i++) {
    tabState = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.status-panel')
      const tabEls = [...document.querySelectorAll('.tab, .tab-item, [class*="tab"]')]
      return {
        tabText: tabEls.map(t => t.innerText.trim()).filter(Boolean).slice(0, 6),
        panelText: panel ? panel.innerText : '',
        hasPanelData: !!(panel && /CPU/.test(panel.innerText)),
        hasTerminal: !!document.querySelector('.xterm')
      }
    })()`)
    if (tabState.hasPanelData) break
    await new Promise((r) => setTimeout(r, 500))
  }

  check('连接后出现终端 (xterm 已挂载)', tabState?.hasTerminal === true,
    JSON.stringify(tabState?.tabText || []))
  check('状态面板出现真实数据区', tabState?.hasPanelData === true,
    `panel=${JSON.stringify((tabState?.panelText || '').slice(0, 300))}`)
  console.log(`        面板内容: ${(tabState?.panelText || '').replace(/\n/g, ' | ').slice(0, 500)}`)

  // --- 7. 面板内容断言 ---
  if (tabState?.hasPanelData) {
    const panel = tabState.panelText
    check('面板显示 CPU 信息', /CPU/.test(panel), panel.slice(0, 200))
    check('面板显示内存信息', /内存/.test(panel), panel.slice(0, 200))
    check('面板显示磁盘信息', /磁盘/.test(panel), panel.slice(0, 200))
    check('面板显示主机名或发行版', /linKe|Debian|Linux/i.test(panel), panel.slice(0, 200))
    check('面板显示采集时间戳', /\d{2}:\d{2}:\d{2}/.test(panel), panel.slice(0, 200))
    // 等第二轮采样, 验证 CPU% 与网络速率出现 (需两次采样求差)
    let withRates = null
    for (let i = 0; i < 30; i++) {
      withRates = await cdp.evaluate(`(() => {
        const p = document.querySelector('.status-panel')
        return p ? p.innerText : ''
      })()`)
      if (/网络/.test(withRates) && /%/.test(withRates)) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    check('二次采样后出现 CPU 百分比', /\d+(\.\d+)?%/.test(withRates || ''), (withRates || '').slice(0, 200))
    check('二次采样后出现网络速率', /网络/.test(withRates || '') && /\/s/.test(withRates || ''),
      (withRates || '').slice(0, 300))
    console.log(`        二次采样: ${(withRates || '').replace(/\n/g, ' | ').slice(0, 500)}`)

    // 手动刷新按钮: 点一下应更新时间戳
    const before = await cdp.evaluate(`document.querySelector('.status-panel .time')?.innerText || ''`)
    await new Promise((r) => setTimeout(r, 1200))
    await cdp.evaluate(`document.querySelector('.status-panel .refresh').click()`)
    let after = before
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      after = await cdp.evaluate(`document.querySelector('.status-panel .time')?.innerText || ''`)
      if (after !== before) break
    }
    check('点刷新按钮后时间戳更新', after !== before, `${before} → ${after}`)
  }

  // --- 9. 布局几何 (文本对了不代表没塌) ---
  // 只查 innerText 会漏掉「渲染了但高度为 0 / 被挤出视口」这类问题,
  // 所以这里量真实几何: 面板要有可见高度, 终端要有可用面积, 两者不重叠。
  console.log('\n[9] 布局几何')
  const layout = await cdp.evaluate(`(() => {
    const r = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), bottom: Math.round(b.bottom) }
    }
    return {
      panel: r('.status-panel'),
      term: r('.terminal-area'),
      statusbar: r('.statusbar'),
      viewportH: window.innerHeight,
      viewportW: window.innerWidth
    }
  })()`)
  check('状态面板有可见高度', (layout.panel?.h || 0) > 40, JSON.stringify(layout.panel))
  check('状态面板宽度铺满主区', (layout.panel?.w || 0) > 200, JSON.stringify(layout.panel))
  check('终端区域仍有可用高度', (layout.term?.h || 0) > 100, JSON.stringify(layout.term))
  check('终端与面板不重叠', (layout.term?.bottom || 0) <= (layout.panel?.top || 0) + 2,
    `term.bottom=${layout.term?.bottom} panel.top=${layout.panel?.top}`)
  check('状态栏在面板下方', (layout.statusbar?.top || 0) >= (layout.panel?.bottom || 0) - 2,
    `panel.bottom=${layout.panel?.bottom} statusbar.top=${layout.statusbar?.top}`)
  check('整体未超出视口高度', (layout.statusbar?.bottom || 0) <= layout.viewportH + 2,
    `statusbar.bottom=${layout.statusbar?.bottom} viewport=${layout.viewportH}`)
  console.log(`        面板 ${layout.panel?.w}×${layout.panel?.h} · 终端 ${layout.term?.w}×${layout.term?.h} · 视口 ${layout.viewportW}×${layout.viewportH}`)

  // --- 8. 无控制台错误 ---
  console.log('\n[8] 渲染层控制台')
  const realErrors = cdp.consoleErrors.filter((e) =>
    !/DevTools|Autofill|Extension|third-party cookie/i.test(e)
  )
  check('渲染层无未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' || '))
} catch (error) {
  check('验证过程无异常', false, error?.message || String(error))
} finally {
  if (cdp) { try { cdp.close() } catch {} }
  try { child.kill() } catch {}
  await new Promise((r) => setTimeout(r, 1500))
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  try { rmSync(uiKeyPath, { force: true }) } catch {}
  await stopOpenSshServer()
}

console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===`)
if (failures.length > 0) {
  console.log('失败项:')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log()
process.exit(failed > 0 ? 1 : 0)
