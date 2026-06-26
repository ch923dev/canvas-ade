import { describe, it, expect } from 'vitest'
import { colsChanged, applyResizeBackstop, type ResizeBackstopDeps } from './terminalResizeBackstop'

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
