// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useLingeringPresence, LOD_FADE_MS } from './useLingeringPresence'

let reduced = false

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  // prefersReducedMotion() reads matchMedia live at the falling edge.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && reduced,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useLingeringPresence', () => {
  it('mirrors active=true immediately (rising edge is instant)', () => {
    const { result, rerender } = renderHook(({ a }) => useLingeringPresence(a), {
      initialProps: { a: false }
    })
    expect(result.current).toBe(false)
    rerender({ a: true })
    expect(result.current).toBe(true)
  })

  it('lingers for the fade duration after active falls, then releases', () => {
    const { result, rerender } = renderHook(({ a }) => useLingeringPresence(a), {
      initialProps: { a: true }
    })
    rerender({ a: false })
    expect(result.current).toBe(true) // still present — fading out
    act(() => {
      vi.advanceTimersByTime(LOD_FADE_MS - 1)
    })
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(false)
  })

  it('a rising edge during the linger cancels the pending release', () => {
    const { result, rerender } = renderHook(({ a }) => useLingeringPresence(a), {
      initialProps: { a: true }
    })
    rerender({ a: false })
    act(() => {
      vi.advanceTimersByTime(LOD_FADE_MS / 2)
    })
    rerender({ a: true }) // re-crossed the threshold mid-fade
    act(() => {
      vi.advanceTimersByTime(LOD_FADE_MS * 2)
    })
    expect(result.current).toBe(true) // stale timer must not release presence
  })

  it('collapses to an instant swap under prefers-reduced-motion', () => {
    reduced = true
    const { result, rerender } = renderHook(({ a }) => useLingeringPresence(a), {
      initialProps: { a: true }
    })
    rerender({ a: false })
    expect(result.current).toBe(false) // no linger at all
  })

  it('does not linger on initial mount with active=false', () => {
    const { result } = renderHook(() => useLingeringPresence(false))
    expect(result.current).toBe(false)
  })
})
