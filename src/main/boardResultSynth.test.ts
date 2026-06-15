import { describe, it, expect, beforeEach } from 'vitest'
import {
  synthesizeBoardResult,
  createResultSynthesizer,
  SYNTH_SUMMARY_MAX
} from './boardResultSynth'
import {
  readBoardResult,
  recordBoardResult,
  isResultSynthesized,
  __resetBoardResults
} from './boardResults'
import type { RecapFacts, RecapStatus } from './recapFacts'

/** Minimal RecapFacts factory — overlay only the fields a case exercises. */
function facts(p: Partial<RecapFacts> & { status: RecapStatus }): RecapFacts {
  return {
    v: 1,
    live: false,
    turns: { user: 0, agent: 0 },
    files: [],
    commands: [],
    generatedAt: 0,
    ...p
  }
}

describe('synthesizeBoardResult (pure mapper)', () => {
  it('returns null for not-done states (running/spawning/waiting-on-you)', () => {
    expect(synthesizeBoardResult(facts({ status: 'running' }))).toBeNull()
    expect(synthesizeBoardResult(facts({ status: 'spawning' }))).toBeNull()
    expect(synthesizeBoardResult(facts({ status: 'waiting-on-you' }))).toBeNull()
  })

  it('idle → success verdict with a one-line summary and file refs', () => {
    const r = synthesizeBoardResult(
      facts({
        status: 'idle',
        title: 'Add auth guard',
        turns: { user: 2, agent: 3 },
        files: [
          { path: 'src/a.ts', op: 'edit', count: 2 },
          { path: 'src/b.ts', op: 'write', count: 1 }
        ],
        commands: [{ label: 'run tests', count: 1 }]
      })
    )
    expect(r).not.toBeNull()
    expect(r!.status).toBe('success')
    expect(r!.refs).toEqual(['src/a.ts', 'src/b.ts'])
    expect(r!.summary).toContain('Add auth guard')
    expect(r!.summary).toContain('2 files')
    expect(r!.summary).toContain('1 command')
    expect(r!.summary).toContain('3 turns')
  })

  it('exited non-zero → failure with an exit-code head; exited zero → success', () => {
    const fail = synthesizeBoardResult(facts({ status: 'exited', exitCode: 1 }))
    expect(fail!.status).toBe('failure')
    expect(fail!.summary).toContain('exited (code 1)')

    const ok = synthesizeBoardResult(facts({ status: 'exited', exitCode: 0 }))
    expect(ok!.status).toBe('success')
    expect(ok!.summary).toContain('exited (code 0)')
  })

  it('spawn-failed → failure verdict', () => {
    const r = synthesizeBoardResult(facts({ status: 'spawn-failed' }))
    expect(r!.status).toBe('failure')
    expect(r!.summary).toContain('spawn failed')
  })

  it('omits refs when no files were touched, and singularizes counts', () => {
    const r = synthesizeBoardResult(
      facts({
        status: 'idle',
        files: [{ path: 'only.ts', op: 'edit', count: 1 }],
        turns: { user: 1, agent: 1 }
      })
    )
    expect(r!.refs).toEqual(['only.ts'])
    expect(r!.summary).toContain('1 file')
    expect(r!.summary).toContain('1 turn')

    const noFiles = synthesizeBoardResult(facts({ status: 'idle' }))
    expect(noFiles!.refs).toBeUndefined()
    // No title/counts → the bare fallback.
    expect(noFiles!.summary).toBe('completed')
  })

  it('caps the summary to SYNTH_SUMMARY_MAX', () => {
    const r = synthesizeBoardResult(facts({ status: 'idle', title: 'x'.repeat(500) }))
    expect(r!.summary).toHaveLength(SYNTH_SUMMARY_MAX)
  })
})

describe('createResultSynthesizer (settle → record driver)', () => {
  const NOW = 1_000_000
  beforeEach(() => __resetBoardResults())

  it('records a synthesized result on settle and tags it synthesized', () => {
    const synth = createResultSynthesizer({
      now: () => NOW,
      getFacts: () => facts({ status: 'idle', title: 'done', turns: { user: 1, agent: 1 } })
    })
    synth.onSettle('b1')
    const r = readBoardResult('b1')
    expect(r.present).toBe(true)
    expect(r.status).toBe('success')
    expect(r.at).toBe(new Date(NOW).toISOString())
    expect(isResultSynthesized('b1')).toBe(true)
  })

  it('never clobbers an explicit write_result (self-report owns the id)', () => {
    // Worker self-report: recorded WITHOUT the synthesized tag.
    recordBoardResult('b1', { present: true, status: 'success', summary: 'worker said so' })
    const synth = createResultSynthesizer({
      now: () => NOW,
      getFacts: () => facts({ status: 'exited', exitCode: 1 }) // would otherwise write 'failure'
    })
    synth.onSettle('b1')
    expect(readBoardResult('b1').summary).toBe('worker said so')
    expect(readBoardResult('b1').status).toBe('success')
    expect(isResultSynthesized('b1')).toBe(false)
  })

  it('refreshes its OWN prior synthesis on a later settle', () => {
    let s: RecapStatus = 'idle'
    const synth = createResultSynthesizer({
      now: () => NOW,
      getFacts: () => facts({ status: 'exited', exitCode: s === 'idle' ? 0 : 1 })
    })
    synth.onSettle('b1')
    expect(readBoardResult('b1').status).toBe('success')
    s = 'exited' // flip the produced facts to a failing exit
    synth.onSettle('b1')
    expect(readBoardResult('b1').status).toBe('failure')
  })

  it('parks ONE deferred re-check while running, then records once idle', () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    let call = 0
    const synth = createResultSynthesizer({
      now: () => NOW,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms })
        return () => {}
      },
      getFacts: () => {
        call++
        // First read: still running (30s since last activity). Re-check read: idle.
        return call === 1
          ? facts({ status: 'running', lastActivity: NOW - 30_000 })
          : facts({ status: 'idle', title: 'late finish' })
      }
    })
    synth.onSettle('b1')
    // Nothing recorded yet (still running), and exactly one re-check parked.
    expect(readBoardResult('b1').present).toBe(false)
    expect(scheduled).toHaveLength(1)
    // wait = idleAfterMs(60s) - elapsed(30s) + slack(1s).
    expect(scheduled[0].ms).toBe(31_000)
    // Fire the deferred re-check → now idle → records.
    scheduled[0].fn()
    expect(readBoardResult('b1').present).toBe(true)
    expect(readBoardResult('b1').status).toBe('success')
    // The one-shot re-check does not re-arm itself.
    expect(scheduled).toHaveLength(1)
  })

  it('retain cancels pending timers for boards no longer live', () => {
    const cancels: Record<string, boolean> = {}
    const synth = createResultSynthesizer({
      now: () => NOW,
      schedule: (_fn, _ms) => {
        const id = `t${Object.keys(cancels).length}`
        cancels[id] = false
        return () => {
          cancels[id] = true
        }
      },
      getFacts: () => facts({ status: 'running', lastActivity: NOW })
    })
    synth.onSettle('keep')
    synth.onSettle('drop')
    synth.retain(new Set(['keep']))
    // The 'drop' board's timer was cancelled; 'keep' survives.
    expect(Object.values(cancels)).toContain(true)
    expect(Object.values(cancels).filter(Boolean)).toHaveLength(1)
  })

  it('getFacts returning null is a no-op (no record, no throw)', () => {
    const synth = createResultSynthesizer({ now: () => NOW, getFacts: () => null })
    expect(() => synth.onSettle('b1')).not.toThrow()
    expect(readBoardResult('b1').present).toBe(false)
  })

  it('a throwing getFacts is swallowed', () => {
    const synth = createResultSynthesizer({
      now: () => NOW,
      getFacts: () => {
        throw new Error('boom')
      }
    })
    expect(() => synth.onSettle('b1')).not.toThrow()
    expect(readBoardResult('b1').present).toBe(false)
  })

  it('dispose cancels all pending timers', () => {
    let cancelled = 0
    const synth = createResultSynthesizer({
      now: () => NOW,
      schedule: () => () => {
        cancelled++
      },
      getFacts: () => facts({ status: 'running', lastActivity: NOW })
    })
    synth.onSettle('b1')
    synth.onSettle('b2')
    synth.dispose()
    expect(cancelled).toBe(2)
  })
})
