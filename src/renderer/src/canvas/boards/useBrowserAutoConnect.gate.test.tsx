// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Board } from '../../lib/boardSchema'

/**
 * Audit R13 (P-7): the auto-connect interval must exist ONLY while a Browser board
 * does — with zero Browser boards an idle app pays zero ticks (the old shape ticked
 * 1/s forever, iterating all boards). Asserted BEHAVIORALLY: every tick reads
 * `useCanvasStore.getState()`, so a getState spy counts ticks across fake-timer
 * advances (timer-identity spies proved unreliable under the sinon fake-timer layer).
 *
 * Both stores are mocked down to bare zustand stores: their real module graphs carry
 * side-effect subscribers whose own timers/reads would pollute the counts.
 */
vi.mock('../../store/canvasStore', async () => {
  const { create } = await import('zustand')
  return {
    useCanvasStore: create(() => ({ boards: [] as Board[] })),
    patchBoardUntracked: vi.fn()
  }
})
vi.mock('../../store/previewStore', async () => {
  const { create } = await import('zustand')
  return { usePreviewStore: create(() => ({ byId: {} })) }
})

import { useCanvasStore } from '../../store/canvasStore'
import { useBrowserAutoConnect } from './useBrowserAutoConnect'

const browserBoard = (id: string): Board =>
  ({ id, type: 'browser', x: 0, y: 0, w: 400, h: 300, url: 'http://localhost:5173' }) as Board
const planningBoard = (id: string): Board =>
  ({ id, type: 'planning', x: 0, y: 0, w: 400, h: 300, elements: [] }) as unknown as Board

/** Ticks observed while advancing fake time — the tick body always reads getState(). */
function ticksDuring(advanceMs: number): number {
  const spy = vi.spyOn(useCanvasStore, 'getState')
  spy.mockClear()
  act(() => void vi.advanceTimersByTime(advanceMs))
  const n = spy.mock.calls.length
  spy.mockRestore()
  return n
}

describe('useBrowserAutoConnect gating (R13)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCanvasStore.setState({ boards: [] })
    // The tick body may act on its plan (reload/detect) — give it an inert bridge so a
    // callback never throws out of the fake-timer run.
    ;(window as unknown as { api: unknown }).api = {
      reloadOsrPreview: vi.fn(async () => undefined),
      detectPorts: vi.fn(async () => [])
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    useCanvasStore.setState({ boards: [] })
  })

  it('never ticks with zero Browser boards (planning boards do not count)', () => {
    useCanvasStore.setState({ boards: [planningBoard('p1')] })
    const { unmount } = renderHook(() => useBrowserAutoConnect())
    expect(ticksDuring(5_000)).toBe(0)
    unmount()
  })

  it('ticks while a Browser board exists and stops when the last one goes', () => {
    const { unmount } = renderHook(() => useBrowserAutoConnect())
    expect(ticksDuring(3_000)).toBe(0)

    act(() => useCanvasStore.setState({ boards: [browserBoard('b1'), planningBoard('p1')] }))
    expect(ticksDuring(3_000)).toBeGreaterThanOrEqual(2)

    act(() => useCanvasStore.setState({ boards: [planningBoard('p1')] }))
    expect(ticksDuring(5_000)).toBe(0)

    unmount()
  })

  it('stops ticking on unmount', () => {
    useCanvasStore.setState({ boards: [browserBoard('b1')] })
    const { unmount } = renderHook(() => useBrowserAutoConnect())
    expect(ticksDuring(3_000)).toBeGreaterThanOrEqual(2)
    unmount()
    expect(ticksDuring(5_000)).toBe(0)
  })
})
