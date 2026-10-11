import { app, screen, BrowserWindow } from 'electron'
import { join } from 'path'
import Store from 'electron-store'

/**
 * 窗口状态记忆 (借鉴 shell-rs 的 window_state.rs)
 * - 位置/大小/最大化 去抖持久化, 退出时补写
 * - 恢复时按显示器做越界校验: 完全不可见则居中, 超过屏幕则收缩
 */

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface WindowToggles {
  rememberSize: boolean
  rememberPosition: boolean
}

export const DEFAULT_WIDTH = 1240
export const DEFAULT_HEIGHT = 780
export const MIN_WIDTH = 900
export const MIN_HEIGHT = 600
// 至少要有这么多像素落在某块屏幕内, 才认为窗口可见
const VISIBLE_WIDTH = 120
const VISIBLE_HEIGHT = 40
const SAVE_DEBOUNCE_MS = 500

const DEFAULTS: WindowState = {
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  maximized: false
}

const store = new Store<{ window: WindowState }>({
  name: 'window-state',
  cwd: join(app.getPath('userData'), 'config'),
  defaults: { window: DEFAULTS }
})

type Rect = { x: number; y: number; width: number; height: number }

/** 两个矩形的可见交集尺寸 */
function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  }
}

/**
 * 根据保存的状态 + 设置开关, 解析出可安全使用的窗口尺寸与位置
 * (screen 模块需在 app ready 之后调用)
 */
export function resolveWindowBounds(
  saved: Partial<WindowState>,
  toggles: WindowToggles
): { width: number; height: number; x?: number; y?: number } {
  const width = toggles.rememberSize
    ? Math.max(MIN_WIDTH, Math.round(saved.width || DEFAULT_WIDTH))
    : DEFAULT_WIDTH
  const height = toggles.rememberSize
    ? Math.max(MIN_HEIGHT, Math.round(saved.height || DEFAULT_HEIGHT))
    : DEFAULT_HEIGHT

  const result: { width: number; height: number; x?: number; y?: number } = { width, height }

  const hasPos = Number.isInteger(saved.x) && Number.isInteger(saved.y)
  if (toggles.rememberPosition && hasPos) {
    const rect: Rect = { x: saved.x as number, y: saved.y as number, width, height }
    // 借鉴 shell-rs 的 reachable(): 标题栏必须在屏幕内, 否则用户拖不动窗口。
    // 仅判「有交集」不够 —— 窗口被拖到屏幕上方时交集仍在, 但标题栏已不可及。
    const reachable = screen.getAllDisplays().some((d) => {
      const v = overlap(rect, d.workArea)
      const titleBarVisible =
        rect.y >= d.workArea.y &&
        rect.y <= d.workArea.y + d.workArea.height - VISIBLE_HEIGHT
      return titleBarVisible && v.w >= VISIBLE_WIDTH && v.h >= VISIBLE_HEIGHT
    })
    if (reachable) {
      result.x = rect.x
      result.y = rect.y
    }
  }

  // 分辨率变化: 尺寸不得超过目标显示器工作区
  const ref: Rect =
    result.x !== undefined && result.y !== undefined
      ? { x: result.x, y: result.y, width, height }
      : screen.getPrimaryDisplay().workArea
  const target = screen.getDisplayMatching(ref)
  result.width = Math.min(result.width, target.workArea.width)
  result.height = Math.min(result.height, target.workArea.height)
  return result
}

/** 读取上次保存的窗口状态并解析为 BrowserWindow 可用参数 */
export function getWindowStateOptions(toggles: WindowToggles) {
  const saved = store.get('window')
  const bounds = resolveWindowBounds(saved || {}, toggles)
  return { bounds, maximized: toggles.rememberSize ? !!saved?.maximized : false }
}

/** 监听窗口尺寸/位置变化并去抖持久化, 关闭前补写一次 */
export function trackWindowState(win: BrowserWindow, getToggles: () => WindowToggles) {
  let timer: ReturnType<typeof setTimeout> | null = null

  const persist = () => {
    if (win.isDestroyed()) return
    const toggles = getToggles()
    if (!toggles.rememberSize && !toggles.rememberPosition) return
    const prev = store.get('window') || DEFAULTS
    const bounds = win.getNormalBounds() // 最大化/全屏时返回还原后的尺寸
    const next: WindowState = { ...prev }
    if (toggles.rememberSize) {
      next.width = bounds.width
      next.height = bounds.height
    }
    if (toggles.rememberPosition) {
      next.x = bounds.x
      next.y = bounds.y
    }
    // 全屏不记忆 (与 shell-rs 一致), 只记最大化
    next.maximized = win.isMaximized()
    store.set('window', next)
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, SAVE_DEBOUNCE_MS)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    persist()
  })
}