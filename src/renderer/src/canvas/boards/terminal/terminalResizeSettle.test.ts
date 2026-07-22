/**
 * Resize-storm fix (terminal display v2): the trailing-throttle settler that collapses a
 * burst of xterm grid resizes into ONE PTY-bound resize (the settled grid). Timers are
 * injected, so the burst-collapse contract is provable without real time.
 */
import { describe, expect, it, vi } from 'vitest'
import { createResizeSettler, RESIZE_SETTLE_MS } from './terminalResizeSettle'

/** Manual timer harness: schedule() records the callback; fire() runs the armed one. */
function makeTimers(): {
  schedule: (fn: () => void, ms: number) => number
  cancel: (h: number) => void
  fire: () => void
  armed: () => boolean
  cancelled: number[]
} {
  let next = 1
  let pending: { h: number; fn: () => void } | null = null
  const cancelled: number[] = []
  return {
    schedule(fn, _ms) {
      const h = next++
      pending = { h, fn }
      return h
    },
    cancel(h) {
      cancelled.push(h)
      if (pending?.h === h) pending = null
    },
    fire() {
      const p = pending
      pending = null
      p?.fn()
    },
    armed: () => pending !== null,
    cancelled
  }
}

function make(): {
  post: ReturnType<typeof vi.fn>
  timers: ReturnType<typeof makeTimers>
  settler: ReturnType<typeof createResizeSettler>
} {
  const post = vi.fn()
  const timers = makeTimers()
  const settler = createResizeSettler({
    post,
    delayMs: RESIZE_SETTLE_MS,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  return { post, timers, settler }
}

describe('createResizeSettler (resize-storm fix — one PTY resize per burst)', () => {
  it('posts nothing until the window elapses, then the pushed dims once', () => {
    const { post, timers, settler } = make()
    settler.push(100, 30)
    expect(post).not.toHaveBeenCalled()
    timers.fire()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(100, 30)
  })

  it('collapses a burst to the LATEST dims — the backstop resize + row-shed pair post once', () => {
    const { post, timers, settler } = make()
    settler.push(140, 40) // backstop cols resize
    settler.push(140, 39) // whole-cell row-shed, same tick
    settler.push(141, 39) // coalesced catch-up fit, a frame later (still inside the window)
    timers.fire()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(141, 39)
  })

  it('a push AFTER the window fired arms a fresh window (a drag paces, never starves)', () => {
    const { post, timers, settler } = make()
    settler.push(100, 30)
    timers.fire()
    settler.push(101, 30)
    expect(timers.armed()).toBe(true)
    timers.fire()
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenLastCalledWith(101, 30)
  })

  it('dispose cancels the armed timer and drops the pending dims', () => {
    const { post, timers, settler } = make()
    settler.push(100, 30)
    settler.dispose()
    expect(timers.cancelled.length).toBe(1)
    timers.fire() // nothing armed — must be a no-op
    expect(post).not.toHaveBeenCalled()
  })

  it('dispose with no armed timer is a no-op', () => {
    const { timers, settler } = make()
    settler.dispose()
    expect(timers.cancelled.length).toBe(0)
  })

  describe('hold (T1a′ — a handle-drag posts ONE resize, on release)', () => {
    it('held pushes never arm a timer; release posts only the LATEST dims', () => {
      const { post, timers, settler } = make()
      settler.setHold(true)
      settler.push(100, 30)
      settler.push(110, 32)
      settler.push(120, 34) // the whole drag, frame by frame
      expect(timers.armed()).toBe(false)
      settler.setHold(false)
      expect(post).not.toHaveBeenCalled() // release still settles through the window
      timers.fire()
      expect(post).toHaveBeenCalledTimes(1)
      expect(post).toHaveBeenCalledWith(120, 34)
    })

    it('release with nothing pending posts nothing (a drag that never crossed a cell)', () => {
      const { post, timers, settler } = make()
      settler.setHold(true)
      settler.setHold(false)
      expect(timers.armed()).toBe(false)
      timers.fire()
      expect(post).not.toHaveBeenCalled()
    })

    it('a timer firing while held keeps the pending dims for the release', () => {
      const { post, timers, settler } = make()
      settler.push(100, 30) // arms pre-drag
      settler.setHold(true) // drag starts inside the window
      settler.push(115, 33)
      timers.fire() // the pre-drag window elapses mid-drag — must NOT post a mid-drag grid
      expect(post).not.toHaveBeenCalled()
      settler.setHold(false)
      timers.fire()
      expect(post).toHaveBeenCalledTimes(1)
      expect(post).toHaveBeenCalledWith(115, 33)
    })

    it('a fit AFTER release but inside the window still wins (trailing semantics survive)', () => {
      const { post, timers, settler } = make()
      settler.setHold(true)
      settler.push(100, 30)
      settler.setHold(false) // release arms the window…
      settler.push(101, 30) // …and the final ResizeObserver fit lands inside it
      timers.fire()
      expect(post).toHaveBeenCalledTimes(1)
      expect(post).toHaveBeenCalledWith(101, 30)
    })

    it('redundant setHold calls are no-ops (unmount-guard end after a real end)', () => {
      const { post, timers, settler } = make()
      settler.setHold(true)
      settler.setHold(true)
      settler.push(100, 30)
      settler.setHold(false)
      settler.setHold(false) // must not re-arm / double-post
      timers.fire()
      expect(post).toHaveBeenCalledTimes(1)
    })

    it('dispose during a hold drops the pending dims — a later release posts nothing', () => {
      const { post, timers, settler } = make()
      settler.setHold(true)
      settler.push(100, 30)
      settler.dispose()
      settler.setHold(false)
      expect(timers.armed()).toBe(false)
      timers.fire()
      expect(post).not.toHaveBeenCalled()
    })
  })
})
