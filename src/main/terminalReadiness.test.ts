import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createReadinessWaiter, type ReadinessDeps } from './terminalReadiness'

/**
 * Fake probes with a fake-timer-driven boot age: `ageMs` derives from the advancing clock (like
 * the real pty `spawnedAt`), `stale` and `pid` are set per phase, `alive` kills the session.
 */
function makeDeps(spawnAgoMs = 0): {
  deps: ReadinessDeps
  set: { stale(v: number | undefined): void; pid(v: number): void; kill(): void }
} {
  const spawnAt = Date.now() - spawnAgoMs
  let stale: number | undefined = 0
  let pid = 111
  let alive = true
  return {
    deps: {
      bootInfo: () => (alive ? { ageMs: Date.now() - spawnAt, pid } : undefined),
      activityStaleMs: () => (alive ? stale : undefined),
      now: () => Date.now()
    },
    set: {
      stale: (v) => (stale = v),
      pid: (v) => (pid = v),
      kill: () => (alive = false)
    }
  }
}

const OPTS = { minBootMs: 1000, quietMs: 500, pollMs: 100, backstopMs: 5000 }

/** Advance fake time and let the poll ticks run. */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('createReadinessWaiter (the MCP dispatch readiness gate)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('no live session → no_session immediately (the gate then fails the write loudly, as today)', async () => {
    const { deps, set } = makeDeps()
    set.kill()
    const r = await createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    expect(r).toEqual({ outcome: 'no_session', waitedMs: 0 })
  })

  it('floor → activity → quiet resolves ready (the boot-settle happy path)', async () => {
    const { deps, set } = makeDeps()
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    // Inside the floor: output flowing (stale 0) — must NOT settle regardless of quiet later.
    await advance(600)
    // Past the floor, still active for a tick (sawActivity), then boot-quiet.
    await advance(600) // age ~1200 > minBootMs; stale still 0 → sawActivity
    set.stale(600) // ≥ quietMs → boot finished
    await advance(200) // next poll tick observes the quiet
    const r = await p
    expect(r.outcome).toBe('ready')
    expect(r.waitedMs).toBeGreaterThanOrEqual(1200)
  })

  it('never settles on a pre-activity quiet: stale ≥ quiet from the start → backstop → unconfirmed', async () => {
    const { deps, set } = makeDeps()
    set.stale(10_000) // no output EVER observed inside the quiet window (sawActivity never arms)
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    await advance(5_100)
    const r = await p
    expect(r.outcome).toBe('unconfirmed')
  })

  it('continuous output (never quiet) → backstop → unconfirmed (degrade-honestly, never hangs)', async () => {
    const { deps } = makeDeps() // stale stays 0
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    await advance(5_100)
    const r = await p
    expect(r.outcome).toBe('unconfirmed')
    expect(r.waitedMs).toBeGreaterThanOrEqual(5000)
  })

  it('maturity fast-path: an old session that is CURRENTLY QUIET resolves ready_assumed in 0ms', async () => {
    const { deps, set } = makeDeps(60_000) // booted a minute ago
    set.stale(600) // ≥ quietMs — nothing streaming right now
    const r = await createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    expect(r).toEqual({ outcome: 'ready_assumed', waitedMs: 0 })
  })

  it('maturity requalify: an old session streaming output waits for quiet, then resolves ready', async () => {
    const { deps, set } = makeDeps(60_000)
    // stale 0 = output flowing RIGHT NOW (the F4 relay window) — must NOT return blind.
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    await advance(300)
    set.stale(600) // burst ended
    await advance(200) // next poll observes the quiet
    const r = await p
    expect(r.outcome).toBe('ready')
  })

  it('maturity requalify: never-quiet output caps at requalifyMs under the FAST-PATH label (≤3s, not 15s)', async () => {
    const { deps } = makeDeps(60_000) // stale stays 0 — busy streaming agent
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', { ...OPTS, requalifyMs: 1000 })
    await advance(1_100)
    const r = await p
    expect(r.outcome).toBe('ready_assumed') // fast-path label, NOT unconfirmed — no WARNING spam
    expect(r.waitedMs).toBeGreaterThanOrEqual(1000)
    expect(r.waitedMs).toBeLessThan(OPTS.backstopMs) // never rides the 15s boot backstop
  })

  it('latch requalify: a latched pid streaming output re-waits for quiet instead of returning blind', async () => {
    const { deps, set } = makeDeps()
    const waiter = createReadinessWaiter(deps)
    const p = waiter.awaitTerminalReady('t1', OPTS)
    await advance(1200)
    set.stale(600)
    await advance(200)
    expect((await p).outcome).toBe('ready') // latch armed for pid 111
    set.stale(0) // the agent is now mid-burst (e.g. claude redrawing)
    const p2 = waiter.awaitTerminalReady('t1', { ...OPTS, requalifyMs: 1000 })
    await advance(300)
    set.stale(600) // burst ended → quiet
    await advance(200)
    const r2 = await p2
    expect(r2.outcome).toBe('ready') // observed quiet → full-confidence label
    // And a latched pid that NEVER quiets caps out under its own label:
    set.stale(0)
    const p3 = waiter.awaitTerminalReady('t1', { ...OPTS, requalifyMs: 1000 })
    await advance(1_100)
    expect((await p3).outcome).toBe('ready_latched')
  })

  it('latch: a second wait on the SAME process resolves ready_latched in 0ms; a new pid re-waits', async () => {
    const { deps, set } = makeDeps()
    const waiter = createReadinessWaiter(deps)
    const p = waiter.awaitTerminalReady('t1', OPTS)
    await advance(1200)
    set.stale(600)
    await advance(200)
    expect((await p).outcome).toBe('ready')
    // Same pid → latched, no wait.
    expect(await waiter.awaitTerminalReady('t1', OPTS)).toEqual({
      outcome: 'ready_latched',
      waitedMs: 0
    })
    // Respawn under the same board id (new pid) → the latch misses; a fresh (quiet-less) wait
    // rides to the backstop.
    set.pid(222)
    set.stale(0)
    const p2 = waiter.awaitTerminalReady('t1', OPTS)
    await advance(5_100)
    expect((await p2).outcome).toBe('unconfirmed')
  })

  it('pid change MID-WAIT resets the activity observation (a new process is booting)', async () => {
    const { deps, set } = makeDeps()
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    await advance(1200) // past floor, stale 0 → sawActivity armed for pid 111
    set.pid(222) // respawn: new proc; the armed sawActivity must NOT carry over
    set.stale(10_000) // the new proc never shows activity inside the quiet window
    await advance(5_100)
    expect((await p).outcome).toBe('unconfirmed') // would have been 'ready' without the reset
  })

  it('session dies mid-wait → no_session (the gate’s write-failure path takes over)', async () => {
    const { deps, set } = makeDeps()
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', OPTS)
    await advance(300)
    set.kill()
    await advance(200)
    expect((await p).outcome).toBe('no_session')
  })

  it('abort (confirm denied) resolves unconfirmed immediately and clears every timer', async () => {
    const { deps } = makeDeps()
    const ac = new AbortController()
    const p = createReadinessWaiter(deps).awaitTerminalReady('t1', { ...OPTS, signal: ac.signal })
    await advance(300)
    ac.abort()
    expect((await p).outcome).toBe('unconfirmed')
    expect(vi.getTimerCount()).toBe(0) // no leaked poll/backstop timer after a denied dispatch
  })
})
