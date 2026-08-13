import { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

let mainWindowRef: BrowserWindow | null = null

export function setMainWindowRef(win: BrowserWindow | null) {
  mainWindowRef = win
}

export function isValidSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(e.sender)
  return !!win && !!mainWindowRef && win.id === mainWindowRef.id
}

export function getWin(e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow {
  return BrowserWindow.fromWebContents(e.sender)!
}
