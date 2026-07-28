/**
 * Publishing a findings batch — the gate, the single write, and the two disciplines earned in S3.
 *
 *  · RE-CHECK INSIDE THE WRITE, not only at the gate (BUG-021). A human can sit on the confirm modal
 *    for minutes while the orchestrator keeps working, so the destination board is re-resolved AFTER
 *    the decision returns.
 *  · GATE THE WRITE, NOT THE NO-OP (S3 round-2 `[warning]`). Approving nothing touches nothing, and
 *    a path that touches nothing must never be reported as a failure.
 */
import { describe, expect, it, vi } from 'vitest'
import { publishFindings, type FindingsPublishDeps } from './findingsPublish'
import type { KanbanOp } from '../shared/mcpTypes'
import type { WorkerReport } from './findingsBatch'

const KANBAN = 'kanban-1'

interface Harness {
  deps: FindingsPublishDeps
  sent: Array<{ id: string; ops: KanbanOp[] }>
  confirmed: Array<{ title: string; items: Array<{ label: string; body: string }> }>
}

function harness(over?: {
  reports?: WorkerReport[]
  approve?: (i: number) => boolean
  lanes?: string[]
  boards?: Record<string, { type: string; title: string }>
  /** Runs while the confirm modal is "open" — the seam for the TOCTOU case. */
  duringConfirm?: () => void
  sendAck?: { ok: true; type: string } | { ok: false; error: string }
}): Harness {
  const sent: Harness['sent'] = []
  const confirmed: Harness['confirmed'] = []
  const boards: Record<string, { type: string; title: string }> = over?.boards ?? {
    [KANBAN]: { type: 'kanban', title: 'Review findings' },
    w1: { type: 'terminal', title: 'reviewer-1' },
    w2: { type: 'terminal', title: 'reviewer-2' }
  }
  const deps: FindingsPublishDeps = {
    collectReports: () =>
      over?.reports ?? [
        { boardId: 'w1', refs: ['src/a.ts:1 high — real bug'] },
        { boardId: 'w2', refs: ['src/b.ts:2 low — nit'] }
      ],
    lookupBoard: (id) => boards[id],
    lanesOf: () => over?.lanes ?? ['backlog', 'in-progress', 'review', 'done'],
    confirmBatch: async (req) => {
      confirmed.push(req)
      over?.duringConfirm?.()
      return { decisions: req.items.map((_, i) => ({ approved: over?.approve?.(i) ?? true })) }
    },
    send: async (command) => {
      if (command.type === 'patchKanban') sent.push({ id: command.id, ops: command.ops })
      return over?.sendAck ?? { ok: true, type: command.type }
    },
    newCardId: (() => {
      let n = 0
      return () => `card-${++n}`
    })()
  }
  return { deps, sent, confirmed }
}

describe('publishFindings', () => {
  it('refuses a board that is not there', async () => {
    const h = harness({ boards: {} })
    const r = await publishFindings(h.deps, KANBAN)
    expect(r).toMatchObject({ ok: false, published: 0 })
    expect(h.confirmed).toHaveLength(0)
  })

  it('refuses a non-kanban destination and says what it actually is', async () => {
    const h = harness({ boards: { [KANBAN]: { type: 'planning', title: 'Plan' } } })
    const r = await publishFindings(h.deps, KANBAN)
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('is a planning, not a kanban')
  })

  it('🔒 lands N findings in ONE confirm and ONE patchKanban — never N add_cards', async () => {
    const h = harness()
    const r = await publishFindings(h.deps, KANBAN)
    // This IS the feature: the whole reason the batch path exists is that N durable writes would
    // otherwise be N human-confirm modals.
    expect(h.confirmed).toHaveLength(1)
    expect(h.confirmed[0].items).toHaveLength(2)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].ops).toHaveLength(2)
    expect(r).toMatchObject({ ok: true, published: 2 })
  })

  it('writes only the approved rows and reports the declines', async () => {
    const h = harness({ approve: (i) => i === 0 })
    const r = await publishFindings(h.deps, KANBAN)
    expect(h.sent[0].ops).toHaveLength(1)
    expect(r.published).toBe(1)
    expect(r.summary).toContain('1 declined')
  })

  it('🔒 approving NOTHING is a successful no-op, not a failure', async () => {
    // S3 round-2 `[warning]`: a path that touches nothing must not be refused. Declining every row
    // is a legitimate answer to the question the modal asked.
    const h = harness({ approve: () => false })
    const r = await publishFindings(h.deps, KANBAN)
    expect(r).toMatchObject({ ok: true, published: 0 })
    expect(h.sent).toHaveLength(0)
  })

  it('🔒 an EMPTY batch is also a successful no-op, and carries its reason', async () => {
    const h = harness({ reports: [{ boardId: 'w1', status: 'done' }] })
    const r = await publishFindings(h.deps, KANBAN)
    expect(r.ok).toBe(true)
    expect(r.published).toBe(0)
    expect(r.summary).toContain('nothing to publish')
    expect(r.summary).toContain('reported nothing')
    expect(h.confirmed).toHaveLength(0)
  })

  it('🔒 re-checks the destination AFTER the decision (BUG-021 TOCTOU)', async () => {
    const boards: Record<string, { type: string; title: string }> = {
      [KANBAN]: { type: 'kanban', title: 'Review findings' },
      w1: { type: 'terminal', title: 'reviewer-1' },
      w2: { type: 'terminal', title: 'reviewer-2' }
    }
    const h = harness({
      boards,
      // The human sat on the modal; the board was deleted while it was open.
      duringConfirm: () => delete boards[KANBAN]
    })
    const r = await publishFindings(h.deps, KANBAN)
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('was removed while the confirmation was open')
    expect(h.sent).toHaveLength(0)
  })

  it('routes by severity into the board’s real lanes', async () => {
    const h = harness()
    await publishFindings(h.deps, KANBAN)
    const cols = h.sent[0].ops.map((o) => (o.op === 'add' ? o.card.columnId : ''))
    expect(cols).toEqual(['review', 'backlog'])
  })

  it('honours an explicit lane override', async () => {
    const h = harness()
    await publishFindings(h.deps, KANBAN, { lane: 'in-progress' })
    const cols = h.sent[0].ops.map((o) => (o.op === 'add' ? o.card.columnId : ''))
    expect(cols).toEqual(['in-progress', 'in-progress'])
  })

  it('falls back to an EXISTING lane rather than dropping a finding, and says it rerouted', async () => {
    // A board with custom columns may have neither `review` nor `backlog`.
    const h = harness({ lanes: ['ideas', 'shipped'] })
    const r = await publishFindings(h.deps, KANBAN)
    const cols = h.sent[0].ops.map((o) => (o.op === 'add' ? o.card.columnId : ''))
    expect(cols).toEqual(['ideas', 'ideas'])
    expect(r.summary).toContain('routed to an existing lane instead')
  })

  it('builds the card from the finding: title, ref, fileRefs, tags, assignee', async () => {
    const h = harness({
      reports: [{ boardId: 'w1', role: 'code-reviewer', refs: ['src/a.ts:7 crit — boom'] }]
    })
    await publishFindings(h.deps, KANBAN)
    const op = h.sent[0].ops[0]
    expect(op.op).toBe('add')
    if (op.op !== 'add') throw new Error('expected an add op')
    expect(op.card).toMatchObject({
      title: 'boom',
      ref: 'src/a.ts:7',
      tag: 'crit',
      assignee: 'reviewer-1',
      fileRefs: [{ path: 'src/a.ts', line: 7 }]
    })
    expect(op.card.tags).toEqual(['crit', 'code-reviewer'])
  })

  it('🔒 never presents a worker claim as a verification', async () => {
    const h = harness({ reports: [{ boardId: 'w1', refs: ['src/a.ts:7 crit — boom'] }] })
    await publishFindings(h.deps, KANBAN)
    const op = h.sent[0].ops[0]
    if (op.op !== 'add') throw new Error('expected an add op')
    expect(op.card.description).toContain('its claim, not a verification')
  })

  it('🔒 marks a SYNTHESIZED finding as derived, never as self-reported', async () => {
    const h = harness({
      reports: [{ boardId: 'w1', refs: ['src/a.ts:7 crit — boom'], synthesized: true }]
    })
    await publishFindings(h.deps, KANBAN)
    const op = h.sent[0].ops[0]
    if (op.op !== 'add') throw new Error('expected an add op')
    expect(op.card.description).toContain('never reported this itself')
  })

  it('names every reporter of a merged finding in the description', async () => {
    const h = harness({
      reports: [
        { boardId: 'w1', refs: ['src/a.ts:1 high — same claim'] },
        { boardId: 'w2', refs: ['src/a.ts:1 high — same claim'] }
      ]
    })
    await publishFindings(h.deps, KANBAN)
    const op = h.sent[0].ops[0]
    if (op.op !== 'add') throw new Error('expected an add op')
    expect(op.card.description).toContain('reviewer-1, reviewer-2')
  })

  it('surfaces a refused write instead of claiming a publish', async () => {
    const h = harness({ sendAck: { ok: false, error: 'project-loading' } })
    const r = await publishFindings(h.deps, KANBAN)
    expect(r).toMatchObject({ ok: false, published: 0 })
    expect(r.summary).toContain('project-loading')
  })

  it('always carries the batch disclosure into the outcome string', async () => {
    const h = harness()
    const r = await publishFindings(h.deps, KANBAN)
    expect(r.summary).toContain("severities are the workers' own claims, not verified")
  })

  it('never asks the agent for card content — reports come from collectReports only', async () => {
    const collect = vi.fn(() => [{ boardId: 'w1', refs: ['src/a.ts:1 high — n'] }])
    const h = harness()
    await publishFindings({ ...h.deps, collectReports: collect }, KANBAN)
    expect(collect).toHaveBeenCalledTimes(1)
  })
})
