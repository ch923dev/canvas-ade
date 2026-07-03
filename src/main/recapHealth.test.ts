import { describe, it, expect, vi } from 'vitest'
import { computeRecapHealth, createFocusReEnsure, selectTranscriptClocks } from './recapHealth'
import type { RecapMapEntry } from './agentRecapMap'

const healthDeps = (
  over: Partial<Parameters<typeof computeRecapHealth>[0]> = {}
): Parameters<typeof computeRecapHealth>[0] => ({
  getCurrentDir: () => 'C:/proj',
  isConsented: () => true,
  runnerOk: () => true,
  hookInstalled: () => true,
  hasCapture: () => true,
  sessionAgeMs: () => 42_000,
  ...over
})

describe('computeRecapHealth — the fault matrix', () => {
  it('null without an open project (nothing to be healthy about)', () => {
    expect(computeRecapHealth(healthDeps({ getCurrentDir: () => null }), 'b1')).toBeNull()
  })

  it('null when the project has not consented — capture off is EXPECTED, never a fault', () => {
    expect(computeRecapHealth(healthDeps({ isConsented: () => false }), 'b1')).toBeNull()
  })

  it('healthy: runner ok + hook installed + a capture exists', () => {
    expect(computeRecapHealth(healthDeps(), 'b1')).toEqual({
      runner: 'ok',
      hookInstalled: true,
      captured: true,
      sessionAgeMs: 42_000
    })
  })

  it('runner missing (packaged, no node on PATH) reports independently of the rest', () => {
    expect(computeRecapHealth(healthDeps({ runnerOk: () => false }), 'b1')).toEqual({
      runner: 'missing',
      hookInstalled: true,
      captured: true,
      sessionAgeMs: 42_000
    })
  })

  it('hook not installed (the settings.local.json clobber) reports with runner ok', () => {
    expect(computeRecapHealth(healthDeps({ hookInstalled: () => false }), 'b1')).toEqual({
      runner: 'ok',
      hookInstalled: false,
      captured: true,
      sessionAgeMs: 42_000
    })
  })

  it('captured=false when the map has no entry for THIS board', () => {
    const deps = healthDeps({ hasCapture: (id) => id === 'other', sessionAgeMs: () => null })
    expect(computeRecapHealth(deps, 'b1')).toEqual({
      runner: 'ok',
      hookInstalled: true,
      captured: false,
      sessionAgeMs: null
    })
  })
})

describe('createFocusReEnsure — the focus-time self-heal', () => {
  const mk = (
    over: Partial<Parameters<typeof createFocusReEnsure>[0]> = {}
  ): { reEnsure: () => void; install: ReturnType<typeof vi.fn> } => {
    const install = vi.fn()
    const reEnsure = createFocusReEnsure({
      getCurrentDir: () => 'C:/proj',
      isConsented: () => true,
      runnerOk: () => true,
      install,
      ...over
    })
    return { reEnsure, install }
  }

  it('re-installs for the open consented project', () => {
    const { reEnsure, install } = mk()
    reEnsure()
    expect(install).toHaveBeenCalledExactlyOnceWith('C:/proj')
  })

  it('does nothing without a project, without consent, or without a runner', () => {
    for (const over of [
      { getCurrentDir: () => null },
      { isConsented: () => false },
      { runnerOk: () => false }
    ] as const) {
      const { reEnsure, install } = mk(over)
      reEnsure()
      expect(install).not.toHaveBeenCalled()
    }
  })

  it('swallows an install throw — a broken settings file must never break window focus', () => {
    const { reEnsure } = mk({
      install: () => {
        throw new Error('EACCES')
      }
    })
    expect(() => reEnsure()).not.toThrow()
  })
})

describe('selectTranscriptClocks — the A4 clock selection (#295 carry-in)', () => {
  const entry: RecapMapEntry = {
    sessionId: 'eager-session-id',
    transcriptPath: 'C:/claude/eager.jsonl',
    ts: 1000,
    confirmed: {
      sessionId: 'confirmed-session-id',
      transcriptPath: 'C:/claude/real.jsonl',
      ts: 2000
    }
  }

  it('top-level entry clocks when the recorded path IS the entry path', () => {
    expect(selectTranscriptClocks(entry, 'C:/claude/eager.jsonl')).toEqual({
      sessionId: 'eager-session-id',
      recordedAt: 1000
    })
  })

  it('CONFIRMED clocks when the recorded path is the confirmed capture path — the carry-in: a', () => {
    // rotated confirmed session now threads its own lineage anchor + grace clock, so
    // resolveLiveTranscriptPath can adopt the rotation successor instead of the stale fork.
    expect(selectTranscriptClocks(entry, 'C:/claude/real.jsonl')).toEqual({
      sessionId: 'confirmed-session-id',
      recordedAt: 2000
    })
  })

  it('an empty confirmed sessionId (pre-id hook lines) becomes undefined, never a "" anchor', () => {
    const e: RecapMapEntry = {
      ...entry,
      confirmed: { sessionId: '', transcriptPath: 'C:/claude/real.jsonl', ts: 2000 }
    }
    expect(selectTranscriptClocks(e, 'C:/claude/real.jsonl')).toEqual({
      sessionId: undefined,
      recordedAt: 2000
    })
  })

  it('no clocks for a divergent persisted path, a missing entry, or no recorded path', () => {
    expect(selectTranscriptClocks(entry, 'C:/claude/other.jsonl')).toEqual({})
    expect(selectTranscriptClocks(undefined, 'C:/claude/eager.jsonl')).toEqual({})
    expect(selectTranscriptClocks(entry, undefined)).toEqual({})
  })
})
