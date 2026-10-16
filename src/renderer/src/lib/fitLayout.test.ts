import { describe, expect, test } from 'vitest'
import {
  fitLayout,
  FIT_UNIT_GAP,
  type FitOptions,
  type FitOverflow,
  type FitResult,
  type FitUnit
} from './fitLayout'
import { tidyLayout, TIDY_GAP, type TidyBoard } from './tidyLayout'
import { MIN_BOARD_SIZE } from './boardDefaults'
import { GROUP_BOX_PAD } from '../canvas/GroupBoxLayer'
import {
  FIT_MAX_ZOOM,
  FIT_MIN_ZOOM,
  READABLE_ZOOM,
  fitZoom,
  rectsIntersect,
  type Rect
} from '../../../shared/spatialGeometry'

type BoardKind = 'terminal' | 'browser' | 'planning' | 'kanban'

const b = (
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
  extra: Partial<TidyBoard> = {}
): TidyBoard => ({ id, x, y, w, h, ...extra })

const WIDE = { w: 1920, h: 1080 }

/** Full rects of a result — a placement's w/h (shrink) wins over the input board's. */
const rectsOf = (res: FitResult, src: readonly TidyBoard[]): Map<string, Rect> =>
  new Map(
    res.placements.map((p) => {
      const s = src.find((o) => o.id === p.id)!
      return [p.id, { x: p.x, y: p.y, w: p.w ?? s.w, h: p.h ?? s.h }]
    })
  )

const bounds = (rects: readonly Rect[]): Rect => {
  const x = rects.reduce((m, r) => Math.min(m, r.x), Infinity)
  const y = rects.reduce((m, r) => Math.min(m, r.y), Infinity)
  const right = rects.reduce((m, r) => Math.max(m, r.x + r.w), -Infinity)
  const bottom = rects.reduce((m, r) => Math.max(m, r.y + r.h), -Infinity)
  return { x, y, w: right - x, h: bottom - y }
}

const pad = (r: Rect, p: number): Rect => ({
  x: r.x - p,
  y: r.y - p,
  w: r.w + 2 * p,
  h: r.h + 2 * p
})

const distinct = (ns: number[]): number => new Set(ns).size

const noOverlaps = (rects: Map<string, Rect>): boolean => {
  const list = [...rects.values()]
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) if (rectsIntersect(list[i], list[j])) return false
  return true
}

/** Test oracle for step 1: each board → its smallest unit (fewest PRESENT members, id
 *  tie-break); unclaimed boards are singles. Written independently of the implementation. */
function expectedUnits(boards: readonly TidyBoard[], units: readonly FitUnit[]): string[][] {
  const present = new Set(boards.map((o) => o.id))
  const members = new Map<string, Set<string>>()
  for (const u of units) {
    const set = members.get(u.id) ?? new Set<string>()
    u.boardIds.filter((id) => present.has(id)).forEach((id) => set.add(id))
    members.set(u.id, set)
  }
  const out = new Map<string, string[]>()
  for (const board of boards) {
    const owners = [...members.entries()]
      .filter(([, set]) => set.has(board.id))
      .sort(([ia, a], [ib, c]) => a.size - c.size || (ia < ib ? -1 : 1))
    const key = owners.length ? `unit:${owners[0][0]}` : `single:${board.id}`
    out.set(key, [...(out.get(key) ?? []), board.id])
  }
  return [...out.values()]
}

// ── Step 1: assign ───────────────────────────────────────────────────────────
describe('fitLayout — step 1: assign boards to units', () => {
  test('a board in several units joins the SMALLEST one', () => {
    // c is in A (3 members) and B (2 members) → c packs with d, away from a/b.
    const boards = [b('a', 0, 0), b('b', 200, 0), b('c', 400, 0), b('d', 600, 0)]
    const units = [
      { id: 'A', boardIds: ['a', 'b', 'c'] },
      { id: 'B', boardIds: ['c', 'd'] }
    ]
    const rects = rectsOf(fitLayout(boards, { pane: WIDE, units }), boards)
    const unitA = bounds([rects.get('a')!, rects.get('b')!])
    const unitB = bounds([rects.get('c')!, rects.get('d')!])
    expect(unitB.w).toBe(100 + TIDY_GAP + 100) // c + d packed together at the in-unit gap
    expect(rectsIntersect(pad(unitA, FIT_UNIT_GAP), rects.get('c')!)).toBe(false)
    expect(rectsIntersect(pad(unitA, FIT_UNIT_GAP / 2), pad(unitB, FIT_UNIT_GAP / 2))).toBe(false)
  })

  test('equal-size units tie-break by unit id (smaller id wins)', () => {
    const boards = [b('a', 0, 0), b('b', 200, 0), b('c', 400, 0)]
    const units = [
      { id: 'Y', boardIds: ['b', 'c'] },
      { id: 'X', boardIds: ['a', 'b'] }
    ]
    const rects = rectsOf(fitLayout(boards, { pane: WIDE, units }), boards)
    // b went to X with a (in-unit gap); c is left alone in Y (a unit gap away).
    expect(rects.get('b')!.x - (rects.get('a')!.x + 100)).toBe(TIDY_GAP)
    expect(rects.get('c')!.x - (rects.get('b')!.x + 100)).toBe(FIT_UNIT_GAP)
  })

  test('boards in no unit become single-board units (a unit gap apart)', () => {
    const boards = [b('a', 0, 0), b('b', 10, 0), b('c', 20, 0)]
    const res = fitLayout(boards, { pane: { w: 3000, h: 400 } })
    expect(res.placements.map((p) => p.x)).toEqual([
      0,
      100 + FIT_UNIT_GAP,
      2 * (100 + FIT_UNIT_GAP)
    ])
  })

  test('unknown ids are ignored and same-id units merge', () => {
    const boards = [b('a', 0, 0), b('b', 10, 0), b('c', 20, 0)]
    const merged = fitLayout(boards, {
      pane: { w: 3000, h: 400 },
      units: [
        { id: 'G', boardIds: ['a', 'ghost'] },
        { id: 'G', boardIds: ['b'] }
      ]
    })
    const plain = fitLayout(boards, {
      pane: { w: 3000, h: 400 },
      units: [{ id: 'G', boardIds: ['a', 'b'] }]
    })
    expect(merged).toEqual(plain)
    expect(merged.placements.map((p) => p.x)).toEqual([0, 100 + TIDY_GAP, 228 + FIT_UNIT_GAP])
  })
})

// ── Step 2: in-unit packing ──────────────────────────────────────────────────
describe('fitLayout — step 2: pack inside each unit with smart', () => {
  test("a unit's internal arrangement is tidyLayout smart, translated", () => {
    const members: TidyBoard[] = [
      b('t', 0, 0, 420, 340, { type: 'terminal' }),
      b('b1', 900, 0, 700, 500, { type: 'browser', viewport: 'desktop', previewSourceId: 't' }),
      b('b2', 1700, 0, 390, 500, { type: 'browser', viewport: 'mobile', previewSourceId: 't' })
    ]
    const boards = [...members, b('lone', 3000, 2000, 300, 200)]
    const res = fitLayout(boards, { pane: WIDE, units: [{ id: 'U', boardIds: ['t', 'b1', 'b2'] }] })
    const smart = tidyLayout(members, { mode: 'smart', gap: TIDY_GAP })
    const at = (id: string): { x: number; y: number } => res.placements.find((p) => p.id === id)!
    const sm = (id: string): { x: number; y: number } => smart.find((p) => p.id === id)!
    for (const id of ['b1', 'b2']) {
      expect(at(id).x - at('t').x).toBe(sm(id).x - sm('t').x)
      expect(at(id).y - at('t').y).toBe(sm(id).y - sm('t').y)
    }
    expect(at('t').y).toBeGreaterThan(at('b1').y) // smart: browsers above their terminal
  })
})

// ── Step 3: unit order ───────────────────────────────────────────────────────
describe('fitLayout — step 3: units keep reading order', () => {
  const pane = { w: 4000, h: 400 } // wide enough for one row → x order = unit order

  test('ordered by current top-left: y first, then x', () => {
    const boards = [b('a', 0, 500), b('b', 800, 0), b('c', 0, 0)]
    const xs = new Map(fitLayout(boards, { pane }).placements.map((p) => [p.id, p.x]))
    expect([...xs.entries()].sort((m, n) => m[1] - n[1]).map(([id]) => id)).toEqual(['c', 'b', 'a'])
  })

  test('full position ties fall back to id', () => {
    const boards = [b('z', 0, 0), b('m', 0, 0), b('a', 0, 0)]
    const xs = new Map(fitLayout(boards, { pane }).placements.map((p) => [p.id, p.x]))
    expect(xs.get('a')!).toBeLessThan(xs.get('m')!)
    expect(xs.get('m')!).toBeLessThan(xs.get('z')!)
  })

  test("a unit's position is the top-left of its members' bounds", () => {
    // Unit {p, q} starts at (0, 50) — above lone r at (−500, 100) → the unit comes first.
    const boards = [b('p', 0, 50), b('q', 900, 900), b('r', -500, 100)]
    const res = fitLayout(boards, { pane, units: [{ id: 'U', boardIds: ['p', 'q'] }] })
    const x = new Map(res.placements.map((p) => [p.id, p.x]))
    expect(Math.max(x.get('p')!, x.get('q')!)).toBeLessThan(x.get('r')!)
  })
})

// ── Step 4: shelf-pack toward the pane aspect ────────────────────────────────
describe('fitLayout — step 4: shelf-pack units toward the pane aspect', () => {
  const twelve = Array.from({ length: 12 }, (_, i) =>
    b(`n${String(i).padStart(2, '0')}`, i * 10, 0, 400, 300)
  )

  test('a wide pane → 4 columns × 3 rows (the best-fitting candidate)', () => {
    const res = fitLayout(twelve, { pane: WIDE })
    expect(distinct(res.placements.map((p) => p.x))).toBe(4)
    expect(distinct(res.placements.map((p) => p.y))).toBe(3)
    expect(res.fitZoom).toBeCloseTo((1080 - 128) / (3 * 300 + 2 * FIT_UNIT_GAP), 10)
  })

  test('a tall pane → 2 columns × 6 rows', () => {
    const res = fitLayout(twelve, { pane: { w: 1080, h: 1920 } })
    expect(distinct(res.placements.map((p) => p.x))).toBe(2)
    expect(distinct(res.placements.map((p) => p.y))).toBe(6)
  })

  test('beats both the one-row and the one-column arrangement', () => {
    const res = fitLayout(twelve, { pane: WIDE })
    const oneRow = fitZoom({ x: 0, y: 0, w: 12 * 400 + 11 * FIT_UNIT_GAP, h: 300 }, WIDE)
    const oneCol = fitZoom({ x: 0, y: 0, w: 400, h: 12 * 300 + 11 * FIT_UNIT_GAP }, WIDE)
    expect(res.fitZoom).toBeGreaterThan(oneRow)
    expect(res.fitZoom).toBeGreaterThan(oneCol)
  })

  test('the "one row" candidate wins on a letterbox pane', () => {
    const three = [b('a', 0, 0, 400, 100), b('b', 0, 10, 400, 100), b('c', 0, 20, 400, 100)]
    const res = fitLayout(three, { pane: { w: 3000, h: 400 } })
    expect(distinct(res.placements.map((p) => p.y))).toBe(1)
  })

  test('the "one column" candidate wins on a narrow pane', () => {
    const three = [b('a', 0, 0, 400, 300), b('b', 10, 0, 400, 300), b('c', 20, 0, 400, 300)]
    const res = fitLayout(three, { pane: { w: 600, h: 2000 } })
    expect(distinct(res.placements.map((p) => p.x))).toBe(1)
  })

  test('a score tie prefers fewer rows', () => {
    // Square pane, two 100² boards, no unit gap: one row (200×100) and one column (100×200)
    // fit at exactly the same zoom → the one-row shelf wins.
    const two = [b('a', 0, 0), b('b', 0, 300)]
    const res = fitLayout(two, { pane: { w: 1000, h: 1000 }, unitGap: 0 })
    expect(res.placements).toEqual([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 0 }
    ])
  })

  test('a canvas too big for ANY zoom still packs toward the pane aspect (no one-row strip)', () => {
    // Every candidate clamps to FIT_MIN_ZOOM here, so a clamped-score tie would hand the
    // win to "fewer rows" = the one-row strip. Ranking breaks that tie on the unclamped fit.
    const forty = Array.from({ length: 40 }, (_, i) =>
      b(`m${String(i).padStart(2, '0')}`, i, 0, 1200, 900)
    )
    const res = fitLayout(forty, { pane: { w: 800, h: 600 } })
    expect(res.fitZoom).toBe(FIT_MIN_ZOOM)
    const aspect = res.bbox.w / res.bbox.h
    expect(aspect).toBeGreaterThan((800 / 600) * 0.5)
    expect(aspect).toBeLessThan((800 / 600) * 2)
  })
})

// ── Step 5: anchor ───────────────────────────────────────────────────────────
describe('fitLayout — step 5: anchor at the current cluster top-left', () => {
  test('the packed block starts at the input min x / min y', () => {
    const boards = [b('a', 500, 500), b('b', -200, 900), b('c', 900, 30), b('d', 40, 1200)]
    const res = fitLayout(boards, { pane: WIDE })
    expect(res.bbox.x).toBe(-200)
    expect(res.bbox.y).toBe(30)
    expect(Math.min(...res.placements.map((p) => p.x))).toBe(-200)
    expect(Math.min(...res.placements.map((p) => p.y))).toBe(30)
  })
})

// ── Step 6: overflow ─────────────────────────────────────────────────────────
describe('fitLayout — step 6: overflow when still unreadable', () => {
  // Six 1200×900 boards on a 1600×1000 pane: the best single packing (3×2) fits at ~0.388.
  const six = Array.from({ length: 6 }, (_, i) => b(`p${i}`, i * 2000, 0, 1200, 900))
  const pane = { w: 1600, h: 1000 }

  test('report (the default) keeps the packing and reports readable:false', () => {
    const res = fitLayout(six, { pane })
    expect(res).toEqual(fitLayout(six, { pane, overflow: 'report' }))
    expect(res.readable).toBe(false)
    expect(res.fitZoom).toBeLessThan(READABLE_ZOOM)
    expect(res.pages).toBeUndefined()
    expect(res.placements.every((p) => p.w === undefined && p.h === undefined)).toBe(true)
  })

  test('pages cuts the ordered units into pages that each fit at ≥ readableZoom', () => {
    const res = fitLayout(six, { pane, overflow: 'pages' })
    expect(res.pages!.map((p) => p.boardIds)).toEqual([
      ['p0', 'p1', 'p2', 'p3'],
      ['p4', 'p5']
    ])
    for (const page of res.pages!)
      expect(fitZoom(page.bbox, pane)).toBeGreaterThanOrEqual(READABLE_ZOOM)
    expect(res.fitZoom).toBe(fitZoom(res.pages![0].bbox, pane)) // fitZoom describes page 0
    expect(res.readable).toBe(true)
  })

  test('pages are laid left→right, 2 × unitGap apart, top-aligned at the anchor', () => {
    const [p0, p1] = fitLayout(six, { pane, overflow: 'pages' }).pages!
    expect(p0.bbox.x).toBe(0)
    expect(p1.bbox.x).toBe(p0.bbox.x + p0.bbox.w + 2 * FIT_UNIT_GAP)
    expect(p1.bbox.y).toBe(p0.bbox.y)
  })

  test('a unit too big for any page gets its own (still unreadable) page', () => {
    const boards = [...six.slice(0, 2), b('huge', 2500, 0, 9000, 7000), ...six.slice(3)]
    const res = fitLayout(boards, { pane, overflow: 'pages' })
    const own = res.pages!.find((p) => p.boardIds.includes('huge'))!
    expect(own.boardIds).toEqual(['huge'])
    expect(fitZoom(own.bbox, pane)).toBeLessThan(READABLE_ZOOM)
    expect(res.pages!.flatMap((p) => p.boardIds).sort()).toEqual(boards.map((o) => o.id).sort())
  })

  test('pages is absent when the layout is already readable', () => {
    const res = fitLayout(six.slice(0, 2), { pane, overflow: 'pages' })
    expect(res.readable).toBe(true)
    expect(res.pages).toBeUndefined()
  })

  test('shrink scales every board by ONE factor until the packing is readable', () => {
    const res = fitLayout(six, { pane, overflow: 'shrink' })
    expect(res.readable).toBe(true)
    expect(res.fitZoom).toBeGreaterThanOrEqual(READABLE_ZOOM)
    const sizes = res.placements.map((p) => [p.w!, p.h!])
    expect(new Set(sizes.map(([w, h]) => `${w}x${h}`)).size).toBe(1) // one factor for all
    const [w, h] = sizes[0]
    expect(w).toBeLessThan(1200)
    expect(w).toBeGreaterThan(1100) // only as much as needed (3×2 fits from ~0.968)
    expect(Math.abs(w / h - 1200 / 900)).toBeLessThan(0.01) // aspect kept (±rounding)
    expect(noOverlaps(rectsOf(res, six))).toBe(true)
  })

  test('shrink floors at MIN_BOARD_SIZE and reports readable:false when the floor is hit', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      b(`m${String(i).padStart(2, '0')}`, i, 0, 1200, 900)
    )
    const tiny = b('tiny', -10, 0, 100, 80)
    const res = fitLayout([...many, tiny], { pane: { w: 800, h: 600 }, overflow: 'shrink' })
    expect(res.readable).toBe(false)
    for (const p of res.placements.filter((o) => o.id !== 'tiny')) {
      expect([p.w, p.h]).toEqual([MIN_BOARD_SIZE.w, MIN_BOARD_SIZE.h])
    }
    // A board already under the floor never grows and carries no w/h.
    const t = res.placements.find((p) => p.id === 'tiny')!
    expect(t.w).toBeUndefined()
    expect(t.h).toBeUndefined()
  })

  test('shrink leaves w/h off a readable layout (nothing to resize)', () => {
    const res = fitLayout(six.slice(0, 2), { pane, overflow: 'shrink' })
    expect(res.readable).toBe(true)
    expect(res.placements.every((p) => p.w === undefined && p.h === undefined)).toBe(true)
  })
})

// ── Step 7: fewer than 2 boards ──────────────────────────────────────────────
describe('fitLayout — step 7: fewer than 2 boards', () => {
  test('empty input → no placements, a zero bbox, readable', () => {
    expect(fitLayout([], { pane: WIDE })).toEqual({
      placements: [],
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      fitZoom: FIT_MAX_ZOOM,
      readable: true
    })
  })

  test('one board → position unchanged, readable computed honestly', () => {
    const small = fitLayout([b('a', 37, 91, 400, 300)], { pane: WIDE })
    expect(small.placements).toEqual([{ id: 'a', x: 37, y: 91 }])
    expect(small.bbox).toEqual({ x: 37, y: 91, w: 400, h: 300 })
    expect(small.readable).toBe(true)
    const huge = fitLayout([b('a', 5, 5, 9000, 7000)], { pane: WIDE, overflow: 'shrink' })
    expect(huge.placements).toEqual([{ id: 'a', x: 5, y: 5 }]) // no-op even under shrink
    expect(huge.readable).toBe(false)
    expect(huge.fitZoom).toBe(fitZoom({ x: 5, y: 5, w: 9000, h: 7000 }, WIDE))
  })
})

// ── Options ──────────────────────────────────────────────────────────────────
describe('fitLayout — options', () => {
  test('unitGap default (96) exceeds 2 × the group-outline pad, so outlines never touch', () => {
    expect(FIT_UNIT_GAP).toBe(96)
    expect(FIT_UNIT_GAP).toBeGreaterThan(2 * GROUP_BOX_PAD)
  })

  test('custom gap / unitGap are honoured; negative or NaN fall back safely', () => {
    const boards = [b('a', 0, 0), b('b', 0, 0), b('c', 0, 0)]
    const units = [{ id: 'U', boardIds: ['a', 'b'] }]
    const pane = { w: 3000, h: 400 }
    const xs = (o: Partial<FitOptions>): number[] =>
      fitLayout(boards, { pane, units, ...o }).placements.map((p) => p.x)
    expect(xs({ gap: 10, unitGap: 50 })).toEqual([0, 110, 260])
    expect(xs({ gap: -5, unitGap: -5 })).toEqual([0, 100, 200]) // clamped to 0
    expect(xs({ gap: NaN, unitGap: NaN })).toEqual(xs({})) // defaults
  })

  test('readableZoom moves the readable threshold', () => {
    const two = [b('a', 0, 0, 800, 600), b('b', 0, 0, 800, 600)]
    expect(fitLayout(two, { pane: WIDE }).readable).toBe(true)
    expect(fitLayout(two, { pane: WIDE, readableZoom: 1.9 }).readable).toBe(false)
  })
})

// ── Property tests (seeded; ≥ 200 cases each) ────────────────────────────────
/** mulberry32 — a tiny seeded PRNG so every failing case is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Case {
  boards: TidyBoard[]
  opts: FitOptions
}

const KINDS: readonly BoardKind[] = ['terminal', 'browser', 'planning', 'kanban']
const OVERFLOWS: ReadonlyArray<FitOverflow | undefined> = [undefined, 'report', 'pages', 'shrink']

/** A random canvas: 0–28 boards from tiny to huge, overlapping units (multi-membership,
 *  unknown ids, duplicate unit ids), a random pane (sometimes degenerate) and overflow. */
function genCase(seed: number): Case {
  const rnd = mulberry32(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const n = int(0, 28)
  const boards: TidyBoard[] = []
  for (let i = 0; i < n; i++) {
    const c = rnd()
    const [w, h] =
      c < 0.15
        ? [int(8, 200), int(8, 150)]
        : c < 0.85
          ? [int(240, 1000), int(160, 800)]
          : [int(1500, 6000), int(1000, 4000)]
    boards.push(
      b(`${pick(['a', 'k', 'z'])}${i}`, int(-4000, 4000), int(-4000, 4000), w, h, {
        type: pick(KINDS)
      })
    )
  }
  const terminals = boards.filter((o) => o.type === 'terminal').map((o) => o.id)
  for (const o of boards) {
    if (o.type === 'browser' && terminals.length && rnd() < 0.6) o.previewSourceId = pick(terminals)
  }
  const units: FitUnit[] = []
  for (let u = int(0, 5); u > 0 && n > 0; u--) {
    const ids = Array.from({ length: int(1, Math.min(6, n)) }, () => boards[int(0, n - 1)].id)
    if (rnd() < 0.15) ids.push('ghost')
    units.push({ id: pick(['g1', 'g2', 'g3', 'ctx-a', 'ctx-b']), boardIds: ids })
  }
  const pane =
    rnd() < 0.05 ? { w: int(1, 200), h: int(1, 200) } : { w: int(320, 3840), h: int(240, 2160) }
  return { boards, opts: { pane, units, overflow: pick(OVERFLOWS) } }
}

/** Shuffle with its own seeded PRNG (Fisher–Yates). */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed)
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const CASES = 200

/** Run `check` over CASES seeded random canvases; every assertion message carries the seed. */
function forAll(base: number, check: (c: Case, res: FitResult, seed: string) => void): void {
  for (let i = 0; i < CASES; i++) {
    const seed = base + i
    const c = genCase(seed)
    check(c, fitLayout(c.boards, c.opts), `seed=${seed}`)
  }
}

describe('fitLayout — properties (seeded random canvases)', () => {
  test('no two boards overlap', () => {
    forAll(1_000, (c, res, seed) => {
      expect(noOverlaps(rectsOf(res, c.boards)), seed).toBe(true)
    })
  })

  test('for units A ≠ B, the padded bbox of A contains no board of B (and outlines never touch)', () => {
    forAll(2_000, (c, res, seed) => {
      if (c.boards.length < 2) return
      const rects = rectsOf(res, c.boards)
      const units = expectedUnits(c.boards, c.opts.units ?? [])
      const boxes = units.map((ids) => bounds(ids.map((id) => rects.get(id)!)))
      units.forEach((_, ia) => {
        units.forEach((idsB, ib) => {
          if (ia === ib) return
          for (const id of idsB) {
            expect(
              rectsIntersect(pad(boxes[ia], FIT_UNIT_GAP), rects.get(id)!),
              `${seed} unit ${ia} ∋ ${id}`
            ).toBe(false)
          }
          const half = FIT_UNIT_GAP / 2
          expect(
            rectsIntersect(pad(boxes[ia], half), pad(boxes[ib], half)),
            `${seed} ${ia}/${ib}`
          ).toBe(false)
        })
      })
    })
  })

  test('deterministic for any input order (boards, units, unit members)', () => {
    forAll(3_000, (c, res, seed) => {
      const units = shuffled(c.opts.units ?? [], 7).map((u, i) => ({
        ...u,
        boardIds: shuffled(u.boardIds, i)
      }))
      const again = fitLayout(shuffled(c.boards, 11), { ...c.opts, units })
      expect(again, seed).toEqual(res)
    })
  })

  test("w/h untouched unless 'shrink' (and shrink only ever shrinks, down to the floor)", () => {
    forAll(4_000, (c, res, seed) => {
      for (const p of res.placements) {
        if (c.opts.overflow !== 'shrink') {
          expect(p.w === undefined && p.h === undefined, `${seed} ${p.id}`).toBe(true)
          continue
        }
        const src = c.boards.find((o) => o.id === p.id)!
        if (p.w !== undefined) {
          expect(p.w, `${seed} ${p.id}.w`).toBeLessThanOrEqual(src.w)
          expect(p.w, `${seed} ${p.id}.w`).toBeGreaterThanOrEqual(Math.min(src.w, MIN_BOARD_SIZE.w))
        }
        if (p.h !== undefined) {
          expect(p.h, `${seed} ${p.id}.h`).toBeLessThanOrEqual(src.h)
          expect(p.h, `${seed} ${p.id}.h`).toBeGreaterThanOrEqual(Math.min(src.h, MIN_BOARD_SIZE.h))
        }
      }
    })
  })

  test('every input board gets exactly one placement', () => {
    forAll(5_000, (c, res, seed) => {
      expect(
        res.placements.map((p) => p.id),
        seed
      ).toEqual(c.boards.map((o) => o.id).sort())
    })
  })

  test('anchored at the cluster top-left, with an honest fitZoom / readable', () => {
    forAll(6_000, (c, res, seed) => {
      if (c.boards.length === 0) return
      const input = bounds(c.boards)
      expect([res.bbox.x, res.bbox.y], seed).toEqual([input.x, input.y])
      expect(res.bbox, seed).toEqual(bounds([...rectsOf(res, c.boards).values()]))
      const framed = res.pages ? res.pages[0].bbox : res.bbox
      expect(res.fitZoom, seed).toBe(fitZoom(framed, c.opts.pane))
      expect(res.readable, seed).toBe(res.fitZoom >= READABLE_ZOOM)
    })
  })
})
