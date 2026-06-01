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

  it('flush() resolves only after the underlying save settles (BUG-M2 handshake)', async () => {
    vi.useRealTimers() // exercise the real async settle
    let resolveSave: (v: boolean) => void = () => {}
    const save = vi.fn(() => new Promise<boolean>((r) => (resolveSave = r)))
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    let settled = false
    const p = a.flush().then(() => {
      settled = true
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false) // save still in flight → handshake not yet complete
    resolveSave(true)
    await p
    expect(settled).toBe(true) // main can now safely app.exit
  })

  it('flush() resolves immediately (no save) when status is not "open"', async () => {
    vi.useRealTimers()
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'loading', delayMs: 1000 })
    a.schedule()
    await a.flush() // must not hang when there is nothing to save
    expect(save).not.toHaveBeenCalled()
  })

  it('surfaces a rejected save via onError instead of floating it silently (SAVE-1)', async () => {
    vi.useRealTimers()
    const onError = vi.fn()
    const save = vi.fn().mockRejectedValue(new Error('ENOSPC'))
    const a = createAutosaver({ save, getStatus: () => 'open', onError })
    a.schedule()
    await a.flush() // must not throw / leave an unhandled rejection
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('surfaces a save that resolves false via onError (SAVE-1)', async () => {
    vi.useRealTimers()
    const onError = vi.fn()
    const save = vi.fn().mockResolvedValue(false)
    const a = createAutosaver({ save, getStatus: () => 'open', onError })
    a.schedule()
    await a.flush()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
