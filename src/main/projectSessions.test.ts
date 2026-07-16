import { describe, it, expect, vi } from 'vitest'
import { createProjectSessions, type ProjectSessionDeps } from './projectSessions'

// Background project sessions (Phase 1): the registry orchestrates the pty/previewOsr
// project-scoped resource functions and is the single source of truth for WHICH projects are
// backgrounded. Deps are factory-injected, so these tests drive the real registry logic with
// recording fakes — no electron/node-pty runtime.

function makeDeps(overrides: Partial<ProjectSessionDeps> = {}): {
  deps: ProjectSessionDeps
  calls: Record<string, string[]>
  /** The fake persisted forever-keep store (Phase 4) — saveForeverKeeps writes land here. */
  persisted: { dirs: string[] }
} {
  const calls: Record<string, string[]> = {
    reapUndoParks: [],
    parkPtys: [],
    disposePtys: [],
    backgroundOsr: [],
    foregroundOsr: [],
    disposeOsr: [],
    persistRingTails: []
  }
  const persisted: { dirs: string[] } = { dirs: [] }
  const deps: ProjectSessionDeps = {
    reapUndoParks: async (dir) => {
      calls.reapUndoParks.push(dir)
    },
    parkPtys: (dir) => {
      calls.parkPtys.push(dir)
      return 2
    },
    disposePtys: async (dir) => {
      calls.disposePtys.push(dir)
    },
    countPtys: () => ({ running: 2 }),
    backgroundOsr: (dir) => {
      calls.backgroundOsr.push(dir)
      return 1
    },
    foregroundOsr: (dir) => {
      calls.foregroundOsr.push(dir)
      return 1
    },
    disposeOsr: (dir) => {
      calls.disposeOsr.push(dir)
    },
    countOsr: () => 1,
    now: () => 1_000,
    // C1 defaults: a generous cap (single-background tests evict nothing) + a far-future TTL
    // (never reaps unless a test overrides now/idleTtlMs). persistRingTails records the flush order.
    maxBackground: () => 3,
    idleTtlMs: () => 10 * 60_000,
    persistRingTails: (dir) => {
      calls.persistRingTails.push(dir)
    },
    loadForeverKeeps: () => persisted.dirs,
    saveForeverKeeps: (dirs) => {
      persisted.dirs = dirs
    },
    // Busy-aware defaults: nothing ever busy/active, no two-strike grace (immediate close past
    // the TTL) — the legacy behavior most suites drive; the busy-aware suite overrides these.
    activityAt: () => 0,
    isBusy: () => false,
    graceMs: () => 0,
    ...overrides
  }
  return { deps, calls, persisted }
}

describe('createProjectSessions (Phase 1 registry)', () => {
  it('backgroundProject reaps undo-parks first, parks + freezes, and registers the dir', async () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)

    const res = await ps.backgroundProject('C:/work/alpha')

    expect(res).toEqual({ terminals: 2, previews: 1, evicted: [], deferred: 0 })
    // R5: deleted boards' undo-parks die BEFORE the background park (their undo rail dies
    // with the switch's store replace).
    expect(calls.reapUndoParks).toEqual(['C:/work/alpha'])
    expect(calls.parkPtys).toEqual(['C:/work/alpha'])
    expect(calls.backgroundOsr).toEqual(['C:/work/alpha'])
    expect(ps.isBackgroundProject('C:/work/alpha')).toBe(true)
    expect(ps.backgroundCount()).toBe(1)
  })

  it('a reapUndoParks failure never blocks the background handover', async () => {
    const { deps, calls } = makeDeps({
      reapUndoParks: async () => {
        throw new Error('reap raced an exit')
      }
    })
    const ps = createProjectSessions(deps)
    await expect(ps.backgroundProject('C:/work/alpha')).resolves.toEqual({
      terminals: 2,
      previews: 1,
      evicted: [],
      deferred: 0
    })
    expect(calls.parkPtys).toEqual(['C:/work/alpha'])
  })

  it('listBackgroundProjects reports live counts + name + backgroundedAt', async () => {
    const { deps } = makeDeps({ now: () => 42 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('C:/work/alpha')

    expect(ps.listBackgroundProjects()).toEqual([
      {
        dir: 'C:/work/alpha',
        name: 'alpha',
        terminalsRunning: 2,
        previews: 1,
        backgroundedAt: 42
      }
    ])
  })

  it('foregroundProject un-registers and un-throttles — idempotent for a never-backgrounded dir', async () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('C:/work/alpha')

    ps.foregroundProject('C:/work/alpha')
    expect(ps.isBackgroundProject('C:/work/alpha')).toBe(false)
    expect(calls.foregroundOsr).toEqual(['C:/work/alpha'])

    // Never-backgrounded dir: still calls foregroundOsr (a no-op downstream), never throws.
    ps.foregroundProject('C:/work/other')
    expect(calls.foregroundOsr).toEqual(['C:/work/alpha', 'C:/work/other'])
  })

  it('closeBackgroundProject disposes ONLY a registered dir (never an arbitrary path)', async () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('C:/work/alpha')

    // Unregistered path (e.g. straight from a compromised renderer) → refused, nothing disposed.
    await expect(ps.closeBackgroundProject('C:\\Windows')).resolves.toBe(false)
    expect(calls.disposeOsr).toEqual([])
    expect(calls.disposePtys).toEqual([])

    await expect(ps.closeBackgroundProject('C:/work/alpha')).resolves.toBe(true)
    expect(calls.disposeOsr).toEqual(['C:/work/alpha'])
    expect(calls.disposePtys).toEqual(['C:/work/alpha'])
    expect(ps.isBackgroundProject('C:/work/alpha')).toBe(false)
    expect(ps.backgroundCount()).toBe(0)
  })

  it('re-backgrounding the same dir refreshes its stamp instead of duplicating', async () => {
    let t = 0
    const { deps } = makeDeps({ now: () => ++t })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('C:/work/alpha')
    await ps.backgroundProject('C:/work/alpha')
    expect(ps.backgroundCount()).toBe(1)
    expect(ps.listBackgroundProjects()[0].backgroundedAt).toBe(2)
  })

  it('a disposePtys rejection propagates (caller audits the failure) but the dir is already un-registered', async () => {
    const { deps } = makeDeps({
      disposePtys: vi.fn(async () => {
        throw new Error('taskkill hung')
      })
    })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('C:/work/alpha')
    await expect(ps.closeBackgroundProject('C:/work/alpha')).rejects.toThrow('taskkill hung')
    expect(ps.isBackgroundProject('C:/work/alpha')).toBe(false)
  })
})

// Phase 4: the per-project keep policy — the state machine behind the ask-on-switch dialog.
// ask (default) → Keep = session 'keep' → Keep+forever = persisted → forget/close = back to ask.
describe('switch keep policy (Phase 4)', () => {
  const A = 'C:/work/alpha'

  it("defaults to 'ask' and flips to 'keep' on setKeepPolicy (session-scoped: nothing persisted)", () => {
    const { deps, persisted } = makeDeps()
    const ps = createProjectSessions(deps)
    expect(ps.getSwitchPolicy(A)).toBe('ask')

    ps.setKeepPolicy(A, false)
    expect(ps.getSwitchPolicy(A)).toBe('keep')
    expect(persisted.dirs).toEqual([]) // app-run scope only — never written to disk
    expect(ps.keepForeverDirs()).toEqual([])
  })

  it('forever=true persists through the injected store and hydrates a fresh registry', () => {
    const { deps, persisted } = makeDeps()
    const ps = createProjectSessions(deps)
    ps.setKeepPolicy(A, true)
    expect(persisted.dirs).toEqual([A])
    expect(ps.keepForeverDirs()).toEqual([A])

    // A "new app run": a fresh registry over the SAME persisted store still keeps silently.
    const ps2 = createProjectSessions(makeDeps({ loadForeverKeeps: () => persisted.dirs }).deps)
    expect(ps2.getSwitchPolicy(A)).toBe('keep')
  })

  it('forgetKeepPolicy (the ∞ badge) clears session AND forever, back to ask', () => {
    const { deps, persisted } = makeDeps()
    const ps = createProjectSessions(deps)
    ps.setKeepPolicy(A, true)

    expect(ps.forgetKeepPolicy(A)).toBe(true)
    expect(ps.getSwitchPolicy(A)).toBe('ask')
    expect(persisted.dirs).toEqual([])
    expect(ps.forgetKeepPolicy(A)).toBe(false) // idempotent — nothing left to clear
  })

  it('closeBackgroundProject resets the policy too (closing IS the reset gesture)', async () => {
    const { deps, persisted } = makeDeps()
    const ps = createProjectSessions(deps)
    ps.setKeepPolicy(A, true)
    await ps.backgroundProject(A)

    await ps.closeBackgroundProject(A)
    expect(ps.getSwitchPolicy(A)).toBe('ask')
    expect(persisted.dirs).toEqual([])
  })

  it('a corrupt/throwing forever store degrades to session-only, never throws', () => {
    const { deps } = makeDeps({
      loadForeverKeeps: () => {
        throw new Error('corrupt json')
      },
      saveForeverKeeps: () => {
        throw new Error('disk full')
      }
    })
    const ps = createProjectSessions(deps)
    expect(ps.getSwitchPolicy(A)).toBe('ask')
    expect(() => ps.setKeepPolicy(A, true)).not.toThrow()
    expect(ps.getSwitchPolicy(A)).toBe('keep') // session keep still works
  })

  it('liveCounts reports the dialog body counts off the injected counters', () => {
    const { deps } = makeDeps()
    const ps = createProjectSessions(deps)
    expect(ps.liveCounts(A)).toEqual({ terminals: 2, previews: 1 })
  })
})

describe('createProjectSessions — C1 cap + idle TTL', () => {
  // A mutable clock so each background gets a distinct backgroundedAt (identifies the oldest).
  // `now` is applied LAST so it always wins over any override the test passes.
  function clockDeps(overrides: Partial<ProjectSessionDeps> = {}): ReturnType<typeof makeDeps> & {
    tick: (ms?: number) => void
    setTime: (v: number) => void
  } {
    let t = 0
    const base = makeDeps({ ...overrides, now: () => t })
    return {
      ...base,
      tick: (ms = 1000) => {
        t += ms
      },
      setTime: (v) => {
        t = v
      }
    }
  }

  it('cap eviction closes the LONGEST-backgrounded when the budget is exceeded', async () => {
    const { deps, calls, tick } = clockDeps({ maxBackground: () => 2 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a')
    tick()
    await ps.backgroundProject('/b')
    tick()
    const res = await ps.backgroundProject('/c') // size 3 > cap 2 → evict the oldest (/a)

    expect(res.evicted).toEqual(['/a'])
    expect(ps.isBackgroundProject('/a')).toBe(false)
    expect(ps.isBackgroundProject('/b')).toBe(true)
    expect(ps.isBackgroundProject('/c')).toBe(true)
    expect(ps.backgroundCount()).toBe(2)
    // Scoped: ONLY /a's resources were disposed — the dispose-all-vs-scoped hazard. B/C untouched.
    expect(calls.disposePtys).toEqual(['/a'])
    expect(calls.disposeOsr).toEqual(['/a'])
  })

  it('never evicts the just-backgrounded dir (keeps the one the user switched away from)', async () => {
    const { deps, calls, tick } = clockDeps({ maxBackground: () => 1 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a')
    tick()
    const res = await ps.backgroundProject('/b') // cap 1, size 2 → evict /a, keep the just-added /b

    expect(res.evicted).toEqual(['/a'])
    expect(ps.isBackgroundProject('/b')).toBe(true)
    expect(calls.disposePtys).toEqual(['/a'])
  })

  it('a live cap DROP (Low-RAM) collapses the resident set in one background call', async () => {
    let cap = 3
    const { deps, tick } = clockDeps({ maxBackground: () => cap })
    const ps = createProjectSessions(deps)
    for (const d of ['/a', '/b', '/c']) {
      await ps.backgroundProject(d)
      tick()
    }
    expect(ps.backgroundCount()).toBe(3)

    cap = 1 // Low-RAM lowered the cap live
    const res = await ps.backgroundProject('/d') // must collapse to 1 (the just-added /d)
    expect(res.evicted).toEqual(['/a', '/b', '/c'])
    expect(ps.backgroundCount()).toBe(1)
    expect(ps.isBackgroundProject('/d')).toBe(true)
  })

  it('closeBg flushes ring tails BEFORE disposing PTYs (the data-loss fix)', async () => {
    const order: string[] = []
    const { deps } = clockDeps({
      persistRingTails: (dir) => order.push(`flush:${dir}`),
      disposePtys: async (dir) => {
        order.push(`dispose:${dir}`)
      }
    })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a')
    await ps.closeBackgroundProject('/a')
    expect(order).toEqual(['flush:/a', 'dispose:/a'])
  })

  it('reapIdle closes residents past the TTL, protecting the active + fresh ones', async () => {
    const { deps, calls, setTime } = clockDeps({ idleTtlMs: () => 1000 })
    const ps = createProjectSessions(deps)
    setTime(0)
    await ps.backgroundProject('/old') // backgroundedAt 0
    setTime(500)
    await ps.backgroundProject('/active') // 500 — past TTL at reap time but PROTECTED
    setTime(2000)
    await ps.backgroundProject('/fresh') // 2000 — under TTL

    const res = await ps.reapIdle(['/active']) // now=2000, TTL=1000
    expect(res.closed).toEqual(['/old']) // age 2000 > 1000
    expect(res.warned).toEqual([]) // grace 0 → no warning phase
    expect(res.capEvicted).toEqual([])
    expect(ps.isBackgroundProject('/old')).toBe(false)
    expect(ps.isBackgroundProject('/active')).toBe(true) // protected despite age 1500 > 1000
    expect(ps.isBackgroundProject('/fresh')).toBe(true) // age 0, under TTL
    expect(calls.disposePtys).toEqual(['/old'])
    expect(calls.persistRingTails).toEqual(['/old']) // reap flushes tails too — no lost output
  })

  it('an auto-evict PRESERVES a forever-keep (re-keeps next switch); manual close forgets it', async () => {
    const { deps, tick } = clockDeps({
      maxBackground: () => 1,
      loadForeverKeeps: () => ['/kept']
    })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/kept')
    tick()
    const res = await ps.backgroundProject('/new') // cap 1 → /kept auto-evicted despite forever flag

    expect(res.evicted).toEqual(['/kept'])
    expect(ps.isBackgroundProject('/kept')).toBe(false)
    // Involuntary eviction is NOT a policy reset — the forever flag survives so it re-keeps.
    expect(ps.keepForeverDirs()).toContain('/kept')

    // A MANUAL close, by contrast, IS the reset gesture.
    await ps.backgroundProject('/kept')
    await ps.closeBackgroundProject('/kept')
    expect(ps.keepForeverDirs()).not.toContain('/kept')
  })
})

// Busy-aware eviction: working residents (CPU-busy or recently-streaming) are never reaped or
// cap-evicted; activity resets the idle clock; the reap is two-strike; ∞ forever-keeps are
// TTL-exempt. These drive the exact scenario that motivated the feature: an agent mid-run in a
// backgrounded project must survive any wall-clock TTL.
describe('createProjectSessions — busy-aware eviction', () => {
  function busyDeps(overrides: Partial<ProjectSessionDeps> = {}): ReturnType<typeof makeDeps> & {
    busy: Set<string>
    activity: Map<string, number>
    setTime: (v: number) => void
  } {
    let t = 0
    const busy = new Set<string>()
    const activity = new Map<string, number>()
    const base = makeDeps({
      idleTtlMs: () => 60_000,
      isBusy: (dir) => busy.has(dir),
      activityAt: (dir) => activity.get(dir) ?? 0,
      ...overrides,
      now: () => t // applied LAST so the mutable clock always wins
    })
    return {
      ...base,
      busy,
      activity,
      setTime: (v) => {
        t = v
      }
    }
  }

  it('a CPU-busy resident survives arbitrarily far past the TTL; reaped once idle', async () => {
    const { deps, busy, setTime } = busyDeps()
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/work') // t=0
    busy.add('/work')

    setTime(10 * 60_000) // 10× the TTL — the old registry would have killed this agent mid-run
    expect((await ps.reapIdle([])).closed).toEqual([])
    expect(ps.isBackgroundProject('/work')).toBe(true)

    busy.delete('/work')
    expect((await ps.reapIdle([])).closed).toEqual(['/work'])
  })

  it('PTY output RESETS the idle clock (idle = since last activity, not since backgrounded)', async () => {
    const { deps, activity, setTime } = busyDeps()
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a') // t=0, TTL 60s

    // Output landed 50s ago (outside the 30s working window, so no busy skip) — the idle clock
    // runs from IT, not from backgroundedAt: 50s idle < 60s TTL → survives at t=300s.
    setTime(300_000)
    activity.set('/a', 250_000)
    expect((await ps.reapIdle([])).closed).toEqual([])

    setTime(320_000) // now 70s past the last output → past the TTL → reaped
    expect((await ps.reapIdle([])).closed).toEqual(['/a'])
  })

  it('output within the working window skips the reap entirely (streaming agent)', async () => {
    const { deps, activity, setTime } = busyDeps()
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a') // t=0
    setTime(300_000)
    activity.set('/a', 290_000) // 10s ago — inside OUTPUT_BUSY_WINDOW_MS
    expect((await ps.reapIdle([])).closed).toEqual([])
  })

  it('two-strike: warn → silent within grace → close after grace', async () => {
    const { deps, setTime } = busyDeps({ graceMs: () => 120_000 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a') // t=0, TTL 60s

    setTime(61_000) // past the TTL → strike 1: warned, NOT closed
    const first = await ps.reapIdle([])
    expect(first.closed).toEqual([])
    expect(first.warned).toEqual([{ dir: '/a', closesInMs: 120_000 }])
    expect(ps.isBackgroundProject('/a')).toBe(true)

    setTime(120_000) // between strikes (59s of the 120s grace) → silent, no re-warn
    const mid = await ps.reapIdle([])
    expect(mid.closed).toEqual([])
    expect(mid.warned).toEqual([])

    setTime(181_001) // grace elapsed → strike 2 closes
    expect((await ps.reapIdle([])).closed).toEqual(['/a'])
  })

  it('going busy between strikes clears the strike — a fresh idle spell warns AGAIN', async () => {
    const { deps, busy, setTime } = busyDeps({ graceMs: () => 120_000 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a')

    setTime(61_000)
    expect((await ps.reapIdle([])).warned).toHaveLength(1) // strike 1

    busy.add('/a') // work resumed → the pending strike must die with it
    setTime(200_000)
    expect((await ps.reapIdle([])).closed).toEqual([])

    busy.delete('/a') // idle again FAR past warnedAt+grace — must WARN, never instant-close
    setTime(400_000)
    const again = await ps.reapIdle([])
    expect(again.closed).toEqual([])
    expect(again.warned).toEqual([{ dir: '/a', closesInMs: 120_000 }])
  })

  it('∞ forever-keeps are exempt from the TTL reap (but still cap-evictable when idle)', async () => {
    const { deps, setTime } = busyDeps({ loadForeverKeeps: () => ['/kept'] })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/kept') // t=0

    setTime(60 * 60_000) // an hour idle — the user said keep forever, so the TTL never fires
    expect((await ps.reapIdle([])).closed).toEqual([])
    expect(ps.isBackgroundProject('/kept')).toBe(true)
  })

  it('cap: a WORKING resident is never the victim — the set defers past the cap', async () => {
    const { deps, busy, setTime } = busyDeps({ maxBackground: () => 1 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a')
    busy.add('/a') // the only candidate victim is mid-work
    setTime(1000)

    const res = await ps.backgroundProject('/b') // cap 1, size 2, /a busy → defer, kill nothing
    expect(res.evicted).toEqual([])
    expect(res.deferred).toBe(1)
    expect(ps.backgroundCount()).toBe(2)
  })

  it('the sweep collapses a deferred over-cap set once the survivor goes idle — and never the freshly-kept project', async () => {
    const { deps, busy, setTime } = busyDeps({
      maxBackground: () => 1,
      idleTtlMs: () => 60 * 60_000, // TTL far away — this test isolates the cap retry
      graceMs: () => 120_000
    })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/a')
    busy.add('/a')
    setTime(1000)
    await ps.backgroundProject('/b') // deferred past the cap (/a busy)

    // /b is idle-at-prompt but FRESH (aged 1s < grace) — the retry must NOT collapse onto it
    // one sweep after the user chose Keep (that would be the original silent-kill bug reborn).
    setTime(2000)
    expect((await ps.reapIdle([])).capEvicted).toEqual([])
    expect(ps.backgroundCount()).toBe(2)

    busy.delete('/a')
    setTime(150_000) // both aged past the grace; /a (oldest idle) is the victim
    const res = await ps.reapIdle([])
    expect(res.capEvicted).toEqual(['/a'])
    expect(ps.backgroundCount()).toBe(1)
    expect(ps.isBackgroundProject('/b')).toBe(true)
  })

  it('cap eviction picks the oldest IDLE resident, skipping a busy older one', async () => {
    const { deps, busy, setTime } = busyDeps({ maxBackground: () => 2 })
    const ps = createProjectSessions(deps)
    await ps.backgroundProject('/oldest-busy') // t=0
    busy.add('/oldest-busy')
    setTime(1000)
    await ps.backgroundProject('/older-idle')
    setTime(2000)

    const res = await ps.backgroundProject('/new') // cap 2 → victim = /older-idle (not the busy elder)
    expect(res.evicted).toEqual(['/older-idle'])
    expect(res.deferred).toBe(0)
    expect(ps.isBackgroundProject('/oldest-busy')).toBe(true)
  })
})
