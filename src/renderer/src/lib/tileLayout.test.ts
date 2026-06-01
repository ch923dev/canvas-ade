import { describe, expect, test } from 'vitest'
import { tileLayout, type TileBoard, type TileArea, type TiledRect } from './tileLayout'

const AREA: TileArea = { x: 0, y: 0, w: 1200, h: 800 }
const GAP = 20

const board = (id: string, x = 0, y = 0, w = 400, h = 300): TileBoard => ({ id, x, y, w, h })
const mk = (n: number): TileBoard[] =>
  Array.from({ length: n }, (_, i) => board(`b${i}`, i * 10, i * 10))

// Normalize w/h before the overlap test: a negative dimension (a packing bug) would otherwise
// make `x + w < x` and silently dodge the comparison — exactly the blind spot a degenerate-zone
// regression would hide behind. Normalizing means this helper actually catches it.
const overlaps = (a: TiledRect, c: TiledRect): boolean => {
  const ax = Math.min(a.x, a.x + a.w), aw = Math.abs(a.w), ay = Math.min(a.y, a.y + a.h), ah = Math.abs(a.h)
  const cx = Math.min(c.x, c.x + c.w), cw = Math.abs(c.w), cy = Math.min(c.y, c.y + c.h), ch = Math.abs(c.h)
  return ax < cx + cw - 0.01 && cx < ax + aw - 0.01 && ay < cy + ch - 0.01 && cy < ay + ah - 0.01
}

const noOverlaps = (rects: TiledRect[]): boolean => {
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i], rects[j])) return false
  return true
}

/** The union bounding box of the tiled rects equals the area (tiling fills it edge-to-edge). */
const fillsArea = (rects: TiledRect[], area: TileArea): boolean => {
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const maxY = Math.max(...rects.map((r) => r.y + r.h))
  return (
    Math.abs(minX - area.x) < 0.01 &&
    Math.abs(minY - area.y) < 0.01 &&
    Math.abs(maxX - (area.x + area.w)) < 0.01 &&
    Math.abs(maxY - (area.y + area.h)) < 0.01
  )
}

describe('tileLayout — edge cases', () => {
  test('empty → empty', () => {
    expect(tileLayout([], 'grid', AREA)).toEqual([])
  })

  test('single board fills the whole area (every template)', () => {
    for (const t of ['cols-2', 'cols-3', 'cols-4', 'main-sidebar', 'grid'] as const) {
      expect(tileLayout([board('only')], t, AREA)).toEqual([{ id: 'only', x: 0, y: 0, w: 1200, h: 800 }])
    }
  })
})

describe('tileLayout — columns', () => {
  test('cols-2 with 4 boards → two equal columns, fills area, no overlap', () => {
    const r = tileLayout(mk(4), 'cols-2', AREA, GAP)
    expect(r).toHaveLength(4)
    expect(noOverlaps(r)).toBe(true)
    expect(fillsArea(r, AREA)).toBe(true)
    const colW = (1200 - GAP) / 2
    expect(r.every((x) => Math.abs(x.w - colW) < 0.01)).toBe(true) // all equal column width
    expect(new Set(r.map((x) => Math.round(x.x))).size).toBe(2) // exactly two distinct x (columns)
  })

  test('cols-3 distributes 5 boards as [2,2,1] column-major and fills', () => {
    const r = tileLayout(mk(5), 'cols-3', AREA, GAP)
    expect(noOverlaps(r)).toBe(true)
    expect(fillsArea(r, AREA)).toBe(true)
    const colXs = [...new Set(r.map((x) => Math.round(x.x)))].sort((a, b) => a - b)
    expect(colXs).toHaveLength(3)
    const perCol = colXs.map((cx) => r.filter((x) => Math.round(x.x) === cx).length)
    expect(perCol).toEqual([2, 2, 1])
  })

  test('cols-4 clamps to N when there are fewer boards than columns', () => {
    const r = tileLayout(mk(2), 'cols-4', AREA, GAP)
    expect(new Set(r.map((x) => Math.round(x.x))).size).toBe(2) // only 2 columns used
    expect(fillsArea(r, AREA)).toBe(true)
  })
})

describe('tileLayout — main + sidebar', () => {
  test('the LARGEST board becomes the full-height 62% main zone', () => {
    const boards = [board('s1', 0, 0, 300, 200), board('big', 50, 50, 900, 700), board('s2', 0, 0, 300, 200)]
    const r = tileLayout(boards, 'main-sidebar', AREA, GAP)
    const main = r.find((x) => x.id === 'big')!
    expect(main.x).toBe(0)
    expect(main.y).toBe(0)
    expect(main.h).toBe(800) // full height
    expect(Math.abs(main.w - (1200 - GAP) * 0.62)).toBeLessThan(0.01)
    expect(noOverlaps(r)).toBe(true)
    expect(fillsArea(r, AREA)).toBe(true)
    // sidebar boards share one x column to the right of main, stacked
    const side = r.filter((x) => x.id !== 'big')
    expect(new Set(side.map((x) => Math.round(x.x))).size).toBe(1)
    expect(side.every((x) => x.x > main.x + main.w)).toBe(true)
  })
})

describe('tileLayout — grid', () => {
  test('5 boards → 3×2 grid, last row widens to fill, no overlap', () => {
    const r = tileLayout(mk(5), 'grid', AREA, GAP)
    expect(noOverlaps(r)).toBe(true)
    expect(fillsArea(r, AREA)).toBe(true)
    const rowYs = [...new Set(r.map((x) => Math.round(x.y)))].sort((a, b) => a - b)
    expect(rowYs).toHaveLength(2)
    // top row has 3 cells (narrow), bottom row 2 cells (wider)
    const top = r.filter((x) => Math.round(x.y) === rowYs[0])
    const bottom = r.filter((x) => Math.round(x.y) === rowYs[1])
    expect(top).toHaveLength(3)
    expect(bottom).toHaveLength(2)
    expect(bottom[0].w).toBeGreaterThan(top[0].w) // short row's cells are wider
  })

  test('4 boards → perfect 2×2', () => {
    const r = tileLayout(mk(4), 'grid', AREA, GAP)
    expect(noOverlaps(r)).toBe(true)
    expect(fillsArea(r, AREA)).toBe(true)
    expect(new Set(r.map((x) => Math.round(x.x))).size).toBe(2)
    expect(new Set(r.map((x) => Math.round(x.y))).size).toBe(2)
  })
})

describe('tileLayout — degenerate zones clamp to the board minimum (no overlap)', () => {
  const MIN_W = 240
  const MIN_H = 160
  const minOk = (rects: TiledRect[]): boolean => rects.every((r) => r.w >= MIN_W - 0.01 && r.h >= MIN_H - 0.01)

  test('many boards in a normal area → zones clamp to min, boards overflow but never overlap', () => {
    // 24 boards, cols-2 → 12 per column; raw cellH (~100px) < MIN so it clamps. Pre-fix the
    // store clamped SIZE while the stride stayed sub-min → rows overlapped (the medium finding).
    const r = tileLayout(mk(24), 'cols-2', { x: 0, y: 0, w: 1600, h: 1500 }, 28)
    expect(r).toHaveLength(24)
    expect(noOverlaps(r)).toBe(true)
    expect(minOk(r)).toBe(true)
  })

  test('an area narrower than the gap does not produce negative widths or overlaps', () => {
    for (const t of ['cols-2', 'cols-3', 'cols-4', 'grid'] as const) {
      const r = tileLayout(mk(6), t, { x: 0, y: 0, w: 20, h: 13 }, 28)
      expect(noOverlaps(r)).toBe(true)
      expect(minOk(r)).toBe(true)
    }
  })

  test('main-sidebar with a tall sidebar clamps + does not overlap', () => {
    const r = tileLayout(mk(14), 'main-sidebar', { x: 0, y: 0, w: 1600, h: 1000 }, 28)
    expect(noOverlaps(r)).toBe(true)
    expect(minOk(r)).toBe(true)
  })
})

describe('tileLayout — determinism', () => {
  test('input order does not change the result', () => {
    const a = mk(6)
    const shuffled = [a[3], a[0], a[5], a[1], a[4], a[2]]
    expect(tileLayout(shuffled, 'grid', AREA, GAP)).toEqual(tileLayout(a, 'grid', AREA, GAP))
    expect(tileLayout(shuffled, 'cols-3', AREA, GAP)).toEqual(tileLayout(a, 'cols-3', AREA, GAP))
  })
})
