import { describe, it, expect, vi } from 'vitest'
import { createProjectSessions, type ProjectSessionDeps } from './projectSessions'

// Background project sessions (Phase 1): the registry orchestrates the pty/previewOsr
// project-scoped resource functions and is the single source of truth for WHICH projects are
// backgrounded. Deps are factory-injected, so these tests drive the real registry logic with
// recording fakes — no electron/node-pty runtime.

function makeDeps(overrides: Partial<ProjectSessionDeps> = {}): {
  deps: ProjectSessionDeps
  calls: Record<string, string[]>
} {
  const calls: Record<string, string[]> = {
    parkPtys: [],
    disposePtys: [],
    backgroundOsr: [],
    foregroundOsr: [],
    disposeOsr: []
  }
  const deps: ProjectSessionDeps = {
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
    ...overrides
  }
  return { deps, calls }
}

describe('createProjectSessions (Phase 1 registry)', () => {
  it('backgroundProject parks + freezes and registers the dir', () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)

    const res = ps.backgroundProject('C:\\work\\alpha')

    expect(res).toEqual({ terminals: 2, previews: 1 })
    expect(calls.parkPtys).toEqual(['C:\\work\\alpha'])
    expect(calls.backgroundOsr).toEqual(['C:\\work\\alpha'])
    expect(ps.isBackgroundProject('C:\\work\\alpha')).toBe(true)
    expect(ps.backgroundCount()).toBe(1)
  })

  it('listBackgroundProjects reports live counts + name + backgroundedAt', () => {
    const { deps } = makeDeps({ now: () => 42 })
    const ps = createProjectSessions(deps)
    ps.backgroundProject('C:\\work\\alpha')

    expect(ps.listBackgroundProjects()).toEqual([
      {
        dir: 'C:\\work\\alpha',
        name: 'alpha',
        terminalsRunning: 2,
        previews: 1,
        backgroundedAt: 42
      }
    ])
  })

  it('foregroundProject un-registers and un-throttles — idempotent for a never-backgrounded dir', () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)
    ps.backgroundProject('C:\\work\\alpha')

    ps.foregroundProject('C:\\work\\alpha')
    expect(ps.isBackgroundProject('C:\\work\\alpha')).toBe(false)
    expect(calls.foregroundOsr).toEqual(['C:\\work\\alpha'])

    // Never-backgrounded dir: still calls foregroundOsr (a no-op downstream), never throws.
    ps.foregroundProject('C:\\work\\other')
    expect(calls.foregroundOsr).toEqual(['C:\\work\\alpha', 'C:\\work\\other'])
  })

  it('closeBackgroundProject disposes ONLY a registered dir (never an arbitrary path)', async () => {
    const { deps, calls } = makeDeps()
    const ps = createProjectSessions(deps)
    ps.backgroundProject('C:\\work\\alpha')

    // Unregistered path (e.g. straight from a compromised renderer) → refused, nothing disposed.
    await expect(ps.closeBackgroundProject('C:\\Windows')).resolves.toBe(false)
    expect(calls.disposeOsr).toEqual([])
    expect(calls.disposePtys).toEqual([])

    await expect(ps.closeBackgroundProject('C:\\work\\alpha')).resolves.toBe(true)
    expect(calls.disposeOsr).toEqual(['C:\\work\\alpha'])
    expect(calls.disposePtys).toEqual(['C:\\work\\alpha'])
    expect(ps.isBackgroundProject('C:\\work\\alpha')).toBe(false)
    expect(ps.backgroundCount()).toBe(0)
  })

  it('re-backgrounding the same dir refreshes its stamp instead of duplicating', () => {
    let t = 0
    const { deps } = makeDeps({ now: () => ++t })
    const ps = createProjectSessions(deps)
    ps.backgroundProject('C:\\work\\alpha')
    ps.backgroundProject('C:\\work\\alpha')
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
    ps.backgroundProject('C:\\work\\alpha')
    await expect(ps.closeBackgroundProject('C:\\work\\alpha')).rejects.toThrow('taskkill hung')
    expect(ps.isBackgroundProject('C:\\work\\alpha')).toBe(false)
  })
})
