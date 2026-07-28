import { describe, it, expect } from 'vitest'
import {
  createSessionFlow,
  createAckCounter,
  HIGH_WATERMARK_CHARS,
  LOW_WATERMARK_CHARS,
  CHAR_COUNT_ACK_SIZE,
  type FlowScheduler
} from './flowControl'

/**
 * Audit Phase 3 gate: "a synthetic runaway-output PTY test shows pause/resume engaging at the
 * watermarks". This is that test, driven against the SAME state machine daemonMain.ts wires to a
 * real node-pty — the daemon side is a five-line adapter (send/pause/resume), so exercising the
 * machine here exercises the shipped decision, not a re-implementation of it.
 */

/** A manual tick, so a "same tick" is whatever the test says it is. */
function manualScheduler(): { scheduler: FlowScheduler; tick: () => void; queued: () => number } {
  let queue: (() => void)[] = []
  return {
    scheduler: (fn) => {
      queue.push(fn)
      return {
        cancel: () => {
          queue = queue.filter((q) => q !== fn)
        }
      }
    },
    tick: () => {
      const run = queue
      queue = []
      for (const fn of run) fn()
    },
    queued: () => queue.length
  }
}

interface Harness {
  flow: ReturnType<typeof createSessionFlow>
  sent: string[]
  pauses: number
  resumes: number
  tick: () => void
  queued: () => number
}

function harness(limits?: { high?: number; low?: number }): Harness {
  const { scheduler, tick, queued } = manualScheduler()
  const h = { sent: [] as string[], pauses: 0, resumes: 0 } as unknown as Harness
  h.sent = []
  h.pauses = 0
  h.resumes = 0
  h.flow = createSessionFlow({
    send: (d) => h.sent.push(d),
    pause: () => h.pauses++,
    resume: () => h.resumes++,
    scheduler,
    limits
  })
  h.tick = tick
  h.queued = queued
  h.flow.setEnabled(true)
  h.flow.setSubscribers(1)
  return h
}

describe('flow-control constants', () => {
  /**
   * THE invariant. If the consumer only acks every N chars while the producer waits for the debt
   * to fall to a LOWER threshold, a paused pty can never satisfy the resume condition and the
   * terminal freezes forever, silently. Asserted so a future tuning edit cannot land it.
   */
  it('ack size is at most the low watermark, or a paused pty could never resume', () => {
    expect(CHAR_COUNT_ACK_SIZE).toBeLessThanOrEqual(LOW_WATERMARK_CHARS)
    expect(LOW_WATERMARK_CHARS).toBeLessThan(HIGH_WATERMARK_CHARS)
  })

  it('matches VS Code’s measured constants', () => {
    expect(HIGH_WATERMARK_CHARS).toBe(100_000)
    expect(LOW_WATERMARK_CHARS).toBe(5_000)
    expect(CHAR_COUNT_ACK_SIZE).toBe(5_000)
  })
})

describe('runaway output — pause/resume at the watermarks', () => {
  const CHUNK = 'x'.repeat(4096) // a plausible ConPTY read size

  it('pauses the pty once unacked output crosses the high watermark', () => {
    const h = harness()
    let written = 0
    while (h.pauses === 0) {
      h.flow.push(CHUNK)
      written += CHUNK.length
      expect(written, 'paused before reaching the high watermark').toBeLessThanOrEqual(
        HIGH_WATERMARK_CHARS + CHUNK.length
      )
    }
    expect(h.flow.paused).toBe(true)
    expect(h.flow.unacked).toBeGreaterThanOrEqual(HIGH_WATERMARK_CHARS)
    expect(h.pauses).toBe(1) // and only once — not per chunk while it stays over
    h.flow.push(CHUNK)
    expect(h.pauses).toBe(1)
  })

  it('resumes only when acks bring the debt to the low watermark, not before', () => {
    const h = harness()
    while (h.pauses === 0) h.flow.push(CHUNK)
    const debt = h.flow.unacked

    // Ack most of it, but leave more than the low watermark outstanding.
    h.flow.ack(debt - LOW_WATERMARK_CHARS - 1)
    expect(h.flow.paused, 'resumed while still above the low watermark').toBe(true)
    expect(h.resumes).toBe(0)

    h.flow.ack(1)
    expect(h.flow.paused).toBe(false)
    expect(h.resumes).toBe(1)
  })

  // The end-to-end property: a producer that never stops, against a consumer acking at the real
  // ack size, must settle into pause/resume cycles rather than running away or deadlocking.
  it('sustains a 10 MB runaway stream: bounded backlog, and it always comes back', () => {
    const h = harness()
    const counter = createAckCounter()
    let produced = 0
    let maxUnacked = 0
    while (produced < 10 * 1024 * 1024) {
      // A producer that OUTRUNS its consumer: a burst of chunks lands inside one tick, which is
      // exactly the shape of a runaway agent (a `cat` of a binary, a build log). Draining one
      // chunk per tick would never build a backlog and the guard would never be exercised.
      for (let i = 0; i < 64 && !h.flow.paused; i++) {
        h.flow.push(CHUNK)
        produced += CHUNK.length
        maxUnacked = Math.max(maxUnacked, h.flow.unacked)
      }
      // The consumer drains this tick's coalesced message and acks on the real schedule.
      h.tick()
      for (const msg of h.sent.splice(0)) {
        const due = counter.received(msg.length)
        if (due > 0) h.flow.ack(due)
      }
    }
    expect(produced).toBeGreaterThanOrEqual(10 * 1024 * 1024)
    expect(h.pauses).toBeGreaterThan(0) // the guard actually engaged
    expect(h.resumes).toBe(h.pauses) // …and released every time: no permanent freeze
    expect(h.flow.paused).toBe(false)
    // The whole point: the in-flight backlog stays bounded near the watermark instead of growing
    // with the length of the stream.
    expect(maxUnacked).toBeLessThan(HIGH_WATERMARK_CHARS + CHUNK.length * 2)
  })

  /**
   * The mutation this test exists to catch: an ack size ABOVE the low watermark. The consumer's
   * final partial debt never reaches the ack threshold, the daemon never sees the debt drop to the
   * low watermark, and the pty stays paused for good.
   */
  it('MUTANT: a debt below an oversized ack size but above the low watermark strands the pty', () => {
    const OVERSIZED_ACK = 6_000 // the mutation: > LOW_WATERMARK_CHARS
    const h = harness()
    while (h.pauses === 0) h.flow.push(CHUNK)
    const debt = h.flow.unacked

    // The consumer has consumed everything except a residual it is still buffering. Under an
    // oversized ack size this residual can legally sit ABOVE the low watermark while remaining
    // BELOW the ack threshold — so no ack is ever sent, and the daemon never sees the debt fall
    // far enough to resume. That is the permanent freeze, reproduced.
    const stranded = LOW_WATERMARK_CHARS + 1
    expect(stranded).toBeLessThan(OVERSIZED_ACK) // an oversized counter would never ack this
    expect(createAckCounter(OVERSIZED_ACK).received(stranded)).toBe(0) // …proven, not asserted
    h.flow.ack(debt - stranded)
    expect(h.flow.paused).toBe(true)
    expect(h.resumes).toBe(0)

    // With the SHIPPED ack size (≤ the low watermark) that same residual is acked, and the pty
    // comes back. This is the entire reason for the constant relationship.
    expect(createAckCounter(CHAR_COUNT_ACK_SIZE).received(stranded)).toBe(stranded)
    h.flow.ack(stranded)
    expect(h.flow.paused).toBe(false)
    expect(h.resumes).toBe(1)
  })
})

describe('detached sessions (the freeze-forever case)', () => {
  /**
   * Daemon sessions outlive the app on purpose — an update install, a crash, a plain restart. With
   * no client attached there are no acks, so an accounting session would cross the high watermark
   * and pause a pty that nothing is going to un-pause: a background agent frozen until the app
   * came back, with the daemon looking perfectly healthy.
   */
  it('never pauses a session with zero subscribers', () => {
    const h = harness()
    h.flow.setSubscribers(0)
    for (let i = 0; i < 200; i++) h.flow.push('y'.repeat(4096)) // ~800 KB, 8× the watermark
    expect(h.flow.paused).toBe(false)
    expect(h.pauses).toBe(0)
    expect(h.flow.unacked).toBe(0)
  })

  it('releases a pause taken while attached when the last subscriber goes away', () => {
    const h = harness()
    while (h.pauses === 0) h.flow.push('z'.repeat(4096))
    expect(h.flow.paused).toBe(true)
    h.flow.setSubscribers(0) // the app quit / the pipe dropped
    expect(h.flow.paused).toBe(false)
    expect(h.resumes).toBe(1)
    expect(h.flow.unacked).toBe(0)
  })

  it('never pauses for a client that did not declare flow control', () => {
    const h = harness()
    h.flow.setEnabled(false) // an OLD app reattaching to a NEW daemon after an update
    for (let i = 0; i < 200; i++) h.flow.push('w'.repeat(4096))
    expect(h.pauses).toBe(0)
    expect(h.flow.paused).toBe(false)
  })

  it('releases a pause if accounting is turned off mid-stream', () => {
    const h = harness()
    while (h.pauses === 0) h.flow.push('q'.repeat(4096))
    h.flow.setEnabled(false)
    expect(h.flow.paused).toBe(false)
    expect(h.resumes).toBe(1)
  })
})

describe('same-tick coalescing', () => {
  it('sends one message per tick regardless of how many chunks arrived', () => {
    const h = harness()
    h.flow.push('a')
    h.flow.push('b')
    h.flow.push('c')
    expect(h.sent).toHaveLength(0) // nothing goes out mid-tick
    h.tick()
    expect(h.sent).toEqual(['abc']) // one JSON.stringify + one socket write, not three
  })

  it('flush() sends immediately and cancels the pending tick', () => {
    const h = harness()
    h.flow.push('a')
    h.flow.push('b')
    h.flow.flush()
    expect(h.sent).toEqual(['ab'])
    expect(h.queued()).toBe(0)
    h.tick()
    expect(h.sent).toEqual(['ab']) // no duplicate from the cancelled tick
  })

  it('flush() with nothing pending sends nothing', () => {
    const h = harness()
    h.flow.flush()
    expect(h.sent).toHaveLength(0)
  })

  // daemonMain flushes before building an attach replay: the buffered chunk is ALREADY in the ring
  // (pushDaemonRing runs at onData), so a later flush would deliver it a second time.
  it('dispose() drops the buffer so a scheduled flush cannot fire after teardown', () => {
    const h = harness()
    h.flow.push('tail')
    h.flow.dispose()
    h.tick()
    expect(h.sent).toHaveLength(0)
  })
})

describe('createAckCounter', () => {
  it('acks nothing until the ack size is reached, then the whole debt at once', () => {
    const c = createAckCounter(100)
    expect(c.received(40)).toBe(0)
    expect(c.received(40)).toBe(0)
    expect(c.received(40)).toBe(120) // the full outstanding amount, not a rounded 100
    expect(c.received(1)).toBe(0) // and the debt restarts from zero
  })

  it('acks a single oversized chunk immediately', () => {
    const c = createAckCounter(100)
    expect(c.received(5_000)).toBe(5_000)
  })

  it('reset() drops an in-flight debt (the session ended)', () => {
    const c = createAckCounter(100)
    c.received(90)
    c.reset()
    expect(c.received(90)).toBe(0)
  })
})
