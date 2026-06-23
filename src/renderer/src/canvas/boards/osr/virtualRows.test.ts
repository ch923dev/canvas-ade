import { describe, it, expect } from 'vitest'
import { computeRowWindow } from './virtualRows'

/**
 * SLICE-010 — the pure window math behind the Network table virtualization. Pins the contract the
 * spacer-row rendering relies on: the rendered slice covers the viewport (+overscan), the spacers
 * reserve exactly the off-screen extent (so the scrollbar + total height stay correct), and a stale
 * scrollTop past a shrunk list clamps to the last page rather than rendering blank.
 */
describe('computeRowWindow', () => {
  const ROW_H = 26
  const OVERSCAN = 6

  it('renders the whole list (no spacers) when it fits in the window', () => {
    const w = computeRowWindow(0, 300, ROW_H, 5, OVERSCAN)
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
    expect(w.topPad).toBe(0)
    expect(w.bottomPad).toBe(0)
  })

  it('at the top of a large list renders from index 0 with a bottom spacer only', () => {
    const total = 1000
    const w = computeRowWindow(0, 260, ROW_H, total, OVERSCAN)
    expect(w.start).toBe(0)
    expect(w.topPad).toBe(0)
    // viewport 260 / 26 = 10 rows + 2*overscan = 22 rendered.
    expect(w.end).toBe(Math.ceil(260 / ROW_H) + OVERSCAN * 2)
    expect(w.bottomPad).toBe((total - w.end) * ROW_H)
  })

  it('bounds the rendered row count to roughly the viewport, not the whole list', () => {
    const w = computeRowWindow(0, 260, ROW_H, 1000, OVERSCAN)
    expect(w.end - w.start).toBeLessThan(40)
    expect(w.end - w.start).toBeGreaterThan(0)
  })

  it('scrolled into the middle, the window straddles the visible rows', () => {
    const total = 1000
    const scrollTop = 5000 // ~row 192
    const w = computeRowWindow(scrollTop, 260, ROW_H, total, OVERSCAN)
    const firstVisible = Math.floor(scrollTop / ROW_H)
    expect(w.start).toBe(firstVisible - OVERSCAN)
    // the rendered band fully contains [scrollTop, scrollTop+viewport]
    expect(w.topPad).toBeLessThanOrEqual(scrollTop)
    expect(w.topPad + (w.end - w.start) * ROW_H).toBeGreaterThanOrEqual(scrollTop + 260)
  })

  it('scrolled to the bottom renders the last page with no bottom spacer', () => {
    const total = 1000
    const w = computeRowWindow(total * ROW_H, 260, ROW_H, total, OVERSCAN)
    expect(w.end).toBe(total)
    expect(w.bottomPad).toBe(0)
  })

  it('clamps a stale scrollTop past a now-shrunk list to the last page (never blank)', () => {
    // scrollTop left over from a 1000-row list, but the filter shrank it to 10 rows.
    const w = computeRowWindow(20_000, 260, ROW_H, 10, OVERSCAN)
    expect(w.start).toBe(0)
    expect(w.end).toBe(10)
    expect(w.topPad).toBe(0)
    expect(w.bottomPad).toBe(0)
  })

  it('preserves total scroll height: topPad + rendered + bottomPad === total*rowH', () => {
    for (const scrollTop of [0, 3000, 12_345, 26_000]) {
      const total = 1000
      const w = computeRowWindow(scrollTop, 260, ROW_H, total, OVERSCAN)
      const rendered = (w.end - w.start) * ROW_H
      expect(w.topPad + rendered + w.bottomPad).toBe(total * ROW_H)
    }
  })

  it('falls back to a positive pitch when rowH is non-positive (no divide-by-zero)', () => {
    const w = computeRowWindow(0, 260, 0, 100, OVERSCAN)
    expect(Number.isFinite(w.end)).toBe(true)
    expect(w.end).toBeGreaterThan(0)
  })
})
