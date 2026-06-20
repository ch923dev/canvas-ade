import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createAutosaver,
  setActiveAutosaver,
  cancelActiveAutosave,
  SAVED_KEYS,
  hasSavableChange
} from './useAutosave'
import type { CanvasState } from './canvasStore'
import { toObject } from '../lib/boardSchema'

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

  // BUG-008: a failed save must re-arm dirty, or every later flush (blur, beforeunload,
  // MAIN's project:flush quit handshake) no-ops on the `!dirty` gate and the tail edits
  // are permanently lost even after the disk recovers.
  it('BUG-008: a rejected save re-arms dirty so a later flush retries the write', async () => {
    vi.useRealTimers()
    const onError = vi.fn()
    const save = vi.fn().mockRejectedValueOnce(new Error('EBUSY')).mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', onError })
    a.schedule()
    await a.flush() // transient lock: first attempt fails
    expect(onError).toHaveBeenCalledTimes(1)
    await a.flush() // the quit-flush handshake must retry, not no-op
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('BUG-008: a save resolving false re-arms dirty so a later flush retries', async () => {
    vi.useRealTimers()
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open' })
    a.schedule()
    await a.flush()
    await a.flush()
    expect(save).toHaveBeenCalledTimes(2)
    await a.flush() // after a SUCCESSFUL save, dirty is clear → no third write
    expect(save).toHaveBeenCalledTimes(2)
  })

  // PERSIST-02: single-flight latch. A second save must not start while one is in flight,
  // or two writers race the same canvas.json.
  it('PERSIST-02: does not start a second concurrent save while one is in flight', async () => {
    vi.useRealTimers()
    let resolveFirst: (v: boolean) => void = () => {}
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (resolveFirst = r)))
      .mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    const flush1 = a.flush() // starts save #1 (in flight)
    expect(save).toHaveBeenCalledTimes(1)
    // A second flush WHILE save #1 is in flight must JOIN it, not start a 2nd write.
    const flush2 = a.flush()
    expect(save).toHaveBeenCalledTimes(1)
    resolveFirst(true)
    await Promise.all([flush1, flush2])
    expect(save).toHaveBeenCalledTimes(1) // nothing new to write → no extra save
  })

  // PERSIST-02: an edit that lands DURING an in-flight save is not lost — a single
  // trailing save drains it (so a quit/blur flush reaches a clean disk).
  it('PERSIST-02: an edit during an in-flight save is captured by one trailing save', async () => {
    vi.useRealTimers()
    let resolveFirst: (v: boolean) => void = () => {}
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (resolveFirst = r)))
      .mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    const flush1 = a.flush() // save #1 in flight
    expect(save).toHaveBeenCalledTimes(1)
    a.schedule() // edit arrives DURING save #1 → re-arms dirty
    resolveFirst(true)
    await flush1 // flush's returned promise drains the trailing edit
    expect(save).toHaveBeenCalledTimes(2) // exactly one trailing save captured the edit
  })

  // PERSIST-02: a failure during an in-flight save must NOT spin a trailing retry loop —
  // it re-arms dirty (BUG-008) and waits for the next schedule()/flush() (no hot-loop).
  it('PERSIST-02: a failing save does not hot-loop via the trailing-coalesce path', async () => {
    vi.useRealTimers()
    const onError = vi.fn()
    const save = vi.fn().mockResolvedValue(false) // disk down: every save fails
    const a = createAutosaver({ save, getStatus: () => 'open', onError })
    a.schedule()
    await a.flush()
    expect(save).toHaveBeenCalledTimes(1) // single attempt — no recursive retry storm
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('active-autosaver registry (PERSIST-B)', () => {
  afterEach(() => setActiveAutosaver(null))

  it('cancelActiveAutosave cancels the registered saver pending timer', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    setActiveAutosaver(a)
    a.schedule()
    // A project switch fires before the debounce elapses: cancel must kill the armed
    // timer so it can't fire post-load and write the new project's state redundantly.
    cancelActiveAutosave()
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('cancelActiveAutosave is a safe no-op when no saver is registered', () => {
    setActiveAutosaver(null)
    expect(() => cancelActiveAutosave()).not.toThrow()
  })

  it('only the currently-registered saver is cancelled (re-register supersedes)', () => {
    const saveA = vi.fn().mockResolvedValue(true)
    const saveB = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save: saveA, getStatus: () => 'open', delayMs: 1000 })
    const b = createAutosaver({ save: saveB, getStatus: () => 'open', delayMs: 1000 })
    setActiveAutosaver(a)
    setActiveAutosaver(b) // hook re-mount registers a new instance
    a.schedule()
    b.schedule()
    cancelActiveAutosave()
    vi.advanceTimersByTime(1000)
    expect(saveB).not.toHaveBeenCalled() // current one cancelled
    expect(saveA).toHaveBeenCalledTimes(1) // the stale instance is no longer tracked
  })
})

// The autosave dirty-trigger: a change to ANY persisted slice must arm a save, and a
// change to ONLY ephemeral state (selection/tool/hover) must not. The bug this guards:
// groups (v6) and background (v9) round-trip to canvas.json but were absent from the
// subscription's watched set, so a group rename / backdrop pick with no board or camera
// edit before the next flush was silently lost on reopen (the engine above was fine —
// the subscription wiring was the gap, and it was untested).
describe('hasSavableChange (autosave dirty-trigger)', () => {
  const base: Pick<CanvasState, (typeof SAVED_KEYS)[number]> = {
    boards: [],
    connectors: [],
    viewport: null,
    groups: [],
    background: null
  }

  it('does not arm on pure ephemeral churn (no persisted ref changed)', () => {
    expect(hasSavableChange(base, { ...base })).toBe(false)
  })

  it('arms on a boards change', () => {
    expect(hasSavableChange(base, { ...base, boards: [...base.boards] })).toBe(true)
  })

  it('arms on a connectors change (M2)', () => {
    expect(hasSavableChange(base, { ...base, connectors: [...base.connectors] })).toBe(true)
  })

  it('arms on a viewport change', () => {
    expect(hasSavableChange(base, { ...base, viewport: { x: 1, y: 2, zoom: 1 } })).toBe(true)
  })

  it('arms on a groups-only change (v6) — regression for the silent-loss bug', () => {
    expect(hasSavableChange(base, { ...base, groups: [...base.groups] })).toBe(true)
  })

  it('arms on a background-only change (v9) — regression for the silent-loss bug', () => {
    expect(
      hasSavableChange(base, {
        ...base,
        background: { kind: 'none', dim: 0.25, saturation: 0.7, gridDots: false }
      })
    ).toBe(true)
  })

  // Drift guard: the watched set MUST equal every persisted content key toObject()
  // writes (minus the version stamps). If a future schema adds a doc-level field to
  // toObject without adding it here, this fails — closing the class of bug for good.
  it('SAVED_KEYS mirrors every persisted field toObject() serializes (drift guard)', () => {
    const doc = toObject([], { x: 0, y: 0, zoom: 1 }, [], [], {
      kind: 'none',
      dim: 0.25,
      saturation: 0.7,
      gridDots: false
    })
    const VERSION_KEYS = new Set(['schemaVersion', 'minReaderVersion'])
    const persisted = Object.keys(doc)
      .filter((k) => !VERSION_KEYS.has(k))
      .sort()
    expect([...SAVED_KEYS].sort()).toEqual(persisted)
  })
})
