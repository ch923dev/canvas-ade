/**
 * Pure cross-kind hit-testing for the Planning whiteboard's eraser (W1.1). No
 * React, no DOM: takes an element + a board-local point and answers "is this point
 * on/near it?" so a swipe can collect the ids to delete atomically. Unit-tested
 * like elements.test.ts. The per-kind geometry (rect/bezier/polyline) is a base for
 * W2 — snapping anchors reuse it directly; the marquee will need a SIBLING
 * rect-overlaps-element test (point-near is the wrong predicate for a box select).
 *
 * Atomic only: a hit removes the WHOLE element — partial stroke/arrow erasing
 * (Excalidraw #4904) is out of scope.
 */
import type { ArrowElement, PlanningElement, StrokeElement } from '../../../lib/boardSchema'
import { nominalChecklistHeight } from './elements'

/** A board-local point (same coordinate space as element x/y). */
export interface HitPoint {
  x: number
  y: number
}

/**
 * Hit tolerance in BOARD-LOCAL px. Zoom-stable: the caller maps the screen pointer
 * to board space (÷ camera zoom) before calling, so this band stays constant on the
 * board regardless of camera zoom.
 */
export const ERASE_TOL = 8

/**
 * Auto-sized text persists no w/h, so give it a nominal hit box anchored at its
 * top-left. Used as a fallback when no live DOM measurement is available.
 * W2 refinement: eraseHitTest now accepts a measured map and prefers it when present.
 */
export const TEXT_HIT = { w: 160, h: 24 } as const

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
 * Sample the arrow's cubic bezier (SAME control points as `arrowPath` in
 * svgPaths.ts) and test the min distance from the swipe point to the sampled
 * polyline. Keeps the eraser's notion of "on the arrow" identical to what's drawn.
 */
function nearArrow(a: ArrowElement, p: HitPoint, tol: number): boolean {
  const c1x = a.x + (a.x2 - a.x) * 0.4
  const c1y = a.y + (a.y2 - a.y) * 0.1
  const c2x = a.x + (a.x2 - a.x) * 0.6
  const c2y = a.y2 - (a.y2 - a.y) * 0.1
  // Arc-length-adaptive sampling: a fixed step count leaves gaps wider than `tol` between
  // samples on a long arrow, so a swipe along the middle of a long curved arrow could miss
  // it. Scale the step count with the chord length so each segment stays ~`tol` px (floor
  // 16 keeps short-arrow behaviour identical; cap 512 bounds the worst case). The chord
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

/**
 * True if the board-local point hits the element (within `tol`). Cards use a
 * tolerance-padded rect (checklist uses a nominal height since its schema h is 0);
 * arrows sample the bezier; strokes test the polyline; text uses the live DOM
 * measurement when provided, falling back to a nominal box.
 *
 * `measured` is a map of element-id → {w,h} (board-local px) populated at runtime
 * by the card components' onMeasure callbacks. Pass null/undefined when no live
 * DOM sizes are available (e.g. in unit tests).
 */
export function eraseHitTest(
  el: PlanningElement,
  p: HitPoint,
  tol?: number,
  measured?: ReadonlyMap<string, { w: number; h: number }> | null
): boolean {
  const t = tol ?? ERASE_TOL
  switch (el.kind) {
    case 'note': {
      // Prefer the live measured height when positive (NoteCard auto-sizes); fall
      // back to el.h. A zero measured height means the DOM has not laid out yet
      // (e.g. first frame or jsdom test environment) — treat it as unmeasured.
      const m = measured?.get(el.id)
      const h = m && m.h > 0 ? m.h : el.h
      return inRect(p, el.x, el.y, el.w, h, t)
    }
    case 'checklist': {
      const m = measured?.get(el.id)
      const h = m && m.h > 0 ? m.h : nominalChecklistHeight(el.items.length)
      return inRect(p, el.x, el.y, el.w, h, t)
    }
    case 'text': {
      const m = measured?.get(el.id)
      // Only use measured dimensions when both are positive — a zero-area measured
      // entry means no layout has occurred yet; fall back to the nominal box.
      const w = m && m.w > 0 ? m.w : TEXT_HIT.w
      const h = m && m.h > 0 ? m.h : TEXT_HIT.h
      return inRect(p, el.x, el.y, w, h, t)
    }
    case 'arrow':
      return nearArrow(el, p, t)
    case 'stroke':
      return nearStroke(el, p, t)
    // W4: image element — treat as a rect hit (renderer task handles display).
    case 'image':
      return inRect(p, el.x, el.y, el.w, el.h, t)
  }
}
