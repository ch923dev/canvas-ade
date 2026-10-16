/**
 * Fit-to-screen layout (spatial-awareness C4) — pure, deterministic, SCREEN-aware packing
 * (no React, no Zustand). Where `tidyLayout`'s smart mode packs the whole canvas as one
 * type-bucketed block (every terminal in ONE row, Named Groups split across rows), `fit` treats
 * each group / derived context as a UNIT: it packs each unit on its own with the existing smart
 * layout, then shelf-packs the unit rects toward the pane aspect so the result fills the
 * screen and group outlines never touch (spec DESIGN.md › W4).
 *
 * Algorithm (SPEC C4 — each step has a named unit test):
 * 1. Assign each board to at most one unit (the smallest; id tie-break). Unclaimed boards
 *    become single-board units.
 * 2. Pack inside each unit with `tidyLayout` smart → one rect per unit.
 * 3. Order units by their current top-left in reading order (y, x, id).
 * 4. Shelf-pack the units toward the pane aspect; keep the candidate row width that fits best.
 * 5. Anchor at the cluster's current top-left (tidy's "nudge, don't teleport" rule).
 * 6. Still below `readableZoom` → `report` it, cut `pages`, or `shrink` the boards.
 * 7. Fewer than 2 boards is a no-op (readability still computed honestly).
 *
 * Reposition-only (w/h untouched) unless `overflow: 'shrink'`. Docked terminals are filtered
 * by the caller (the `tidyApply` precedent) — never passed in.
 */

import { MIN_BOARD_SIZE } from './boardDefaults'
import { DEFAULT_ASPECT, TIDY_GAP, tidyLayout, type TidyBoard } from './tidyLayout'
import { FIT_PADDING_PX, READABLE_ZOOM, fitZoom, type Rect } from '../../../shared/spatialGeometry'

/** What to do when the best packing is still too small to read (D4). */
export type FitOverflow = 'report' | 'pages' | 'shrink'

/** A set of boards that must stay together — a Named Group and/or a derived context. */
export interface FitUnit {
  id: string
  boardIds: string[]
}

export interface FitOptions {
  /** Visible canvas pane in CSS px — REQUIRED, the whole point of `fit`. */
  pane: { w: number; h: number }
  /** Default: none (every board is its own unit). */
  units?: FitUnit[]
  /** In-unit gap (world px). Default `TIDY_GAP`. */
  gap?: number
  /** Gap between units (world px). Default `FIT_UNIT_GAP`. */
  unitGap?: number
  /** Default `'report'` (D4). */
  overflow?: FitOverflow
  /** Default `READABLE_ZOOM`. */
  readableZoom?: number
}

/** A new top-left for one board; `w`/`h` only under `'shrink'`, only for boards it resized. */
export interface FitPlacement {
  id: string
  x: number
  y: number
  w?: number
  h?: number
}

export interface FitPage {
  index: number
  /** Sorted by id. */
  boardIds: string[]
  bbox: Rect
}

export interface FitResult {
  /** One per input board, sorted by id. */
  placements: FitPlacement[]
  bbox: Rect
  /** `fitZoom(bbox, pane)` of the result (page 0's bbox under `'pages'`). */
  fitZoom: number
  /** `fitZoom >= readableZoom`. */
  readable: boolean
  /** Present only when `'pages'` actually paged the layout. */
  pages?: FitPage[]
}

/** Gap between units — must exceed 2 × the group-outline pad (GroupBoxLayer's
 *  `GROUP_BOX_PAD`, pinned in the tests) so two group outlines never touch. */
export const FIT_UNIT_GAP = 96

/** Step 4's candidate row-width multipliers, 0.6 … 1.6 (built from integers — no float drift). */
const ROW_WIDTH_FACTORS: readonly number[] = Array.from({ length: 11 }, (_, i) => (6 + i) / 10)

/** Bisection steps for `shrink` — 2^-24 of the scale range is far below a pixel. */
const SHRINK_STEPS = 24

interface Size {
  w: number
  h: number
}

/** A unit after step 2: its own w/h + each member's offset from the unit's top-left. */
interface PackedUnit extends Size {
  offsets: Array<{ id: string; dx: number; dy: number }>
}

/** Step 4's output: each unit's top-left relative to the block origin. */
interface Shelf extends Size {
  xs: number[]
  ys: number[]
  rows: number
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** A finite, non-negative option or its default (a NaN/negative gap would overlap boards). */
const gapOr = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) ? Math.max(0, v) : fallback

/** Bounding rect of `rects` — linear scan (no Math.min(...spread): V8's argument ceiling,
 *  BUG-015). Empty → the zero rect at the origin. */
function boundsOf(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.w > maxX) maxX = r.x + r.w
    if (r.y + r.h > maxY) maxY = r.y + r.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Step 1 + step 3. Each board joins the SMALLEST unit that lists it (fewest present members,
 * unit-id tie-break); boards no unit claims become single-board units. Same-id units merge and
 * ids absent from `boards` are ignored, so the result is independent of input order. Returns
 * the member lists in reading order of each unit's current top-left (y, then x, then id).
 */
function assignUnits(sorted: readonly TidyBoard[], units: readonly FitUnit[]): TidyBoard[][] {
  const present = new Map(sorted.map((b) => [b.id, b]))
  const members = new Map<string, Set<string>>()
  for (const u of units) {
    const set = members.get(u.id) ?? new Set<string>()
    for (const id of u.boardIds) if (present.has(id)) set.add(id)
    members.set(u.id, set)
  }
  const owner = new Map<string, string>()
  // Ascending unit ids + a strict `<` keep the smaller id on a size tie.
  for (const uid of [...members.keys()].sort()) {
    const size = members.get(uid)!.size
    for (const bid of members.get(uid)!) {
      const cur = owner.get(bid)
      if (cur === undefined || size < members.get(cur)!.size) owner.set(bid, uid)
    }
  }

  const grouped = new Map<string, TidyBoard[]>()
  const singles: Array<{ key: string; boards: TidyBoard[] }> = []
  for (const b of sorted) {
    const uid = owner.get(b.id)
    if (uid === undefined) singles.push({ key: b.id, boards: [b] })
    else grouped.set(uid, [...(grouped.get(uid) ?? []), b])
  }
  const list = [
    ...[...grouped.keys()].sort().map((key) => ({ key, boards: grouped.get(key)! })),
    ...singles
  ].map((u) => ({ ...u, top: boundsOf(u.boards) }))
  // Stable sort over a canonical list → even full ties are input-order independent.
  list.sort(
    (a, b) => a.top.y - b.top.y || a.top.x - b.top.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
  return list.map((u) => u.boards)
}

/** Step 2: smart-pack one unit, normalized to the unit's own origin. */
function packUnit(members: readonly TidyBoard[], gap: number): PackedUnit {
  const size = new Map(members.map((b) => [b.id, b]))
  const placed = tidyLayout(members, { mode: 'smart', gap })
  const box = boundsOf(
    placed.map((p) => ({ x: p.x, y: p.y, w: size.get(p.id)!.w, h: size.get(p.id)!.h }))
  )
  return {
    w: box.w,
    h: box.h,
    offsets: placed.map((p) => ({ id: p.id, dx: p.x - box.x, dy: p.y - box.y }))
  }
}

/** Shelf-pack `sizes` left→right in order, wrapping when a row would pass `targetW`.
 *  Rows are top-aligned; a unit wider than `targetW` still gets a row of its own. */
function shelfPack(sizes: readonly Size[], targetW: number, unitGap: number): Shelf {
  const xs: number[] = []
  const ys: number[] = []
  let cursorX = 0
  let rowY = 0
  let rowH = 0
  let rowCount = 0
  let rows = 1
  let maxW = 0
  for (const s of sizes) {
    if (rowCount > 0 && cursorX + s.w > targetW) {
      rowY += rowH + unitGap
      cursorX = 0
      rowH = 0
      rowCount = 0
      rows++
    }
    xs.push(cursorX)
    ys.push(rowY)
    if (cursorX + s.w > maxW) maxW = cursorX + s.w
    cursorX += s.w + unitGap
    if (s.h > rowH) rowH = s.h
    rowCount++
  }
  return { xs, ys, w: maxW, h: rowY + rowH, rows }
}

/**
 * The UNCLAMPED fit ratio, used only to RANK step 4's candidates. `fitZoom` clamps to
 * [FIT_MIN_ZOOM, FIT_MAX_ZOOM]; a big canvas ties every candidate at the floor and the
 * "fewer rows" tie-break would then pick the one-row strip (the very G2 failure fit exists
 * to fix). Max ratio ⇒ max clamped `fitZoom`, so this only refines the tie-break.
 */
function fitRatio(s: Size, pane: Size): number {
  const availW = Math.max(1, (Number.isFinite(pane.w) ? pane.w : 1) - 2 * FIT_PADDING_PX)
  const availH = Math.max(1, (Number.isFinite(pane.h) ? pane.h : 1) - 2 * FIT_PADDING_PX)
  return Math.min(s.w > 0 ? availW / s.w : Infinity, s.h > 0 ? availH / s.h : Infinity)
}

/**
 * Step 4: try row widths `sqrt(totalUnitArea × paneAspect) × {0.6 … 1.6}`, then one row,
 * then one column; keep the best fit (tie ⇒ fewer rows ⇒ smaller candidate index).
 */
function bestShelf(sizes: readonly Size[], unitGap: number, pane: Size): Shelf {
  let area = 0
  for (const s of sizes) area += s.w * s.h
  const ratio = pane.w / pane.h
  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_ASPECT
  const base = Math.sqrt(area * aspect)
  const candidates = [...ROW_WIDTH_FACTORS.map((f) => base * f), Infinity, 0]
  let best: Shelf | null = null
  let bestScore = -Infinity
  for (const targetW of candidates) {
    const shelf = shelfPack(sizes, targetW, unitGap)
    const score = fitRatio(shelf, pane)
    if (best === null || score > bestScore || (score === bestScore && shelf.rows < best.rows)) {
      best = shelf
      bestScore = score
    }
  }
  return best!
}

/** Steps 4 + 5 for one block of packed units: shelf-pack, then translate to `origin`. */
function placeBlock(
  units: readonly PackedUnit[],
  origin: { x: number; y: number },
  unitGap: number,
  pane: Size
): { placements: FitPlacement[]; bbox: Rect } {
  const shelf = bestShelf(units, unitGap, pane)
  const placements: FitPlacement[] = []
  units.forEach((u, i) => {
    for (const o of u.offsets) {
      placements.push({
        id: o.id,
        x: origin.x + shelf.xs[i] + o.dx,
        y: origin.y + shelf.ys[i] + o.dy
      })
    }
  })
  return { placements, bbox: { x: origin.x, y: origin.y, w: shelf.w, h: shelf.h } }
}

/** Step 6 `pages`: greedily cut the ordered units into pages that each fit at ≥ `readable`
 *  on their own, laid left→right `2 × unitGap` apart. A unit too big for any page gets a
 *  page of its own (any block holding it is at least its size, so it never fits shared). */
function paginate(
  units: readonly PackedUnit[],
  origin: { x: number; y: number },
  unitGap: number,
  pane: Size,
  readable: number
): { placements: FitPlacement[]; pages: FitPage[] } {
  const groups: PackedUnit[][] = []
  let current: PackedUnit[] = []
  for (const u of units) {
    if (current.length > 0) {
      const trial = bestShelf([...current, u], unitGap, pane)
      if (fitZoom({ x: 0, y: 0, w: trial.w, h: trial.h }, pane) < readable) {
        groups.push(current)
        current = []
      }
    }
    current.push(u)
  }
  if (current.length > 0) groups.push(current)

  const placements: FitPlacement[] = []
  const pages: FitPage[] = []
  let x = origin.x
  groups.forEach((group, index) => {
    const block = placeBlock(group, { x, y: origin.y }, unitGap, pane)
    placements.push(...block.placements)
    pages.push({ index, boardIds: block.placements.map((p) => p.id).sort(), bbox: block.bbox })
    x += block.bbox.w + 2 * unitGap
  })
  return { placements, pages }
}

/** One dimension under `shrink`: scaled toward `floor`, never below it, never grown. */
const shrinkDim = (v: number, scale: number, floor: number): number =>
  v <= floor ? v : Math.min(v, Math.max(floor, Math.round(v * scale)))

/**
 * Lay out `boards` so they fit `opts.pane`, keeping each unit together. Returns one placement
 * per board (sorted by id). Deterministic for any input ordering (of boards, units, and unit
 * members). Moves only, unless `overflow: 'shrink'` had to resize boards to become readable.
 */
export function fitLayout(boards: readonly TidyBoard[], opts: FitOptions): FitResult {
  const { pane } = opts
  const gap = gapOr(opts.gap, TIDY_GAP)
  const unitGap = gapOr(opts.unitGap, FIT_UNIT_GAP)
  const readableZoom =
    opts.readableZoom !== undefined && Number.isFinite(opts.readableZoom)
      ? opts.readableZoom
      : READABLE_ZOOM
  const fits = (bbox: Rect): boolean => fitZoom(bbox, pane) >= readableZoom
  const sizesOf = (list: readonly TidyBoard[]): Map<string, Size> =>
    new Map(list.map((b) => [b.id, { w: b.w, h: b.h }]))
  const finish = (
    placements: FitPlacement[],
    sizes: Map<string, Size>,
    pages?: FitPage[]
  ): FitResult => {
    placements.sort(byId)
    const bbox = boundsOf(placements.map((p) => ({ x: p.x, y: p.y, ...sizes.get(p.id)! })))
    const zoom = fitZoom(pages ? pages[0].bbox : bbox, pane)
    const result: FitResult = { placements, bbox, fitZoom: zoom, readable: zoom >= readableZoom }
    if (pages) result.pages = pages
    return result
  }

  const sorted = [...boards].sort(byId)
  const original = sizesOf(sorted)
  // Step 7: fewer than 2 boards — nothing to arrange (positions AND sizes unchanged).
  if (sorted.length < 2) {
    return finish(
      sorted.map((b) => ({ id: b.id, x: b.x, y: b.y })),
      original
    )
  }

  const ordered = assignUnits(sorted, opts.units ?? []) // steps 1 + 3
  const origin = boundsOf(sorted) // step 5's anchor: the cluster's current top-left
  const packed = ordered.map((members) => packUnit(members, gap)) // step 2
  const first = placeBlock(packed, origin, unitGap, pane) // steps 4 + 5
  // Step 6: readable as is, or `report` (the default; an unknown value is treated as it).
  if (fits(first.bbox) || (opts.overflow !== 'pages' && opts.overflow !== 'shrink')) {
    return finish(first.placements, original)
  }

  if (opts.overflow === 'pages') {
    const { placements, pages } = paginate(packed, origin, unitGap, pane, readableZoom)
    return finish(placements, original, pages)
  }

  // Step 6 `shrink`: ONE factor for every board. Below `floorScale` every board sits at
  // MIN_BOARD_SIZE, so bisect [floorScale, 1] for the largest factor whose re-pack is readable.
  const scaled = (scale: number): TidyBoard[][] =>
    ordered.map((members) =>
      members.map((b) => ({
        ...b,
        w: shrinkDim(b.w, scale, MIN_BOARD_SIZE.w),
        h: shrinkDim(b.h, scale, MIN_BOARD_SIZE.h)
      }))
    )
  const arrange = (list: readonly TidyBoard[][]): { placements: FitPlacement[]; bbox: Rect } =>
    placeBlock(
      list.map((members) => packUnit(members, gap)),
      origin,
      unitGap,
      pane
    )
  let floorScale = 1
  for (const b of sorted) {
    floorScale = Math.min(floorScale, MIN_BOARD_SIZE.w / b.w, MIN_BOARD_SIZE.h / b.h)
  }
  // `lo` only ever holds a verified-readable factor (or the floor when even that fails).
  let lo = floorScale
  if (fits(arrange(scaled(lo)).bbox)) {
    let hi = 1 // known unreadable: the unscaled packing failed above
    for (let i = 0; i < SHRINK_STEPS; i++) {
      const mid = (lo + hi) / 2
      if (fits(arrange(scaled(mid)).bbox)) lo = mid
      else hi = mid
    }
  }
  const final = scaled(lo)
  const block = arrange(final)
  const resized = sizesOf(final.flat())
  const placements = block.placements.map((p) => {
    const was = original.get(p.id)!
    const now = resized.get(p.id)!
    return now.w === was.w && now.h === was.h ? p : { ...p, w: now.w, h: now.h }
  })
  return finish(placements, resized)
}
