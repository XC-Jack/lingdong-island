import type { IslandApi } from './index'

declare global {
  interface Window {
    island: IslandApi
  }
}
