import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Todo, ShelfItem, ShelfOpenResult, ShelfRevealResult } from '../shared/types'

export type { Todo, ShelfItem, ShelfOpenResult, ShelfRevealResult }

/** 收起态状态栏的数据快照（与主进程 statusStore 保持一致） */
export interface StatusSnapshot {
  battery: number | null
  charging: boolean
}

/** 通知页数据（与主进程 notifyStore 保持一致） */
export interface NotifyItem {
  id: number
  order: number
  app: string
  title: string
  body: string
  arrival: number
}

export interface NotifyListResult {
  items: NotifyItem[]
  unread: number
}

/** 拖放落盘后的回调登记表（跨闭包广播，不走 ipcRenderer 事件——emit/on 参数语义容易踩坑） */
const shelfAddedCbs: ((list: ShelfItem[]) => void)[] = []

const api = {
  /** 请求主进程把窗口切到展开/收起尺寸 */
  setExpanded(value: boolean): void {
    ipcRenderer.send('island:set-expanded', value)
  },
  /** 收起态内容宽度上报（主进程按它定窗口宽，clamp 150~320） */
  setCollapsedWidth(px: number): void {
    ipcRenderer.send('island:set-collapsed-width', px)
  },
  /** 展开态内容尺寸上报（主进程 clamp 到 420~720 × 220~420 后定窗口大小） */
  setExpandedSize(w: number, h: number): void {
    ipcRenderer.send('island:set-expanded-size', w, h)
  },
  /** 文件拖悬停在窗口上（收起态时让主进程放大窗口） */
  dragHover(): void {
    ipcRenderer.send('island:drag-hover')
  },
  /** 窗口失焦（点了桌面或其他程序）——渲染层借此自动收回 */
  onWindowBlur(cb: () => void): void {
    ipcRenderer.on('island:window-blur', cb)
  },
  /** 待办清单：读 / 增 / 勾选切换 / 删 / 改名，全部返回最新全量列表 */
  todosList(): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:list')
  },
  todosAdd(text: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:add', text)
  },
  todosToggle(id: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:toggle', id)
  },
  todosRemove(id: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:remove', id)
  },
  todosRename(id: string, text: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:rename', { id, text })
  },
  /** 收起态状态栏快照：电量、充电状态 */
  statusSnapshot(): Promise<StatusSnapshot> {
    return ipcRenderer.invoke('status:snapshot')
  },
  /** 开机自启：读状态 / 开关 */
  autostartGet(): Promise<boolean> {
    return ipcRenderer.invoke('autostart:get')
  },
  autostartSet(on: boolean): Promise<boolean> {
    return ipcRenderer.invoke('autostart:set', on)
  },
  /** 置物架：列 / 加（拖入路径数组）/ 删 / 清空 / 打开 / 显示所在文件夹 */
  shelfList(): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:list')
  },
  shelfAdd(paths: string[]): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:add', paths)
  },
  shelfRemove(id: string): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:remove', id)
  },
  shelfClear(): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:clear')
  },
  /** 网格内拖动排序：传入新的 id 顺序，返回重排后的全量列表 */
  shelfReorder(ids: string[]): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:reorder', ids)
  },
  /** 取某文件名的系统图标 PNG 绝对路径（按扩展名缓存，文件夹用真实图标），失败返回 null */
  shelfIcon(name: string, path: string): Promise<string | null> {
    return ipcRenderer.invoke('shelf:icon', name, path)
  },
  shelfOpen(path: string): Promise<ShelfOpenResult> {
    return ipcRenderer.invoke('shelf:open', path)
  },
  /**
   * 在文件夹中显示。走 invoke 而不是 send：主进程注册的是 ipcMain.handle，
   * 用 send 发出去的事件没有任何监听者，按钮点了会静默无反应（既有 bug，本次一并修好）。
   */
  shelfShowInFolder(path: string): Promise<ShelfRevealResult> {
    return ipcRenderer.invoke('shelf:show-in-folder', path)
  },
  /** 拖放落盘后广播新列表（本进程内直接调用回调，无序列化歧义） */
  emitShelfAdded(list: ShelfItem[]): void {
    for (const cb of shelfAddedCbs) cb(list)
  },
  onShelfAdded(cb: (list: ShelfItem[]) => void): void {
    shelfAddedCbs.push(cb)
  },
  /**
   * 把拖入的 File 对象转成完整路径。
   * Electron 32+ 移除了 File.path 属性，官方替代就是 webUtils.getPathForFile。
   */
  filePath(file: File): string {
    return webUtils.getPathForFile(file)
  },
  /** 通知页：最近通知列表 + 未读数 */
  notifyList(): Promise<NotifyListResult> {
    return ipcRenderer.invoke('notify:list')
  },
  /** 通知页：手动刷新（切到通知页时调一次） */
  notifyRefresh(): Promise<NotifyListResult> {
    return ipcRenderer.invoke('notify:refresh')
  },
  /** 全部标记已读，返回新未读数 */
  notifyMarkRead(): Promise<number> {
    return ipcRenderer.invoke('notify:mark-read')
  },
  /** 尝试打开通知来源应用；映射不到返回 false */
  notifyOpenSource(appName: string): Promise<boolean> {
    return ipcRenderer.invoke('notify:open-source', appName)
  },
  /** 日程：列 / 增（文本 + 可选 'HH:mm' + 可选 'YYYY-MM-DD'）/ 勾选切换 / 删，全部返回最新全量列表 */
  scheduleList(): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:list')
  },
  scheduleAdd(text: string, time: string | null, day?: string | null): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:add', text, time, day ?? null)
  },
  scheduleToggle(id: string): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:toggle', id)
  },
  scheduleRemove(id: string): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:remove', id)
  }
}

/** 日程条目（与主进程 scheduleStore 保持一致） */
export interface ScheduleItem {
  id: string
  text: string
  day: string // 'YYYY-MM-DD'
  time: string | null
  done: boolean
  reminded: boolean
  createdAt: number
}

contextBridge.exposeInMainWorld('island', api)

export type IslandApi = typeof api
