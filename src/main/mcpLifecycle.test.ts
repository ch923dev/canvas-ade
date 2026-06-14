import { describe, expect, it } from 'vitest'
import type { BoardOutput, BoardResult, BoardSummary, MemoryDoc } from '@expanse-ade/mcp'
import { createMcpLifecycle } from './mcpLifecycle'
import type { BoardRegistry } from './mcpRegistry'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

/** No-op dispatch dependencies the lifecycle cluster never touches. */
const DISPATCH_DEFAULTS = {
  writeToPty: (): boolean => true,
  confirm: async (): Promise<{ approved: boolean }> => ({ approved: true }),
  audit: async (): Promise<void> => {},
  recordResult: (): void => {},
  listConnectors: () => [],
  subscribeStatus: () => () => {}
}

/**
 * A registry whose mirror is mutated by the commands the lifecycle issues (so its own
 * spawns/closes show up in listBoards, like the real renderer). Modelled on
 * mcpOrchestrator.test.ts's `liveReg`. `removeFail` makes a removeBoard ack fail for one id.
 */
function liveReg(opts: { drained?: string[]; removeFailId?: () => string | null } = {}): {
  registry: BoardRegistry
  boards: Array<{ id: string; type: string; title: string; status?: string }>
  setStatus: (id: string, status: string) => void
} {
  const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
  const registry: BoardRegistry = {
    listBoards: () => boards,
    listSessions: () => [],
    readOutput: () => EMPTY_OUTPUT,
    readResult: () => EMPTY_RESULT,
    readMemory: () => EMPTY_MEMORY,
    readSummary: () => EMPTY_MEMORY,
    sendCommand: async (cmd) => {
      if (cmd.type === 'addBoard')
        boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T', status: 'running' })
      if (cmd.type === 'removeBoard') {
        if (opts.removeFailId?.() === cmd.id) return { ok: false, error: 'no-window' }
        const i = boards.findIndex((b) => b.id === cmd.id)
        if (i >= 0) boards.splice(i, 1)
      }
      return { ok: true, type: cmd.type }
    },
    drainPty: async (id) => {
      opts.drained?.push(id)
    },
    ...DISPATCH_DEFAULTS
  }
  const setStatus = (id: string, status: string): void => {
    const b = boards.find((x) => x.id === id)
    if (b) b.status = status
  }
  return { registry, boards, setStatus }
}

/** A listBoards dep that derives `{ id, type, title, status }` from the live mirror. */
function listBoardsFrom(
  boards: Array<{ id: string; type: string; title: string; status?: string }>
): () => Promise<BoardSummary[]> {
  return async () =>
    boards.map((b) => ({ id: b.id, type: b.type, title: b.title, status: b.status ?? 'idle' }))
}

describe('createMcpLifecycle (DI factory — extracted from buildOrchestrator)', () => {
  it('🔒 BUG-003: two concurrent spawns at cap-1 never exceed the cap (reserve-before-await)', async () => {
    // The cap check is synchronous but the slot must be reserved BEFORE `await sendCommand`.
    // sendCommand yields the event loop, so two spawns fired near the cap both pass the
    // `tracked.size >= cap` check unless the reservation happens before the await → cap+1.
    const clock = 0
    const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        await Promise.resolve() // yield: both concurrent spawns interleave past the cap check
        if (cmd.type === 'addBoard')
          boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T', status: 'running' })
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      idleTtlMs: 1000,
      spawnGraceMs: 5000,
      idleActivityMs: 60_000,
      listBoards: listBoardsFrom(boards)
    })
    // Fill to cap-1 sequentially (3 of 4 slots used).
    for (let i = 0; i < 3; i++) await life.spawnBoard({ type: 'terminal' })
    // Fire two concurrently into the single remaining slot: exactly one may win.
    const results = await Promise.allSettled([
      life.spawnBoard({ type: 'terminal' }),
      life.spawnBoard({ type: 'terminal' })
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toBe(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ message: expect.stringMatching(/cap/i) })
    // The live budget is now exactly at the cap — a further spawn rejects (no cap+1).
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
  })

  it('🔒 BUG-009: closeBoard frees the cap slot even when removeBoard fails (PTY already dead)', async () => {
    const clock = 0
    const drained: string[] = []
    let removeOk = false
    let failId: string | null = null
    const { registry } = liveReg({ drained, removeFailId: () => (removeOk ? null : failId) })
    const boardsRef: Array<{ id: string; type: string; title: string; status?: string }> =
      registry.listBoards()
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      idleTtlMs: 1000,
      spawnGraceMs: 5000,
      idleActivityMs: 60_000,
      listBoards: listBoardsFrom(boardsRef)
    })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await life.spawnBoard({ type: 'terminal' })).id)
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i) // at the cap
    // Close one, but the renderer rejects the removeBoard — the close throws…
    failId = ids[0]
    await expect(life.closeBoard(ids[0])).rejects.toThrow(/no-window/)
    expect(drained).toContain(ids[0]) // the PTY was drained/killed regardless
    // …yet the slot was freed (finally), so a fresh spawn succeeds (no leaked slot).
    removeOk = true
    await expect(life.spawnBoard({ type: 'terminal' })).resolves.toHaveProperty('id')
  })

  it('reapIdle closes a board idle past the TTL, leaves a running one, no-ops within the TTL', async () => {
    let clock = 0
    const drained: string[] = []
    const { registry, boards, setStatus } = liveReg({ drained })
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      idleTtlMs: 1000,
      spawnGraceMs: 5000,
      idleActivityMs: 60_000,
      listBoards: listBoardsFrom(boards)
    })
    const { id: idle } = await life.spawnBoard({ type: 'terminal' })
    const { id: busy } = await life.spawnBoard({ type: 'terminal' })
    setStatus(idle, 'idle')
    setStatus(busy, 'running')
    expect(await life.reapIdle()).toEqual([]) // sweep 1 arms idleSince
    clock = 500
    expect(await life.reapIdle()).toEqual([]) // still within the TTL
    clock = 1500 // idle for 1500ms >= ttl 1000
    expect(await life.reapIdle()).toEqual([idle])
    expect(drained).toContain(idle) // gracefully closed (drained + removed)
    expect(boards.some((b) => b.id === idle)).toBe(false) // gone from the mirror
    expect(boards.some((b) => b.id === busy)).toBe(true) // the running board survives
  })

  it('🔒 BUG-007: reaps a quiescent terminal by OUTPUT SILENCE even while its status stays `running`', async () => {
    // A live agent shell's coarse status bucket is permanently `running` (no per-task
    // running->idle transition), so the OLD reaper (which only reaped a board whose bucket
    // read `idle`) NEVER reaped a dormant terminal. The fix measures dormancy by output silence
    // via registry.boardActivityStaleMs. Both boards report status `running` here; only output
    // silence distinguishes the dormant one from the actively-working one.
    let clock = 0
    const drained: string[] = []
    const { registry, boards, setStatus } = liveReg({ drained })
    // Per-board ms-since-last-output, driven by the test (the pty.ts getter in prod).
    const staleById: Record<string, number> = {}
    registry.boardActivityStaleMs = (id) => staleById[id]
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      idleTtlMs: 1000,
      spawnGraceMs: 5000,
      idleActivityMs: 60_000, // output silent >= 60s counts as dormant
      listBoards: listBoardsFrom(boards)
    })
    const { id: quiet } = await life.spawnBoard({ type: 'terminal' })
    const { id: busy } = await life.spawnBoard({ type: 'terminal' })
    // BOTH boards' status pill is permanently `running` — the bug's exact precondition.
    setStatus(quiet, 'running')
    setStatus(busy, 'running')
    // The quiet board has been silent for 90s (>= idleActivityMs); the busy one printed 5s ago.
    staleById[quiet] = 90_000
    staleById[busy] = 5_000
    expect(await life.reapIdle()).toEqual([]) // sweep 1 arms idleSince for the quiet board
    clock = 500
    expect(await life.reapIdle()).toEqual([]) // still within the reaper TTL
    clock = 1500 // dormant for >= idleTtlMs 1000 of continuous output silence
    expect(await life.reapIdle()).toEqual([quiet])
    expect(drained).toContain(quiet)
    expect(boards.some((b) => b.id === quiet)).toBe(false) // reaped despite `running` status
    expect(boards.some((b) => b.id === busy)).toBe(true) // the actively-printing board survives
  })

  it('🔒 BUG-007: fresh output RE-ARMS a terminal — a board that resumes printing is not reaped', async () => {
    // The idleSince clock must clear when output resumes, exactly as it cleared on a return to
    // a non-idle status before. A board that goes silent, then prints again, must reset.
    let clock = 0
    const drained: string[] = []
    const { registry, boards, setStatus } = liveReg({ drained })
    const staleById: Record<string, number> = {}
    registry.boardActivityStaleMs = (id) => staleById[id]
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      idleTtlMs: 1000,
      spawnGraceMs: 5000,
      idleActivityMs: 60_000,
      listBoards: listBoardsFrom(boards)
    })
    const { id } = await life.spawnBoard({ type: 'terminal' })
    setStatus(id, 'running')
    staleById[id] = 90_000 // silent
    expect(await life.reapIdle()).toEqual([]) // arms idleSince
    clock = 500
    staleById[id] = 1_000 // the agent printed again — back to active (< idleActivityMs)
    expect(await life.reapIdle()).toEqual([]) // clears idleSince (re-armed)
    clock = 1500 // would have been past the TTL had the clock not reset
    staleById[id] = 90_000 // silent again
    expect(await life.reapIdle()).toEqual([]) // a FRESH idle clock (not the original) → no reap yet
    clock = 3000
    expect(await life.reapIdle()).toEqual([id]) // now dormant past the TTL since the re-arm
    expect(boards.some((b) => b.id === id)).toBe(false)
  })

  it('🔒 APP-N3: rejects an off-type spawn at the adapter — no command sent (reject precedes side effects)', async () => {
    const clock = 0
    const seen: string[] = []
    const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        seen.push(cmd.type)
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      idleTtlMs: 1000,
      spawnGraceMs: 5000,
      idleActivityMs: 60_000,
      listBoards: listBoardsFrom(boards)
    })
    await expect(life.spawnBoard({ type: 'evil' })).rejects.toThrow(/type|spawnable/i)
    expect(seen).toEqual([]) // nothing reached the renderer / mint path
  })
})
