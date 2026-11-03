import { contextBridge, ipcRenderer } from 'electron'

const api = {
  /** 请求主进程把窗口切到展开/收起尺寸 */
  setExpanded(value: boolean): void {
    ipcRenderer.send('island:set-expanded', value)
  }
}

contextBridge.exposeInMainWorld('island', api)

export type IslandApi = typeof api
