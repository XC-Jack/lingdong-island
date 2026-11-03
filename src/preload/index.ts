import { contextBridge, ipcRenderer } from 'electron'
import type { Todo } from '../shared/types'

export type { Todo }

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
  }
}

contextBridge.exposeInMainWorld('island', api)

export type IslandApi = typeof api
