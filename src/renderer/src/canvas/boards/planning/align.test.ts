import { describe, it, expect } from 'vitest'
import { alignElements, distributeElements, ALIGN_PAD, ALIGN_GAP } from './align'
import type { PlanningElement } from '../../../lib/boardSchema'

const note = (id: string, x: number, y: number, w = 100, h = 60): PlanningElement =>
  ({ id, kind: 'note', x, y, w, h, tint: 'yellow', text: '' }) as PlanningElement

const byId = (els: PlanningElement[], id: string): PlanningElement => els.find((e) => e.id === id)!
const BOARD = { w: 500, h: 400 }

describe('alignElements — board edge + no-overlap fan', () => {
  // A at (40,40), B at (300,200); both 100x60.
  const els = [note('a', 40, 40), note('b', 300, 200)]

  it('align-left flushes left edges to the board pad and fans down (no overlap)', () => {
    const out = alignElements(els, ['a', 'b'], 'left', BOARD)
    expect(byId(out, 'a').x).toBe(ALIGN_PAD)
    expect(byId(out, 'b').x).toBe(ALIGN_PAD)
    // fanned on Y in current order (a above b): a stays at its top, b packed below it.
    expect(byId(out, 'a').y).toBe(40)
    expect(byId(out, 'b').y).toBe(40 + 60 + ALIGN_GAP)
  })

  it('align-right flushes right edges to board.w - pad', () => {
    const out = alignElements(els, ['a', 'b'], 'right', BOARD)
    const expectedX = BOARD.w - ALIGN_PAD - 100
    expect(byId(out, 'a').x).toBe(expectedX)
    expect(byId(out, 'b').x).toBe(expectedX)
  })

  it('align-centerX centers cards in the board horizontally', () => {
    const out = alignElements(els, ['a', 'b'], 'centerX', BOARD)
    expect(byId(out, 'a').x).toBe(Math.round((BOARD.w - 100) / 2))
  })

  it('align-top flushes top edges to the pad and fans right (a row, no overlap)', () => {
    const out = alignElements(els, ['a', 'b'], 'top', BOARD)
    expect(byId(out, 'a').y).toBe(ALIGN_PAD)
    expect(byId(out, 'b').y).toBe(ALIGN_PAD)
    expect(byId(out, 'a').x).toBe(40)
    expect(byId(out, 'b').x).toBe(40 + 100 + ALIGN_GAP)
  })

  it('two SAME-ROW cards no longer collapse onto each other (the bug)', () => {
    const same = [note('a', 40, 40), note('b', 300, 40)] // identical y
    const out = alignElements(same, ['a', 'b'], 'left', BOARD)
    expect(byId(out, 'a').x).toBe(ALIGN_PAD)
    expect(byId(out, 'b').x).toBe(ALIGN_PAD)
    expect(byId(out, 'a').y).not.toBe(byId(out, 'b').y) // fanned, not stacked
  })

  it('aligns an arrow by its bbox, fanning it like any card', () => {
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 300, y: 0, x2: 360, y2: 40 }
    const out = alignElements([note('a', 40, 40), arrow], ['a', 'ar'], 'left', BOARD)
    const a2 = byId(out, 'ar')
    if (a2.kind !== 'arrow') throw new Error('arrow')
    // arrow bbox left = 300 → flushed to pad (shift -288): x 300→12, x2 360→72.
    expect(a2.x).toBe(ALIGN_PAD)
    expect(a2.x2).toBe(ALIGN_PAD + 60)
  })

  it('is a no-op for fewer than 2 selected', () => {
    expect(alignElements(els, ['a'], 'left', BOARD)).toBe(els)
  })

  it('keeps cards IN BOUNDS even when they cannot fit (clamp rule)', () => {
    // three 200-wide cards aligned into a row of a 300-wide board → cannot fit, but
    // every card must stay within [PAD, board.w - PAD].
    const wide = [note('a', 0, 10, 200), note('b', 80, 90, 200), note('c', 160, 30, 200)]
    const out = alignElements(wide, ['a', 'b', 'c'], 'top', { w: 300, h: 400 })
    for (const id of ['a', 'b', 'c']) {
      const e = byId(out, id)
      expect(e.x).toBeGreaterThanOrEqual(ALIGN_PAD)
      expect(e.x + 200).toBeLessThanOrEqual(300 - ALIGN_PAD + 1) // +1 for rounding
      expect(e.y).toBe(ALIGN_PAD) // top-flushed
    }
  })
})

describe('distributeElements — equal gaps, no overlap, in-bounds', () => {
  it('equalizes gaps and pins the endpoints when the cards fit', () => {
    const els = [note('a', 0, 0), note('m', 130, 0), note('b', 400, 0)]
    const out = distributeElements(els, ['a', 'm', 'b'], 'h', { w: 600, h: 400 })
    expect(byId(out, 'a').x).toBe(0)
    expect(byId(out, 'b').x).toBe(400)
    expect(byId(out, 'm').x).toBe(200)
  })

  it('packs with a min gap (no overlap) when the cards do not fit', () => {
    // three 200-wide cards crammed into x 0..300 → negative equal-gap → repack.
    const els = [note('a', 0, 0, 200), note('b', 50, 0, 200), note('c', 100, 0, 200)]
    const out = distributeElements(els, ['a', 'b', 'c'], 'h', { w: 300, h: 400 })
    const xs = [byId(out, 'a').x, byId(out, 'b').x, byId(out, 'c').x].sort((p, q) => p - q)
    expect(xs[0]).toBe(ALIGN_PAD)
    expect(xs[1]).toBe(ALIGN_PAD + 200 + ALIGN_GAP)
    expect(xs[2]).toBe(ALIGN_PAD + (200 + ALIGN_GAP) * 2)
    // no overlap: each start is past the previous end.
    expect(xs[1]).toBeGreaterThanOrEqual(xs[0] + 200)
  })

  it('is a no-op for fewer than 3 selected', () => {
    const els = [note('a', 0, 0), note('b', 100, 0)]
    expect(distributeElements(els, ['a', 'b'], 'h', { w: 600, h: 400 })).toBe(els)
  })
})
