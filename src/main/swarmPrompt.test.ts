import { describe, expect, it } from 'vitest'
import { composeSwarmSystem, composeTurnRoster, turnRosterWorkers } from './swarmPrompt'
import { ROLE_PACKS } from '../shared/rolePacks'
import type { SwarmRunLedger } from '../shared/swarmLedgerTypes'

/**
 * The orchestrator system prompt is a CONTRACT (07 §4 + the 2026-07-31 prompt-overhaul report,
 * docs/research/2026-07-31-swarm-prompt-overhaul.md §3.3) — these pins keep the load-bearing
 * rules from silently falling out of a later rewording.
 */
describe('composeSwarmSystem — 07 §4 rules are encoded', () => {
  const s = composeSwarmSystem(false)
  // Long phrases can wrap across the source's line breaks — pin them against a collapsed copy.
  const flat = s.replace(/\s+/g, ' ')

  it('encodes the four-field task spec', () => {
    for (const f of ['objective', 'context', 'boundaries', 'outputFormat']) {
      expect(s).toContain(f)
    }
  })

  it('four-field context is enriched + carries the aggregate test (report §3.4)', () => {
    expect(flat).toMatch(/what other in-flight workers own/i)
    expect(flat).toMatch(/results together would answer the whole goal/i)
  })

  it('encodes the effort ladder (1 / 2-4 / 3-5 / 10+)', () => {
    expect(s).toMatch(/1 worker/i)
    expect(s).toContain('2-4')
    expect(s).toContain('3-5')
    expect(s).toContain('10+')
  })

  it('encodes write serialization as DISCLOSED (no silent caps)', () => {
    expect(s).toMatch(/write-role tasks are capped/i)
    expect(s).toMatch(/SAY SO/i)
  })

  it('encodes one-voice (never paste raw worker output)', () => {
    expect(s).toMatch(/never paste raw worker output/i)
  })

  it('encodes the human gate + denied-confirm acceptance', () => {
    expect(s).toMatch(/human confirmation/i)
    expect(s).toMatch(/do not retry/i)
  })

  it('lists every shipped role pack in the catalog', () => {
    for (const p of ROLE_PACKS) expect(s).toContain(`- ${p.id} `)
  })

  it('routes by entryCondition purpose lines, researcher included (the V1 catalog-hole fix)', () => {
    expect(s).toContain('- researcher (read-only)')
    expect(s).toMatch(/external sources/i)
  })

  it('paused variant tells the model dispatch tools refuse', () => {
    expect(composeSwarmSystem(true)).toMatch(/RUN IS PAUSED/i)
  })
})

describe('composeSwarmSystem — worker-lifecycle discipline (report V2, orphan spawns)', () => {
  const s = composeSwarmSystem(false)

  it('reuse-before-spawn: workers are standing capacity, idle role-match blocks a duplicate spawn', () => {
    expect(s).toMatch(/WORKERS ARE REUSABLE/i)
    expect(s).toMatch(/standing capacity/i)
    expect(s).toMatch(/do not\s+spawn a duplicate/i)
  })

  it('spawn-commits-dispatch: an orphaned worker is a bookkeeping error', () => {
    expect(s).toMatch(/SPAWN COMMITS YOU TO DISPATCH/i)
    expect(s).toMatch(/orphaned worker is your bookkeeping error/i)
  })

  it('names list_workers as the roster truth after any confirm gate (stale-memory rule)', () => {
    expect(s).toMatch(/re-check\s+list_workers/i)
    expect(s).toMatch(/the tool is the truth/i)
  })

  it('names the per-turn [worker roster] block as an affordance', () => {
    expect(s).toContain('[worker roster]')
  })

  it('distinct-tasks rule: no two workers on overlapping ground', () => {
    expect(s).toMatch(/DISTINCT TASKS/i)
    expect(s).toMatch(/overlapping ground/i)
  })

  it('stop rule: diminishing returns end dispatching (report V4)', () => {
    expect(s).toMatch(/KNOW WHEN TO STOP/i)
    expect(s).toMatch(/diminishing returns/i)
  })

  it('catalog-gap rule: a routed "failed — needs X" is routing information, not a retry', () => {
    expect(s).toMatch(/NO ROLE FITS/i)
    expect(s).toMatch(/routing information/i)
    expect(s).toMatch(/do not re-try the same role/i)
  })
})

// ── Per-turn roster block (report §3.3(2) — the load-bearing orphan-spawn fix) ──

const ledgerWith = (
  over: Partial<SwarmRunLedger>
): Pick<SwarmRunLedger, 'tasks' | 'planItems'> => ({
  tasks: [],
  planItems: [],
  ...over
})

const busyTask = (
  boardId: string,
  over: Partial<SwarmRunLedger['tasks'][number]> = {}
): SwarmRunLedger['tasks'][number] => ({
  taskId: 't1',
  content: 'Migrate the settings schema',
  activeForm: 'Migrating settings schema…',
  state: 'in_progress',
  assignment: {
    boardId,
    role: 'builder',
    spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
    dispatchedAt: 1,
    lastActivityAt: 1,
    stallCount: 0,
    worktree: null,
    branch: null
  },
  ...over
})

describe('turnRosterWorkers — joins session roles, live boards, and the ledger', () => {
  it('a spawned-but-never-dispatched worker shows as idle (exactly the orphan case)', () => {
    const rows = turnRosterWorkers(
      new Map([['w1', 'researcher']]),
      [{ id: 'w1', title: 'mcp-researcher' }],
      ledgerWith({})
    )
    expect(rows).toEqual([{ id: 'w1', role: 'researcher', title: 'mcp-researcher' }])
  })

  it('an in-flight assignment marks the worker busy with activity + plan item', () => {
    const rows = turnRosterWorkers(
      new Map([['w1', 'builder']]),
      [{ id: 'w1', title: 'builder-1' }],
      ledgerWith({
        tasks: [busyTask('w1', { planItemId: 'p2' })],
        planItems: [
          { id: 'p1', label: 'a', done: true },
          { id: 'p2', label: 'b', done: false }
        ]
      })
    )
    expect(rows[0].activity).toBe('Migrating settings schema…')
    expect(rows[0].planItem).toBe(2)
  })

  it('a settled task frees the worker back to idle; a blocked one flags stalled', () => {
    const done = turnRosterWorkers(
      new Map([['w1', 'builder']]),
      [{ id: 'w1' }],
      ledgerWith({ tasks: [busyTask('w1', { state: 'done' })] })
    )
    expect(done[0].activity).toBeUndefined()
    const blocked = turnRosterWorkers(
      new Map([['w1', 'builder']]),
      [{ id: 'w1' }],
      ledgerWith({ tasks: [busyTask('w1', { state: 'blocked' })] })
    )
    expect(blocked[0].stalled).toBe(true)
  })

  it('a reused board resolves to its NEWEST non-terminal task — stale history cannot shadow it (PR #417 review)', () => {
    // Task 1 went blocked and was never revisited; task 2 was dispatched to the same worker and
    // finished. The worker is fully idle — a forward fold over history would keep it "stalled".
    const idle = turnRosterWorkers(
      new Map([['w1', 'builder']]),
      [{ id: 'w1' }],
      ledgerWith({
        tasks: [
          busyTask('w1', { taskId: 't1', state: 'blocked' }),
          busyTask('w1', { taskId: 't2', state: 'done', activeForm: 'Second task…' })
        ]
      })
    )
    expect(idle[0].activity).toBeUndefined()
    expect(idle[0].stalled).toBeUndefined()
    // Old blocked + new in-flight: the newest non-terminal wins — busy with the NEW activity,
    // and the old entry's blocked flag does not leak onto the current task.
    const busy = turnRosterWorkers(
      new Map([['w1', 'builder']]),
      [{ id: 'w1' }],
      ledgerWith({
        tasks: [
          busyTask('w1', { taskId: 't1', state: 'blocked' }),
          busyTask('w1', { taskId: 't2', activeForm: 'Second task…' })
        ]
      })
    )
    expect(busy[0].activity).toBe('Second task…')
    expect(busy[0].stalled).toBeUndefined()
  })

  it('re-seeds workers from ledger assignments when the session map is empty (post-restart)', () => {
    const rows = turnRosterWorkers(
      new Map(),
      [{ id: 'w1' }],
      ledgerWith({ tasks: [busyTask('w1')] })
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('builder')
  })

  it('drops a worker whose board is gone; keeps everything when boards are unknowable (null)', () => {
    const roles = new Map([
      ['w1', 'builder'],
      ['w2', 'explorer']
    ])
    expect(turnRosterWorkers(roles, [{ id: 'w2' }], null).map((r) => r.id)).toEqual(['w2'])
    expect(turnRosterWorkers(roles, null, null)).toHaveLength(2)
  })
})

describe('composeTurnRoster — the user-turn block', () => {
  it('is empty when there is nothing to say (turn one stays clean)', () => {
    expect(composeTurnRoster([], null)).toBe('')
    expect(composeTurnRoster([], { done: 0, total: 0 })).toBe('')
  })

  it('renders idle workers with a reuse nudge and busy workers with activity + plan item', () => {
    const block = composeTurnRoster(
      [
        { id: 'w1', role: 'builder', title: 'builder-1', activity: 'Migrating…', planItem: 2 },
        { id: 'w2', role: 'researcher', title: 'mcp-researcher' }
      ],
      { done: 2, total: 5 }
    )
    expect(block.startsWith('[worker roster')).toBe(true)
    expect(block).toContain('builder-1 (w1, builder): busy — "Migrating…", plan item 2')
    expect(block).toContain(
      'mcp-researcher (w2, researcher): idle — reuse before spawning another researcher'
    )
    expect(block).toContain('plan: 2/5 done')
  })

  it('flags a stalled worker and renders a plan-only block when no workers exist yet', () => {
    expect(
      composeTurnRoster([{ id: 'w1', role: 'builder', activity: 'x', stalled: true }], null)
    ).toContain('[stalled/blocked]')
    const planOnly = composeTurnRoster([], { done: 1, total: 3 })
    expect(planOnly).toContain('no workers spawned yet')
    expect(planOnly).toContain('plan: 1/3 done')
  })
})
