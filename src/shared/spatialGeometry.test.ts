import { describe, expect, test } from 'vitest'
import {
  FIT_MAX_ZOOM,
  FIT_MIN_ZOOM,
  FIT_PADDING_PX,
  READABLE_ZOOM,
  fitZoom,
  rectsIntersect,
  visibleWorld,
  type Rect
} from './spatialGeometry'

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

describe('spatialGeometry — constants', () => {
  test('the contract values (pinned to canvasView by spatialGeometry.parity.test.ts)', () => {
    expect(READABLE_ZOOM).toBe(0.4)
    expect(FIT_PADDING_PX).toBe(64)
    expect(FIT_MAX_ZOOM).toBe(2)
    expect(FIT_MIN_ZOOM).toBe(0.1)
  })
})

describe('fitZoom', () => {
  test('is (pane - 2 × padding) / bbox on the limiting axis', () => {
    // avail = 1128 - 128 = 1000 wide, 628 - 128 = 500 tall.
    expect(fitZoom(r(0, 0, 1000, 500), { w: 1128, h: 628 })).toBe(1)
    expect(fitZoom(r(0, 0, 2000, 500), { w: 1128, h: 628 })).toBe(0.5) // width-limited
    expect(fitZoom(r(0, 0, 1000, 2000), { w: 1128, h: 628 })).toBe(0.25) // height-limited
  })

  test('ignores the bbox position (only its size matters)', () => {
    const pane = { w: 1600, h: 1000 }
    expect(fitZoom(r(-5000, 9000, 800, 600), pane)).toBe(fitZoom(r(0, 0, 800, 600), pane))
  })

  test('clamps to FIT_MAX_ZOOM for a small bbox', () => {
    expect(fitZoom(r(0, 0, 10, 10), { w: 1600, h: 1000 })).toBe(FIT_MAX_ZOOM)
  })

  test('clamps to FIT_MIN_ZOOM for a huge bbox', () => {
    expect(fitZoom(r(0, 0, 1e6, 1e6), { w: 1600, h: 1000 })).toBe(FIT_MIN_ZOOM)
  })

  test('a zero-width (or zero-height) bbox is limited by the other axis only', () => {
    expect(fitZoom(r(0, 0, 0, 500), { w: 1128, h: 628 })).toBe(1)
    expect(fitZoom(r(0, 0, 2000, 0), { w: 1128, h: 628 })).toBe(0.5)
  })

  test('an empty (zero-size) bbox fits at FIT_MAX_ZOOM', () => {
    expect(fitZoom(r(0, 0, 0, 0), { w: 1600, h: 1000 })).toBe(FIT_MAX_ZOOM)
  })

  test('a pane no larger than 2 × padding returns FIT_MIN_ZOOM', () => {
    expect(fitZoom(r(0, 0, 100, 100), { w: 2 * FIT_PADDING_PX, h: 900 })).toBe(FIT_MIN_ZOOM)
    expect(fitZoom(r(0, 0, 100, 100), { w: 900, h: 50 })).toBe(FIT_MIN_ZOOM)
    expect(fitZoom(r(0, 0, 0, 0), { w: 0, h: 0 })).toBe(FIT_MIN_ZOOM)
  })

  test('degenerate inputs always return a finite clamp bound, never NaN / Infinity', () => {
    const cases: Array<[Rect, { w: number; h: number }]> = [
      [r(0, 0, NaN, 100), { w: 1600, h: 1000 }],
      [r(0, 0, 100, 100), { w: NaN, h: 1000 }],
      [r(0, 0, Infinity, 100), { w: 1600, h: 1000 }],
      [r(0, 0, 100, 100), { w: Infinity, h: Infinity }],
      [r(0, 0, -50, -50), { w: 1600, h: 1000 }],
      [r(0, 0, 0, 0), { w: -10, h: -10 }]
    ]
    for (const [bbox, pane] of cases) {
      const z = fitZoom(bbox, pane)
      expect(Number.isFinite(z), JSON.stringify({ bbox, pane })).toBe(true)
      expect([FIT_MIN_ZOOM, FIT_MAX_ZOOM], JSON.stringify({ bbox, pane, z })).toContain(z)
    }
  })
})

describe('visibleWorld', () => {
  test('identity camera → the pane itself', () => {
    expect(visibleWorld({ w: 1600, h: 1000 }, { x: 0, y: 0, zoom: 1 })).toEqual(r(0, 0, 1600, 1000))
  })

  test('inverts world→screen (p × zoom + {x, y})', () => {
    const pane = { w: 1000, h: 800 }
    const camera = { x: -200, y: 100, zoom: 2 }
    const v = visibleWorld(pane, camera)
    expect(v).toEqual(r(100, -50, 500, 400))
    // The visible rect's corners land exactly on the pane's corners.
    expect(v.x * camera.zoom + camera.x).toBe(0)
    expect(v.y * camera.zoom + camera.y).toBe(0)
    expect((v.x + v.w) * camera.zoom + camera.x).toBe(pane.w)
    expect((v.y + v.h) * camera.zoom + camera.y).toBe(pane.h)
  })

  test('zooming out shows more world', () => {
    const v = visibleWorld({ w: 1000, h: 800 }, { x: 0, y: 0, zoom: 0.5 })
    expect(v).toEqual(r(0, 0, 2000, 1600))
  })

  test('degenerate camera / pane values still yield a finite rect', () => {
    const bad = [
      visibleWorld({ w: 1000, h: 800 }, { x: 0, y: 0, zoom: 0 }),
      visibleWorld({ w: 1000, h: 800 }, { x: NaN, y: Infinity, zoom: NaN }),
      visibleWorld({ w: -5, h: NaN }, { x: 10, y: 10, zoom: -1 })
    ]
    for (const v of bad) {
      for (const n of [v.x, v.y, v.w, v.h]) expect(Number.isFinite(n), JSON.stringify(v)).toBe(true)
      expect(v.w).toBeGreaterThanOrEqual(0)
      expect(v.h).toBeGreaterThanOrEqual(0)
    }
    // A zero / negative zoom is floored at FIT_MIN_ZOOM (the camera's own floor).
    expect(visibleWorld({ w: 100, h: 100 }, { x: 0, y: 0, zoom: 0 }).w).toBe(100 / FIT_MIN_ZOOM)
  })
})

describe('rectsIntersect', () => {
  test('overlapping rects intersect (symmetric)', () => {
    expect(rectsIntersect(r(0, 0, 100, 100), r(50, 50, 100, 100))).toBe(true)
    expect(rectsIntersect(r(50, 50, 100, 100), r(0, 0, 100, 100))).toBe(true)
  })

  test('containment intersects', () => {
    expect(rectsIntersect(r(0, 0, 1000, 1000), r(10, 10, 5, 5))).toBe(true)
    expect(rectsIntersect(r(10, 10, 5, 5), r(0, 0, 1000, 1000))).toBe(true)
  })

  test('disjoint rects do not intersect', () => {
    expect(rectsIntersect(r(0, 0, 100, 100), r(200, 0, 100, 100))).toBe(false)
    expect(rectsIntersect(r(0, 0, 100, 100), r(0, 200, 100, 100))).toBe(false)
  })

  test('edge-touching rects do NOT intersect', () => {
    expect(rectsIntersect(r(0, 0, 100, 100), r(100, 0, 100, 100))).toBe(false)
    expect(rectsIntersect(r(0, 0, 100, 100), r(0, 100, 100, 100))).toBe(false)
    expect(rectsIntersect(r(0, 0, 100, 100), r(100, 100, 50, 50))).toBe(false)
  })
})
