import type { BrowserWindow } from 'electron'

/**
 * 岛主窗口的引用（唯一事实来源）。
 *
 * 为什么需要这个文件：`notifyStore` / `clipboardStore` 以前用
 * `BrowserWindow.getAllWindows()[0]` 往渲染层推横幅事件，假设「[0] 一定是岛窗口」。
 * 2026-11-12 实测这个假设不成立——用户把桌宠切成「独立小窗口」后，
 * `getAllWindows()` 返回的顺序是 `[pet.html, index.html]`，
 * 于是横幅事件全发给了宠物窗口（它根本没有监听 `island:notify-arrived`），
 * 岛上一个提示都不弹。用户原话「我刚刚截图，灵动岛没有信息提示弹出」就是这个。
 *
 * 不直接用 `BrowserWindow.getAllWindows()[0]`，也不靠 URL 猜窗口：
 * URL 匹配在开发版（各自 loadURL）和打包版（loadFile）下写法不同，容易漏。
 * 用一个显式登记、显式清空的引用最稳。
 */

let islandWindow: BrowserWindow | null = null

/** 岛窗口创建后登记。index.ts 的 createWindow 里调用 */
export function setIslandWindow(win: BrowserWindow | null): void {
  islandWindow = win
}

/**
 * 取岛窗口；已销毁或还没创建时返回 null（调用方用可选链，不发就不发）。
 * 每次都判 isDestroyed：窗口关了但引用还在时直接发会抛异常。
 */
export function getIslandWindow(): BrowserWindow | null {
  if (!islandWindow) return null
  if (islandWindow.isDestroyed() || islandWindow.webContents.isDestroyed()) return null
  return islandWindow
}

/** 往岛渲染层推一个事件；窗口不在就静默跳过（横幅错过一条比崩掉好） */
export function sendToIsland(channel: string, ...args: unknown[]): boolean {
  const win = getIslandWindow()
  if (!win) return false
  win.webContents.send(channel, ...args)
  return true
}
