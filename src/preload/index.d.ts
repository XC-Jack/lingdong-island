import type { IslandApi, Todo, ShelfItem } from './index'

declare global {
  interface Window {
    island: IslandApi
  }
}

export type { Todo, ShelfItem }
