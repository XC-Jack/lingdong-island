/** 单条待办（主进程与渲染进程共用） */
export interface Todo {
  id: string
  text: string
  done: boolean
  /** 创建时间戳（毫秒） */
  createdAt: number
}
