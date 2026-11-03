import type { IslandApi, Todo, ShelfItem, NotifyItem, NotifyListResult, ScheduleItem } from './index'

declare global {
  interface Window {
    island: IslandApi
  }
}

export type { Todo, ShelfItem, NotifyItem, NotifyListResult, ScheduleItem }
