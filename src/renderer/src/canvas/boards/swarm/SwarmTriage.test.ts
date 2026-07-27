import { describe, expect, it } from 'vitest'
import { mergeTriage } from './SwarmTriage'
import type { SwarmTriageRow } from '../../../../../shared/swarmLedgerTypes'
import type { AttentionKind } from '../../../store/attentionStore'

/**
 * The triage queue's ORDER is the whole point of the queue: a human scanning it top-down must hit
 * the things that block them first. That order is produced by merging two sources which know
 * nothing about each other (the live attention store, and MAIN's ledger projection), so this is
 * where the contract gets pinned.
 */
const row = (id: string, tag: SwarmTriageRow['tag'], boardId: string): SwarmTriageRow => ({
  id,
  tag,
  boardId,
  text: 'happened',
  actions: ['open']
})

const attn = (m: Record<string, AttentionKind>): Record<string, AttentionKind> => m

describe('mergeTriage — the two-source merge', () => {
  it('puts live needs-input rows on top, ahead of every ledger tag', () => {
    const out = mergeTriage(['w1', 'w2'], attn({ w2: 'needs-input' }), [
      row('t1', 'unreviewed', 'w1'),
      row('t2', 'lost', 'w3')
    ])
    expect(out.map((r) => r.tag)).toEqual(['needs_input', 'lost', 'unreviewed'])
    expect(out[0].boardId).toBe('w2')
  })

  it('orders ledger rows by risk (SWARM_BLOCKED_TAGS order), not by arrival', () => {
    const out = mergeTriage([], attn({}), [
      row('a', 'unreviewed', 'w1'),
      row('b', 'stalled', 'w2'),
      row('c', 'lost', 'w3'),
      row('d', 'dependency', 'w4'),
      row('e', 'failing_check', 'w5')
    ])
    expect(out.map((r) => r.tag)).toEqual([
      'lost',
      'failing_check',
      'stalled',
      'dependency',
      'unreviewed'
    ])
  })

  it('is stable within a tag — equal risk keeps ledger order', () => {
    const out = mergeTriage([], attn({}), [
      row('a', 'stalled', 'w1'),
      row('b', 'stalled', 'w2'),
      row('c', 'stalled', 'w3')
    ])
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('🔒 a board in BOTH sources shows the needs-input row only — answering it is what unblocks it', () => {
    const out = mergeTriage(['w1'], attn({ w1: 'needs-input' }), [row('t1', 'stalled', 'w1')])
    expect(out).toHaveLength(1)
    expect(out[0].tag).toBe('needs_input')
    expect(out[0].id).toBe('attn:w1')
  })

  it('ignores attention kinds that are not a human blocker', () => {
    const out = mergeTriage(['w1', 'w2'], attn({ w1: 'done', w2: 'error' }), [])
    expect(out).toEqual([])
  })

  it('renders nothing at all when neither source has anything', () => {
    expect(mergeTriage(['w1'], attn({}), [])).toEqual([])
  })

  it('works with no ledger at all (the S1 degradation): attention rows still surface', () => {
    const out = mergeTriage(['w1'], attn({ w1: 'needs-input' }), [])
    expect(out.map((r) => r.tag)).toEqual(['needs_input'])
    expect(out[0].actions).toEqual(['open'])
  })
})
