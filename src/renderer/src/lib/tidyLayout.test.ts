import { describe, expect, test } from 'vitest'
import { tidyLayout, TIDY_GAP, type TidyBoard, type TidyPlacement } from './tidyLayout'

const b = (id: string, x: number, y: number, w = 100, h = 100): TidyBoard => ({ id, x, y, w, h })
/** Typed board helper for smart/by-type modes. */
const tb = (
  id: string,
  type: 'terminal' | 'browser' | 'planning',
  w: number,
  h: number,
  extra: Partial<TidyBoard> = {}
): TidyBoard => ({ id, x: 0, y: 0, w, h, type, ...extra })

/** Re-attach the original w/h to a placement so callers can reason about full rects. */
const rectOf = (p: TidyPlacement, src: readonly TidyBoard[]): TidyBoard => {
  const s = src.find((o) => o.id === p.id)!
  return { id: p.id, x: p.x, y: p.y, w: s.w, h: s.h }
}

const overlaps = (a: TidyBoard, c: TidyBoard): boolean =>
  a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h

const noOverlaps = (placed: TidyPlacement[], src: readonly TidyBoard[]): boolean => {
  const rects = placed.map((p) => rectOf(p, src))
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i], rects[j])) return false
  return true
}

describe('tidyLayout — no-op cases (mode-agnostic)', () => {
  test('empty input → empty output', () => {
    expect(tidyLayout([])).toEqual([])
  })

  test('single board → identity (coords untouched)', () => {
    const one = [b('a', 37, 91)]
    expect(tidyLayout(one)).toEqual([{ id: 'a', x: 37, y: 91 }])
  })
})

// ── smart (link-aware) — the default + bake-off winner ────────────────────────
describe('tidyLayout — smart (link-aware)', () => {
  // The Entheos topology: source terminal drives 3 responsive browsers + 2 standalone terminals.
  const src = tb('src', 'terminal', 418, 319)
  const t1 = tb('t1', 'terminal', 420, 340)
  const t2 = tb('t2', 'terminal', 420, 340)
  const desktop = tb('bd', 'browser', 757, 675, { viewport: 'desktop', previewSourceId: 'src' })
  const tablet = tb('bt', 'browser', 757, 675, { viewport: 'tablet', previewSourceId: 'src' })
  const mobile = tb('bm', 'browser', 757, 675, { viewport: 'mobile', previewSourceId: 'src' })
  const boards = [t1, src, desktop, mobile, t2, tablet] // intentionally unordered

  const placed = tidyLayout(boards, { mode: 'smart', gap: 28 })
  const at = (id: string): TidyPlacement => placed.find((p) => p.id === id)!

  test('no overlaps', () => {
    expect(noOverlaps(placed, boards)).toBe(true)
  })

  test('the three linked browsers form one row, widest viewport first (desktop→tablet→mobile)', () => {
    expect(at('bd').y).toBe(at('bt').y)
    expect(at('bt').y).toBe(at('bm').y)
    expect(at('bd').x).toBeLessThan(at('bt').x) // desktop left of tablet
    expect(at('bt').x).toBeLessThan(at('bm').x) // tablet left of mobile
  })

  test('terminals sit on a row BELOW the browser row', () => {
    expect(at('src').y).toBeGreaterThan(at('bd').y)
    expect(at('t1').y).toBe(at('src').y)
    expect(at('t2').y).toBe(at('src').y)
  })

  test('the SOURCE terminal lands centered under the midpoint of its previews', () => {
    const browserMid = (at('bd').x + (at('bm').x + 757)) / 2 // left edge of desktop … right edge of mobile
    const srcMid = at('src').x + 418 / 2
    expect(Math.abs(srcMid - browserMid)).toBeLessThan(1) // pixel-perfect center anchor
  })

  test('standalone terminals flank the source (one each side)', () => {
    expect(at('t1').x).toBeLessThan(at('src').x)
    expect(at('t2').x).toBeGreaterThan(at('src').x)
  })

  test('a planning board trails as its own bottom row', () => {
    const withPlan = [...boards, tb('p1', 'planning', 500, 360)]
    const p = tidyLayout(withPlan, { mode: 'smart' })
    const planY = p.find((x) => x.id === 'p1')!.y
    expect(planY).toBeGreaterThan(p.find((x) => x.id === 'src')!.y)
    expect(noOverlaps(p, withPlan)).toBe(true)
  })

  test('unlinked browser (no present source) still lays out without overlap', () => {
    const orphan = tb('bo', 'browser', 700, 500, { previewSourceId: 'gone' })
    const set = [src, desktop, orphan, t1]
    const p = tidyLayout(set, { mode: 'smart' })
    expect(noOverlaps(p, set)).toBe(true)
    expect(p).toHaveLength(4)
  })

  test('deterministic regardless of input order', () => {
    const shuffled = [tablet, t2, desktop, src, mobile, t1]
    expect(tidyLayout(shuffled, { mode: 'smart' })).toEqual(tidyLayout(boards, { mode: 'smart' }))
  })
})

// ── by-type columns ───────────────────────────────────────────────────────────
describe('tidyLayout — by-type', () => {
  const set = [
    tb('t1', 'terminal', 420, 340),
    tb('t2', 'terminal', 420, 340),
    tb('b1', 'browser', 757, 675),
    tb('b2', 'browser', 757, 675),
    tb('p1', 'planning', 500, 360)
  ]
  const placed = tidyLayout(set, { mode: 'by-type', gap: 28 })
  const at = (id: string): TidyPlacement => placed.find((p) => p.id === id)!

  test('no overlaps', () => {
    expect(noOverlaps(placed, set)).toBe(true)
  })

  test('each type is its own column (same x), tops aligned, ordered terminals→browsers→planning', () => {
    expect(at('t1').x).toBe(at('t2').x) // terminals share a column
    expect(at('b1').x).toBe(at('b2').x) // browsers share a column
    expect(at('t1').x).toBeLessThan(at('b1').x) // terminals column left of browsers
    expect(at('b1').x).toBeLessThan(at('p1').x) // browsers left of planning
    expect(at('t1').y).toBe(at('b1').y) // tops aligned across columns
    expect(at('b1').y).toBe(at('p1').y)
  })

  test('boards stack vertically within a column with the gap', () => {
    expect(at('t2').y - at('t1').y).toBe(340 + 28)
  })
})

// ── grid (naive shelf-pack baseline) ────────────────────────────────────────────
describe('tidyLayout — grid (shelf-pack)', () => {
  const scattered = [
    b('a', 500, 500),
    b('b', 520, 480),
    b('c', -200, 30),
    b('d', 900, 1200),
    b('e', 100, 100),
    b('f', 460, 510)
  ]

  test('no two tidied boards overlap', () => {
    expect(noOverlaps(tidyLayout(scattered, { mode: 'grid' }), scattered)).toBe(true)
  })

  test('anchors the block at the cluster top-left', () => {
    const placed = tidyLayout(scattered, { mode: 'grid' })
    expect(Math.min(...placed.map((p) => p.x))).toBe(-200)
    expect(Math.min(...placed.map((p) => p.y))).toBe(30)
  })

  test('horizontal gap between neighbours in a row is exactly the gap', () => {
    const four = [b('a', 0, 0), b('b', 0, 0), b('c', 0, 0), b('d', 0, 0)]
    const placed = tidyLayout(four, { mode: 'grid', aspect: 100 }) // wide → one row
    const xs = placed.map((p) => p.x).sort((m, n) => m - n)
    expect(xs).toEqual([0, 128, 256, 384])
    expect(placed.every((p) => p.y === 0)).toBe(true)
  })

  test('a wider target aspect yields a wider, shorter block', () => {
    const nine = Array.from({ length: 9 }, (_, i) => b(`n${i}`, i * 7, i * 3))
    const blockSize = (placed: TidyPlacement[]): { w: number; h: number } => {
      const rects = placed.map((p) => rectOf(p, nine))
      return {
        w: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
        h: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y))
      }
    }
    const wide = blockSize(tidyLayout(nine, { mode: 'grid', aspect: 3 }))
    const tall = blockSize(tidyLayout(nine, { mode: 'grid', aspect: 0.5 }))
    expect(wide.w).toBeGreaterThan(tall.w)
    expect(wide.h).toBeLessThan(tall.h)
  })

  test('a tall board sets its row height so the next row clears it', () => {
    const boards = [b('a', 0, 0, 100, 300), b('b', 0, 0, 100, 100), b('c', 0, 0, 100, 100)]
    const byIdP = Object.fromEntries(tidyLayout(boards, { mode: 'grid', aspect: 1.25 }).map((p) => [p.id, p]))
    expect(byIdP.a).toMatchObject({ x: 0, y: 0 })
    expect(byIdP.b).toMatchObject({ x: 128, y: 0 })
    expect(byIdP.c).toMatchObject({ x: 0, y: 328 }) // 300 (tall a) + 28 gap
    expect(noOverlaps(tidyLayout(boards, { mode: 'grid', aspect: 1.25 }), boards)).toBe(true)
  })

  test('clamps a negative gap to 0 so same-row boards never overlap', () => {
    const two = [b('a', 0, 0), b('b', 0, 0)]
    const placed = tidyLayout(two, { mode: 'grid', aspect: 100, gap: -50 })
    expect(noOverlaps(placed, two)).toBe(true)
    expect(placed.map((p) => p.x).sort((m, n) => m - n)).toEqual([0, 100])
  })

  test('input order does not affect the result', () => {
    const set = [b('z', 5, 5), b('a', 900, 10), b('m', 10, 400), b('q', 300, 300)]
    const shuffled = [set[2], set[0], set[3], set[1]]
    expect(tidyLayout(shuffled, { mode: 'grid' })).toEqual(tidyLayout(set, { mode: 'grid' }))
  })

  test('default gap is TIDY_GAP', () => {
    const two = [b('a', 0, 0), b('b', 0, 0)]
    const placed = tidyLayout(two, { mode: 'grid', aspect: 100 })
    const xs = placed.map((p) => p.x).sort((m, n) => m - n)
    expect(xs[1] - xs[0]).toBe(100 + TIDY_GAP)
  })
})

describe('tidyLayout — default mode is smart', () => {
  test('no opts → smart grouping (browsers row above terminal row)', () => {
    const set = [
      tb('t', 'terminal', 418, 319),
      tb('bd', 'browser', 757, 675, { viewport: 'desktop', previewSourceId: 't' }),
      tb('bm', 'browser', 757, 675, { viewport: 'mobile', previewSourceId: 't' })
    ]
    const placed = tidyLayout(set) // no mode
    const at = (id: string): TidyPlacement => placed.find((p) => p.id === id)!
    expect(at('bd').y).toBe(at('bm').y) // browsers on one row
    expect(at('t').y).toBeGreaterThan(at('bd').y) // terminal below
    expect(noOverlaps(placed, set)).toBe(true)
  })
})
