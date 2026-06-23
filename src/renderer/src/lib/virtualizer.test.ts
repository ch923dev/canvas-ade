import { describe, it, expect } from 'vitest'
import { windowRange, scrollToIndex } from './virtualizer'

describe('windowRange', () => {
  it('bounds the rendered slice to ~viewport+overscan regardless of total (the H5 fix)', () => {
    // 50k rows, an 18px row, a 360px viewport → only a few dozen rows materialize.
    const r = windowRange({ scrollTop: 0, viewportH: 360, rowH: 18, total: 50_000, overscan: 8 })
    expect(r.start).toBe(0)
    expect(r.end).toBeLessThanOrEqual(40) // ceil(360/18)=20 + 8 overscan + a margin
    expect(r.end - r.start).toBeLessThan(50)
    expect(r.padTop).toBe(0)
    expect(r.padBottom).toBe((50_000 - r.end) * 18)
  })

  it('windows around an arbitrary scroll offset with symmetric overscan', () => {
    const r = windowRange({
      scrollTop: 18_000,
      viewportH: 360,
      rowH: 18,
      total: 50_000,
      overscan: 8
    })
    const first = Math.floor(18_000 / 18) // 1000
    expect(r.start).toBe(first - 8)
    expect(r.end).toBe(first + Math.ceil(360 / 18) + 8)
    expect(r.padTop).toBe(r.start * 18)
    expect(r.padBottom).toBe((50_000 - r.end) * 18)
  })

  it('clamps start≥0 and end≤total at the list edges (never negative padBottom)', () => {
    const top = windowRange({ scrollTop: -50, viewportH: 200, rowH: 20, total: 10, overscan: 8 })
    expect(top.start).toBe(0)

    const bottom = windowRange({
      scrollTop: 10_000,
      viewportH: 200,
      rowH: 20,
      total: 10,
      overscan: 8
    })
    expect(bottom.end).toBe(10)
    expect(bottom.padBottom).toBe(0)
    expect(bottom.padBottom).toBeGreaterThanOrEqual(0)
  })

  it('falls back to a small fixed window before the viewport is measured (viewportH<=0)', () => {
    const r = windowRange({ scrollTop: 0, viewportH: 0, rowH: 18, total: 50_000 })
    expect(r.start).toBe(0)
    expect(r.end).toBeGreaterThan(0)
    expect(r.end).toBeLessThan(50) // never the full 50k
  })

  it('is a no-op shell for an empty list', () => {
    expect(windowRange({ scrollTop: 0, viewportH: 200, rowH: 18, total: 0 })).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0
    })
  })
})

describe('scrollToIndex', () => {
  const base = { viewportH: 180, rowH: 18 } // 10 rows visible

  it('scrolls up to reveal a row above the fold', () => {
    expect(scrollToIndex({ index: 2, scrollTop: 100, ...base })).toBe(36) // 2*18
  })

  it('scrolls down so a row below the fold sits at the bottom edge', () => {
    // row 20 bottom = 21*18 = 378; minus viewport 180 → 198
    expect(scrollToIndex({ index: 20, scrollTop: 0, ...base })).toBe(198)
  })

  it('leaves scroll untouched when the row is already fully in view', () => {
    expect(scrollToIndex({ index: 5, scrollTop: 18, ...base })).toBe(18)
  })

  it('never returns a negative scrollTop', () => {
    expect(scrollToIndex({ index: 0, scrollTop: 0, ...base })).toBe(0)
  })
})
