import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Todo, ShelfItem } from '../shared/types'

export type { Todo, ShelfItem }

/** 收起态状态栏的数据快照（与主进程 statusStore 保持一致） */
export interface StatusSnapshot {
  battery: number | null
  charging: boolean
}

const api = {
  /** 请求主进程把窗口切到展开/收起尺寸 */
  setExpanded(value: boolean): void {
    ipcRenderer.send('island:set-expanded', value)
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
  shelfOpen(path: string): Promise<string> {
    return ipcRenderer.invoke('shelf:open', path)
  },
  shelfShowInFolder(path: string): void {
    ipcRenderer.send('shelf:show-in-folder', path)
  },
  /**
   * 把拖入的 File 对象转成完整路径。
   * Electron 32+ 移除了 File.path 属性，官方替代就是 webUtils.getPathForFile。
   */
  filePath(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('island', api)

export type IslandApi = typeof api
