import { describe, expect, it } from 'vitest'
import { createSwarmLedgerStore, type LedgerMemory } from './swarmLedger'
import { createSwarmLedgerSession } from './swarmLedgerSession'
import { SWARM_STALL_THRESHOLD_MS, type SwarmTask } from '../shared/swarmLedgerTypes'

/**
 * `applyAction` is the one place a RENDERER click becomes a durable ledger write, so it is the one
 * place the trust boundary has to hold: "the reply proposes, MAIN disposes". These cover the two
 * ways that failed — an action applied to a task whose row never offered it, and an Accept that
 * changed a flag nothing reads.
 */
function memoryStub(): LedgerMemory {
  const files = new Map<string, string>()
  return {
    writeRun: (id, data) => (files.set(id, JSON.stringify(data)), true),
    readRun: (id) => {
      const raw = files.get(id)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    removeRun: (id) => void files.delete(id),
    listRunIds: () => [...files.keys()]
  }
}

const MIN = 60_000

function assignment(at: number): NonNullable<SwarmTask['assignment']> {
  return {
    boardId: 'w1',
    role: 'builder',
    spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
    dispatchedAt: at,
    lastActivityAt: at,
    stallCount: 0,
    worktree: null,
    branch: null
  }
}

/** One run, one task, at a fixed clock. `task` patches the seeded task into the shape under test. */
function session(task: Partial<SwarmTask>, at = 5 * MIN) {
  const store = createSwarmLedgerStore({
    getProjectDir: () => '/proj',
    now: () => at,
    memoryFor: () => memoryStub()
  })
  store.ensureRun('run1', 'ship the thing')
  store.update('run1', (l) => {
    l.planItems = [{ id: 'p1', label: 'Migrate the readers', done: false }]
    l.tasks.push({
      taskId: 't1',
      planItemId: 'p1',
      content: 'Migrate the readers',
      activeForm: 'Migrating readers…',
      state: 'in_progress',
      assignment: assignment(at),
      ...task
    } as SwarmTask)
  })
  return {
    store,
    ledger: createSwarmLedgerSession('run1', { store, now: () => at }),
    read: () => store.readRun('run1')!
  }
}

const salvaged = {
  status: 'partial',
  summary: 'touched 6 files',
  refs: ['a', 'b'],
  provenance: 'synthesized' as const,
  at: 4 * MIN
}

describe('applyAction — the action must be one the row actually offered', () => {
  it('🔒 refuses `reassign` on a healthy in-progress task and leaves its assignment intact', () => {
    // The attack this closes is mundane: a stale row id (the queue moves under the human) or a
    // buggy renderer. Before the gate this wiped a LIVE worker's assignment and told the
    // orchestrator to dispatch the task again.
    const s = session({})
    expect(s.ledger.applyAction('t1', 'reassign')).toEqual({ ok: false })
    const t = s.read().tasks[0]
    expect(t.state).toBe('in_progress')
    expect(t.assignment?.boardId).toBe('w1')
  })

  it('refuses `dismiss` on a task whose row never offered it', () => {
    const s = session({})
    expect(s.ledger.applyAction('t1', 'dismiss')).toEqual({ ok: false })
    expect(s.read().tasks[0].dismissed).toBeUndefined()
  })

  it('refuses `wait` on a task that is not stalled', () => {
    const s = session({})
    expect(s.ledger.applyAction('t1', 'wait')).toEqual({ ok: false })
    expect(s.read().tasks[0].snoozedUntil).toBeUndefined()
  })

  it('allows `wait` once the task IS stalled (the row offers it)', () => {
    const at = 20 * MIN // silence since t=0, well past the 10m threshold
    const s = session({ assignment: { ...assignment(0), lastActivityAt: 0 } }, at)
    expect(SWARM_STALL_THRESHOLD_MS).toBeLessThan(at) // the seed really is past the threshold
    expect(s.ledger.applyAction('t1', 'wait').ok).toBe(true)
    expect(s.read().tasks[0].snoozedUntil).toBe(at + SWARM_STALL_THRESHOLD_MS)
  })

  it('allows `reassign` on a LOST task, un-assigning it and handing back a prompt', () => {
    const s = session({ state: 'blocked', blockedTag: 'lost' })
    const r = s.ledger.applyAction('t1', 'reassign')
    expect(r.ok).toBe(true)
    expect(r.prompt).toContain('Reassign')
    const t = s.read().tasks[0]
    expect(t.state).toBe('pending')
    expect(t.assignment).toBeUndefined()
  })
})

describe('a REUSED worker board (the same board takes a second task)', () => {
  it('🔒 settles onto the task the worker is currently working, not its first-ever one', async () => {
    // A finished task keeps its `assignment` — that is the run's record of who did the work — so a
    // board handed a second task matches two rows. A first-match lookup resolved to the FIRST one
    // forever: task 2's result landed on task 1 (overwriting it) while task 2 never left
    // `in_progress`, so its card spun and its plan item never released its owner dot.
    const at = 5 * MIN
    const store = createSwarmLedgerStore({
      getProjectDir: () => '/proj',
      now: () => at,
      memoryFor: () => memoryStub()
    })
    const ledger = createSwarmLedgerSession('run1', { store, now: () => at })
    ledger.ensure('ship the thing')
    const hooks = ledger.hooks(() => null)
    const spec = { objective: 'first', context: 'c', boundaries: 'b', outputFormat: 'f' }

    await hooks.dispatched({ workerId: 'w1', role: 'builder', spec })
    await hooks.settled({
      workerId: 'w1',
      status: 'ok',
      summary: 'first done',
      refs: [],
      provenance: 'claimed'
    })
    // …the worker goes idle and the orchestrator hands it the next task.
    await hooks.dispatched({
      workerId: 'w1',
      role: 'builder',
      spec: { ...spec, objective: 'second' }
    })
    await hooks.settled({
      workerId: 'w1',
      status: 'ok',
      summary: 'second done',
      refs: [],
      provenance: 'claimed'
    })

    const tasks = store.readRun('run1')!.tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0].state).toBe('done')
    expect(tasks[0].result?.summary).toBe('first done') // NOT clobbered by the second settle
    expect(tasks[1].state).toBe('done') // before the fix: stuck in_progress forever
    expect(tasks[1].result?.summary).toBe('second done')
  })

  it('a re-settle with no open task still updates the row it belongs to (the newest finished one)', async () => {
    const at = 5 * MIN
    const store = createSwarmLedgerStore({
      getProjectDir: () => '/proj',
      now: () => at,
      memoryFor: () => memoryStub()
    })
    const ledger = createSwarmLedgerSession('run1', { store, now: () => at })
    ledger.ensure('ship the thing')
    const hooks = ledger.hooks(() => null)
    const spec = { objective: 'only', context: 'c', boundaries: 'b', outputFormat: 'f' }

    await hooks.dispatched({ workerId: 'w1', role: 'builder', spec })
    for (const summary of ['draft', 'revised']) {
      await hooks.settled({
        workerId: 'w1',
        status: 'ok',
        summary,
        refs: [],
        provenance: 'claimed'
      })
    }
    const tasks = store.readRun('run1')!.tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].result?.summary).toBe('revised')
  })
})

describe('applyAction — accept', () => {
  it('🔒 accepting a LOST worker’s salvaged result closes the task, so the row and the card clear', () => {
    // Accept used to set `acceptedByHuman` and nothing else — but every consumer keys off
    // `blockedTag === 'lost'`, so the triage row and the worker card kept reading `lost` forever
    // and Accept had no observable effect at all.
    const s = session({ state: 'blocked', blockedTag: 'lost', result: { ...salvaged } })
    expect(s.ledger.applyAction('t1', 'accept').ok).toBe(true)
    const t = s.read().tasks[0]
    expect(t.result?.acceptedByHuman).toBe(true)
    expect(t.blockedTag).toBeUndefined()
    expect(t.state).toBe('done')
    // Acceptance is not verification: the provenance the human accepted is preserved verbatim.
    expect(t.result?.provenance).toBe('synthesized')
    // …and the queue is empty — no `lost` row, and no `unreviewed` row for what was just accepted.
    expect(s.ledger.snapshot()?.triage).toEqual([])
  })

  it('refuses accept on a lost task with NOTHING salvaged (that row only offers reassign)', () => {
    const s = session({ state: 'blocked', blockedTag: 'lost' })
    expect(s.ledger.applyAction('t1', 'accept')).toEqual({ ok: false })
    expect(s.read().tasks[0].blockedTag).toBe('lost')
  })

  it('accepts a finished, unreviewed result without touching its state', () => {
    const s = session({ state: 'done', result: { ...salvaged, provenance: 'claimed' } })
    expect(s.ledger.applyAction('t1', 'accept').ok).toBe(true)
    const t = s.read().tasks[0]
    expect(t.state).toBe('done')
    expect(t.result?.acceptedByHuman).toBe(true)
  })
})

// ── S3 · the worktree join ──

describe('S3 · the ledger records the worker tree', () => {
  it('a dispatch carries worktree + branch onto the assignment (the fields S2 wrote null)', async () => {
    const store = createSwarmLedgerStore({
      getProjectDir: () => '/proj',
      now: () => 1000,
      memoryFor: () => memoryStub()
    })
    const s = createSwarmLedgerSession('run1', { store, now: () => 1000 })
    s.ensure('run')
    await s
      .hooks(() => null)
      .dispatched({
        workerId: 'w1',
        role: 'builder',
        spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
        worktree: 'M:/proj/.canvas/worktrees/b1',
        branch: 'swarm/rrrr/b1'
      })
    const a = store.readRun('run1')!.tasks[0].assignment!
    expect(a.worktree).toBe('M:/proj/.canvas/worktrees/b1')
    expect(a.branch).toBe('swarm/rrrr/b1')
  })

  it('a read-only dispatch leaves both null — isolation cost is paid by writers alone', async () => {
    const store = createSwarmLedgerStore({
      getProjectDir: () => '/proj',
      now: () => 1000,
      memoryFor: () => memoryStub()
    })
    const s = createSwarmLedgerSession('run1', { store, now: () => 1000 })
    s.ensure('run')
    await s
      .hooks(() => null)
      .dispatched({
        workerId: 'r1',
        role: 'code-reviewer',
        spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' }
      })
    const a = store.readRun('run1')!.tasks[0].assignment!
    expect(a.worktree).toBeNull()
    expect(a.branch).toBeNull()
  })

  it('worktreePaths de-duplicates and survives the task being long finished', async () => {
    const store = createSwarmLedgerStore({
      getProjectDir: () => '/proj',
      now: () => 1000,
      memoryFor: () => memoryStub()
    })
    const s = createSwarmLedgerSession('run1', { store, now: () => 1000 })
    s.ensure('run')
    const hooks = s.hooks(() => null)
    const spec = { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' }
    // The same worker takes two tasks: ONE tree, listed once.
    await hooks.dispatched({
      workerId: 'w1',
      role: 'builder',
      spec,
      worktree: '/wt/a',
      branch: 'swarm/r/a'
    })
    await hooks.dispatched({
      workerId: 'w1',
      role: 'builder',
      spec,
      worktree: '/wt/a',
      branch: 'swarm/r/a'
    })
    await hooks.dispatched({
      workerId: 'w2',
      role: 'builder',
      spec,
      worktree: '/wt/b',
      branch: 'swarm/r/b'
    })
    await hooks.settled({
      workerId: 'w1',
      status: 'done',
      summary: 's',
      refs: [],
      provenance: 'claimed'
    })
    // A preserved worktree stops being visible the moment we stop asking about it, so a finished
    // task's tree must still be listed.
    expect(s.worktreePaths().sort()).toEqual(['/wt/a', '/wt/b'])
  })

  it('worktreeFor resolves a row id to the tree the disposition acts on, and refuses anything else', async () => {
    const store = createSwarmLedgerStore({
      getProjectDir: () => '/proj',
      now: () => 1000,
      memoryFor: () => memoryStub()
    })
    const s = createSwarmLedgerSession('run1', { store, now: () => 1000 })
    s.ensure('run')
    await s
      .hooks(() => null)
      .dispatched({
        workerId: 'w1',
        role: 'builder',
        spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
        worktree: '/wt/a',
        branch: 'swarm/rrrr/builder-1'
      })
    expect(s.worktreeFor('t1')).toEqual({
      worktree: '/wt/a',
      branch: 'swarm/rrrr/builder-1',
      // The label is the branch leaf — how the human identified this worker on the card.
      label: 'builder-1'
    })
    // 🔒 Nothing but a real, isolated task id resolves: the dispose IPC trusts only the id.
    expect(s.worktreeFor('nope')).toBeNull()
  })

  it('🔒 `resolve` is not in any row vocabulary, so applyAction refuses it outright', () => {
    const s = session({
      state: 'blocked',
      blockedTag: 'lost',
      result: { status: 'failed', summary: 's', refs: [], provenance: 'synthesized', at: 0 }
    }).ledger
    // It needs async git, so it rides `swarm:worktreeDispose` — a half-action here would be a
    // worktree write that never happened reported as if it had.
    expect(s.applyAction('t1', 'resolve')).toEqual({ ok: false })
  })
})
