/**
 * Pure smart-alignment detection (Canva/Figma "helper lines"). Given the dragged board's
 * candidate rect and the other boards, find — within `threshold` (WORLD units) — the nearest
 * per-axis EDGE/CENTER alignment (slice 1) or a 16px GUTTER beside an axis-neighbor (slice 2a),
 * return the snapped top-left, the guide(s) to draw, and any live overlap rectangles. No React,
 * no store — unit-tested like the other lib/*.ts.
 *
 * Snap math: a stop is `origin + offset`; to land it on `target`, shift origin by `target - stop`.
 * The single smallest qualifying diff per axis wins; edge/center alignment beats a gap candidate at
 * equal diff (aligning edges is primary, the gutter is the keep-apart fallback). Threshold is a
 * screen-px value divided by zoom by the caller so the feel is constant across zoom.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** An edge/center alignment line in WORLD coords (slice 1). `axis:'x'` = vertical line at world-x
 *  `pos` spanning world-y [start,end]; `axis:'y'` = horizontal at world-y `pos` spanning [start,end]. */
export interface AlignGuide {
  kind: 'align'
  axis: 'x' | 'y'
  pos: number
  start: number
  end: number
}

/** A gutter/gap indicator in WORLD coords (slice 2a). The gutter runs along `axis`, centered at
 *  `pos` with width `distance`; `perp` is the perpendicular coordinate to anchor the connector+pill. */
export interface GapGuide {
  kind: 'gap'
  axis: 'x' | 'y'
  pos: number
  perp: number
  distance: number
}

/** An equal-spacing indicator (slice 2b): the dragged board is centered between two neighbors so
 *  both gaps match. Each entry in `gaps` is an equal segment on `axis` (world coords from→to);
 *  `perp` anchors the connectors+pills; `distance` is the (equal) gap size. */
export interface DistributionGuide {
  kind: 'distribute'
  axis: 'x' | 'y'
  gaps: { from: number; to: number }[]
  perp: number
  distance: number
}

export type Guide = AlignGuide | GapGuide | DistributionGuide

export interface AlignResult {
  /** Snapped top-left (unchanged on an axis with no match). */
  x: number
  y: number
  /** 0–2 guide lines/indicators (≤1 per axis). */
  guides: Guide[]
  /** World-space intersection rects of the snapped dragged board vs overlapped boards. */
  overlaps: Rect[]
}

/** Screen px the dragged edge must be within to snap (caller divides by zoom). */
export const SNAP_THRESHOLD_PX = 8
/** Gutter width the gap-snap offers beside a neighbor (flush=0 is handled by edge alignment). */
export const GAP_SNAP_PX = 16

interface OtherAxis {
  origin: number
  size: number
  perpMin: number
  perpMax: number
}

/** Internal winner for one axis: the snapped origin + the guide to draw. */
interface AxisMatch {
  origin: number
  guide: Guide
  diff: number
}

/** Stops along an axis: [near edge, center, far edge]. */
function stops(origin: number, size: number): [number, number, number] {
  return [origin, origin + size / 2, origin + size]
}

/** Do two [min,max] ranges overlap (strictly)? Used to gate gap-snap to real axis-neighbors. */
function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return Math.max(aMin, bMin) < Math.min(aMax, bMax)
}

function bestAxisMatch(
  axis: 'x' | 'y',
  dragOrigin: number,
  dragSize: number,
  dragPerpMin: number,
  dragPerpMax: number,
  others: OtherAxis[],
  threshold: number
): AxisMatch | null {
  const dStops = stops(dragOrigin, dragSize)
  let best: AxisMatch | null = null
  const consider = (diff: number, origin: number, guide: Guide): void => {
    if (diff > threshold) return
    // Strict `<` keeps the first-found winner on ties → align (added first) beats gap.
    if (best && diff >= best.diff) return
    best = { diff, origin, guide }
  }

  for (const o of others) {
    const oStops = stops(o.origin, o.size)
    const perpOverlap = rangesOverlap(dragPerpMin, dragPerpMax, o.perpMin, o.perpMax)
    // 1) ALIGN candidates (edge/center vs edge/center).
    for (const ds of dStops) {
      for (const os of oStops) {
        consider(Math.abs(ds - os), dragOrigin + (os - ds), {
          kind: 'align',
          axis,
          pos: os,
          start: Math.min(dragPerpMin, o.perpMin),
          end: Math.max(dragPerpMax, o.perpMax)
        })
      }
    }
    // 2) GAP candidates (16px gutter), only between axis-neighbors.
    if (perpOverlap) {
      const perp = (Math.max(dragPerpMin, o.perpMin) + Math.min(dragPerpMax, o.perpMax)) / 2
      const g = GAP_SNAP_PX
      // dragged to the LEFT of other: dragged far-edge (origin+size) == other.near-edge - g.
      const leftOrigin = o.origin - g - dragSize
      consider(Math.abs(dragOrigin - leftOrigin), leftOrigin, {
        kind: 'gap',
        axis,
        pos: o.origin - g / 2,
        perp,
        distance: g
      })
      // dragged to the RIGHT of other: dragged near-edge (origin) == other.far-edge + g.
      const rightOrigin = o.origin + o.size + g
      consider(Math.abs(dragOrigin - rightOrigin), rightOrigin, {
        kind: 'gap',
        axis,
        pos: o.origin + o.size + g / 2,
        perp,
        distance: g
      })
    }
  }
  return best
}

/** Axis-independent rect intersection, or null if they do not strictly overlap (touching = null). */
function intersect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * Best centered-distribution match on one axis: if the dragged board has BOTH an immediate
 * perpendicular-neighbor to each side with room between them, the position that makes the two side
 * gaps equal. Returns the snapped origin + a `distribute` guide, or null. `others` is the axis-mapped
 * neighbor list (same shape `bestAxisMatch` consumes).
 */
function bestDistribution(
  axis: 'x' | 'y',
  dragOrigin: number,
  dragSize: number,
  dragPerpMin: number,
  dragPerpMax: number,
  others: OtherAxis[],
  threshold: number
): AxisMatch | null {
  const dragCenter = dragOrigin + dragSize / 2
  let L: OtherAxis | null = null // immediate left (rightmost far edge among left neighbors)
  let R: OtherAxis | null = null // immediate right (leftmost near edge among right neighbors)
  for (const o of others) {
    if (!rangesOverlap(dragPerpMin, dragPerpMax, o.perpMin, o.perpMax)) continue
    const oCenter = o.origin + o.size / 2
    if (oCenter < dragCenter) {
      if (!L || o.origin + o.size > L.origin + L.size) L = o
    } else if (oCenter > dragCenter) {
      if (!R || o.origin < R.origin) R = o
    }
  }
  if (!L || !R) return null

  const lFar = L.origin + L.size
  const rNear = R.origin
  const free = rNear - lFar - dragSize
  if (free < 0) return null // no room → would overlap; not a distribution

  const gap = free / 2
  const origin = lFar + gap
  const diff = Math.abs(dragOrigin - origin)
  if (diff > threshold) return null

  // Indicator row: center of the perp overlap shared by L, dragged, and R (fallback: dragged center).
  const pMin = Math.max(dragPerpMin, L.perpMin, R.perpMin)
  const pMax = Math.min(dragPerpMax, L.perpMax, R.perpMax)
  const perp = pMin < pMax ? (pMin + pMax) / 2 : (dragPerpMin + dragPerpMax) / 2

  const guide: DistributionGuide = {
    kind: 'distribute',
    axis,
    gaps: [
      { from: lFar, to: lFar + gap },
      { from: origin + dragSize, to: rNear }
    ],
    perp,
    distance: gap
  }
  return { diff, origin, guide }
}

/** Pick the better of two axis candidates: smaller diff wins; on an exact tie keep `primary`
 *  (edge/center align or gutter), since alignment is the primary intent over distribution. */
function pickAxis(primary: AxisMatch | null, distribution: AxisMatch | null): AxisMatch | null {
  if (!primary) return distribution
  if (!distribution) return primary
  return distribution.diff < primary.diff ? distribution : primary
}

export function computeAlignment(rect: Rect, others: Rect[], threshold: number): AlignResult {
  const xOthers = others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h }))
  const yOthers = others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w }))

  const xMatch = pickAxis(
    bestAxisMatch('x', rect.x, rect.w, rect.y, rect.y + rect.h, xOthers, threshold),
    bestDistribution('x', rect.x, rect.w, rect.y, rect.y + rect.h, xOthers, threshold)
  )
  const yMatch = pickAxis(
    bestAxisMatch('y', rect.y, rect.h, rect.x, rect.x + rect.w, yOthers, threshold),
    bestDistribution('y', rect.y, rect.h, rect.x, rect.x + rect.w, yOthers, threshold)
  )

  const x = xMatch ? xMatch.origin : rect.x
  const y = yMatch ? yMatch.origin : rect.y
  const guides: Guide[] = []
  if (xMatch) guides.push(xMatch.guide)
  if (yMatch) guides.push(yMatch.guide)

  // Overlaps use the SNAPPED rect so a snapped-flush/gutter board reports none.
  const snapped: Rect = { x, y, w: rect.w, h: rect.h }
  const overlaps: Rect[] = []
  for (const o of others) {
    const hit = intersect(snapped, o)
    if (hit) overlaps.push(hit)
  }

  return { x, y, guides, overlaps }
}

/** One snapped edge: the corrected edge coordinate + the guide to draw. */
interface EdgeSnap {
  value: number
  guide: Guide
}

/**
 * Snap a single moving edge (at `edgeVal`, with perpendicular extent [perpMin,perpMax]) on `axis`
 * to the nearest other-board edge/center (align line) or a 16px gutter beside a perpendicular
 * neighbor (gap pill). `others` is the axis-mapped neighbor list. Nearest qualifying wins; align
 * beats gap on ties (added first, strict `<`).
 */
function snapEdge(
  axis: 'x' | 'y',
  edgeVal: number,
  perpMin: number,
  perpMax: number,
  others: OtherAxis[],
  threshold: number
): EdgeSnap | null {
  let best: (EdgeSnap & { diff: number }) | null = null
  const consider = (diff: number, value: number, guide: Guide): void => {
    if (diff > threshold) return
    if (best && diff >= best.diff) return
    best = { diff, value, guide }
  }
  for (const o of others) {
    // Align: edge → other's near/center/far edge (any board, no neighbor requirement).
    for (const os of stops(o.origin, o.size)) {
      consider(Math.abs(edgeVal - os), os, {
        kind: 'align',
        axis,
        pos: os,
        start: Math.min(perpMin, o.perpMin),
        end: Math.max(perpMax, o.perpMax)
      })
    }
    // Gap: a 16px gutter to a facing edge — only between perpendicular neighbors.
    if (rangesOverlap(perpMin, perpMax, o.perpMin, o.perpMax)) {
      const g = GAP_SNAP_PX
      const perp = (Math.max(perpMin, o.perpMin) + Math.min(perpMax, o.perpMax)) / 2
      const leftVal = o.origin - g // edge sits a gutter to the LEFT of the other's near edge
      consider(Math.abs(edgeVal - leftVal), leftVal, {
        kind: 'gap',
        axis,
        pos: o.origin - g / 2,
        perp,
        distance: g
      })
      const rightVal = o.origin + o.size + g // a gutter to the RIGHT of the other's far edge
      consider(Math.abs(edgeVal - rightVal), rightVal, {
        kind: 'gap',
        axis,
        pos: o.origin + o.size + g / 2,
        perp,
        distance: g
      })
    }
  }
  return best
}

/** Result of resize snapping: a corrected rect + the guides to draw. */
export interface ResizeResult {
  x: number
  y: number
  w: number
  h: number
  guides: Guide[]
}

/**
 * Snap the MOVING edge(s) of a resize. `old` is the pre-resize rect, `prop` the proposed rect from
 * React Flow (dimensions ± N/W position shift). Only edges whose coordinate differs from `old` snap;
 * a snap that would shrink the board below `min` is skipped. Returns the corrected rect + guides.
 */
export function computeResizeSnap(
  old: Rect,
  prop: Rect,
  others: Rect[],
  threshold: number,
  min: { w: number; h: number }
): ResizeResult {
  let { x, y, w, h } = prop
  const right0 = prop.x + prop.w
  const bottom0 = prop.y + prop.h
  const guides: Guide[] = []

  const xOthers = others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h }))
  const yOthers = others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w }))

  // X edges (perpendicular extent = the board's current vertical span).
  if (prop.x !== old.x) {
    const m = snapEdge('x', prop.x, prop.y, prop.y + prop.h, xOthers, threshold)
    if (m && right0 - m.value >= min.w) {
      x = m.value
      w = right0 - x
      guides.push(m.guide)
    }
  }
  if (right0 !== old.x + old.w) {
    const m = snapEdge('x', right0, prop.y, prop.y + prop.h, xOthers, threshold)
    if (m && m.value - x >= min.w) {
      w = m.value - x
      guides.push(m.guide)
    }
  }
  // Y edges (perpendicular extent = the board's current horizontal span).
  if (prop.y !== old.y) {
    const m = snapEdge('y', prop.y, prop.x, prop.x + prop.w, yOthers, threshold)
    if (m && bottom0 - m.value >= min.h) {
      y = m.value
      h = bottom0 - y
      guides.push(m.guide)
    }
  }
  if (bottom0 !== old.y + old.h) {
    const m = snapEdge('y', bottom0, prop.x, prop.x + prop.w, yOthers, threshold)
    if (m && m.value - y >= min.h) {
      h = m.value - y
      guides.push(m.guide)
    }
  }

  return { x, y, w, h, guides }
}

/** An align guide projected into screen-space pixels for SVG. */
export interface ScreenLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Project a WORLD-space ALIGN guide into screen pixels using React Flow's viewport transform
 * `[translateX, translateY, zoom]`: screen = world*zoom + translate. Stroke width stays in screen
 * px at the call site, so the 1px line is crisp at any zoom.
 */
export function projectGuide(g: AlignGuide, transform: [number, number, number]): ScreenLine {
  const [tx, ty, zoom] = transform
  if (g.axis === 'x') {
    const sx = g.pos * zoom + tx
    return { x1: sx, y1: g.start * zoom + ty, x2: sx, y2: g.end * zoom + ty }
  }
  const sy = g.pos * zoom + ty
  return { x1: g.start * zoom + tx, y1: sy, x2: g.end * zoom + tx, y2: sy }
}

/** A gap guide projected to screen: a connector segment (a→b) + a label anchor + the distance. */
export interface GapVisual {
  ax: number
  ay: number
  bx: number
  by: number
  lx: number
  ly: number
  distance: number
}

/** Project a WORLD-space GAP guide to screen pixels (connector + label anchor). */
export function projectGapGuide(g: GapGuide, transform: [number, number, number]): GapVisual {
  const [tx, ty, zoom] = transform
  const half = g.distance / 2
  if (g.axis === 'x') {
    const y = g.perp * zoom + ty
    return {
      ax: (g.pos - half) * zoom + tx,
      ay: y,
      bx: (g.pos + half) * zoom + tx,
      by: y,
      lx: g.pos * zoom + tx,
      ly: y,
      distance: g.distance
    }
  }
  const x = g.perp * zoom + tx
  return {
    ax: x,
    ay: (g.pos - half) * zoom + ty,
    bx: x,
    by: (g.pos + half) * zoom + ty,
    lx: x,
    ly: g.pos * zoom + ty,
    distance: g.distance
  }
}

/** A world rect projected to a screen rect (for overlap tint). */
export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export function projectRect(r: Rect, transform: [number, number, number]): ScreenRect {
  const [tx, ty, zoom] = transform
  return { x: r.x * zoom + tx, y: r.y * zoom + ty, w: r.w * zoom, h: r.h * zoom }
}
