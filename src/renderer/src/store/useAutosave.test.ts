import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosaver } from './useAutosave'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createAutosaver', () => {
  it('debounces bursts into a single save', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    a.schedule()
    a.schedule()
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not save while status !== "open"', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'loading', delayMs: 1000 })
    a.schedule()
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('flush() saves immediately and cancels the pending timer', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    a.flush()
    expect(save).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1) // timer was cancelled, no double save
  })

  it('flush() is a no-op when nothing is scheduled', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.flush()
    expect(save).not.toHaveBeenCalled()
  })
})
