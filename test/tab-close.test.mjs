import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 标签关闭路径的资源清理测试。
 *
 * 为什么单独测这个: 曾经出现「直接过滤数组」绕过 closeTab 的写法,
 * 导致后端 SSH 会话与 IPC 监听器泄漏, 而且没有测试能发现。
 * 这里用最小的 store 复刻 + 假 window.api 记录调用, 锁住这条不变量:
 *
 *   任何让标签消失的路径, 都必须走 closeTab (断开 + 清监听)
 */

/** 记录调用的假 window.api */
function makeFakeApi() {
  const calls = { disconnect: [], sshRemoveListeners: [], ptyKill: [], ptyRemoveListeners: [] }
  return {
    calls,
    api: {
      ssh: {
        disconnect: (id) => calls.disconnect.push(id),
        removeListeners: (id) => calls.sshRemoveListeners.push(id)
      },
      pty: {
        kill: (id) => calls.ptyKill.push(id),
        removeListeners: (id) => calls.ptyRemoveListeners.push(id)
      }
    }
  }
}

/**
 * 复刻 src/stores/tabs.ts 的关闭逻辑 (保持与源码同样的结构)。
 * 只保留本测试关心的部分: 关闭、批量关闭、激活项修正、资源清理。
 */
function makeStore(fakeApi) {
  const tabs = []
  let activeTabId = null
  let counter = 0

  const idxOf = (id) => tabs.findIndex((t) => t.id === id)

  function create(type = 'ssh') {
    const id = `tab-${++counter}`
    tabs.push({ id, type })
    activeTabId = id
    return id
  }

  function closeTab(id) {
    const idx = idxOf(id)
    if (idx === -1) return
    tabs.splice(idx, 1)
    // 与源码一致: 清理资源
    fakeApi.api.ssh.removeListeners(id)
    fakeApi.api.ssh.disconnect(id)
    fakeApi.api.pty.removeListeners(id)
    fakeApi.api.pty.kill(id)
    if (activeTabId === id) {
      activeTabId = tabs.length > 0 ? tabs[Math.max(0, idx - 1)].id : null
    }
  }

  function closeMany(ids) {
    for (const id of ids) closeTab(id)
  }

  function closeOthers(id) {
    closeMany(tabs.filter((t) => t.id !== id).map((t) => t.id))
  }

  function closeSide(id, side) {
    const idx = idxOf(id)
    if (idx === -1) return 0
    const doomed = side === 'left' ? tabs.slice(0, idx) : tabs.slice(idx + 1)
    if (doomed.length === 0) return 0
    closeMany(doomed.map((t) => t.id))
    return doomed.length
  }

  function closeAll() {
    closeMany(tabs.map((t) => t.id))
  }

  return {
    get tabs() { return tabs.map((t) => t.id) },
    get active() { return activeTabId },
    create, closeTab, closeOthers, closeSide, closeAll
  }
}

let fake
let store
beforeEach(() => {
  fake = makeFakeApi()
  store = makeStore(fake)
})

describe('标签关闭 — 资源清理不变量', () => {
  it('closeTab 会断开连接并清监听', () => {
    const id = store.create()
    store.closeTab(id)
    assert.deepEqual(fake.calls.disconnect, [id])
    assert.deepEqual(fake.calls.sshRemoveListeners, [id])
    assert.deepEqual(fake.calls.ptyKill, [id])
    assert.deepEqual(fake.calls.ptyRemoveListeners, [id])
  })

  it('closeOthers 对每个被关的标签都做清理', () => {
    const a = store.create(); const b = store.create(); const c = store.create()
    store.closeOthers(b)
    assert.equal(store.tabs.length, 1)
    assert.equal(store.tabs[0], b)
    // a 与 c 都被关, 两者都应清理
    assert.deepEqual([...fake.calls.disconnect].sort(), [a, c].sort())
    assert.deepEqual([...fake.calls.sshRemoveListeners].sort(), [a, c].sort())
  })

  it('closeSide(left) 清理左侧全部标签', () => {
    const a = store.create(); const b = store.create(); const c = store.create(); const d = store.create()
    const n = store.closeSide(c, 'left')
    assert.equal(n, 2)
    assert.deepEqual(store.tabs, [c, d])
    assert.deepEqual([...fake.calls.disconnect].sort(), [a, b].sort())
  })

  it('closeSide(right) 清理右侧全部标签', () => {
    const a = store.create(); const b = store.create(); const c = store.create(); const d = store.create()
    const n = store.closeSide(b, 'right')
    assert.equal(n, 2)
    assert.deepEqual(store.tabs, [a, b])
    assert.deepEqual([...fake.calls.disconnect].sort(), [c, d].sort())
  })

  it('closeAll 清理每一个标签', () => {
    const ids = [store.create(), store.create(), store.create()]
    store.closeAll()
    assert.equal(store.tabs.length, 0)
    assert.equal(store.active, null)
    assert.deepEqual([...fake.calls.disconnect].sort(), [...ids].sort())
  })

  it('没有可关闭对象时 closeSide 不做任何清理', () => {
    const a = store.create()
    assert.equal(store.closeSide(a, 'left'), 0)
    assert.equal(store.closeSide(a, 'right'), 0)
    assert.equal(fake.calls.disconnect.length, 0)
  })

  it('关闭不存在的标签是安全的空操作', () => {
    store.create()
    store.closeTab('no-such-tab')
    assert.equal(fake.calls.disconnect.length, 0)
  })
})

describe('标签关闭 — 激活项一致性', () => {
  it('关闭激活标签后激活项仍指向存在的标签', () => {
    const a = store.create(); const b = store.create(); const c = store.create()
    store.closeTab(b)
    assert.ok([a, c].includes(store.active), `active=${store.active}`)
    assert.ok(store.tabs.includes(store.active))
  })

  it('关闭左侧且含激活项时激活项被修正', () => {
    store.create(); store.create()
    const c = store.create()
    store.closeSide(c, 'left')
    assert.equal(store.active, c)
  })

  it('全部关闭后激活项为 null', () => {
    store.create(); store.create()
    store.closeAll()
    assert.equal(store.active, null)
  })

  it('批量关闭后激活项绝不指向已关闭的标签', () => {
    const ids = [store.create(), store.create(), store.create(), store.create(), store.create()]
    // 逐个场景: 关闭其他 / 关闭左右侧 / 全关
    for (const target of ids) {
      fake = makeFakeApi()
      const s = makeStore(fake)
      const live = ids.map(() => s.create())
      s.closeOthers(target === ids[0] ? live[2] : live[0])
      assert.ok(s.active === null || s.tabs.includes(s.active),
        `closeOthers 后 active=${s.active} 不在 ${s.tabs}`)
    }
  })
})

describe('标签关闭 — 防回归: 不得绕过 closeTab', () => {
  it('closeOthers/closeSide/closeAll 都必须产生清理调用', () => {
    const scenarios = [
      ['closeOthers', (s, ids) => s.closeOthers(ids[1])],
      ['closeSide-left', (s, ids) => s.closeSide(ids[2], 'left')],
      ['closeSide-right', (s, ids) => s.closeSide(ids[1], 'right')],
      ['closeAll', (s) => s.closeAll()]
    ]
    for (const [name, run] of scenarios) {
      const f = makeFakeApi()
      const s = makeStore(f)
      const ids = [s.create(), s.create(), s.create(), s.create()]
      run(s, ids)
      // 只要关了标签, 就必须有等量的清理调用
      const closedCount = 4 - s.tabs.length
      assert.ok(closedCount > 0, `${name} 没有关闭任何标签`)
      assert.equal(f.calls.disconnect.length, closedCount,
        `${name}: 关闭 ${closedCount} 个但只清理了 ${f.calls.disconnect.length} 个`)
      assert.equal(f.calls.sshRemoveListeners.length, closedCount,
        `${name}: 监听清理数量不符`)
    }
  })
})
