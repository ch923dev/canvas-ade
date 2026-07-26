import { describe, expect, it, vi } from 'vitest'
import {
  coerceLedger,
  createSwarmLedgerStore,
  runWorkerIds,
  setBlockedTag,
  setTaskState,
  taskForBoard,
  unsettledTasks,
  type LedgerMemory
} from './swarmLedger'
import {
  MAX_LEDGER_EVENTS,
  MAX_LEDGER_REFS,
  MAX_RUNS_PER_PROJECT,
  SWARM_LEDGER_VERSION,
  type SwarmRunLedger
} from '../shared/swarmLedgerTypes'

/**
 * An in-memory stand-in for `canvasMemory`'s run-sidecar slice. Round-trips through JSON exactly
 * like the real atomic writer does, so a value the store cannot serialize fails here too.
 */
function memoryStub(seed: Record<string, unknown> = {}): LedgerMemory & {
  files: Map<string, string>
  writes: number
} {
  const files = new Map<string, string>(
    Object.entries(seed).map(([id, v]) => [id, JSON.stringify(v)])
  )
  const api = {
    files,
    writes: 0,
    writeRun(id: string, data: unknown): boolean {
      api.writes += 1
      files.set(id, JSON.stringify(data))
      return true
    },
    readRun(id: string): unknown {
      const raw = files.get(id)
      if (raw === undefined) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    },
    removeRun(id: string): void {
      files.delete(id)
    },
    listRunIds(): string[] {
      return [...files.keys()]
    }
  }
  return api
}

const storeWith = (
  mem: LedgerMemory,
  dir: string | null = '/proj',
  now = (): number => 1_000
): ReturnType<typeof createSwarmLedgerStore> =>
  createSwarmLedgerStore({ getProjectDir: () => dir, now, memoryFor: () => mem })

describe('swarmLedger — persistence', () => {
  it('creates a run on first touch and reloads it verbatim from disk', () => {
    const mem = memoryStub()
    const a = storeWith(mem)
    const made = a.ensureRun('board1', 'migrate settings')
    expect(made?.runId).toBe('board1')
    expect(made?.boardId).toBe('board1')
    expect(made?.title).toBe('migrate settings')
    expect(made?.state).toBe('live')
    expect(made?.events[0]).toMatchObject({ seq: 1, kind: 'runCreated' })

    // A COLD store (fresh cache) must read the same run back off the stub's bytes.
    const b = storeWith(mem)
    expect(b.readRun('board1')).toMatchObject({ runId: 'board1', title: 'migrate settings' })
  })

  it('ensureRun is idempotent — a second call returns the existing run, not a fresh one', () => {
    const mem = memoryStub()
    const store = storeWith(mem)
    const first = store.ensureRun('board1', 'first title')
    store.update('board1', (l) => {
      l.tasks.push({
        taskId: 't1',
        content: 'do it',
        activeForm: 'doing it',
        state: 'in_progress'
      })
    })
    const second = store.ensureRun('board1', 'DIFFERENT title')
    expect(second?.createdAt).toBe(first?.createdAt)
    expect(second?.title).toBe('first title') // not overwritten by the second call's title
    expect(second?.tasks).toHaveLength(1)
  })

  it('no project dir ⇒ every call no-ops instead of throwing', () => {
    const mem = memoryStub()
    const store = storeWith(mem, null)
    expect(store.ensureRun('board1', 't')).toBeNull()
    expect(store.readRun('board1')).toBeNull()
    expect(store.update('board1', () => {})).toBeNull()
    expect(store.append('board1', { kind: 'taskCreated', taskId: 't1' })).toBeNull()
    expect(store.listRuns()).toEqual([])
    expect(mem.writes).toBe(0)
  })

  it('drops the cache and rebinds when the project dir changes mid-session', () => {
    const memA = memoryStub()
    const memB = memoryStub()
    let dir = '/projA'
    const store = createSwarmLedgerStore({
      getProjectDir: () => dir,
      now: () => 1_000,
      memoryFor: (d) => (d === '/projA' ? memA : memB)
    })
    store.ensureRun('board1', 'in A')
    expect(memA.files.has('board1')).toBe(true)

    dir = '/projB'
    // The SAME board id in another project must not serve project A's cached ledger.
    expect(store.readRun('board1')).toBeNull()
    store.ensureRun('board1', 'in B')
    expect(memB.files.has('board1')).toBe(true)
    expect(JSON.parse(memA.files.get('board1') as string).title).toBe('in A')
  })

  it('append stamps a gap-free monotonic seq', () => {
    const store = storeWith(memoryStub())
    store.ensureRun('board1', 't')
    store.append('board1', { kind: 'taskCreated', taskId: 't1' })
    const l = store.append('board1', { kind: 'taskCreated', taskId: 't2' })
    expect(l?.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(l?.eventSeq).toBe(3)
  })
})

describe('swarmLedger — hostile input', () => {
  it('a corrupt sidecar reads as absent and is safely overwritten by a fresh run', () => {
    const mem = memoryStub()
    mem.files.set('board1', '{ this is not json')
    const store = storeWith(mem)
    expect(store.readRun('board1')).toBeNull()
    const fresh = store.ensureRun('board1', 'recovered')
    expect(fresh?.title).toBe('recovered')
  })

  it('a FUTURE version is never parsed AND never overwritten', () => {
    const mem = memoryStub()
    const future = { version: SWARM_LEDGER_VERSION + 1, boardId: 'board1', title: 'from tomorrow' }
    mem.files.set('board1', JSON.stringify(future))
    const store = storeWith(mem)
    expect(store.readRun('board1')).toBeNull()
    // The run degrades to ephemeral-only rather than destroying a newer app's data.
    expect(store.ensureRun('board1', 'clobber me')).toBeNull()
    expect(JSON.parse(mem.files.get('board1') as string)).toEqual(future)
    expect(mem.writes).toBe(0)
  })

  it('rejects a sidecar whose body claims a different board than its filename', () => {
    // A hand-copied ledger must not be able to redirect writes at another run.
    const raw = { version: SWARM_LEDGER_VERSION, boardId: 'someone-else', title: 'x' }
    expect(coerceLedger(raw, 'board1', 0)).toBeNull()
  })

  it('coerces garbage fields to safe defaults rather than propagating them', () => {
    const l = coerceLedger(
      {
        version: SWARM_LEDGER_VERSION,
        boardId: 'b',
        title: 42,
        state: 'exploded',
        createdAt: 'nope',
        planBoardId: 7,
        planItems: [{ id: 'p1', label: 'ok', done: 'yes' }, { label: 'no id' }, null],
        tasks: [
          { taskId: 't1', state: 'weird', result: { status: 'ok', provenance: 'invented' } },
          { content: 'no id' }
        ],
        events: [{ seq: 3, at: 1, kind: 'taskCreated', taskId: 't1' }, { kind: 'no seq' }]
      },
      'b',
      500
    )
    expect(l).not.toBeNull()
    expect(l?.title).toBe('') // a non-string title becomes empty, not "42"
    expect(l?.state).toBe('live') // off-vocabulary state falls back
    expect(l?.createdAt).toBe(500) // non-numeric timestamp takes `now`
    expect(l?.planBoardId).toBeNull() // non-string id becomes null
    expect(l?.planItems).toHaveLength(1) // the id-less and null items are dropped
    expect(l?.planItems[0].done).toBe(false) // 'yes' is not `true`
    expect(l?.tasks).toHaveLength(1) // the id-less task is dropped
    expect(l?.tasks[0].state).toBe('pending')
    expect(l?.tasks[0].result?.provenance).toBe('claimed') // off-vocabulary provenance falls back
    expect(l?.events).toHaveLength(1) // the seq-less event is DROPPED, never fabricated
    expect(l?.eventSeq).toBe(3) // seq stays monotonic across the reload
  })

  it('preserves S3 worktree/branch if a future build wrote them, else keeps them null', () => {
    const l = coerceLedger(
      {
        version: SWARM_LEDGER_VERSION,
        boardId: 'b',
        tasks: [
          { taskId: 't1', assignment: { boardId: 'w1', worktree: '/wt/a', branch: 'feat/a' } },
          { taskId: 't2', assignment: { boardId: 'w2' } }
        ]
      },
      'b',
      0
    )
    expect(l?.tasks[0].assignment).toMatchObject({ worktree: '/wt/a', branch: 'feat/a' })
    // S2 writes null — the field must EXIST so S3 needs no format bump.
    expect(l?.tasks[1].assignment?.worktree).toBeNull()
    expect(l?.tasks[1].assignment?.branch).toBeNull()
  })
})

describe('swarmLedger — caps and retention', () => {
  it('clamps the event tail to the newest MAX_LEDGER_EVENTS', () => {
    const store = storeWith(memoryStub())
    store.ensureRun('board1', 't')
    const l = store.update('board1', (draft) => {
      for (let i = 0; i < MAX_LEDGER_EVENTS + 50; i++) {
        draft.eventSeq += 1
        draft.events.push({ seq: draft.eventSeq, at: i, kind: 'taskCreated', taskId: `t${i}` })
      }
    })
    expect(l?.events).toHaveLength(MAX_LEDGER_EVENTS)
    // The OLDEST are dropped — a stale event is worth less than a fresh one.
    expect(l?.events[l.events.length - 1].seq).toBe(l?.eventSeq)
  })

  it('clamps a result refs array to MAX_LEDGER_REFS', () => {
    const store = storeWith(memoryStub())
    store.ensureRun('board1', 't')
    const l = store.update('board1', (draft) => {
      draft.tasks.push({
        taskId: 't1',
        content: 'c',
        activeForm: 'a',
        state: 'done',
        result: {
          status: 'done',
          summary: 's',
          refs: Array.from({ length: MAX_LEDGER_REFS + 40 }, (_, i) => `f${i}.ts`),
          provenance: 'claimed',
          at: 1
        }
      })
    })
    expect(l?.tasks[0].result?.refs).toHaveLength(MAX_LEDGER_REFS)
  })

  it('prunes to the newest MAX_RUNS_PER_PROJECT ledgers, always keeping the one just written', () => {
    const mem = memoryStub()
    // Seed MAX+5 old runs, oldest first by lastActiveAt.
    const total = MAX_RUNS_PER_PROJECT + 5
    for (let i = 0; i < total; i++) {
      mem.files.set(
        `old${i}`,
        JSON.stringify({
          version: SWARM_LEDGER_VERSION,
          runId: `old${i}`,
          boardId: `old${i}`,
          title: `run ${i}`,
          createdAt: i,
          lastActiveAt: i,
          lastSeenAt: i,
          state: 'live',
          planBoardId: null,
          planItems: [],
          tasks: [],
          events: [],
          eventSeq: 0
        })
      )
    }
    const store = storeWith(mem, '/proj', () => 9_999)
    store.ensureRun('fresh', 'the new one')

    expect(mem.files.size).toBe(MAX_RUNS_PER_PROJECT)
    expect(mem.files.has('fresh')).toBe(true) // the run just written is never a victim
    expect(mem.files.has('old0')).toBe(false) // the oldest went first
    expect(mem.files.has(`old${total - 1}`)).toBe(true) // the newest old run survived
  })

  it('never prunes a sidecar it could not parse', () => {
    const mem = memoryStub()
    for (let i = 0; i < MAX_RUNS_PER_PROJECT + 3; i++) mem.files.set(`junk${i}`, 'not json')
    const store = storeWith(mem)
    store.ensureRun('fresh', 'x')
    // Pruning is a size guard, not a cleaner of files we cannot read.
    expect(mem.files.size).toBe(MAX_RUNS_PER_PROJECT + 4)
  })

  it('listRuns returns readable ledgers newest-first and skips unreadable ones', () => {
    const mem = memoryStub()
    const mk = (id: string, at: number): void => {
      mem.files.set(
        id,
        JSON.stringify({
          version: SWARM_LEDGER_VERSION,
          boardId: id,
          createdAt: at,
          lastActiveAt: at,
          state: 'live',
          planItems: [],
          tasks: [],
          events: []
        })
      )
    }
    mk('a', 10)
    mk('b', 30)
    mk('c', 20)
    mem.files.set('broken', '{{{')
    expect(
      storeWith(mem)
        .listRuns()
        .map((l) => l.runId)
    ).toEqual(['b', 'c', 'a'])
  })

  it('removeRun deletes the sidecar and forgets the cache entry', () => {
    const mem = memoryStub()
    const store = storeWith(mem)
    store.ensureRun('board1', 't')
    store.removeRun('board1')
    expect(mem.files.has('board1')).toBe(false)
    expect(store.readRun('board1')).toBeNull()
  })

  it('a failed write reports null without throwing', () => {
    const mem = memoryStub()
    const failing: LedgerMemory = { ...mem, writeRun: vi.fn(() => false) }
    expect(storeWith(failing).ensureRun('board1', 't')).toBeNull()
  })
})

describe('swarmLedger — task helpers', () => {
  const ledger = (): SwarmRunLedger => ({
    version: SWARM_LEDGER_VERSION,
    runId: 'r',
    boardId: 'r',
    title: 't',
    createdAt: 0,
    lastActiveAt: 0,
    lastSeenAt: 0,
    state: 'live',
    planBoardId: null,
    planItems: [],
    tasks: [
      {
        taskId: 't1',
        content: 'a',
        activeForm: 'a-ing',
        state: 'in_progress',
        assignment: {
          boardId: 'w1',
          role: 'builder',
          spec: { objective: '', context: '', boundaries: '', outputFormat: '' },
          dispatchedAt: 0,
          lastActivityAt: 0,
          stallCount: 0,
          worktree: null,
          branch: null
        }
      },
      { taskId: 't2', content: 'b', activeForm: 'b-ing', state: 'done' },
      {
        taskId: 't3',
        content: 'c',
        activeForm: 'c-ing',
        state: 'blocked',
        assignment: {
          boardId: 'w2',
          role: 'reviewer',
          spec: { objective: '', context: '', boundaries: '', outputFormat: '' },
          dispatchedAt: 0,
          lastActivityAt: 0,
          stallCount: 0,
          worktree: null,
          branch: null
        }
      }
    ],
    events: [],
    eventSeq: 0
  })

  it('taskForBoard / runWorkerIds / unsettledTasks read the assignment map', () => {
    const l = ledger()
    expect(taskForBoard(l, 'w1')?.taskId).toBe('t1')
    expect(taskForBoard(l, 'nope')).toBeUndefined()
    expect(runWorkerIds(l)).toEqual(['w1', 'w2'])
    expect(unsettledTasks(l).map((t) => t.taskId)).toEqual(['t1', 't3'])
  })

  it('setTaskState records the transition and a terminal state clears the blocked tag', () => {
    const l = ledger()
    setBlockedTag(l, 't1', 'stalled', 5)
    expect(l.tasks[0].blockedTag).toBe('stalled')
    expect(l.events.at(-1)).toMatchObject({ kind: 'blocked', tag: 'stalled', seq: 1 })

    setTaskState(l, 't1', 'done', 6, 'synthesized')
    expect(l.tasks[0].state).toBe('done')
    expect(l.tasks[0].blockedTag).toBeUndefined() // a done task is not still "stalled"
    expect(l.events.at(-1)).toMatchObject({
      kind: 'status',
      state: 'done',
      provenance: 'synthesized'
    })
  })

  it('setBlockedTag is a no-op when the tag is unchanged (no duplicate events)', () => {
    const l = ledger()
    setBlockedTag(l, 't1', 'stalled', 5)
    setBlockedTag(l, 't1', 'stalled', 6)
    expect(l.events).toHaveLength(1)
  })
})
