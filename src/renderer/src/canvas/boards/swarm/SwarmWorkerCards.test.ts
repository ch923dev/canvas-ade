import { describe, expect, it } from 'vitest'
import { ORDER, activityLine, stateOf, type CardState } from './SwarmWorkerCards'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'
import type { SwarmWorkerLedgerState } from '../../../../../shared/swarmLedgerTypes'

/**
 * `stateOf` is the two-source merge (live attention ⊕ ledger projection) whose precedence IS the
 * card's honesty: PR #400's reviewer caught that a `blocked` attention with no ledger story fell
 * through to "Working…/Idle" while the board ring above said blocked. These tests pin the fixed
 * ordering: needs-input → lost → stalled → blocked → working/idle.
 */
const W = 'w1'
const attn = (a?: AttentionKind): Record<string, AttentionKind> => (a ? { [W]: a } : {})
const run = (r: boolean): Record<string, boolean> => ({ [W]: r })
const led = (state: 'stalled' | 'lost'): SwarmWorkerLedgerState => ({ boardId: W, state })

describe('stateOf — the blocked branch (P4 follow-up)', () => {
  it('🔒 `blocked` attention renders blocked, not Working…/Idle (the card/ring disagreement)', () => {
    // The latent bug: no branch consumed `blocked`, so a live PTY read as working and a dead one
    // as idle — both lies while the board-level ring said blocked.
    expect(stateOf(W, attn('blocked'), run(true), undefined)).toBe('blocked')
    expect(stateOf(W, attn('blocked'), run(false), undefined)).toBe('blocked')
  })

  it('the ledger’s SPECIFIC diagnoses outrank the generic blocked bucket', () => {
    // `workerAttention` derives blocked FROM the lost/stalled tags (and everything
    // off-vocabulary) — so when the two co-occur, the ledger knows the richer story
    // (salvage provenance, stall threshold) and must win.
    expect(stateOf(W, attn('blocked'), run(true), led('lost'))).toBe('lost')
    expect(stateOf(W, attn('blocked'), run(true), led('stalled'))).toBe('stalled')
  })

  it('🔒 live needs-input still outranks every ledger state (the S2 lock, unmoved)', () => {
    expect(stateOf(W, attn('needs-input'), run(true), led('stalled'))).toBe('needs-input')
    expect(stateOf(W, attn('needs-input'), run(true), led('lost'))).toBe('needs-input')
  })

  it('🔒 an off-vocabulary attention kind falls THROUGH to liveness — never a fabricated state', () => {
    // A forward kind from a newer writer must degrade to what the PTY can prove, exactly like
    // boardStatusBucket does one level up.
    const forward = { [W]: 'paused' as AttentionKind }
    expect(stateOf(W, forward, run(true), undefined)).toBe('working')
    expect(stateOf(W, forward, run(false), undefined)).toBe('idle')
  })
})

describe('ORDER — attention ordering with blocked slotted', () => {
  it('sorts blocked after the ledger states and before working', () => {
    expect(ORDER.blocked).toBeGreaterThan(ORDER.lost)
    expect(ORDER.blocked).toBeGreaterThan(ORDER.stalled)
    expect(ORDER.blocked).toBeLessThan(ORDER.working)
  })

  it('pins the full 09 §4 order', () => {
    const sorted = (Object.keys(ORDER) as CardState[]).sort((a, b) => ORDER[a] - ORDER[b])
    expect(sorted).toEqual([
      'needs-input',
      'lost',
      'stalled',
      'blocked',
      'working',
      'idle',
      'error',
      'done'
    ])
  })
})

describe('activityLine — blocked', () => {
  it('says blocked and ignores the stale last activity', () => {
    // meta.activity described what the worker WAS doing; echoing it on a blocked card would be
    // the same card/ring disagreement one line down.
    const meta = { activity: 'Refactoring pty' } as SwarmRun['workerMeta'][string]
    expect(activityLine('blocked', meta)).toBe('Blocked — waiting')
  })
})
