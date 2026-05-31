import { describe, expect, test } from 'vitest'
import { computeAlignment, projectGuide, projectGapGuide, projectRect, SNAP_THRESHOLD_PX, GAP_SNAP_PX, type Rect } from './alignmentGuides'

const rect = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })

describe('computeAlignment — edge + center', () => {
  test('snaps left edge onto another board left edge within threshold', () => {
    const r = computeAlignment(rect(103, 400), [rect(100, 50)], 8)
    expect(r.x).toBe(100) // left 103 → 100
    expect(r.y).toBe(400) // no Y match → unchanged
    const g = r.guides.find((g) => g.axis === 'x')
    expect(g).toBeDefined()
    expect(g!.kind).toBe('align')
    // narrow to AlignGuide so .start/.end are in scope (a gap guide has neither)
    if (g?.kind !== 'align') throw new Error('expected an align guide')
    expect(g.pos).toBe(100)
    // line spans the union of both boards' y extent
    expect(g.start).toBe(50)
    expect(g.end).toBe(500)
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
    expect(r.guides.some((g) => g.kind === 'align' && g.axis === 'x' && g.pos === 300)).toBe(true)
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
    expect(r.guides.every((g) => g.kind === 'align')).toBe(true)
  })

  test('SNAP_THRESHOLD_PX is the documented 8', () => {
    expect(SNAP_THRESHOLD_PX).toBe(8)
  })
})

describe('computeAlignment — gap-snap (16px gutter between neighbors)', () => {
  // Two boards that vertically overlap (axis-neighbors on X): dragged to the RIGHT of other.
  test('snaps to a 16px gutter on the right of a vertical-neighbor', () => {
    // other at x=100..200, y=0..100. dragged 100x100 approaching other's right edge (200)
    // with a ~16px gap: dragged.left target = 200 + 16 = 216. Put it at 214 (diff 2).
    const r = computeAlignment({ x: 214, y: 0, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(216) // snapped to other.right + 16
    const gap = r.guides.find((g) => g.kind === 'gap')
    expect(gap).toBeDefined()
    expect(gap).toMatchObject({ kind: 'gap', axis: 'x', distance: 16 })
  })

  test('snaps to a 16px gutter on the left of a vertical-neighbor', () => {
    // other x=300..400. dragged.right target = 300 - 16 = 284 ⇒ x = 184. approach at 186 (diff 2)
    const r = computeAlignment({ x: 186, y: 0, w: 100, h: 100 }, [{ x: 300, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(184)
    expect(r.guides.some((g) => g.kind === 'gap' && g.axis === 'x' && g.distance === 16)).toBe(true)
  })

  test('does NOT gap-snap to a non-neighbor (perpendicular ranges do not overlap)', () => {
    // other is far below (y 500..600) — no Y overlap with dragged (y 0..100) → no gutter meaning.
    const r = computeAlignment({ x: 214, y: 0, w: 100, h: 100 }, [{ x: 100, y: 500, w: 100, h: 100 }], 8)
    expect(r.x).toBe(214) // unchanged
    expect(r.guides.some((g) => g.kind === 'gap')).toBe(false)
  })

  test('edge/center ALIGN wins over a gap candidate at equal proximity', () => {
    // Construct a case where an align stop and a gap target are both in range; align must win.
    // other x=100..200,y=0..100. dragged left=205 → align(left↔right=200) diff5;
    // gap right+16=216 vs dragged.left 205 diff 11. Align closer → align wins.
    const r = computeAlignment({ x: 205, y: 0, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(200) // aligned dragged.left to other.right (edge touch), NOT the gutter
    expect(r.guides.some((g) => g.kind === 'align')).toBe(true)
  })
})

describe('computeAlignment — overlap detection', () => {
  test('returns the intersection rect of the snapped dragged board vs an overlapped board', () => {
    // dragged sits on top of other with no near snap (threshold tiny) → overlap reported.
    const r = computeAlignment({ x: 150, y: 50, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 0)
    expect(r.overlaps).toHaveLength(1)
    expect(r.overlaps[0]).toEqual({ x: 150, y: 50, w: 50, h: 50 })
  })

  test('flush/touching boards are NOT an overlap (zero area)', () => {
    // dragged.left = other.right exactly → edges touch, area 0.
    const r = computeAlignment({ x: 200, y: 0, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 0)
    expect(r.overlaps).toEqual([])
  })

  test('no overlap when boards are apart', () => {
    const r = computeAlignment({ x: 400, y: 400, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 0)
    expect(r.overlaps).toEqual([])
  })
})

describe('GAP_SNAP_PX', () => {
  test('is the documented 16', () => {
    expect(GAP_SNAP_PX).toBe(16)
  })
})

describe('projectGuide — world → screen', () => {
  test('vertical guide maps x by zoom+translate, y span scaled', () => {
    // transform [tx, ty, zoom]
    const l = projectGuide({ kind: 'align', axis: 'x', pos: 100, start: 50, end: 500 }, [10, 20, 2])
    expect(l).toEqual({ x1: 210, y1: 120, x2: 210, y2: 1020 })
  })

  test('horizontal guide maps y by zoom+translate, x span scaled', () => {
    const l = projectGuide({ kind: 'align', axis: 'y', pos: 100, start: 50, end: 500 }, [10, 20, 2])
    expect(l).toEqual({ x1: 110, y1: 220, x2: 1010, y2: 220 })
  })

  test('identity transform is a pass-through', () => {
    const l = projectGuide({ kind: 'align', axis: 'x', pos: 5, start: 0, end: 10 }, [0, 0, 1])
    expect(l).toEqual({ x1: 5, y1: 0, x2: 5, y2: 10 })
  })
})

describe('projectGapGuide + projectRect — world → screen', () => {
  test('x-axis gap: horizontal connector at perp, label at gutter mid', () => {
    const v = projectGapGuide(
      { kind: 'gap', axis: 'x', pos: 100, perp: 50, distance: 16 },
      [10, 20, 2]
    )
    // connector spans pos±d/2 = [92,108] on x, at y = 50*2+20 = 120
    expect(v).toEqual({ ax: 194, ay: 120, bx: 226, by: 120, lx: 210, ly: 120, distance: 16 })
  })

  test('y-axis gap: vertical connector at perp', () => {
    const v = projectGapGuide(
      { kind: 'gap', axis: 'y', pos: 100, perp: 50, distance: 16 },
      [10, 20, 2]
    )
    // connector spans pos±d/2 = [92,108] on y, at x = 50*2+10 = 110
    expect(v).toEqual({ ax: 110, ay: 204, bx: 110, by: 236, lx: 110, ly: 220, distance: 16 })
  })

  test('projectRect maps a world rect to a screen rect', () => {
    const s = projectRect({ x: 100, y: 50, w: 20, h: 30 }, [10, 20, 2])
    expect(s).toEqual({ x: 210, y: 120, w: 40, h: 60 })
  })
})

describe('computeAlignment — equal-spacing distribution (centered between two)', () => {
  const L = { x: 0, y: 0, w: 100, h: 100 }
  const R = { x: 400, y: 0, w: 100, h: 100 }

  test('centers a board equally between two perpendicular-neighbors', () => {
    // free = (R.left 400 - L.right 100) - w 100 = 200 → gap 100 → origin 200. Approach at 198.
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [L, R], 8)
    expect(r.x).toBe(200)
    const d = r.guides.find((g) => g.kind === 'distribute')
    expect(d).toBeDefined()
    expect(d).toMatchObject({ kind: 'distribute', axis: 'x', distance: 100 })
    if (d && d.kind === 'distribute') {
      expect(d.gaps).toHaveLength(2)
      // left gap [100,200], right gap [300,400] — each length 100
      expect(d.gaps[0]).toEqual({ from: 100, to: 200 })
      expect(d.gaps[1]).toEqual({ from: 300, to: 400 })
    }
  })

  test('no distribution snap beyond the threshold', () => {
    const r = computeAlignment({ x: 185, y: 0, w: 100, h: 100 }, [L, R], 8) // diff 15 > 8
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('no distribution when there is not enough room (would overlap)', () => {
    const tightR = { x: 150, y: 0, w: 100, h: 100 } // free = (150-100)-100 = -50
    const r = computeAlignment({ x: 110, y: 0, w: 100, h: 100 }, [L, tightR], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('no distribution with only one neighbor', () => {
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [L], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('ignores non-neighbors (no perpendicular overlap) when picking L/R', () => {
    const farR = { x: 400, y: 500, w: 100, h: 100 } // no Y overlap with the dragged board
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [L, farR], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('distributes on the Y axis too (vertical stack)', () => {
    const T = { x: 0, y: 0, w: 100, h: 100 }
    const B = { x: 0, y: 400, w: 100, h: 100 }
    // free = (400 - 100) - 100 = 200 → gap 100 → origin y 200. Approach at 203.
    const r = computeAlignment({ x: 0, y: 203, w: 100, h: 100 }, [T, B], 8)
    expect(r.y).toBe(200)
    expect(r.guides.some((g) => g.kind === 'distribute' && g.axis === 'y')).toBe(true)
  })
})
