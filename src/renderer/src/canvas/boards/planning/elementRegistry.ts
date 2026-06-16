/**
 * Element geometry rail (S3) — the SINGLE source of per-kind Planning-element geometry.
 *
 * Before this module, two independent files each encoded the same per-kind geometry:
 * `elements.ts` owned `elementBBox` (selection / snap / alignment / export bounds) and
 * `erase.ts` owned `eraseHitTest` (eraser + right-click hit-testing). A card-layout change
 * had to be mirrored in BOTH or selection/snap/erase/export would silently drift apart (the
 * R4 drift class). This module merges them: one per-kind descriptor table (`ELEMENT_GEOMETRY`)
 * carries both `bbox` and `hitTest`, so a new element kind is registered in exactly ONE place.
 * The mapped-type registry makes that a COMPILE error until the new kind has a descriptor —
 * the compile-time-exhaustiveness win that S4's `diagram` kind rides on.
 *
 * `elements.ts` and `erase.ts` re-export the public symbols they used to own
 * (`elementBBox`/`TEXT_NOMINAL`/`nominalChecklistHeight`/`BBox`/`Measured` and
 * `eraseHitTest`/`ERASE_TOL`/`TEXT_HIT`/`HitPoint`) so every existing import path keeps
 * working unchanged — this refactor is behavior-identical.
 *
 * PRESERVED drift (NOT a bug to silently reconcile here): an auto-sized text element's
 * nominal bbox (`TEXT_NOMINAL` {120,22}) and its nominal eraser hit box (`TEXT_HIT` {160,24})
 * genuinely differ today — the eraser is deliberately more forgiving on un-measured text.
 * They are co-located here so the difference is VISIBLE, but collapsing them would change
 * behavior and belongs in its own UX-reviewed change. The `elementRegistry.test.ts`
 * drift-guard pins this so a future "cleanup" cannot merge them by accident.
 */
import type { ArrowElement, PlanningElement, StrokeElement } from '../../../lib/boardSchema'

// ── Shared geometry types ─────────────────────────────────────────────────────

/** Board-local axis-aligned box (same coordinate space as element x/y). */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** A single live DOM measurement {w,h} for ONE element (board-local px). */
export interface Measured {
  w: number
  h: number
}

/** A board-local point (same coordinate space as element x/y). */
export interface HitPoint {
  x: number
  y: number
}

/** Runtime map of element-id → measured {w,h}; null/undefined when no live sizes exist. */
export type MeasuredMap = ReadonlyMap<string, Measured> | null | undefined

// ── Nominal sizes (fallbacks when no live DOM measurement exists) ──────────────

/** Nominal box for an auto-sized free-text element's BBOX when unmeasured. */
export const TEXT_NOMINAL: Measured = { w: 120, h: 22 }

/**
 * Nominal box for an auto-sized free-text element's ERASER HIT when unmeasured.
 * Deliberately larger than `TEXT_NOMINAL` (a more forgiving eraser target). See the module
 * header — this difference is preserved, not a bug to silently reconcile in this refactor.
 */
export const TEXT_HIT = { w: 160, h: 24 } as const

/**
 * Hit tolerance in BOARD-LOCAL px. Zoom-stable: the caller maps the screen pointer to board
 * space (÷ camera zoom) before calling, so this band stays constant on the board regardless
 * of camera zoom.
 */
export const ERASE_TOL = 8

// Approx ChecklistCard row metrics — single source of truth. Keep roughly in step with
// ChecklistCard.tsx if its layout changes.
const CHECKLIST_HEADER_H = 30
const CHECKLIST_ROW_H = 24
const CHECKLIST_FOOTER_H = 24

/** Approximate rendered checklist height from its item count (board-local px). */
export function nominalChecklistHeight(itemCount: number): number {
  return CHECKLIST_HEADER_H + itemCount * CHECKLIST_ROW_H + CHECKLIST_FOOTER_H
}

// ── Hit-test primitives (board-local) ──────────────────────────────────────────

/** Point-in-rectangle with a tolerance band (board-local). */
function inRect(p: HitPoint, x: number, y: number, w: number, h: number, tol: number): boolean {
  return p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol
}

/** Shortest distance from point p to the segment a→b. */
function distToSegment(p: HitPoint, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - ax, p.y - ay)
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy))
}

/**
 * Sample the arrow's cubic bezier (SAME control points as `arrowPath` in svgPaths.ts) and
 * test the min distance from the swipe point to the sampled polyline. Keeps the eraser's
 * notion of "on the arrow" identical to what's drawn.
 */
function nearArrow(a: ArrowElement, p: HitPoint, tol: number): boolean {
  const c1x = a.x + (a.x2 - a.x) * 0.4
  const c1y = a.y + (a.y2 - a.y) * 0.1
  const c2x = a.x + (a.x2 - a.x) * 0.6
  const c2y = a.y2 - (a.y2 - a.y) * 0.1
  // Arc-length-adaptive sampling: a fixed step count leaves gaps wider than `tol` between
  // samples on a long arrow, so a swipe along the middle of a long curved arrow could miss
  // it. Scale the step count with the chord length so each segment stays ~`tol` px (floor 16
  // keeps short-arrow behaviour identical; cap 512 bounds the worst case). The chord
  // under-estimates the slightly-bowed bezier negligibly.
  const chord = Math.hypot(a.x2 - a.x, a.y2 - a.y)
  const STEPS = Math.max(16, Math.min(512, Math.ceil(chord / tol)))
  let prevX = a.x
  let prevY = a.y
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS
    const mt = 1 - t
    const x = mt * mt * mt * a.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * a.x2
    const y = mt * mt * mt * a.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * a.y2
    if (distToSegment(p, prevX, prevY, x, y) <= tol) return true
    prevX = x
    prevY = y
  }
  return false
}

/** Test the min distance from the swipe point to any segment of the polyline. */
function nearStroke(s: StrokeElement, p: HitPoint, tol: number): boolean {
  const pts = s.points
  if (pts.length < 2) return false
  if (pts.length === 2) return Math.hypot(p.x - pts[0], p.y - pts[1]) <= tol
  // points are an even-length flat list (schema-validated); each (i, i+2) pair is a segment.
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (distToSegment(p, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= tol) return true
  }
  return false
}

/** Bounding box of a flat stroke point list (even-length [x0,y0,x1,y1,…]). */
function strokeBBox(el: StrokeElement): BBox {
  const pts = el.points
  if (pts.length < 2) return { x: el.x, y: el.y, w: 0, h: 0 }
  let minX = pts[0]
  let minY = pts[1]
  let maxX = pts[0]
  let maxY = pts[1]
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i]
    if (pts[i] > maxX) maxX = pts[i]
    if (pts[i + 1] < minY) minY = pts[i + 1]
    if (pts[i + 1] > maxY) maxY = pts[i + 1]
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// ── Per-kind geometry registry (the rail) ──────────────────────────────────────

/** Per-kind geometry: bounding box (selection/snap/export) + eraser/pointer hit-test. */
interface KindGeometry<E extends PlanningElement> {
  /** Board-local bounding box. `measured` (a live DOM size) refines auto-sized kinds. */
  bbox(el: E, measured?: Measured): BBox
  /** True if the board-local point hits the element within `tol`. */
  hitTest(el: E, p: HitPoint, tol: number, measured: MeasuredMap): boolean
}

/**
 * The single per-kind descriptor table. The mapped type forces an entry for EVERY kind in
 * the `PlanningElement` union — add a kind to the union and this object fails to compile
 * until its geometry is registered here (the S4 `diagram` entry point).
 */
type ElementGeometryRegistry = {
  [K in PlanningElement['kind']]: KindGeometry<Extract<PlanningElement, { kind: K }>>
}

const ELEMENT_GEOMETRY: ElementGeometryRegistry = {
  note: {
    // Prefer the live measured height when positive (NoteCard auto-sizes its textarea, so el.h
    // is only the initial schema default of 96 — BUG-050). A zero measured height means the DOM
    // has not laid out yet; fall back to el.h.
    bbox: (el, measured) => ({
      x: el.x,
      y: el.y,
      w: el.w,
      h: measured && measured.h > 0 ? measured.h : el.h
    }),
    hitTest: (el, p, tol, measured) => {
      const m = measured?.get(el.id)
      const h = m && m.h > 0 ? m.h : el.h
      return inRect(p, el.x, el.y, el.w, h, tol)
    }
  },
  checklist: {
    bbox: (el, measured) => ({
      x: el.x,
      y: el.y,
      w: el.w,
      h: measured?.h ?? nominalChecklistHeight(el.items.length)
    }),
    hitTest: (el, p, tol, measured) => {
      const m = measured?.get(el.id)
      const h = m && m.h > 0 ? m.h : nominalChecklistHeight(el.items.length)
      return inRect(p, el.x, el.y, el.w, h, tol)
    }
  },
  text: {
    bbox: (el, measured) => {
      const m = measured ?? TEXT_NOMINAL
      return { x: el.x, y: el.y, w: m.w, h: m.h }
    },
    // Only use measured dimensions when both are positive — a zero-area measured entry means no
    // layout has occurred yet; fall back to the (deliberately larger) nominal hit box.
    hitTest: (el, p, tol, measured) => {
      const m = measured?.get(el.id)
      const w = m && m.w > 0 ? m.w : TEXT_HIT.w
      const h = m && m.h > 0 ? m.h : TEXT_HIT.h
      return inRect(p, el.x, el.y, w, h, tol)
    }
  },
  arrow: {
    // Arrows have NO single top-left → use the endpoint extent (never w/h).
    bbox: (el) => ({
      x: Math.min(el.x, el.x2),
      y: Math.min(el.y, el.y2),
      w: Math.abs(el.x2 - el.x),
      h: Math.abs(el.y2 - el.y)
    }),
    hitTest: (el, p, tol) => nearArrow(el, p, tol)
  },
  stroke: {
    bbox: (el) => strokeBBox(el),
    hitTest: (el, p, tol) => nearStroke(el, p, tol)
  },
  // W4: image element — bbox is its explicit w/h; hit is a tolerance-padded rect.
  image: {
    bbox: (el) => ({ x: el.x, y: el.y, w: el.w, h: el.h }),
    hitTest: (el, p, tol) => inRect(p, el.x, el.y, el.w, el.h, tol)
  },
  // v11/S4: diagram element — like image, an explicit w/h box with a tolerance-padded hit rect.
  diagram: {
    bbox: (el) => ({ x: el.x, y: el.y, w: el.w, h: el.h }),
    hitTest: (el, p, tol) => inRect(p, el.x, el.y, el.w, el.h, tol)
  },
  // v12/file-tree S1: file-reference chip — an explicit w/h box with a tolerance-padded hit rect.
  fileref: {
    bbox: (el) => ({ x: el.x, y: el.y, w: el.w, h: el.h }),
    hitTest: (el, p, tol) => inRect(p, el.x, el.y, el.w, el.h, tol)
  }
}

// ── Public dispatchers (the stable API; thin lookups over the registry) ─────────

/**
 * Board-local bounding box for any element kind. `measured` (a live DOM size) refines the
 * auto-sized kinds — text has no persisted w/h; checklist persists h:0 and grows. Pure: tests
 * pass `measured` explicitly; the board supplies it from a ref map at runtime. Arrows/strokes
 * have NO single top-left → use the point/endpoint extent (never w/h).
 */
export function elementBBox(el: PlanningElement, measured?: Measured): BBox {
  // The registry is keyed by kind; TS can't correlate el.kind's narrowing with the indexed
  // descriptor's param type (the discriminated-union-index limitation), so widen the descriptor
  // at this single dispatch boundary — each descriptor IS typed on its own kind.
  return (ELEMENT_GEOMETRY[el.kind] as KindGeometry<PlanningElement>).bbox(el, measured)
}

/**
 * True if the board-local point hits the element (within `tol`). Cards use a tolerance-padded
 * rect (checklist/text/note fall back to a nominal size when their live measurement is absent);
 * arrows sample the bezier; strokes test the polyline.
 *
 * `measured` is a map of element-id → {w,h} (board-local px) populated at runtime by the card
 * components' onMeasure callbacks. Pass null/undefined when no live DOM sizes are available
 * (e.g. in unit tests).
 */
export function eraseHitTest(
  el: PlanningElement,
  p: HitPoint,
  tol?: number,
  measured?: MeasuredMap
): boolean {
  return (ELEMENT_GEOMETRY[el.kind] as KindGeometry<PlanningElement>).hitTest(
    el,
    p,
    tol ?? ERASE_TOL,
    measured
  )
}
