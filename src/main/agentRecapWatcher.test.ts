import { describe, it, expect, vi } from 'vitest'
import { createRecapWatcher } from './agentRecapWatcher'

describe('createRecapWatcher', () => {
  it('debounces and fires onIntent per board on change', async () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: (id) => fired.push(id),
      watchFile: () => () => {}
    })
    w.track('b1', '/t/s1.jsonl')
    w.kick('b1') // simulate an mtime change
    w.kick('b1')
    vi.advanceTimersByTime(150)
    expect(fired).toEqual(['b1'])
    vi.useRealTimers()
  })

  it('coalesces multiple kicks to a single onIntent call', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: (id) => fired.push(id),
      watchFile: () => () => {}
    })
    w.track('b1', '/t/s1.jsonl')
    w.kick('b1')
    w.kick('b1')
    w.kick('b1')
    vi.advanceTimersByTime(200)
    expect(fired).toEqual(['b1'])
    vi.useRealTimers()
  })

  it('fires independently for multiple boards', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: (id) => fired.push(id),
      watchFile: () => () => {}
    })
    w.track('b1', '/t/s1.jsonl')
    w.track('b2', '/t/s2.jsonl')
    w.kick('b1')
    w.kick('b2')
    vi.advanceTimersByTime(200)
    expect(fired.sort()).toEqual(['b1', 'b2'])
    vi.useRealTimers()
  })

  it('re-arm via track disposes the prior watcher for the same board', () => {
    vi.useFakeTimers()
    let disposeCount = 0
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: () => {},
      watchFile: () => () => {
        disposeCount++
      }
    })
    w.track('b1', '/t/s1.jsonl')
    w.track('b1', '/t/s1-new.jsonl') // re-arm: should dispose prior
    expect(disposeCount).toBe(1)
    vi.useRealTimers()
  })

  it('untrack stops firing and clears the timer', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: (id) => fired.push(id),
      watchFile: () => () => {}
    })
    w.track('b1', '/t/s1.jsonl')
    w.kick('b1')
    w.untrack('b1')
    vi.advanceTimersByTime(200)
    expect(fired).toEqual([])
    vi.useRealTimers()
  })

  it('dispose clears all timers and watchers', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: (id) => fired.push(id),
      watchFile: () => () => {}
    })
    w.track('b1', '/t/s1.jsonl')
    w.track('b2', '/t/s2.jsonl')
    w.kick('b1')
    w.kick('b2')
    w.dispose()
    vi.advanceTimersByTime(200)
    expect(fired).toEqual([])
    vi.useRealTimers()
  })
})
