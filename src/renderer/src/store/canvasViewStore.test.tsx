// @vitest-environment jsdom
/**
 * canvasViewStore + useCanvasViewTracker — the session-only view bus (spatial awareness S0/C1).
 * The pane is a real element (clientWidth/Height stubbed — jsdom has no layout) observed through a
 * stub ResizeObserver; the camera is driven through the REAL canvasStore viewport mirror, exactly as
 * Canvas feeds it every camera frame.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCanvasViewStore, useCanvasViewTracker, VIEW_SETTLE_MS } from './canvasViewStore'
import { useCanvasStore } from './canvasStore'

let roCallback: (() => void) | null = null
class StubResizeObserver {
  constructor(cb: () => void) {
    roCallback = cb
  }
  observe(): void {}
  disconnect(): void {
    roCallback = null
  }
}

function pane(w: number, h: number): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => w })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => h })
  return el
}

const resizeTo = (el: HTMLDivElement, w: number, h: number): void => {
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => w })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => h })
  act(() => roCallback?.())
}

const driveCamera = (x: number, y: number, zoom: number): void => {
  act(() => useCanvasStore.getState().setViewport({ x, y, zoom }))
}

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 1 })
  useCanvasViewStore.setState({ pane: null, camera: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useCanvasViewTracker', () => {
  it('measures the pane + takes the current camera on mount; clears both on unmount', () => {
    const el = pane(1600, 900)
    const { unmount } = renderHook(() => useCanvasViewTracker({ current: el }))
    expect(useCanvasViewStore.getState().pane).toEqual({ w: 1600, h: 900 })
    expect(useCanvasViewStore.getState().camera).toEqual({ x: 0, y: 0, zoom: 1 })
    unmount()
    expect(useCanvasViewStore.getState().pane).toBeNull()
    expect(useCanvasViewStore.getState().camera).toBeNull()
  })

  it('re-measures the pane on every ResizeObserver tick', () => {
    const el = pane(1600, 900)
    const { unmount } = renderHook(() => useCanvasViewTracker({ current: el }))
    resizeTo(el, 800, 1000)
    expect(useCanvasViewStore.getState().pane).toEqual({ w: 800, h: 1000 })
    unmount()
  })

  it('copies the camera only once it SETTLES — a per-frame burst updates nothing', () => {
    const { unmount } = renderHook(() => useCanvasViewTracker({ current: pane(1600, 900) }))
    const writes: unknown[] = []
    const unsub = useCanvasViewStore.subscribe((s, prev) => {
      if (s.camera !== prev.camera) writes.push(s.camera)
    })
    driveCamera(-10, 0, 1)
    tick(VIEW_SETTLE_MS - 50)
    driveCamera(-20, 0, 0.9) // still moving — the settle restarts
    tick(VIEW_SETTLE_MS - 50)
    driveCamera(-30, 5, 0.8)
    expect(writes).toEqual([])
    tick(VIEW_SETTLE_MS)
    expect(writes).toEqual([{ x: -30, y: 5, zoom: 0.8 }])
    unsub()
    unmount()
  })

  it('no pane element ⇒ no-op (nothing measured, nothing cleared)', () => {
    useCanvasViewStore.setState({ pane: { w: 1, h: 1 } })
    const { unmount } = renderHook(() => useCanvasViewTracker({ current: null }))
    expect(useCanvasViewStore.getState().pane).toEqual({ w: 1, h: 1 })
    unmount()
  })
})
