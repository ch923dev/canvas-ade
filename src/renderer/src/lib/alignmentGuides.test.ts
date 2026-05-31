import { describe, expect, test } from 'vitest'
import { computeAlignment, projectGuide, SNAP_THRESHOLD_PX, type Rect } from './alignmentGuides'

const rect = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })

describe('computeAlignment — edge + center', () => {
  test('snaps left edge onto another board left edge within threshold', () => {
    const r = computeAlignment(rect(103, 400), [rect(100, 50)], 8)
    expect(r.x).toBe(100) // left 103 → 100
    expect(r.y).toBe(400) // no Y match → unchanged
    const g = r.guides.find((g) => g.axis === 'x')
    expect(g).toBeDefined()
    expect(g!.pos).toBe(100)
    // line spans the union of both boards' y extent
    expect(g!.start).toBe(50)
    expect(g!.end).toBe(500)
  })

  test('snaps center-x onto another board center-x', () => {
    // pure center case: dragged centerX = 147 vs other centerX 150
    const c = computeAlignment(rect(97, 400), [rect(100, 50)], 8)
    // dragged centerX = 147 vs other centerX 150 (diff 3) AND left 97 vs 100 (diff 3, tie)
    // smallest-or-equal keeps the FIRST found (left) — both snap x to 100 anyway here.
    expect(c.x).toBe(100)
  })

  test('snaps right edge onto another board left edge (edge touch)', () => {
    // dragged right = x+100; want it to land on other.left = 300
    const r = computeAlignment(rect(205, 400), [rect(300, 400)], 8)
    expect(r.x).toBe(200) // right 305 → 300 ⇒ x 200
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 300)).toBe(true)
  })

  test('no match beyond threshold returns rect unchanged with no guides', () => {
    const r = computeAlignment(rect(140, 400), [rect(100, 50)], 8)
    expect(r.x).toBe(140)
    expect(r.y).toBe(400)
    expect(r.guides).toEqual([])
  })

  test('picks the nearest candidate when several are in range', () => {
    // left 104: other A left 100 (diff 4), other B left 106 (diff 2) → snap to 106
    const r = computeAlignment(rect(104, 400), [rect(100, 50), rect(106, 50)], 8)
    expect(r.x).toBe(106)
  })

  test('matches both axes → two guides', () => {
    const r = computeAlignment(rect(103, 203), [rect(100, 200)], 8)
    expect(r.x).toBe(100)
    expect(r.y).toBe(200)
    expect(r.guides).toHaveLength(2)
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true)
    expect(r.guides.some((g) => g.axis === 'y')).toBe(true)
  })

  test('SNAP_THRESHOLD_PX is the documented 8', () => {
    expect(SNAP_THRESHOLD_PX).toBe(8)
  })
})

describe('projectGuide — world → screen', () => {
  test('vertical guide maps x by zoom+translate, y span scaled', () => {
    // transform [tx, ty, zoom]
    const l = projectGuide({ axis: 'x', pos: 100, start: 50, end: 500 }, [10, 20, 2])
    expect(l).toEqual({ x1: 210, y1: 120, x2: 210, y2: 1020 })
  })

  test('horizontal guide maps y by zoom+translate, x span scaled', () => {
    const l = projectGuide({ axis: 'y', pos: 100, start: 50, end: 500 }, [10, 20, 2])
    expect(l).toEqual({ x1: 110, y1: 220, x2: 1010, y2: 220 })
  })

  test('identity transform is a pass-through', () => {
    const l = projectGuide({ axis: 'x', pos: 5, start: 0, end: 10 }, [0, 0, 1])
    expect(l).toEqual({ x1: 5, y1: 0, x2: 5, y2: 10 })
  })
})
