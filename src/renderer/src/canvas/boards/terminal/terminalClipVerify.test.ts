// Unit tests for the deferred clip-verify watch window (terminal-clip fix). A fake rAF queue
// drives the chain deterministically — each flush() is "one frame" — so the load-bearing
// semantics (no early-exit on clean, coalescing, guards) are pinned without xterm or a DOM.
import { describe, it, expect } from 'vitest'
import { startClipVerify, CLIP_VERIFY_FRAMES } from './terminalClipVerify'
import type { ClipVerifyDeps, ClipVerifyMeasure, ClipVerifySlot } from './terminalClipVerify'

/** Fake rAF + timer: callbacks queue per frame; flush() runs exactly one frame's worth; fireLate()
 *  runs any scheduled late tail tick. */
function fakeRaf(): {
  raf: (cb: () => void) => number
  caf: (h: number) => void
  setTimer: (cb: () => void, ms: number) => number
  clearTimer: (h: number) => void
  flush: () => void
  fireLate: () => void
  pending: () => number
  latePending: () => number
} {
  let nextId = 1
  const queue = new Map<number, () => void>()
  const timers = new Map<number, () => void>()
  return {
    raf: (cb) => {
      const id = nextId++
      queue.set(id, cb)
      return id
    },
    caf: (h) => {
      queue.delete(h)
    },
    setTimer: (cb) => {
      const id = nextId++
      timers.set(id, cb)
      return id
    },
    clearTimer: (h) => {
      timers.delete(h)
    },
    flush: () => {
      const batch = [...queue.values()]
      queue.clear()
      for (const cb of batch) cb()
    },
    fireLate: () => {
      const batch = [...timers.values()]
      timers.clear()
      for (const cb of batch) cb()
    },
    pending: () => queue.size,
    latePending: () => timers.size
  }
}

function makeDeps(
  raf: ReturnType<typeof fakeRaf>,
  overrides: Partial<ClipVerifyDeps> = {}
): ClipVerifyDeps & { resizes: Array<{ cols: number; rows: number }> } {
  const resizes: Array<{ cols: number; rows: number }> = []
  return {
    resizes,
    stillCurrent: () => true,
    backstopInFlight: () => false,
    measure: () => ({ rows: 10, cols: 80, overflow: -16, cellH: 18 }),
    resize: (cols, rows) => resizes.push({ cols, rows }),
    raf: raf.raf,
    caf: raf.caf,
    setTimer: raf.setTimer,
    clearTimer: raf.clearTimer,
    ...overrides
  }
}

describe('startClipVerify — deferred clip-verify watch window (terminal-clip fix, pure)', () => {
  it('sheds when the overflow materializes MID-window (the stale-rect defect this fixes)', () => {
    const raf = fakeRaf()
    // Frames 1-2 read the stale (clean) rect; frame 3 finally shows the reflowed +2px spill —
    // the measured dataFlow-adjacency sequence.
    const frames: Array<ClipVerifyMeasure> = [
      { rows: 10, cols: 80, overflow: -16, cellH: 16.2 }, // stale: pre-fit grid, reads clean
      { rows: 10, cols: 80, overflow: -16, cellH: 16.2 }, // still stale
      { rows: 10, cols: 80, overflow: 2, cellH: 18 } // reflow landed: real spill
    ]
    let i = 0
    const d = makeDeps(raf, {
      measure: () => frames[Math.min(i++, frames.length - 1)]
    })
    startClipVerify({ handle: 0, late: 0 }, CLIP_VERIFY_FRAMES, d)
    raf.flush() // frame 1 — clean read, must NOT end the chain
    raf.flush() // frame 2 — clean read, must NOT end the chain
    expect(d.resizes).toEqual([])
    raf.flush() // frame 3 — spill visible now
    expect(d.resizes).toEqual([{ cols: 80, rows: 9 }])
  })

  it('does not early-exit on clean reads: the chain runs the FULL frame budget', () => {
    const raf = fakeRaf()
    let samples = 0
    const d = makeDeps(raf, {
      measure: () => {
        samples++
        return { rows: 10, cols: 80, overflow: -16, cellH: 18 }
      }
    })
    startClipVerify({ handle: 0, late: 0 }, CLIP_VERIFY_FRAMES, d)
    for (let f = 0; f < CLIP_VERIFY_FRAMES + 2; f++) raf.flush()
    expect(samples).toBe(CLIP_VERIFY_FRAMES) // every budgeted frame measured, then it stopped
    expect(raf.pending()).toBe(0)
    expect(d.resizes).toEqual([])
  })

  it('a newer chain cancels the pending one (coalescing through the shared slot)', () => {
    const raf = fakeRaf()
    const slot: ClipVerifySlot = { handle: 0, late: 0 }
    let firstSamples = 0
    const first = makeDeps(raf, {
      measure: () => {
        firstSamples++
        return { rows: 10, cols: 80, overflow: -16, cellH: 18 }
      }
    })
    startClipVerify(slot, CLIP_VERIFY_FRAMES, first)
    const second = makeDeps(raf)
    startClipVerify(slot, CLIP_VERIFY_FRAMES, second) // cancels first's pending rAF
    for (let f = 0; f < CLIP_VERIFY_FRAMES; f++) raf.flush()
    expect(firstSamples).toBe(0) // the first chain never got a frame
    expect(raf.pending()).toBe(0)
  })

  it('ends silently once the term is disposed/replaced (stillCurrent false)', () => {
    const raf = fakeRaf()
    let current = true
    let samples = 0
    const d = makeDeps(raf, {
      stillCurrent: () => current,
      measure: () => {
        samples++
        return { rows: 10, cols: 80, overflow: 5, cellH: 18 }
      }
    })
    startClipVerify({ handle: 0, late: 0 }, CLIP_VERIFY_FRAMES, d)
    raf.flush()
    expect(samples).toBe(1)
    current = false // respawn replaced the term mid-window
    raf.flush()
    expect(samples).toBe(1) // no further measurement
    expect(raf.pending()).toBe(0) // chain ended, nothing dangling
  })

  it('skips the frame while a backstop is mid-parse but keeps the chain ticking', () => {
    const raf = fakeRaf()
    let inFlight = true
    let samples = 0
    const d = makeDeps(raf, {
      backstopInFlight: () => inFlight,
      measure: () => {
        samples++
        return { rows: 10, cols: 80, overflow: 2, cellH: 18 }
      }
    })
    startClipVerify({ handle: 0, late: 0 }, 3, d)
    raf.flush() // in flight — skipped, no measure
    expect(samples).toBe(0)
    inFlight = false
    raf.flush() // resumed — measures and sheds
    expect(samples).toBe(1)
    expect(d.resizes).toEqual([{ cols: 80, rows: 9 }])
  })

  it('tolerates a missing element mid-window (portal hop): no resize, chain continues', () => {
    const raf = fakeRaf()
    const frames: Array<ClipVerifyMeasure | null> = [
      null, // portal hop: elements unresolvable this frame
      { rows: 10, cols: 80, overflow: 2, cellH: 18 }
    ]
    let i = 0
    const d = makeDeps(raf, {
      measure: () => frames[Math.min(i++, frames.length - 1)]
    })
    startClipVerify({ handle: 0, late: 0 }, 3, d)
    raf.flush()
    expect(d.resizes).toEqual([])
    raf.flush()
    expect(d.resizes).toEqual([{ cols: 80, rows: 9 }])
  })

  it('the late tail tick catches a spill that lands AFTER the whole rAF window (cold-start class)', () => {
    const raf = fakeRaf()
    let i = 0
    const d = makeDeps(raf, {
      // Every rAF frame reads clean; the reflow lands timer-late, after the window.
      measure: () =>
        ++i <= CLIP_VERIFY_FRAMES
          ? { rows: 10, cols: 80, overflow: -16, cellH: 16.2 }
          : { rows: 10, cols: 80, overflow: 2, cellH: 18 }
    })
    startClipVerify({ handle: 0, late: 0 }, CLIP_VERIFY_FRAMES, d)
    for (let f = 0; f < CLIP_VERIFY_FRAMES; f++) raf.flush()
    expect(d.resizes).toEqual([]) // window saw only the stale rect
    raf.fireLate() // wall-clock tail tick — the spill is visible now
    expect(d.resizes).toEqual([{ cols: 80, rows: 9 }])
  })

  it('a newer chain RESCHEDULES the late tail (never stacks a second timer)', () => {
    const raf = fakeRaf()
    const slot: ClipVerifySlot = { handle: 0, late: 0 }
    startClipVerify(slot, 2, makeDeps(raf))
    startClipVerify(slot, 2, makeDeps(raf))
    expect(raf.latePending()).toBe(1) // first chain's tail cancelled, one live tail only
  })

  it('sheds again if a LATER frame spills again (each frame is an independent verify)', () => {
    const raf = fakeRaf()
    const frames: Array<ClipVerifyMeasure> = [
      { rows: 10, cols: 80, overflow: 2, cellH: 18 }, // shed 10 → 9
      { rows: 9, cols: 80, overflow: -16, cellH: 18 }, // rendered clean after the shed
      { rows: 9, cols: 80, overflow: 3, cellH: 18 } // late second reflow spills again
    ]
    let i = 0
    const d = makeDeps(raf, {
      measure: () => frames[Math.min(i++, frames.length - 1)]
    })
    startClipVerify({ handle: 0, late: 0 }, 4, d)
    raf.flush()
    raf.flush()
    raf.flush()
    expect(d.resizes).toEqual([
      { cols: 80, rows: 9 },
      { cols: 80, rows: 8 }
    ])
  })
})
