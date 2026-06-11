// @vitest-environment jsdom
/**
 * useZoomSettle — settle-debounce + snap + publish contract (terminal raster fix).
 * React Flow is mocked (the hook only needs setViewport + the pane size); the camera
 * is driven through the REAL canvasStore viewport mirror, exactly as Canvas feeds it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useZoomSettle, SETTLE_MS } from './useZoomSettle'
import { useCanvasStore } from '../../store/canvasStore'
import { useSettledZoomStore } from '../../store/settledZoomStore'

const setViewportMock = vi.fn()
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ setViewport: setViewportMock }),
  useStoreApi: () => ({ getState: () => ({ width: 1000, height: 800 }) })
}))

const driveCamera = (x: number, y: number, zoom: number): void => {
  act(() => {
    useCanvasStore.getState().setViewport({ x, y, zoom })
  })
}

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  setViewportMock.mockClear()
  useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 1 })
  useSettledZoomStore.setState({ zoom: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useZoomSettle', () => {
  it('publishes the settled zoom after the debounce; no snap outside the band', () => {
    const { unmount } = renderHook(() => useZoomSettle())
    driveCamera(10, 20, 1.3)
    expect(useSettledZoomStore.getState().zoom).toBe(1) // not yet settled
    tick(SETTLE_MS)
    expect(useSettledZoomStore.getState().zoom).toBe(1.3)
    expect(setViewportMock).not.toHaveBeenCalled() // 1.3 is outside the snap band
    unmount()
  })

  it('coalesces a camera burst: nothing publishes until the camera is still', () => {
    const { unmount } = renderHook(() => useZoomSettle())
    driveCamera(0, 0, 1.5)
    tick(SETTLE_MS - 50)
    driveCamera(0, 0, 1.8) // burst continues — debounce restarts
    tick(SETTLE_MS - 50)
    expect(useSettledZoomStore.getState().zoom).toBe(1) // still no settle
    tick(50)
    expect(useSettledZoomStore.getState().zoom).toBe(1.8)
    unmount()
  })

  it('snaps a settled zoom inside the band to exactly 1, anchored at the pane center', () => {
    const { unmount } = renderHook(() => useZoomSettle())
    driveCamera(100, 50, 0.97)
    tick(SETTLE_MS)
    // Anchor math: keep the world point at the pane center (500, 400) fixed.
    expect(setViewportMock).toHaveBeenCalledTimes(1)
    const [vp, opts] = setViewportMock.mock.calls[0]
    expect(vp.zoom).toBe(1)
    expect(vp.x).toBeCloseTo(500 - ((500 - 100) * 1) / 0.97, 8)
    expect(vp.y).toBeCloseTo(400 - ((400 - 50) * 1) / 0.97, 8)
    expect(opts).toEqual({ duration: 0 })
    // The snap itself does NOT publish — the camera change it causes re-enters the
    // debounce and the NEXT settle publishes the crisp zoom.
    expect(useSettledZoomStore.getState().zoom).toBe(1)
    driveCamera(vp.x, vp.y, 1) // the mirror applying the snapped viewport
    tick(SETTLE_MS)
    expect(useSettledZoomStore.getState().zoom).toBe(1)
    expect(setViewportMock).toHaveBeenCalledTimes(1) // settled AT 1 → no re-snap loop
    unmount()
  })

  it('routes the initial (project-restored) viewport through the same settle path', () => {
    useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 0.7 })
    const { unmount } = renderHook(() => useZoomSettle())
    tick(SETTLE_MS)
    expect(useSettledZoomStore.getState().zoom).toBe(0.7) // published without any gesture
    unmount()
  })

  it('stops the timer on unmount (no publish after teardown)', () => {
    const { unmount } = renderHook(() => useZoomSettle())
    driveCamera(0, 0, 1.4)
    unmount()
    tick(SETTLE_MS * 2)
    expect(useSettledZoomStore.getState().zoom).toBe(1) // never published
  })
})
