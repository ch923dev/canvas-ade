/**
 * `openProject` — the no-outgoing-project open primitive (audit R4).
 *
 * R4 exists because three production doors hand-rolled this and did not agree. The point of the
 * primitive is therefore not "less code" but "one behaviour", and the only way to hold that is to
 * pin the behaviour here — otherwise the next door added is free to diverge again exactly as boot
 * did.
 *
 * Same discipline as `projectSwitch.test.ts`: every collaborator appends to one shared `calls` log,
 * so ORDER is assertable (loading must be armed *before* the IPC, not after — that ordering is the
 * whole reason the picker stops being interactive during a slow open), and the lock is a faithful
 * mini-implementation rather than a stubbed boolean, so `'locked'` is a property of a real second
 * acquire failing rather than of a hand-set flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OpenResult } from './canvasStore'

const { calls, storeState, lockState } = vi.hoisted(() => ({
  calls: [] as string[],
  storeState: {
    project: { dir: null as string | null, name: null as string | null, status: 'welcome' },
    setProjectLoading: (): void => {
      calls.push('loading')
    },
    applyOpenResult: async (_r: OpenResult): Promise<void> => undefined
  },
  lockState: { held: false }
}))

vi.mock('./canvasStore', () => ({
  useCanvasStore: {
    getState: () => storeState,
    setState: (fn: (s: typeof storeState) => { project: { status: string } }) => {
      calls.push('welcome')
      storeState.project.status = fn(storeState).project.status
    }
  },
  acquireProjectSwitchLock: (): boolean => {
    if (lockState.held) return false
    lockState.held = true
    return true
  },
  releaseProjectSwitchLock: (): void => {
    lockState.held = false
    calls.push('releaseLock')
  }
}))

const { openProject } = await import('./openProject')

const OK: OpenResult = { ok: true, dir: 'C:/p', name: 'p', doc: {} }

/** Stand in for `applyOpenResult`: logs, then settles the status the real one would have settled. */
function applySettling(status: string): (r: OpenResult) => Promise<void> {
  return async (r) => {
    calls.push(`apply:${r.ok ? 'ok' : `err(${r.error})`}`)
    storeState.project.status = status
  }
}

beforeEach(() => {
  calls.length = 0
  lockState.held = false
  storeState.project = { dir: null, name: null, status: 'welcome' }
  storeState.applyOpenResult = applySettling('open')
})

describe('openProject outcomes', () => {
  it('opened: loads, applies, and reports the status applyOpenResult settled', async () => {
    const outcome = await openProject(async () => {
      calls.push('load')
      return OK
    })

    expect(outcome).toBe('opened')
    // Loading is armed BEFORE the IPC — the picker must not stay interactive during a slow open —
    // and the lock is released only after the result has been applied.
    expect(calls).toEqual(['loading', 'load', 'apply:ok', 'releaseLock'])
  })

  it('none: a null load is "nothing to open", not an error — and undoes the loading state', async () => {
    const outcome = await openProject(async () => {
      calls.push('load')
      return null
    })

    expect(outcome).toBe('none')
    // Boot arms `loading` before asking MAIN what the last project was; without the welcome
    // restore the app would sit on a loading line forever with no project and no picker.
    expect(calls).toEqual(['loading', 'load', 'welcome', 'releaseLock'])
    expect(storeState.project.status).toBe('welcome')
  })

  it('locked: a second open while one is in flight touches NOTHING', async () => {
    lockState.held = true // another surface's open/switch is mid-flight
    const load = vi.fn()

    const outcome = await openProject(load as unknown as () => Promise<OpenResult>)

    expect(outcome).toBe('locked')
    expect(load).not.toHaveBeenCalled()
    // Not even `loading` — a bailed-out open must leave the in-flight one's UI state alone …
    expect(calls).toEqual([])
    // … and must NOT release a lock it never took (that would strand the real holder unguarded).
    expect(lockState.held).toBe(true)
  })

  it('failed: MAIN said no — the error result is applied, not swallowed', async () => {
    storeState.applyOpenResult = applySettling('error')

    const outcome = await openProject(async () => ({ ok: false, error: 'ENOENT canvas.json' }))

    expect(outcome).toBe('failed')
    expect(calls).toContain('apply:err(ENOENT canvas.json)')
    expect(lockState.held).toBe(false)
  })

  it('failed: a REJECTED ipc settles to error rather than sticking on loading (#BUG-030)', async () => {
    storeState.applyOpenResult = applySettling('error')

    const outcome = await openProject(async () => {
      throw new Error('EDQUOT touchRecent')
    })

    expect(outcome).toBe('failed')
    expect(calls).toEqual(['loading', 'apply:err(EDQUOT touchRecent)', 'releaseLock'])
    expect(storeState.project.status).toBe('error')
  })

  it('failed: a rejection carrying no Error message falls back to the caller label', async () => {
    storeState.applyOpenResult = applySettling('error')

    await openProject(async () => {
      throw 'not an Error'
    }, 'failed to create project')

    expect(calls).toContain('apply:err(failed to create project)')
  })

  it('failed: an ok result that applyOpenResult could not load is NOT reported as opened', async () => {
    // The deep-validation path: MAIN's envelope check passed, so `r.ok` is true, but fromObject
    // threw and the .bak retry failed too. Reading the outcome off `r.ok` would call this a
    // successful open onto a canvas that never loaded.
    storeState.applyOpenResult = applySettling('error')

    expect(await openProject(async () => OK)).toBe('failed')
  })

  it('releases the lock even when applying the result throws', async () => {
    storeState.applyOpenResult = async () => {
      calls.push('apply:boom')
      throw new Error('apply exploded')
    }

    // The catch re-routes into applyOpenResult, which throws again — the point is only that the
    // lock does not survive it. A stranded lock silently disables EVERY later open in the session.
    await openProject(async () => OK).catch(() => 'threw')

    expect(lockState.held).toBe(false)
    expect(calls).toContain('releaseLock')
  })

  it('serialises: the lock is free again for the next open', async () => {
    expect(await openProject(async () => OK)).toBe('opened')
    expect(await openProject(async () => OK)).toBe('opened')
  })
})
