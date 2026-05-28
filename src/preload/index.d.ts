import type { CanvasApi } from './index'

declare global {
  interface Window {
    api: CanvasApi
  }
}

export {}
