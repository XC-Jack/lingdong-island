import type { IslandApi, Todo } from './index'

declare global {
  interface Window {
    island: IslandApi
  }
}

export type { Todo }
