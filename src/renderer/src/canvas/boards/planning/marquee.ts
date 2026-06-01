/**
 * Pure marquee (box-select) geometry for the Planning whiteboard (W2.1). No React/DOM.
 * The SIBLING of erase.ts's point-near hit-test: box-select needs rect-overlaps-bbox
 * (intersect), not point-distance. Unit-tested like elements.test.ts.
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, type BBox, type Measured } from './elements'

/** Normalize two corner points (any order) to a positive-size box. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): BBox {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** Axis-aligned overlap. Touching edges count as a hit (intersect predicate). */
export function rectIntersectsBBox(r: BBox, b: BBox): boolean {
  return r.x <= b.x + b.w && r.x + r.w >= b.x && r.y <= b.y + b.h && r.y + r.h >= b.y
}

/** Ids of every element whose bbox the marquee rect intersects; `measured` refines auto-sized kinds. */
export function marqueeHits(
  els: PlanningElement[],
  rect: BBox,
  measured?: Map<string, Measured>
): string[] {
  return els
    .filter((el) => rectIntersectsBBox(rect, elementBBox(el, measured?.get(el.id))))
    .map((el) => el.id)
}
