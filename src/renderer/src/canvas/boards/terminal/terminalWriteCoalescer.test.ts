// src/renderer/src/canvas/boards/terminal/terminalWriteCoalescer.test.ts
//
// Unit coverage for the Lane-A write coalescer (terminal-crisp umbrella): batch per-chunk
// writes into one flush, HOLD the buffer while hidden, flush losslessly on becoming visible,
// and bound the held buffer to a scrollback-derived cap. The scheduler is a manual queue (no
// rAF) so flush timing is deterministic; the visibility source + cap are plain closures.
import { describe, it, expect } from 'vitest'
import { createTerminalWriteCoalescer } from './terminalWriteCoalescer'

/** A test harness: a manual frame scheduler + a writes log + a togglable live flag. */
function harness(opts?: { live?: boolean; cap?: number }) {
  const writes: string[] = []
  let live = opts?.live ?? true
  let cap = opts?.cap ?? 1_000_000
  // Manual scheduler: schedule() queues the flush; runFrame() fires the pending one (like rAF).
  const pending: Array<() => void> = []
  let nextHandle = 1
  const handles = new Map<number, () => void>()
  const c = createTerminalWriteCoalescer({
    write: (chunk) => writes.push(chunk),
    isLive: () => live,
    schedule: (flush) => {
      const h = nextHandle++
      handles.set(h, flush)
      pending.push(flush)
      return h
    },
    cancel: (h) => {
      const fn = handles.get(h)
      handles.delete(h)
      if (fn) {
        const i = pending.indexOf(fn)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    holdCap: () => cap
  })
  return {
    c,
    writes,
    /** Fire all currently-scheduled flushes (one rAF turn). */
    runFrame: () => {
      const due = pending.splice(0)
      for (const fn of due) fn()
    },
    setLive: (v: boolean) => {
      live = v
    },
    setCap: (v: number) => {
      cap = v
    }
  }
}

describe('createTerminalWriteCoalescer — batching (live)', () => {
  it('coalesces a burst of chunks into ONE write per frame, in order', () => {
    const h = harness()
    h.c.enqueue('a')
    h.c.enqueue('b')
    h.c.enqueue('c')
    expect(h.writes, 'nothing written until the frame runs').toEqual([])
    h.runFrame()
    expect(h.writes, 'one coalesced write of the joined burst').toEqual(['abc'])
  })

  it('schedules at most one flush per frame regardless of enqueue count', () => {
    const h = harness()
    for (let i = 0; i < 50; i++) h.c.enqueue(String(i))
    h.runFrame()
    expect(h.writes.length).toBe(1)
    expect(h.writes[0]).toBe(Array.from({ length: 50 }, (_v, i) => String(i)).join(''))
  })

  it('a fresh enqueue after a flush schedules the next frame (no stuck buffer)', () => {
    const h = harness()
    h.c.enqueue('x')
    h.runFrame()
    h.c.enqueue('y')
    h.runFrame()
    expect(h.writes).toEqual(['x', 'y'])
    expect(h.c.held()).toBe(0)
  })

  it('ignores empty chunks (no wasted frame)', () => {
    const h = harness()
    h.c.enqueue('')
    expect(h.c.held()).toBe(0)
    h.runFrame()
    expect(h.writes).toEqual([])
  })
})

describe('createTerminalWriteCoalescer — hold while hidden + lossless catch-up', () => {
  it('HOLDS writes while hidden (PTY keeps producing; nothing rendered)', () => {
    const h = harness({ live: false })
    h.c.enqueue('one')
    h.c.enqueue('two')
    h.runFrame() // even if a frame fires, hidden ⇒ no write
    expect(h.writes, 'hidden terminal renders nothing').toEqual([])
    expect(h.c.held(), 'bytes are held, not lost').toBe(6)
  })

  it('flushes the held buffer losslessly + in order when revealed', () => {
    const h = harness({ live: false })
    h.c.enqueue('alpha')
    h.c.enqueue('beta')
    expect(h.c.held()).toBe(9)
    h.setLive(true)
    h.c.onVisible() // the reveal trigger
    h.runFrame()
    expect(h.writes, 'catches up to the full held stream in one coalesced write').toEqual([
      'alphabeta'
    ])
    expect(h.c.held()).toBe(0)
  })

  it('a flush that fires AFTER going hidden writes nothing and retains the buffer', () => {
    // Race: enqueue while live (schedules a frame), then go hidden before the frame fires.
    const h = harness({ live: true })
    h.c.enqueue('data')
    h.setLive(false)
    h.runFrame() // the already-scheduled flush runs but sees !isLive
    expect(h.writes).toEqual([])
    expect(h.c.held(), 'no data dropped by the racing flush').toBe(4)
    // Reveal → catches up.
    h.setLive(true)
    h.c.onVisible()
    h.runFrame()
    expect(h.writes).toEqual(['data'])
  })

  it('onVisible is a no-op when nothing is held', () => {
    const h = harness({ live: true })
    h.c.onVisible()
    h.runFrame()
    expect(h.writes).toEqual([])
  })
})

describe('createTerminalWriteCoalescer — scrollback-bounded hold (firehose cap)', () => {
  it('drops the OLDEST whole chunks past the cap while hidden (keeps the recent tail)', () => {
    const h = harness({ live: false, cap: 10 })
    h.c.enqueue('AAAAA') // 5
    h.c.enqueue('BBBBB') // 10  (== cap, retained)
    h.c.enqueue('CCCCC') // 15  → over cap → drop oldest 'AAAAA'
    expect(h.c.held(), 'trimmed back under the cap by dropping the oldest chunk').toBe(10)
    h.setLive(true)
    h.c.onVisible()
    h.runFrame()
    expect(h.writes, 'only the most-recent tail survives the firehose cap').toEqual(['BBBBBCCCCC'])
  })

  it('always keeps at least the latest chunk even when it alone exceeds the cap', () => {
    const h = harness({ live: false, cap: 4 })
    h.c.enqueue('this-one-chunk-is-bigger-than-the-cap')
    expect(h.c.held(), 'a single jumbo chunk is never dropped to zero').toBeGreaterThan(0)
    h.setLive(true)
    h.c.onVisible()
    h.runFrame()
    expect(h.writes).toEqual(['this-one-chunk-is-bigger-than-the-cap'])
  })

  it('bounds a live-but-rAF-stalled buffer (minimised window) too', () => {
    // Live, but the frame never runs (rAF stalled) — enqueue must still bound via the cap.
    const h = harness({ live: true, cap: 6 })
    h.c.enqueue('111') // 3
    h.c.enqueue('222') // 6
    h.c.enqueue('333') // 9 → trim oldest → 6
    expect(h.c.held()).toBe(6)
    h.runFrame()
    expect(h.writes).toEqual(['222333'])
  })
})

describe('createTerminalWriteCoalescer — clear (restart / teardown)', () => {
  it('clear() drops the held buffer + cancels the pending flush', () => {
    const h = harness({ live: true })
    h.c.enqueue('stale')
    h.c.clear()
    expect(h.c.held()).toBe(0)
    h.runFrame() // the cancelled flush must not fire
    expect(h.writes).toEqual([])
  })

  it('a cleared coalescer is still usable (re-arms on the next enqueue)', () => {
    const h = harness({ live: true })
    h.c.enqueue('old')
    h.c.clear()
    h.c.enqueue('new')
    h.runFrame()
    expect(h.writes).toEqual(['new'])
  })
})

describe('createTerminalWriteCoalescer - flushNow (find-count fix)', () => {
  it('writes pending chunks synchronously when live and cancels the scheduled frame', () => {
    const h = harness()
    h.c.enqueue('a')
    h.c.enqueue('b')
    expect(h.writes).toEqual([]) // still queued for the next frame
    expect(h.c.flushNow()).toBe(true)
    expect(h.writes).toEqual(['ab']) // one synchronous coalesced write
    h.runFrame() // the cancelled frame must not double-write
    expect(h.writes).toEqual(['ab'])
    expect(h.c.held()).toBe(0)
  })

  it('refuses while hidden (never interleaves into a gated buffer) and keeps the hold', () => {
    const h = harness({ live: false })
    h.c.enqueue('held')
    expect(h.c.flushNow()).toBe(false)
    expect(h.writes).toEqual([])
    expect(h.c.held()).toBe('held'.length)
    // the normal reveal catch-up still flushes the untouched buffer
    h.setLive(true)
    h.c.onVisible()
    h.runFrame()
    expect(h.writes).toEqual(['held'])
  })

  it('is a no-op on an empty buffer', () => {
    const h = harness()
    expect(h.c.flushNow()).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('a fresh enqueue after flushNow re-arms the frame flush (no stuck buffer)', () => {
    const h = harness()
    h.c.enqueue('x')
    h.c.flushNow()
    h.c.enqueue('y')
    h.runFrame()
    expect(h.writes).toEqual(['x', 'y'])
  })
})
