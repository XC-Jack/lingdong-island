import { contextBridge, ipcRenderer } from 'electron'
import type { Todo } from '../shared/types'

export type { Todo }

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
  }
}

contextBridge.exposeInMainWorld('island', api)

export type IslandApi = typeof api
