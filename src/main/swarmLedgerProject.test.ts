import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  discloseFor,
  fmtDur,
  isStalled,
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
