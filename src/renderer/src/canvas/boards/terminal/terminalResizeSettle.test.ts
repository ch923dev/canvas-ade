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
})
