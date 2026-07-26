import { describe, expect, it, vi } from 'vitest'
import { createSwarmLedgerStore, type LedgerMemory } from './swarmLedger'
import { createSwarmWatch, withRunNotices, type SwarmSalvage } from './swarmWatch'
import { SWARM_STALL_THRESHOLD_MS, type SwarmRunLedger } from '../shared/swarmLedgerTypes'

/** In-memory `canvasMemory` run-sidecar slice — JSON round-trip, like the real atomic writer. */
function memoryStub(): LedgerMemory & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    writeRun(id, data) {
      files.set(id, JSON.stringify(data))
      return true
    },
    readRun(id) {
      const raw = files.get(id)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    removeRun(id) {
      files.delete(id)
    },
    listRunIds() {
      return [...files.keys()]
    }
  }
}

const MIN = 60_000

interface Harness {
  store: ReturnType<typeof createSwarmLedgerStore>
  watch: ReturnType<typeof createSwarmWatch>
  narrations: Array<{ runId: string; boardId?: string; status?: string; text: string }>
  changed: string[]
  emit: (change: { id: string; status: string }) => void
  at: (ms: number) => void
  read: () => SwarmRunLedger
  results: Map<string, SwarmSalvage>
  stale: Map<string, number>
}

/**
 * One live run: task `t1` dispatched into worker `w1` at t=0, joined to plan item `p1`.
 * `clock` starts at 0 and is advanced explicitly — no timers, no wall clock.
 */
function harness(opts: { salvage?: SwarmSalvage } = {}): Harness {
  const mem = memoryStub()
  let clock = 0
  const store = createSwarmLedgerStore({
    getProjectDir: () => '/proj',
    now: () => clock,
    memoryFor: () => mem
  })
  store.ensureRun('run1', 'ship the thing')
  store.update('run1', (l) => {
    l.planItems = [{ id: 'p1', label: 'Migrate the settings schema', done: false }]
    l.tasks.push({
      taskId: 't1',
      planItemId: 'p1',
      content: 'Migrate the settings schema',
      activeForm: 'Migrating settings schema…',
      state: 'in_progress',
      assignment: {
        boardId: 'w1',
        role: 'builder',
        spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
        dispatchedAt: 0,
        lastActivityAt: 0,
        stallCount: 0,
        worktree: null,
        branch: null
      }
    })
  })

  const results = new Map<string, SwarmSalvage>()
  if (opts.salvage) results.set('w1', opts.salvage)
  const stale = new Map<string, number>()
  const narrations: Harness['narrations'] = []
  const changed: string[] = []
  let listener: ((c: { id: string; status: string }) => void) | null = null

  const watch = createSwarmWatch({
    store,
    subscribeStatus: (l) => {
      listener = l
      return () => {
        listener = null
      }
    },
    readResult: (id) => results.get(id) ?? { present: false },
    activityStaleMs: (id) => stale.get(id),
    narrate: (runId, n) => narrations.push({ runId, ...n }),
    changed: (runId) => changed.push(runId),
    now: () => clock,
    // No real timer: the sweep is driven explicitly via `watch.tick()`.
    startSweep: () => () => {}
  })
  watch.start()

  return {
    store,
    watch,
    narrations,
    changed,
    results,
    stale,
    emit: (c) => listener?.(c),
    at: (ms) => {
      clock = ms
    },
    read: () => store.readRun('run1')!
  }
}

describe('swarmWatch — failure case A (a worker dies mid-task)', () => {
  it("a worker board going 'gone' marks its task blocked/lost and salvages the derived result", () => {
    const h = harness({
      salvage: {
        present: true,
        status: 'partial',
        summary: 'touched 6 files',
        refs: ['a', 'b'],
        synthesized: true
      }
    })
    h.at(5 * MIN)
    h.emit({ id: 'w1', status: 'gone' })

    const task = h.read().tasks[0]
    expect(task.state).toBe('blocked')
    expect(task.blockedTag).toBe('lost')
    expect(task.result).toMatchObject({
      status: 'partial',
      provenance: 'synthesized',
      refs: ['a', 'b']
    })
    expect(h.read().events.some((e) => e.kind === 'salvaged')).toBe(true)
    expect(h.changed).toEqual(['run1'])
  })

  it('narrates in the orchestrator voice — the tail only, with the provenance disclosed', () => {
    const h = harness({
      salvage: { present: true, status: 'partial', summary: 's', refs: ['a'], synthesized: true }
    })
    h.emit({ id: 'w1', status: 'failed' })
    expect(h.narrations).toHaveLength(1)
    const n = h.narrations[0]
    expect(n.boardId).toBe('w1') // MAIN carries the id; the renderer resolves the title
    expect(n.status).toBe('exited')
    expect(n.text).toContain('died on task 1')
    expect(n.text).toContain('derived') // never laundered into a verified claim
    expect(n.text).toContain('1 file')
  })

  it('says so plainly when there is nothing to salvage', () => {
    const h = harness()
    h.emit({ id: 'w1', status: 'gone' })
    expect(h.narrations[0].text).toContain('nothing to salvage')
    expect(h.read().tasks[0].result).toBeUndefined()
    expect(h.read().tasks[0].blockedTag).toBe('lost')
  })

  it('🔒 never rewrites a task that settled between the status change and the write', () => {
    const h = harness({ salvage: { present: true, status: 'success', summary: 's', refs: [] } })
    // The orchestrator's own await_worker won the race — the task is already done.
    h.store.update('run1', (l) => {
      l.tasks[0].state = 'done'
      l.tasks[0].result = {
        status: 'success',
        summary: 'claimed it',
        refs: [],
        provenance: 'claimed',
        at: 1
      }
    })
    h.emit({ id: 'w1', status: 'gone' })
    expect(h.read().tasks[0].state).toBe('done')
    expect(h.read().tasks[0].blockedTag).toBeUndefined()
    expect(h.narrations).toHaveLength(0)
  })

  it("an 'idle' worker is NOT a dead worker (an agent that finished its turn goes idle)", () => {
    const h = harness()
    h.emit({ id: 'w1', status: 'idle' })
    h.emit({ id: 'w2', status: 'gone' }) // a board this run never assigned
    expect(h.read().tasks[0].state).toBe('in_progress')
    expect(h.narrations).toHaveLength(0)
  })

  it("a status flip to 'running' counts as activity and postpones the stall", () => {
    const h = harness()
    h.at(9 * MIN)
    h.emit({ id: 'w1', status: 'running' })
    h.at(9 * MIN + SWARM_STALL_THRESHOLD_MS - 1)
    h.watch.tick()
    expect(h.narrations).toHaveLength(0)
    expect(h.read().tasks[0].assignment?.stallCount).toBe(0)
  })

  it('ignores a run that is no longer live (interrupted/done runs are history)', () => {
    const h = harness()
    h.store.update('run1', (l) => {
      l.state = 'done'
    })
    h.emit({ id: 'w1', status: 'gone' })
    expect(h.read().tasks[0].state).toBe('in_progress')
  })

  it('a throwing salvage read degrades to "nothing salvageable" instead of escaping', () => {
    const h = harness()
    h.results.set('w1', {
      get present(): boolean {
        throw new Error('registry exploded')
      }
    } as unknown as SwarmSalvage)
    expect(() => h.emit({ id: 'w1', status: 'gone' })).not.toThrow()
    expect(h.read().tasks[0].blockedTag).toBe('lost')
  })
})

describe('swarmWatch — stall watch (design D4)', () => {
  it('counts a stall once per EPISODE, not once per tick', () => {
    const h = harness()
    h.at(SWARM_STALL_THRESHOLD_MS + 1)
    h.watch.tick()
    h.watch.tick()
    h.at(SWARM_STALL_THRESHOLD_MS + 2 * MIN)
    h.watch.tick()
    expect(h.read().tasks[0].assignment?.stallCount).toBe(1)
    expect(h.narrations).toHaveLength(1)
    expect(h.read().events.filter((e) => e.kind === 'stall')).toHaveLength(1)
  })

  it('opens a NEW episode once the worker speaks again and falls silent again', () => {
    const h = harness()
    h.at(SWARM_STALL_THRESHOLD_MS + 1)
    h.watch.tick()
    // The worker printed something 1 minute ago — real PTY silence, folded into the ledger.
    h.at(SWARM_STALL_THRESHOLD_MS + 2 * MIN)
    h.stale.set('w1', MIN)
    h.watch.tick()
    expect(h.read().tasks[0].assignment?.stallCount).toBe(1) // not stalled any more
    // …then goes quiet again past the threshold.
    h.stale.set('w1', SWARM_STALL_THRESHOLD_MS + MIN)
    h.at(SWARM_STALL_THRESHOLD_MS * 2 + 5 * MIN)
    h.watch.tick()
    expect(h.read().tasks[0].assignment?.stallCount).toBe(2)
    expect(h.narrations).toHaveLength(2)
  })

  it('discloses both numbers in the narration — the silence AND the threshold', () => {
    const h = harness()
    h.at(18 * MIN)
    h.watch.tick()
    expect(h.narrations[0].text).toContain('silent 18m')
    expect(h.narrations[0].text).toContain('10m stall threshold')
    expect(h.narrations[0].status).toBeUndefined() // a stall is not an exit — no status divider
  })

  it('PTY silence only ever moves lastActivityAt FORWARD (a stale reading cannot rewind it)', () => {
    const h = harness()
    h.at(5 * MIN)
    h.emit({ id: 'w1', status: 'running' }) // lastActivityAt := 5m
    h.at(6 * MIN)
    h.stale.set('w1', 6 * MIN) // claims silence since t=0 — older than what we know
    h.watch.tick()
    expect(h.read().tasks[0].assignment?.lastActivityAt).toBe(5 * MIN)
  })

  it('a lost task stops producing stall rows (its clock restarts when it is buried)', () => {
    const h = harness()
    h.at(20 * MIN)
    h.emit({ id: 'w1', status: 'gone' })
    h.at(40 * MIN)
    h.watch.tick()
    // Only the death narration — a blocked task is not in_progress, so it can never stall.
    expect(h.narrations).toHaveLength(1)
    expect(h.read().tasks[0].assignment?.stallCount).toBe(0)
  })
})

describe('swarmWatch — failure case B (drain on quit)', () => {
  it('salvages every un-settled worker, marks the run interrupted, and preserves the task', () => {
    const h = harness({
      salvage: {
        present: true,
        status: 'wip',
        summary: 'half done',
        refs: ['x'],
        synthesized: true
      }
    })
    h.at(3 * MIN)
    h.watch.drain()

    const l = h.read()
    expect(l.state).toBe('interrupted')
    expect(l.tasks[0].state).toBe('in_progress') // preserved, NOT settled on our say-so
    expect(l.tasks[0].result).toMatchObject({ status: 'wip', provenance: 'synthesized' })
    expect(l.events.some((e) => e.kind === 'salvaged')).toBe(true)
    expect(l.events.find((e) => e.kind === 'interrupted')).toMatchObject({ liveTasks: 1 })
  })

  it('never clobbers a result the worker already reported for itself', () => {
    const h = harness({ salvage: { present: true, status: 'derived', summary: 'x', refs: [] } })
    h.store.update('run1', (l) => {
      l.tasks[0].result = {
        status: 'success',
        summary: 'the worker said so',
        refs: [],
        provenance: 'claimed',
        at: 1
      }
    })
    h.watch.drain()
    expect(h.read().tasks[0].result?.summary).toBe('the worker said so')
  })

  it('is a no-op on a run with nothing in flight beyond marking it interrupted', () => {
    const h = harness()
    h.store.update('run1', (l) => {
      l.tasks[0].state = 'done'
    })
    h.watch.drain()
    const l = h.read()
    expect(l.state).toBe('interrupted')
    expect(l.events.find((e) => e.kind === 'interrupted')).toMatchObject({ liveTasks: 0 })
  })

  it('does not throw with no project (no ledger at all)', () => {
    const watch = createSwarmWatch({
      store: createSwarmLedgerStore({ getProjectDir: () => null }),
      subscribeStatus: () => () => {},
      readResult: () => ({ present: false }),
      narrate: vi.fn(),
      changed: vi.fn()
    })
    expect(() => watch.drain()).not.toThrow()
    expect(() => watch.tick()).not.toThrow()
  })
})

describe('swarmWatch — notices fed back to the brain', () => {
  it('queues what happened between turns, and hands it over exactly once', () => {
    const h = harness()
    h.emit({ id: 'w1', status: 'gone' })
    const first = h.watch.takeNotices('run1')
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('w1')
    expect(h.watch.takeNotices('run1')).toEqual([])
  })

  it('withRunNotices adds nothing when nothing happened', () => {
    expect(withRunNotices('do the thing', [])).toBe('do the thing')
  })

  it('withRunNotices prefixes the user turn (never a second assistant turn)', () => {
    const out = withRunNotices('carry on', ['worker w1 died on task 1'])
    expect(out.startsWith('[run events since your last turn]')).toBe(true)
    expect(out).toContain('- worker w1 died on task 1')
    expect(out.endsWith('carry on')).toBe(true)
  })
})

describe('swarmWatch — lifecycle', () => {
  it('start is idempotent and stop unsubscribes', () => {
    let subs = 0
    const watch = createSwarmWatch({
      store: createSwarmLedgerStore({ getProjectDir: () => null }),
      subscribeStatus: () => {
        subs += 1
        return () => {
          subs -= 1
        }
      },
      readResult: () => ({ present: false }),
      narrate: vi.fn(),
      changed: vi.fn(),
      startSweep: () => () => {}
    })
    watch.start()
    watch.start()
    expect(subs).toBe(1)
    watch.stop()
    watch.stop()
    expect(subs).toBe(0)
  })
})
