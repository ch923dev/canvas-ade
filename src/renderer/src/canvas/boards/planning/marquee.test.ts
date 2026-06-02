import { describe, it, expect } from 'vitest'
import type { PlanningElement } from '../../../lib/boardSchema'
import { makeNote, makeText, makeArrow, makeStroke } from './elements'
import { rectFromPoints, rectIntersectsBBox, marqueeHits } from './marquee'

describe('rectFromPoints', () => {
  it('normalizes any corner order to a positive box', () => {
    expect(rectFromPoints(30, 40, 10, 10)).toEqual({ x: 10, y: 10, w: 20, h: 30 })
  })
})

describe('rectIntersectsBBox (intersect/touch predicate)', () => {
  const b = { x: 10, y: 10, w: 20, h: 20 } // 10..30
  it('true when overlapping', () => expect(rectIntersectsBBox({ x: 0, y: 0, w: 15, h: 15 }, b)).toBe(true))
  it('true when merely touching an edge', () => expect(rectIntersectsBBox({ x: 30, y: 10, w: 5, h: 5 }, b)).toBe(true))
  it('false when fully disjoint', () => expect(rectIntersectsBBox({ x: 40, y: 40, w: 5, h: 5 }, b)).toBe(false))
})

describe('marqueeHits', () => {
  const note = makeNote('n', { x: 0, y: 0 }, 0) // 0..156 x, 0..96 y
  const arrow = { ...makeArrow('a', { x: 300, y: 300 }), x2: 360, y2: 340 }
  const stroke = makeStroke('s', [500, 500, 520, 540])
  const els: PlanningElement[] = [note, arrow, stroke]
  it('returns exactly the ids whose bbox the rect intersects (incl. arrow + stroke)', () => {
    expect(marqueeHits(els, { x: -10, y: -10, w: 400, h: 400 })).toEqual(['n', 'a'])
    expect(marqueeHits(els, { x: 490, y: 490, w: 40, h: 60 })).toEqual(['s'])
    expect(marqueeHits(els, { x: 1000, y: 1000, w: 5, h: 5 })).toEqual([])
  })
  it('uses a measured override for an auto-sized element', () => {
    const text = makeText('t', { x: 200, y: 0 })
    const big = new Map([['t', { w: 400, h: 400 }]]) // measured spans into the rect
    expect(marqueeHits([text], { x: 0, y: 0, w: 250, h: 50 }, big)).toEqual(['t'])
  })
})
