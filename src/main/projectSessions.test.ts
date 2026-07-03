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
    disposeOsr: []
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
    loadForeverKeeps: () => persisted.dirs,
    saveForeverKeeps: (dirs) => {
      persisted.dirs = dirs
    },
    ...overrides
  }
  return { deps, calls, persisted }
}

describe('createProjectSessions (Phase 1 registry)', () => {
  it('backgroundProject reaps undo-parks first, parks + freezes, and registers the dir', async () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)

    const res = await ps.backgroundProject('C:/work/alpha')

    expect(res).toEqual({ terminals: 2, previews: 1 })
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
      previews: 1
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
