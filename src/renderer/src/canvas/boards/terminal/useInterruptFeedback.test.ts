// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'
import { useInterruptFeedback } from './useInterruptFeedback'

const portWith = (postMessage: () => void): RefObject<MessagePort | null> =>
  ({ current: { postMessage } }) as unknown as RefObject<MessagePort | null>

describe('useInterruptFeedback (TERM-06)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('posts Ctrl-C (\\x03) and flags interruptSent for ~1.2s', () => {
    const postMessage = vi.fn()
    const { result } = renderHook(() => useInterruptFeedback(portWith(postMessage)))
    expect(result.current.interruptSent).toBe(false)
    act(() => result.current.interrupt())
    expect(postMessage).toHaveBeenCalledWith({ t: 'input', d: '\x03' })
    expect(result.current.interruptSent).toBe(true)
    act(() => void vi.advanceTimersByTime(1199))
    expect(result.current.interruptSent).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current.interruptSent).toBe(false)
  })

  it('a re-fire restarts the confirmation window (debounce)', () => {
    const { result } = renderHook(() => useInterruptFeedback(portWith(vi.fn())))
    act(() => result.current.interrupt())
    act(() => void vi.advanceTimersByTime(1000))
    act(() => result.current.interrupt()) // resets the 1200ms timer
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current.interruptSent).toBe(true) // still inside the new window
    act(() => void vi.advanceTimersByTime(200))
    expect(result.current.interruptSent).toBe(false)
  })

  it('does not throw when the port is null (still flags the feedback)', () => {
    const portRef = { current: null } as RefObject<MessagePort | null>
    const { result } = renderHook(() => useInterruptFeedback(portRef))
    act(() => result.current.interrupt())
    expect(result.current.interruptSent).toBe(true)
  })
})
