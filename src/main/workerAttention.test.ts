/**
 * The P4 blocked-tag → attention map: exhaustive over `SWARM_BLOCKED_TAGS`, plus the
 * off-vocabulary fallback and the gate-vocabulary projection.
 *
 * Two things here are load-bearing enough to be pinned by test rather than left to review:
 *  1 · the fallback is `blocked` — the SURFACE-IT direction, not the hide-it one;
 *  2 · `eventForAttention` never returns a fourth value, which is what keeps P4 from needing a
 *      notifications-config key, a new default, and a migration for every existing config file.
 */
import { describe, expect, it } from 'vitest'
import { SWARM_BLOCKED_TAGS, type SwarmBlockedTag } from '../shared/swarmLedgerTypes'
import { attentionForBlockedTag, eventForAttention, workerAttentionSignal } from './workerAttention'

/** Tags that mean "a human must look", as opposed to "this worker is stuck". */
const NEEDS_YOU: SwarmBlockedTag[] = ['needs_input', 'unreviewed', 'merge_ready']

describe('attentionForBlockedTag', () => {
  it('covers EVERY member of the closed vocabulary', () => {
    // If a future lane inserts a tag (S3 inserted three), this fails until the map is updated —
    // which is the point: an unmapped tag would silently take the fallback forever.
    for (const tag of SWARM_BLOCKED_TAGS) {
      const mark = attentionForBlockedTag(tag)
      expect(mark, `tag ${tag}`).toBe(NEEDS_YOU.includes(tag) ? 'needs-input' : 'blocked')
    }
  })

  it('routes the three "a human must decide" tags to needs-input', () => {
    // These are end-states, not failures: the work is done and waiting on a person.
    expect(attentionForBlockedTag('needs_input')).toBe('needs-input')
    expect(attentionForBlockedTag('unreviewed')).toBe('needs-input')
    expect(attentionForBlockedTag('merge_ready')).toBe('needs-input')
  })

  it('routes every cannot-proceed tag to blocked', () => {
    for (const tag of [
      'lost',
      'stalled',
      'failing_check',
      'dependency',
      'overlap',
      'dirty_worktree'
    ] as const) {
      expect(attentionForBlockedTag(tag)).toBe('blocked')
    }
  })

  it('🔒 falls back to `blocked` for an unknown tag — surface it, never hide it', () => {
    // `done` would launder an unclassifiable state into success; `error` would claim a failure
    // nobody reported. `blocked` claims only "not progressing, reason unreadable" — which is true.
    expect(attentionForBlockedTag('some_future_tag')).toBe('blocked')
    expect(attentionForBlockedTag(undefined)).toBe('blocked')
    expect(attentionForBlockedTag('')).toBe('blocked')
  })
})

describe('eventForAttention', () => {
  it('projects the four marks onto the THREE-member gate vocabulary', () => {
    expect(eventForAttention('done')).toBe('done')
    expect(eventForAttention('error')).toBe('error')
    expect(eventForAttention('needs-input')).toBe('needs-input')
    // The one that matters: `blocked` rides the EXISTING needs-input event, so `gateNotification`
    // and its `onInput` switch are untouched — no new config key, no default, no migration.
    expect(eventForAttention('blocked')).toBe('needs-input')
  })

  it('never invents a fourth event', () => {
    const seen = new Set(
      (['done', 'needs-input', 'blocked', 'error'] as const).map(eventForAttention)
    )
    expect([...seen].sort()).toEqual(['done', 'error', 'needs-input'])
  })
})

describe('workerAttentionSignal', () => {
  it('returns null for a worker that warrants no mark', () => {
    // A live worker is the normal case. Ringing it would put a ring on every board and destroy
    // the signal the ring exists to carry.
    expect(workerAttentionSignal({ boardId: 'b1', attention: null })).toBeNull()
  })

  it('carries the finer mark alongside the coarser gate event', () => {
    expect(
      workerAttentionSignal({ boardId: 'b1', attention: 'blocked', detail: 'silent 11m' })
    ).toEqual({ boardId: 'b1', event: 'needs-input', attention: 'blocked', detail: 'silent 11m' })
  })

  it('omits absent optionals so a pre-P4 signal stays byte-identical', () => {
    expect(workerAttentionSignal({ boardId: 'b1', attention: 'done' })).toEqual({
      boardId: 'b1',
      event: 'done',
      attention: 'done'
    })
  })
})
