// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRunTimer } from './useRunTimer'

describe('useRunTimer (TERM-01)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is undefined when not running', () => {
    const { result } = renderHook(({ running }) => useRunTimer(running), {
      initialProps: { running: false }
    })
    expect(result.current).toBeUndefined()
  })

  it('starts at 00:00 and ticks once a second while running', () => {
    const { result } = renderHook(({ running }) => useRunTimer(running), {
      initialProps: { running: true }
    })
    expect(result.current).toBe('00:00')
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe('00:01')
    act(() => void vi.advanceTimersByTime(60_000))
    expect(result.current).toBe('01:01')
  })

  it('clears when running stops, then restarts from 00:00', () => {
    const { result, rerender } = renderHook(({ running }) => useRunTimer(running), {
      initialProps: { running: true }
    })
    act(() => void vi.advanceTimersByTime(5000))
    expect(result.current).toBe('00:05')
    rerender({ running: false })
    expect(result.current).toBeUndefined()
    rerender({ running: true })
    expect(result.current).toBe('00:00') // cleanup reset → fresh start, no stale flash
  })
})
