import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  dedupeTriage,
  discloseFor,
  fmtDur,
  isStalled,
  liveWorktrees,
  planHolders,
  planOwners,
  silentMs,
  sortTriage,
  triageRows,
  workerStates
} from './swarmLedgerProject'
import {
  SWARM_BLOCKED_TAGS,
  SWARM_LEDGER_VERSION,
  SWARM_STALL_THRESHOLD_MS,
  type SwarmAssignment,
  type SwarmRunLedger,
  type SwarmTask,
  type SwarmTaskResult,
  type SwarmTriageRow
} from '../shared/swarmLedgerTypes'

const MIN = 60_000

const assign = (over: Partial<SwarmAssignment> = {}): SwarmAssignment => ({
  boardId: 'w1',
  role: 'builder',
  spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
  dispatchedAt: 0,
  lastActivityAt: 0,
  stallCount: 0,
  worktree: null,
  branch: null,
  ...over
})

const result = (over: Partial<SwarmTaskResult> = {}): SwarmTaskResult => ({
  status: 'done',
  summary: '14 findings',
  refs: [],
  provenance: 'claimed',
  at: 0,
  ...over
})

const task = (over: Partial<SwarmTask> = {}): SwarmTask => ({
  taskId: 't1',
  content: 'Migrate the settings schema',
  activeForm: 'Migrating settings schema…',
  state: 'in_progress',
  assignment: assign(),
  ...over
})

const ledger = (over: Partial<SwarmRunLedger> = {}): SwarmRunLedger => ({
  version: SWARM_LEDGER_VERSION,
  runId: 'r',
  boardId: 'r',
  title: 'run',
  createdAt: 0,
  lastActiveAt: 0,
  lastSeenAt: 0,
  state: 'live',
  planBoardId: null,
  planItems: [],
  tasks: [],
  events: [],
  eventSeq: 0,
  ...over
})

describe('fmtDur', () => {
  it('reads compactly at every scale', () => {
    expect(fmtDur(0)).toBe('0s')
    expect(fmtDur(45_000)).toBe('45s')
    expect(fmtDur(59_999)).toBe('59s')
    expect(fmtDur(18 * MIN)).toBe('18m')
    expect(fmtDur(125 * MIN)).toBe('2h 05m')
    expect(fmtDur(-5_000)).toBe('0s') // a clock skew must not render "-5s"
  })
})

describe('stall detection', () => {
  it('silentMs is null for an UNASSIGNED task — never 0', () => {
    // 0 would read as "just active", which is the opposite of the truth.
    expect(silentMs(task({ assignment: undefined }), 10 * MIN)).toBeNull()
    expect(silentMs(task({ assignment: assign({ lastActivityAt: 2 * MIN }) }), 10 * MIN)).toBe(
      8 * MIN
    )
  })

  it('fires only at or past the threshold', () => {
    const t = task({ assignment: assign({ lastActivityAt: 0 }) })
    expect(isStalled(t, SWARM_STALL_THRESHOLD_MS - 1)).toBe(false)
    expect(isStalled(t, SWARM_STALL_THRESHOLD_MS)).toBe(true)
    expect(isStalled(t, SWARM_STALL_THRESHOLD_MS + MIN)).toBe(true)
  })

  it('only an in_progress task can stall', () => {
    const at = 60 * MIN
    for (const state of ['pending', 'blocked', 'done', 'failed', 'cancelled'] as const) {
      expect(isStalled(task({ state }), at)).toBe(false)
    }
    expect(isStalled(task({ state: 'in_progress' }), at)).toBe(true)
  })

  it('a task blocked on a human is NOT a stall', () => {
    // needs-input is the human's turn; calling it a stall would double-report and mis-colour it.
    expect(isStalled(task({ state: 'blocked', blockedTag: 'needs_input' }), 60 * MIN)).toBe(false)
  })

  it('an un-assigned task never stalls even after an age', () => {
    expect(isStalled(task({ assignment: undefined }), 60 * MIN)).toBe(false)
  })

  it('Wait (snooze) suppresses the stall until it expires', () => {
    const t = task({ snoozedUntil: 30 * MIN })
    expect(isStalled(t, 20 * MIN)).toBe(false)
    expect(isStalled(t, 30 * MIN)).toBe(true) // the snooze is exclusive — it expires AT the mark
  })
})

describe('disclosure line', () => {
  it('names the threshold inline for a stall, and stays terse enough not to truncate', () => {
    const l = ledger({ tasks: [task({ assignment: assign({ lastActivityAt: 0 }) })] })
    const line = discloseFor(l, l.tasks[0], 18 * MIN)
    expect(line).toBe('stalled 18m · threshold 10m')
    // The card grid's minimum column is 180px; a long line would ellipsize away the disclosure.
    expect(line!.length).toBeLessThanOrEqual(34)
  })

  it('carries the exit reason AND the provenance for a lost worker', () => {
    const l = ledger({
      tasks: [
        task({
          state: 'failed',
          blockedTag: 'lost',
          result: result({
            status: 'exit 1',
            provenance: 'synthesized',
            refs: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']
          })
        })
      ]
    })
    expect(discloseFor(l, l.tasks[0], 0)).toBe('exit 1 · derived · 6 files')
  })

  it('singularises a one-file result', () => {
    const l = ledger({
      tasks: [
        task({
          state: 'failed',
          blockedTag: 'lost',
          result: result({ status: 'exit 1', refs: ['a.ts'] })
        })
      ]
    })
    expect(discloseFor(l, l.tasks[0], 0)).toContain('1 file')
    expect(discloseFor(l, l.tasks[0], 0)).not.toContain('1 files')
  })

  it('uses the plan POSITION when the task maps to a plan item', () => {
    const l = ledger({
      planItems: [
        { id: 'p1', label: 'recon', done: true },
        { id: 'p2', label: 'migrate', done: false }
      ],
      // Dispatched 12m ago but ACTIVE 1m ago — so it is healthy, not stalled.
      tasks: [
        task({
          planItemId: 'p2',
          assignment: assign({ dispatchedAt: 0, lastActivityAt: 11 * MIN })
        })
      ]
    })
    expect(discloseFor(l, l.tasks[0], 12 * MIN)).toBe('task 2 · dispatched 12m ago')
  })

  it('a stall OUTRANKS the dispatched line — the card must show why it is amber', () => {
    const l = ledger({
      planItems: [{ id: 'p1', label: 'migrate', done: false }],
      tasks: [
        task({ planItemId: 'p1', assignment: assign({ dispatchedAt: 0, lastActivityAt: 0 }) })
      ]
    })
    expect(discloseFor(l, l.tasks[0], 12 * MIN)).toBe('stalled 12m · threshold 10m')
  })

  it('falls back to the task content when the plan item is gone (a removed plan row)', () => {
    const l = ledger({ planItems: [], tasks: [task({ planItemId: 'deleted' })] })
    expect(discloseFor(l, l.tasks[0], 1 * MIN)).toContain('Migrate the settings schema')
  })
})

describe('worker states', () => {
  it('maps lost and stalled, keeps first-assignment order, and dedupes by board', () => {
    const l = ledger({
      tasks: [
        task({ taskId: 't1', assignment: assign({ boardId: 'w1', lastActivityAt: 0 }) }),
        task({
          taskId: 't2',
          state: 'failed',
          blockedTag: 'lost',
          assignment: assign({ boardId: 'w2' }),
          result: result({ status: 'exit 1', provenance: 'synthesized' })
        }),
        // A SECOND task on w1 (a reassignment) must not produce a second card.
        task({ taskId: 't3', assignment: assign({ boardId: 'w1' }) })
      ]
    })
    const states = workerStates(l, 18 * MIN)
    expect(states.map((s) => s.boardId)).toEqual(['w1', 'w2'])
    expect(states[0]).toMatchObject({ state: 'stalled', taskId: 't1', role: 'builder' })
    expect(states[1]).toMatchObject({ state: 'lost', provenance: 'synthesized' })
    expect(states[0].activity).toBe('Migrating settings schema…')
  })

  it('leaves `state` absent for a healthy worker so S1s derivation still stands', () => {
    const l = ledger({ tasks: [task({ assignment: assign({ lastActivityAt: 17 * MIN }) })] })
    expect(workerStates(l, 18 * MIN)[0].state).toBeUndefined()
  })
})

describe('triage dedupe — one row per worker (2026-07-31 user rule)', () => {
  it('a worker with several concurrent conditions keeps only its highest-risk row', () => {
    // t1 stalled (silent past threshold) + t2 an unseen unreviewed result, BOTH on w1.
    const now = SWARM_STALL_THRESHOLD_MS + MIN
    const l = ledger({
      tasks: [
        task({ taskId: 't1' }),
        task({ taskId: 't2', state: 'done', assignment: assign(), result: result({ at: 5 }) })
      ]
    })
    const rows = triageRows(l, now)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tag: 'stalled', boardId: 'w1' }) // stalled outranks unreviewed
  })

  it('dedupeTriage keeps distinct workers apart and exempts the run-level merge_ready row', () => {
    const row = (id: string, tag: SwarmTriageRow['tag'], boardId: string): SwarmTriageRow => ({
      id,
      tag,
      boardId,
      text: '',
      actions: []
    })
    const out = dedupeTriage([
      row('a', 'stalled', 'w1'),
      row('b', 'unreviewed', 'w2'),
      row('merge-sequence', 'merge_ready', 'w1'), // run-level: boardId is just the sequence head
      row('c', 'lost', 'w1')
    ])
    // w1 keeps `lost` (highest rank), w2 keeps its own row, merge_ready survives untouched.
    expect(out.map((r) => r.id).sort()).toEqual(['b', 'c', 'merge-sequence'])
  })
})

describe('triage rows', () => {
  it('never emits needs_input — that row is the renderers, from attentionStore', () => {
    const l = ledger({
      tasks: [task({ state: 'blocked', blockedTag: 'needs_input' })]
    })
    expect(triageRows(l, 60 * MIN)).toEqual([])
  })

  it('emits a lost row with Accept only when something WAS salvaged', () => {
    const salvaged = ledger({
      tasks: [
        task({
          state: 'failed',
          blockedTag: 'lost',
          result: result({ refs: ['a.ts'], provenance: 'synthesized' })
        })
      ]
    })
    const rows = triageRows(salvaged, 0)
    expect(rows[0]).toMatchObject({ tag: 'lost', boardId: 'w1', actions: ['accept', 'reassign'] })
    expect(rows[0].text).toContain('result salvaged (derived, 1 file)')

    const nothing = ledger({ tasks: [task({ state: 'failed', blockedTag: 'lost' })] })
    const bare = triageRows(nothing, 0)
    expect(bare[0].actions).toEqual(['reassign']) // no Accept when there is nothing to accept
    expect(bare[0].text).toContain('nothing salvageable')
  })

  it('a failing_check row carries the reason in the visible string', () => {
    const l = ledger({
      tasks: [
        task({
          state: 'done',
          blockedTag: 'failing_check',
          result: result({ summary: 'git_diff is empty' })
        })
      ]
    })
    expect(triageRows(l, 0)[0].text).toContain('git_diff is empty')
  })

  it('surfaces an unreviewed result only when it landed AFTER the human last looked', () => {
    const seen = ledger({
      lastSeenAt: 100,
      tasks: [task({ state: 'done', result: result({ at: 50 }) })]
    })
    expect(triageRows(seen, 200)).toEqual([])

    const fresh = ledger({
      lastSeenAt: 100,
      tasks: [task({ state: 'done', result: result({ at: 150 }) })]
    })
    expect(triageRows(fresh, 200)[0]).toMatchObject({ tag: 'unreviewed' })
    expect(triageRows(fresh, 200)[0].text).toContain('agent-claimed, unverified')
  })

  it('an accepted result leaves the queue', () => {
    const l = ledger({
      lastSeenAt: 0,
      tasks: [task({ state: 'done', result: result({ at: 150, acceptedByHuman: true }) })]
    })
    expect(triageRows(l, 200)).toEqual([])
  })

  it('a snoozed task is suppressed until the snooze expires', () => {
    const l = ledger({
      tasks: [task({ assignment: assign({ lastActivityAt: 0 }), snoozedUntil: 40 * MIN })]
    })
    expect(triageRows(l, 20 * MIN)).toEqual([])
    expect(triageRows(l, 45 * MIN)[0]).toMatchObject({ tag: 'stalled' })
  })

  it('a task with no assignment produces no row (there is no board to act on)', () => {
    const l = ledger({ tasks: [task({ assignment: undefined, state: 'pending' })] })
    expect(triageRows(l, 60 * MIN)).toEqual([])
  })

  it('orders by RISK, not by ledger order', () => {
    const l = ledger({
      lastSeenAt: 0,
      tasks: [
        task({
          taskId: 'a',
          state: 'done',
          assignment: assign({ boardId: 'w1' }),
          result: result({ at: 10 })
        }),
        task({ taskId: 'b', assignment: assign({ boardId: 'w2', lastActivityAt: 0 }) }),
        task({
          taskId: 'c',
          state: 'failed',
          blockedTag: 'lost',
          assignment: assign({ boardId: 'w3' }),
          result: result()
        }),
        task({
          taskId: 'd',
          state: 'blocked',
          blockedTag: 'dependency',
          assignment: assign({ boardId: 'w4' })
        })
      ]
    })
    expect(triageRows(l, 20 * MIN).map((r) => r.tag)).toEqual([
      'lost',
      'stalled',
      'dependency',
      'unreviewed'
    ])
  })

  it('sortTriage is stable within a tag and tolerates an unknown tag', () => {
    const rows = [
      { id: '1', tag: 'stalled', boardId: 'w1', text: 'first', actions: [] },
      { id: '2', tag: 'lost', boardId: 'w2', text: '', actions: [] },
      { id: '3', tag: 'stalled', boardId: 'w3', text: 'second', actions: [] },
      { id: '4', tag: 'bogus' as never, boardId: 'w4', text: '', actions: [] }
    ] as SwarmTriageRow[]
    const out = sortTriage(rows)
    expect(out.map((r) => r.id)).toEqual(['2', '1', '3', '4']) // unknown sinks to the bottom
  })

  it('needs_input sorts ahead of every ledger row once the renderer merges the two sources', () => {
    const ledgerRows = triageRows(
      ledger({ tasks: [task({ state: 'failed', blockedTag: 'lost', result: result() })] }),
      0
    )
    const fromAttention: SwarmTriageRow = {
      id: 'w9',
      tag: 'needs_input',
      boardId: 'w9',
      text: 'asks a question',
      actions: ['open']
    }
    expect(sortTriage([...ledgerRows, fromAttention])[0].tag).toBe('needs_input')
    expect(SWARM_BLOCKED_TAGS[0]).toBe('needs_input') // the ordering contract itself
  })
})

describe('buildSnapshot', () => {
  it('counts workers and results, and reports restored only when told', () => {
    const l = ledger({
      planBoardId: 'plan1',
      tasks: [
        task({
          taskId: 't1',
          assignment: assign({ boardId: 'w1' }),
          state: 'done',
          result: result()
        }),
        task({ taskId: 't2', assignment: assign({ boardId: 'w2' }) })
      ]
    })
    const snap = buildSnapshot(l, { now: 0, restored: true })
    expect(snap).toMatchObject({
      runId: 'r',
      state: 'live',
      restored: true,
      planBoardId: 'plan1',
      counts: { workers: 2, results: 1 }
    })
    expect(buildSnapshot(l, { now: 0 }).restored).toBe(false)
  })

  it('honours a caller-supplied threshold (so tests and settings can both drive it)', () => {
    const l = ledger({ tasks: [task({ assignment: assign({ lastActivityAt: 0 }) })] })
    expect(buildSnapshot(l, { now: 5 * MIN }).workers[0].state).toBeUndefined()
    expect(buildSnapshot(l, { now: 5 * MIN, thresholdMs: 1 * MIN }).workers[0].state).toBe(
      'stalled'
    )
  })

  it('carries no raw task specs to the renderer', () => {
    const l = ledger({
      tasks: [
        task({
          assignment: assign({
            spec: { objective: 'SECRET-OBJECTIVE', context: '', boundaries: '', outputFormat: '' }
          })
        })
      ]
    })
    expect(JSON.stringify(buildSnapshot(l, { now: 0 }))).not.toContain('SECRET-OBJECTIVE')
  })
})

// ── S3 · worktree isolation + integration ──

/** A finished, isolated worker: its own tree, its own branch, a settled result with refs. */
const isolated = (
  id: string,
  over: { refs?: string[]; state?: SwarmTask['state']; planItemId?: string } = {}
): SwarmTask =>
  task({
    taskId: id,
    state: over.state ?? 'done',
    ...(over.planItemId ? { planItemId: over.planItemId } : {}),
    assignment: assign({
      boardId: `b-${id}`,
      worktree: `M:/proj/.canvas/worktrees/${id}`,
      branch: `swarm/rrrr/${id}`
    }),
    result: result({ refs: over.refs ?? [] })
  })

const wtStatuses = (
  dirty: string[] = []
): Record<string, { exists: boolean; dirty: boolean; changed: number }> =>
  Object.fromEntries(
    ['t1', 't2', 't3'].map((id) => [
      `M:/proj/.canvas/worktrees/${id}`,
      { exists: true, dirty: dirty.includes(id), changed: dirty.includes(id) ? 7 : 0 }
    ])
  )

describe('S3 · worktreeChipFor — the card line (variant C)', () => {
  it('is ABSENT for a worker with no worktree, so a read-only card is unchanged from S2', () => {
    const states = workerStates(ledger({ tasks: [task()] }), 0)
    expect(states[0].worktree).toBeUndefined()
  })

  it('a working isolated builder shows its live changed count', () => {
    const t = task({ assignment: assign({ worktree: '/wt/b1', branch: 'swarm/r/b1' }) })
    const [w] = workerStates(ledger({ tasks: [t] }), 0, SWARM_STALL_THRESHOLD_MS, {
      '/wt/b1': { exists: true, dirty: true, changed: 4 }
    })
    expect(w.worktree).toMatchObject({ branch: 'swarm/r/b1', leaf: 'b1', note: '4 files' })
    // A RUNNING worker's dirty tree is normal work in progress, never a "kept" preservation.
    expect(w.worktree?.dirty).toBeUndefined()
  })

  it('a working builder that has changed nothing yet says so rather than implying progress', () => {
    const t = task({ assignment: assign({ worktree: '/wt/b1', branch: 'swarm/r/b1' }) })
    const [w] = workerStates(ledger({ tasks: [t] }), 0, SWARM_STALL_THRESHOLD_MS, {
      '/wt/b1': { exists: true, dirty: false, changed: 0 }
    })
    expect(w.worktree?.note).toBe('no changes yet')
  })

  it('a finished clean worker reads as ready, with its own reported file count', () => {
    const t = isolated('t1', { refs: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
    const [w] = workerStates(ledger({ tasks: [t] }), 0, SWARM_STALL_THRESHOLD_MS, wtStatuses())
    expect(w.worktree?.note).toBe('3 files · ready')
  })

  it('🔒 a finished DIRTY worker says KEPT — the string must never read as lost or deleted', () => {
    const t = isolated('t1')
    const [w] = workerStates(
      ledger({ tasks: [t] }),
      0,
      SWARM_STALL_THRESHOLD_MS,
      wtStatuses(['t1'])
    )
    expect(w.worktree?.note).toBe('kept, 7 uncommitted')
    expect(w.worktree?.dirty).toBe(true)
  })

  it('a removed tree still shows the branch — that is what survives and what gets merged', () => {
    const t = isolated('t1')
    const [w] = workerStates(ledger({ tasks: [t] }), 0, SWARM_STALL_THRESHOLD_MS, {
      'M:/proj/.canvas/worktrees/t1': { exists: false, dirty: false, changed: 0 }
    })
    expect(w.worktree?.note).toContain('branch only')
  })

  it('an UNKNOWN status (not statted yet) never claims clean-and-ready', () => {
    const t = task({ assignment: assign({ worktree: '/wt/b1', branch: 'swarm/r/b1' }) })
    const [w] = workerStates(ledger({ tasks: [t] }), 0)
    expect(w.worktree?.note).toBe('working')
  })
})

describe('S3 · merge sequence', () => {
  it('is empty while any of a branch task is still in progress', () => {
    const live = task({
      taskId: 't1',
      state: 'in_progress',
      assignment: assign({ worktree: '/wt/a', branch: 'swarm/r/a' })
    })
    expect(buildSnapshot(ledger({ tasks: [live] }), { now: 0 }).mergeSequence).toEqual([])
  })

  it('orders by plan-item position first, then dispatch time', () => {
    const l = ledger({
      planItems: [
        { id: 'p1', label: 'one', done: false },
        { id: 'p2', label: 'two', done: false }
      ],
      tasks: [
        isolated('t2', { planItemId: 'p2' }),
        isolated('t1', { planItemId: 'p1' }),
        isolated('t3') // no plan item → sorts after the mapped ones
      ]
    })
    expect(buildSnapshot(l, { now: 0 }).mergeSequence.map((s) => s.taskId)).toEqual([
      't1',
      't2',
      't3'
    ])
  })

  it('counts DISTINCT files — `x.ts` and `x.ts:42` are one file, not two', () => {
    const l = ledger({ tasks: [isolated('t1', { refs: ['src/x.ts', 'src/x.ts:42'] })] })
    expect(buildSnapshot(l, { now: 0 }).mergeSequence[0].files).toBe(1)
  })

  it('collapses a second task on the same worker onto ONE branch entry carrying both refs', () => {
    const l = ledger({
      tasks: [
        isolated('t1', { refs: ['src/a.ts'] }),
        // Same board, same branch — the orchestrator handed it a second task.
        task({
          taskId: 't2',
          state: 'done',
          assignment: assign({
            boardId: 'b-t1',
            worktree: 'M:/proj/.canvas/worktrees/t1',
            branch: 'swarm/rrrr/t1'
          }),
          result: result({ refs: ['src/b.ts'] })
        })
      ]
    })
    const seq = buildSnapshot(l, { now: 0 }).mergeSequence
    expect(seq).toHaveLength(1)
    expect(seq[0].files).toBe(2)
  })

  it('marks the later branch as overlapping the earlier one', () => {
    const l = ledger({
      tasks: [
        isolated('t1', { refs: ['src/main/load.ts'] }),
        isolated('t2', { refs: ['./src/main/LOAD.ts'] })
      ]
    })
    const seq = buildSnapshot(l, { now: 0 }).mergeSequence
    expect(seq[0].overlapsWith).toEqual([])
    expect(seq[1].overlapsWith).toEqual([1])
  })
})

describe('S3 · triage rows', () => {
  it('an overlap row names both workers by ID (MAIN is never a title authority)', () => {
    const l = ledger({
      tasks: [isolated('t1', { refs: ['src/x.ts'] }), isolated('t2', { refs: ['src/x.ts'] })]
    })
    const rows = triageRows(l, 0, SWARM_STALL_THRESHOLD_MS, wtStatuses())
    const overlap = rows.find((r) => r.tag === 'overlap')!
    expect(overlap.boardId).toBe('b-t2') // the LATER one — the branch that has to rebase
    expect(overlap.boardId2).toBe('b-t1')
    expect(overlap.text).toContain('src/x.ts')
    expect(overlap.text).toContain('rebase the other')
    // No title ever leaks into MAIN's string.
    expect(overlap.text).not.toContain('builder')
  })

  it('🔒 the dirty-worktree row says KEPT and NOTHING DISCARDED — the reassurance is the row', () => {
    const l = ledger({ tasks: [isolated('t1')] })
    const rows = triageRows(l, 0, SWARM_STALL_THRESHOLD_MS, wtStatuses(['t1']))
    const row = rows.find((r) => r.tag === 'dirty_worktree')!
    expect(row.text).toContain('7 uncommitted files')
    expect(row.text).toContain('kept on disk, nothing discarded')
    expect(row.actions).toEqual(['resolve'])
  })

  it('a RUNNING worker dirty tree raises no row — that would be a nag, not triage', () => {
    const live = task({
      taskId: 't1',
      state: 'in_progress',
      assignment: assign({
        boardId: 'b-t1',
        worktree: 'M:/proj/.canvas/worktrees/t1',
        branch: 'swarm/rrrr/t1'
      })
    })
    const rows = triageRows(
      ledger({ tasks: [live] }),
      0,
      SWARM_STALL_THRESHOLD_MS,
      wtStatuses(['t1'])
    )
    expect(rows.some((r) => r.tag === 'dirty_worktree')).toBe(false)
  })

  it('emits exactly ONE merge-ready row per run, however many branches there are', () => {
    const l = ledger({ tasks: [isolated('t1'), isolated('t2'), isolated('t3')] })
    const rows = triageRows(l, 0, SWARM_STALL_THRESHOLD_MS, wtStatuses())
    const merge = rows.filter((r) => r.tag === 'merge_ready')
    expect(merge).toHaveLength(1)
    expect(merge[0].text).toContain('3 branches ready to merge')
    // No ledger action: the sequence is the deliverable, and there is no merge button anywhere.
    expect(merge[0].actions).toEqual([])
  })

  it('the merge-ready row discloses the overlap and dirty counts it is summarising', () => {
    const l = ledger({
      tasks: [isolated('t1', { refs: ['src/x.ts'] }), isolated('t2', { refs: ['src/x.ts'] })]
    })
    const rows = triageRows(l, 0, SWARM_STALL_THRESHOLD_MS, wtStatuses(['t2']))
    const merge = rows.find((r) => r.tag === 'merge_ready')!
    expect(merge.text).toContain('1 overlap')
    expect(merge.text).toContain('1 with uncommitted changes')
  })

  it('no isolated finished worker ⇒ no integration rows at all (the queue stays quiet)', () => {
    const rows = triageRows(ledger({ tasks: [task()] }), 0)
    expect(rows.some((r) => ['overlap', 'dirty_worktree', 'merge_ready'].includes(r.tag))).toBe(
      false
    )
  })

  it('risk order: overlap outranks stalled, merge_ready sorts last', () => {
    const stalledTask = task({
      taskId: 't9',
      state: 'in_progress',
      assignment: assign({ boardId: 'b-t9', lastActivityAt: -SWARM_STALL_THRESHOLD_MS * 2 })
    })
    const l = ledger({
      tasks: [
        isolated('t1', { refs: ['src/x.ts'] }),
        isolated('t2', { refs: ['src/x.ts'] }),
        stalledTask
      ]
    })
    const tags = triageRows(l, 0, SWARM_STALL_THRESHOLD_MS, wtStatuses()).map((r) => r.tag)
    expect(tags.indexOf('overlap')).toBeLessThan(tags.indexOf('stalled'))
    expect(tags[tags.length - 1]).toBe('merge_ready')
  })
})

describe('S3 · 🔒 a REUSED worker never exposes its live worktree to a destructive action', () => {
  /**
   * The PR #394 `[critical]`. A worker handed a second task keeps ONE worktree, so the ledger holds
   * an older FINISHED task and a newer `in_progress` one pointing at the same tree. The row loop
   * skipped the in-progress record but did not mark its worktree seen, so it fell through to the
   * finished task and emitted a `dirty_worktree` row describing dirt the STILL-RUNNING worker was
   * producing — whose only action, `resolve` → Discard, would `git clean -fd` live work.
   */
  const reused = (): SwarmRunLedger =>
    ledger({
      tasks: [
        // Older, finished — the row used to anchor here.
        task({
          taskId: 't1',
          state: 'done',
          assignment: assign({
            boardId: 'b1',
            worktree: 'M:/proj/.canvas/worktrees/t1',
            branch: 'swarm/rrrr/t1'
          }),
          result: result({ refs: ['src/a.ts'] })
        }),
        // Newer, RUNNING, same worker and therefore the same tree.
        task({
          taskId: 't2',
          state: 'in_progress',
          assignment: assign({
            boardId: 'b1',
            worktree: 'M:/proj/.canvas/worktrees/t1',
            branch: 'swarm/rrrr/t1'
          })
        })
      ]
    })

  it('raises NO dirty_worktree row for a tree a newer task is still writing to', () => {
    const rows = triageRows(reused(), 0, SWARM_STALL_THRESHOLD_MS, wtStatuses(['t1']))
    expect(rows.some((r) => r.tag === 'dirty_worktree')).toBe(false)
  })

  it('and keeps that branch out of the merge sequence — it is not finished', () => {
    expect(buildSnapshot(reused(), { now: 0 }).mergeSequence).toEqual([])
  })

  it('liveWorktrees is the single definition of busy, keyed off the TREE not the task', () => {
    expect(liveWorktrees(reused())).toEqual(['M:/proj/.canvas/worktrees/t1'])
    // A run whose only task is finished has no live tree.
    expect(liveWorktrees(ledger({ tasks: [isolated('t1')] }))).toEqual([])
  })

  it('still rows a genuinely idle dirty tree, so the fix did not silence the feature', () => {
    const rows = triageRows(
      ledger({ tasks: [isolated('t1'), isolated('t2')] }),
      0,
      SWARM_STALL_THRESHOLD_MS,
      wtStatuses(['t1'])
    )
    expect(rows.filter((r) => r.tag === 'dirty_worktree')).toHaveLength(1)
  })
})

describe('planHolders — the plan-kanban worker mapping (planOwners twin)', () => {
  const plan = (over: Partial<SwarmRunLedger> = {}): SwarmRunLedger =>
    ledger({
      planItems: [
        { id: 'i1', label: 'held', done: false, ownerTaskId: 't1' },
        { id: 'i2', label: 'free', done: false },
        { id: 'i3', label: 'settled owner', done: false, ownerTaskId: 't2' }
      ],
      tasks: [
        task({ taskId: 't1', assignment: assign({ boardId: 'w1' }) }),
        task({ taskId: 't2', state: 'done', assignment: assign({ boardId: 'w2' }) })
      ],
      ...over
    })

  it('maps a held item to its worker BOARD, and only a live in_progress hold counts', () => {
    expect(planHolders(plan())).toEqual({ i1: 'w1' })
  })

  it('keys agree with planOwners exactly — dot and column can never disagree', () => {
    const l = plan()
    expect(Object.keys(planHolders(l))).toEqual(Object.keys(planOwners(l, 0)))
  })

  it('rides the snapshot', () => {
    expect(buildSnapshot(plan(), { now: 0 }).planHolders).toEqual({ i1: 'w1' })
  })
})
