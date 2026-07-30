/**
 * MAIN's half of the P4 feed: classify → coalesce → push, and the attention mark that rides with it.
 *
 * The behaviour worth pinning is what the feed REFUSES to say. A live worker gets no ring (or every
 * board wears one and the ring means nothing); a synthesized result never gets the ✓ done ring
 * (it is a guess about a dead worker, not a completion it claimed).
 */
import { describe, expect, it, vi } from 'vitest'
import { createCommandFeed } from './commandFeed'
import type { McpCommand } from '../shared/mcpTypes'
import type { DeliverableSignal } from './lifecycleNotifications'

/** A schedule seam that records pending callbacks so the debounce is driven, never waited on. */
function manualSchedule(): {
  schedule: (fn: () => void, ms: number) => () => void
  runAll: () => void
  pending: number
} {
  let queue: Array<() => void> = []
  return {
    schedule: (fn) => {
      queue.push(fn)
      return () => {
        queue = queue.filter((f) => f !== fn)
      }
    },
    runAll: () => {
      const q = queue
      queue = []
      for (const fn of q) fn()
    },
    get pending() {
      return queue.length
    }
  }
}

function harness(ack: { ok: boolean; rendered?: boolean } = { ok: true }): {
  feed: ReturnType<typeof createCommandFeed>
  sent: McpCommand[]
  signals: DeliverableSignal[]
  clock: ReturnType<typeof manualSchedule>
  unrendered: string[]
} {
  const sent: McpCommand[] = []
  const signals: DeliverableSignal[] = []
  const unrendered: string[] = []
  const clock = manualSchedule()
  const feed = createCommandFeed({
    send: async (command) => {
      sent.push(command)
      return ack.ok
        ? {
            ok: true,
            type: command.type,
            ...(ack.rendered !== undefined ? { rendered: ack.rendered } : {})
          }
        : { ok: false, error: 'no-window' }
    },
    deliver: (sig) => signals.push(sig),
    schedule: clock.schedule,
    onUnrendered: (id) => unrendered.push(id)
  })
  return { feed, sent, signals, clock, unrendered }
}

const feedOf = (c: McpCommand): Extract<McpCommand, { type: 'commandFeed' }>['feed'] => {
  if (c.type !== 'commandFeed') throw new Error(`expected commandFeed, got ${c.type}`)
  return c.feed
}

describe('observeResult', () => {
  it('pushes the classified state + the sanitized result over the ONE canvas pipe', async () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'done', summary: '3 findings', refs: ['a.ts:1'] })
    h.clock.runAll()
    await Promise.resolve()
    expect(h.sent).toHaveLength(1)
    expect(feedOf(h.sent[0])).toMatchObject({
      boardId: 'w1',
      state: 'done',
      result: { status: 'done', summary: '3 findings', refs: ['a.ts:1'] }
    })
  })

  it('COALESCES a burst per board into one push (status is a state, not an event stream)', () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'blocked' })
    h.feed.observeResult('w1', { status: 'done', summary: 'ok' })
    expect(h.clock.pending).toBe(1)
    h.clock.runAll()
    expect(h.sent).toHaveLength(1)
    expect(feedOf(h.sent[0])).toMatchObject({ state: 'done', result: { summary: 'ok' } })
  })

  it('does not coalesce ACROSS boards', () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'done' })
    h.feed.observeResult('w2', { status: 'done' })
    h.clock.runAll()
    expect(h.sent.map((c) => feedOf(c).boardId)).toEqual(['w1', 'w2'])
  })

  it('a second write_result REPLACES the first — last-write-wins, mirroring boardResults', () => {
    // `recordBoardResult` does `results.set(id, result)`: a re-report is the worker's new whole
    // result, not a patch onto the old one (A5-F5). The feed must mirror that or the card and the
    // `canvas://board/{id}/result` resource would show different things.
    const h = harness()
    h.feed.observeResult('w1', { summary: 'partial work' })
    h.feed.observeResult('w1', { status: 'done' })
    h.clock.runAll()
    expect(feedOf(h.sent[0]).result).toEqual({ status: 'done' })
  })

  it('a queued ATTENTION push does not erase a queued result (absent = unchanged)', () => {
    // Merging across push KINDS is where "absent means unchanged" earns its keep: a ledger-side
    // blocked verdict carries no result, and must not blank the report the worker just filed.
    const h = harness()
    h.feed.observeResult('w1', { summary: 'partial work' })
    h.feed.observeAttention('w1', 'blocked', { detail: 'silent 11m' })
    h.clock.runAll()
    expect(h.sent).toHaveLength(1)
    expect(feedOf(h.sent[0])).toMatchObject({
      state: 'blocked',
      result: { summary: 'partial work' },
      disclose: 'silent 11m'
    })
  })

  it('raises the matching attention mark for a settled result', () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'done' })
    h.feed.observeResult('w2', { status: 'failed' })
    h.feed.observeResult('w3', { status: 'blocked' })
    expect(h.signals.map((s) => s.attention)).toEqual(['done', 'error', 'needs-input'])
  })

  it('🔒 raises NO mark for an in-flight worker', () => {
    // Running is the normal case. A ring on every live board is a ring that says nothing.
    const h = harness()
    h.feed.observeResult('w1', { summary: 'still going' })
    expect(h.signals).toHaveLength(0)
  })

  it('🔒 a SYNTHESIZED result never wears the done ring, and says why', () => {
    // It is a transcript-derived guess about a worker that never reported — presenting it as a
    // clean completion is exactly the "launder a claim into a verification" mistake.
    const h = harness()
    h.feed.observeResult('w1', { status: 'done', summary: 's' }, { synthesized: true })
    expect(h.signals[0].attention).toBe('blocked')
    h.clock.runAll()
    expect(feedOf(h.sent[0]).disclose).toBe(
      'derived from the transcript — the worker never reported'
    )
  })

  it('carries the off-vocabulary disclosure onto the card AND the toast', () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'partial-ok' })
    h.clock.runAll()
    expect(feedOf(h.sent[0])).toMatchObject({
      state: 'reporting',
      disclose: 'unrecognized status "partial-ok" — treated as unsettled'
    })
    // Non-terminal ⇒ no ring: the worker reported, we just could not read it. It stays watched.
    expect(h.signals).toHaveLength(0)
  })

  it('ignores a malformed board id rather than pushing junk', () => {
    const h = harness()
    h.feed.observeResult('', { status: 'done' })
    h.clock.runAll()
    expect(h.sent).toHaveLength(0)
  })

  it('reports an unrendered push so the absence of a Command board can be disclosed', async () => {
    const h = harness({ ok: true, rendered: false })
    h.feed.observeResult('w1', { status: 'done' })
    h.clock.runAll()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.unrendered).toEqual(['w1'])
  })
})

describe('observeAttention', () => {
  it('mirrors a blocked verdict onto BOTH the card and the ring', () => {
    const h = harness()
    h.feed.observeAttention('w1', 'blocked', {
      detail: 'silent 11m',
      blockedTag: 'stalled',
      role: 'builder'
    })
    h.clock.runAll()
    expect(feedOf(h.sent[0])).toMatchObject({
      state: 'blocked',
      blockedTag: 'stalled',
      role: 'builder',
      disclose: 'silent 11m'
    })
    expect(h.signals[0]).toMatchObject({ event: 'needs-input', attention: 'blocked' })
  })

  it('🔒 does NOT move the card for a done/error verdict — the worker’s own report owns that', () => {
    // The ledger and the worker can disagree; the worker's own write_result wins the card, so a
    // ledger-side verdict here would race it.
    const h = harness()
    h.feed.observeAttention('w1', 'done')
    h.feed.observeAttention('w2', 'error')
    h.clock.runAll()
    expect(h.sent).toHaveLength(0)
    expect(h.signals).toHaveLength(2)
  })

  it('raises nothing at all for a null verdict', () => {
    const h = harness()
    h.feed.observeAttention('w1', null)
    h.clock.runAll()
    expect(h.sent).toHaveLength(0)
    expect(h.signals).toHaveLength(0)
  })

  it('clamps an over-long detail line', () => {
    const h = harness()
    h.feed.observeAttention('w1', 'blocked', { detail: 'x'.repeat(900) })
    expect(h.signals[0].detail!.length).toBeLessThanOrEqual(200)
  })
})

describe('flush / dispose', () => {
  it('flush sends everything queued right now', () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'done' })
    h.feed.observeResult('w2', { status: 'done' })
    h.feed.flush()
    expect(h.sent).toHaveLength(2)
  })

  it('dispose drops queued pushes — the window is going away', () => {
    const h = harness()
    h.feed.observeResult('w1', { status: 'done' })
    h.feed.dispose()
    h.clock.runAll()
    expect(h.sent).toHaveLength(0)
  })

  it('a refused send never throws into the caller', async () => {
    const h = harness({ ok: false })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.feed.observeResult('w1', { status: 'done' })
    h.clock.runAll()
    await Promise.resolve()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
