// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLIP_HALF_MS, useTerminalFlip } from './useTerminalFlip'

/**
 * The flip controller is the double-click/⟳ flip's brain: a two-phase 3D fold that
 * SETTLES FLAT (transform:none at rest) so it never resurrects the preserve-3d
 * pointer-hit-test bug that made the recap's refresh button unclickable. These tests
 * pin the observable contract — face-swap timing, flat-at-rest geometry, the
 * re-entrancy guard, and the reduced-motion instant path.
 */

/** Stub matchMedia so prefersReducedMotion() is controllable (jsdom omits matchMedia). */
function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }))
}

describe('useTerminalFlip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setReducedMotion(false)
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts unflipped, idle, and flat (no transform at rest)', () => {
    const { result } = renderHook(() => useTerminalFlip())
    expect(result.current.flipped).toBe(false)
    expect(result.current.phase).toBe('idle')
    // Flat at rest: no transform, no perspective → correct pointer hit-testing.
    expect(result.current.stageStyle.transform).toBeUndefined()
    expect(result.current.perspectiveStyle.perspective).toBeUndefined()
  })

  it('animated flip swaps the face at the 90° edge and settles flat & idle', () => {
    const { result } = renderHook(() => useTerminalFlip())

    act(() => result.current.toggle())
    // Phase OUT immediately; face has NOT swapped yet (old face folds away first).
    expect(result.current.phase).toBe('out')
    expect(result.current.flipped).toBe(false)
    // While animating, the stage carries a 3D rotation + perspective.
    expect(result.current.stageStyle.transform).toContain('rotateY')
    expect(result.current.perspectiveStyle.perspective).toBe('1200px')

    // At the 90° edge (invisible): face swaps, second half begins.
    act(() => vi.advanceTimersByTime(FLIP_HALF_MS))
    expect(result.current.flipped).toBe(true)

    // After the full fold completes: back to idle and flat — clicks work again.
    act(() => vi.advanceTimersByTime(FLIP_HALF_MS + 50))
    expect(result.current.phase).toBe('idle')
    expect(result.current.flipped).toBe(true)
    expect(result.current.stageStyle.transform).toBeUndefined()
    expect(result.current.perspectiveStyle.perspective).toBeUndefined()
  })

  it('ignores a toggle while a flip is mid-flight (no desync)', () => {
    const { result } = renderHook(() => useTerminalFlip())

    act(() => result.current.toggle()) // → out
    expect(result.current.phase).toBe('out')
    // Second toggle mid-flight is a no-op: it must NOT cancel a swap or double-flip.
    act(() => result.current.toggle())
    expect(result.current.phase).toBe('out')

    act(() => vi.advanceTimersByTime(FLIP_HALF_MS * 2 + 50))
    // Exactly ONE flip happened.
    expect(result.current.flipped).toBe(true)
    expect(result.current.phase).toBe('idle')
  })

  it('reduced motion flips instantly with no animation phase', () => {
    setReducedMotion(true)
    const { result } = renderHook(() => useTerminalFlip())

    act(() => result.current.toggle())
    // Instant: flipped now, never leaves idle, never gains a transform.
    expect(result.current.flipped).toBe(true)
    expect(result.current.phase).toBe('idle')
    expect(result.current.stageStyle.transform).toBeUndefined()
  })

  it('honors an initial flipped value', () => {
    const { result } = renderHook(() => useTerminalFlip(true))
    expect(result.current.flipped).toBe(true)
  })
})
