import { describe, it, expect, vi } from 'vitest'
import {
  colsChanged,
  applyResizeBackstop,
  runBackstopFit,
  type ResizeBackstopDeps,
  type BackstopFitDeps,
  type BackstopGate
} from './terminalResizeBackstop'

describe('colsChanged', () => {
  it('is true only when proposed cols are finite and differ', () => {
    expect(colsChanged(80, 100)).toBe(true)
    expect(colsChanged(80, 80)).toBe(false)
    expect(colsChanged(80, undefined)).toBe(false)
    expect(colsChanged(80, NaN)).toBe(false)
    expect(colsChanged(80, Infinity)).toBe(false)
  })
})

/** A spy harness whose `write` captures (but does not auto-fire) the parse callback. */
function harness(): {
  deps: ResizeBackstopDeps
  order: string[]
  fireWriteDone: () => void
  writtenData: () => string | undefined
} {
  const order: string[] = []
  let pendingDone: (() => void) | null = null
  let data: string | undefined
  const deps: ResizeBackstopDeps = {
    serialize: () => {
      order.push('serialize')
      return 'SNAPSHOT'
    },
    resize: (c, r) => order.push(`resize:${c}x${r}`),
    reset: () => order.push('reset'),
    write: (d, done) => {
      order.push('write')
      data = d
      pendingDone = done
    },
    pausePump: () => order.push('pause'),
    resumePump: () => order.push('resume')
  }
  return { deps, order, fireWriteDone: () => pendingDone?.(), writtenData: () => data }
}

describe('applyResizeBackstop', () => {
  it('runs pause → serialize → resize → reset → write, then resumes only on the parse callback', () => {
    const h = harness()
    applyResizeBackstop(120, 30, h.deps)
    // Pump is held and the snapshot written, but NOT yet resumed (snapshot still parsing).
    expect(h.order).toEqual(['pause', 'serialize', 'resize:120x30', 'reset', 'write'])
    expect(h.writtenData()).toBe('SNAPSHOT')

    h.fireWriteDone()
    expect(h.order[h.order.length - 1]).toBe('resume')
  })

  it('resumes the pump exactly once even if the parse callback fires twice', () => {
    const h = harness()
    applyResizeBackstop(100, 24, h.deps)
    h.fireWriteDone()
    h.fireWriteDone()
    expect(h.order.filter((o) => o === 'resume')).toHaveLength(1)
  })

  it('resumes immediately if a step throws (never leaves the pump paused)', () => {
    const order: string[] = []
    const deps: ResizeBackstopDeps = {
      serialize: () => {
        order.push('serialize')
        throw new Error('serialize blew up')
      },
      resize: () => order.push('resize'),
      reset: () => order.push('reset'),
      write: () => order.push('write'),
      pausePump: () => order.push('pause'),
      resumePump: () => order.push('resume')
    }
    expect(() => applyResizeBackstop(120, 30, deps)).not.toThrow()
    expect(order).toEqual(['pause', 'serialize', 'resume'])
  })
})

/**
 * Harness for `runBackstopFit`. `write` defers its parse callback (so the backstop stays "in
 * flight"), and `pausePump`/`resumePump` flip a local `inFlight` bool — exactly how the hook's
 * `resizeBackstopRef` behaves — so the re-entrancy guard is exercised realistically.
 */
function fitHarness(opts?: {
  established?: boolean
  propose?: { cols: number; rows: number } | undefined
  currentCols?: number
  plainFitOk?: boolean
}): {
  gate: BackstopGate
  deps: BackstopFitDeps
  order: string[]
  inFlight: () => boolean
  fireWriteDone: () => void
  refit: ReturnType<typeof vi.fn>
  plainFit: ReturnType<typeof vi.fn>
} {
  const order: string[] = []
  let inFlight = false
  let pendingDone: (() => void) | null = null
  const refit = vi.fn()
  const plainFit = vi.fn(() => {
    order.push('plainFit')
    return opts?.plainFitOk ?? true
  })
  const gate: BackstopGate = { pending: false }
  const deps: BackstopFitDeps = {
    currentCols: () => opts?.currentCols ?? 80,
    propose: () => (opts && 'propose' in opts ? opts.propose : { cols: 100, rows: 24 }),
    established: () => opts?.established ?? true,
    plainFit,
    isInFlight: () => inFlight,
    refit,
    serialize: () => {
      order.push('serialize')
      return 'SNAP'
    },
    resize: (c, r) => order.push(`resize:${c}x${r}`),
    reset: () => order.push('reset'),
    write: (_d, done) => {
      order.push('write')
      pendingDone = done
    },
    pausePump: () => {
      inFlight = true
      order.push('pause')
    },
    resumePump: () => {
      inFlight = false
      order.push('resume')
    }
  }
  return {
    gate,
    deps,
    order,
    inFlight: () => inFlight,
    fireWriteDone: () => pendingDone?.(),
    refit,
    plainFit
  }
}

describe('runBackstopFit — re-entrancy guard', () => {
  it('runs the backstop when idle + established + cols change', () => {
    const h = fitHarness({ currentCols: 80, propose: { cols: 100, rows: 24 } })
    expect(runBackstopFit(h.gate, h.deps)).toBe(true)
    expect(h.order).toEqual(['pause', 'serialize', 'resize:100x24', 'reset', 'write'])
    expect(h.gate.pending).toBe(false)
  })

  it('takes the plain fit for a rows-only resize (cols unchanged) — never serializes', () => {
    const h = fitHarness({ currentCols: 100, propose: { cols: 100, rows: 30 } })
    expect(runBackstopFit(h.gate, h.deps)).toBe(true)
    expect(h.order).toEqual(['plainFit'])
  })

  it('takes the plain fit for a fresh (not established) grid', () => {
    const h = fitHarness({ established: false, currentCols: 80, propose: { cols: 100, rows: 24 } })
    expect(runBackstopFit(h.gate, h.deps)).toBe(true)
    expect(h.order).toEqual(['plainFit'])
  })

  it('takes the plain fit when proposeDimensions is undefined (not laid out)', () => {
    const h = fitHarness({ propose: undefined })
    expect(runBackstopFit(h.gate, h.deps)).toBe(true)
    expect(h.order).toEqual(['plainFit'])
  })

  it('returns false (→ caller skips the row-shed) when the plain fit cannot lay out', () => {
    const h = fitHarness({ currentCols: 100, propose: { cols: 100, rows: 30 }, plainFitOk: false })
    expect(runBackstopFit(h.gate, h.deps)).toBe(false)
  })

  it('SKIPS a re-entrant fit while a backstop is in flight — only sets a pending flag, no second serialize/reset', () => {
    const h = fitHarness({ currentCols: 80, propose: { cols: 100, rows: 24 } })
    expect(runBackstopFit(h.gate, h.deps)).toBe(true) // starts the backstop (write deferred)
    expect(h.inFlight()).toBe(true)
    const afterFirst = [...h.order]

    // A drag frame arrives mid-parse — must NOT touch the terminal.
    expect(runBackstopFit(h.gate, h.deps)).toBe(false)
    expect(h.gate.pending).toBe(true)
    expect(h.order).toEqual(afterFirst) // no new pause/serialize/resize/reset/write, no plainFit
    expect(h.refit).not.toHaveBeenCalled()
  })

  it('replays exactly ONE catch-up fit when the in-flight backstop resolves with a pending frame', () => {
    const h = fitHarness({ currentCols: 80, propose: { cols: 100, rows: 24 } })
    runBackstopFit(h.gate, h.deps) // in flight
    runBackstopFit(h.gate, h.deps) // skipped → pending
    expect(h.gate.pending).toBe(true)

    h.fireWriteDone() // parse done → resume, then replay
    expect(h.order).toContain('resume')
    expect(h.refit).toHaveBeenCalledOnce()
    expect(h.gate.pending).toBe(false) // consumed
    expect(h.inFlight()).toBe(false)
  })

  it('does NOT replay when no frame was skipped during the in-flight window', () => {
    const h = fitHarness({ currentCols: 80, propose: { cols: 100, rows: 24 } })
    runBackstopFit(h.gate, h.deps)
    h.fireWriteDone()
    expect(h.refit).not.toHaveBeenCalled()
    expect(h.gate.pending).toBe(false)
  })

  it('serializes only ONCE across in-flight + multiple skipped frames + resolve (no overlap = no scrollback loss)', () => {
    const h = fitHarness({ currentCols: 80, propose: { cols: 100, rows: 24 } })
    runBackstopFit(h.gate, h.deps) // serialize #1
    runBackstopFit(h.gate, h.deps) // skipped
    runBackstopFit(h.gate, h.deps) // skipped again — still ONE pending
    h.fireWriteDone()
    expect(h.order.filter((o) => o === 'serialize')).toHaveLength(1)
    expect(h.refit).toHaveBeenCalledOnce() // many skipped frames coalesce to a single catch-up
  })
})
