import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('retain untracks boards absent from the live set (disposing their watcher) and keeps the rest', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    const disposed: string[] = []
    const w = createRecapWatcher({
      debounceMs: 100,
      onIntent: (id) => fired.push(id),
      // disposer records which board's watcher was torn down (path encodes the id)
      watchFile: (p) => () => disposed.push(p)
    })
    w.track('b1', '/t/b1.jsonl')
    w.track('b2', '/t/b2.jsonl')
    w.track('b3', '/t/b3.jsonl')
    w.kick('b2') // b2 has a pending debounce that retain must cancel

    w.retain(new Set(['b1', 'b3'])) // b2 deleted from the canvas

    expect(disposed).toEqual(['/t/b2.jsonl']) // only the dropped board's watcher closed
    w.kick('b1') // a still-tracked board keeps working
    vi.advanceTimersByTime(200)
    expect(fired).toEqual(['b1']) // b2's pending intent was cancelled; b1 still fires
    vi.useRealTimers()
  })

  it('retain with an empty live set untracks everything', () => {
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
    w.retain(new Set())
    vi.advanceTimersByTime(200)
    expect(fired).toEqual([])
    vi.useRealTimers()
  })

  // Real-fs (default watchFile): the SessionStart-before-JSONL race the dir-watch fallback fixes.
  it('arms a transcript created AFTER track() (SessionStart-before-JSONL race)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recap-race-'))
    const file = join(dir, 's-1.jsonl')
    const fired: string[] = []
    const w = createRecapWatcher({ debounceMs: 50, onIntent: (id) => fired.push(id) })
    try {
      w.track('b1', file) // the .jsonl does NOT exist yet → dir-watch fallback arms
      await new Promise((r) => setTimeout(r, 150)) // let the directory watcher arm
      writeFileSync(file, '{}\n') // create it → must be detected → onIntent after the debounce
      await vi.waitFor(() => expect(fired).toContain('b1'), { timeout: 6000, interval: 50 })
    } finally {
      w.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
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
