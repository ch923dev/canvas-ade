/**
 * Pure align/distribute geometry for the Planning whiteboard selection (W3). No
 * React, no store: operate on board-local element arrays + the W2 bbox/anchor
 * helpers so it is unit-testable in isolation. Locked elements in the selection are
 * never moved. `measured` (live DOM sizes for auto-sized text/checklist) refines the
 * boxes; absent → nominal sizes.
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, anchors, unionBBox, shiftElement, type Measured } from './elements'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeAxis = 'h' | 'v'

function asSet(ids: Iterable<string>): Set<string> {
  return ids instanceof Set ? ids : new Set(ids)
}

/** Align the unlocked selected elements to a shared edge/center. <2 movable → unchanged. */
export function alignElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  edge: AlignEdge,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = asSet(ids)
  const targets = els.filter((el) => set.has(el.id) && !el.locked)
  if (targets.length < 2) return els
  const boxes = targets.map((el) => ({ id: el.id, b: elementBBox(el, measured?.get(el.id)) }))
  const axis: 'x' | 'y' = edge === 'left' || edge === 'centerX' || edge === 'right' ? 'x' : 'y'
  const anchor = (b: (typeof boxes)[number]['b']): number => anchors(b)[edge]

  let target: number
  if (edge === 'left' || edge === 'top') target = Math.min(...boxes.map(({ b }) => anchor(b)))
  else if (edge === 'right' || edge === 'bottom') target = Math.max(...boxes.map(({ b }) => anchor(b)))
  else {
    const u = unionBBox(boxes.map(({ b }) => b))
    target = edge === 'centerX' ? u.x + u.w / 2 : u.y + u.h / 2
  }

  const delta = new Map<string, number>()
  for (const { id, b } of boxes) delta.set(id, Math.round(target - anchor(b)))
  return els.map((el) => {
    const d = delta.get(el.id)
    if (d === undefined || d === 0) return el
    return axis === 'x' ? shiftElement(el, d, 0) : shiftElement(el, 0, d)
  })
}

/**
 * Distribute the unlocked selected elements to equal CENTER spacing along the axis.
 * The extreme (first/last by center) stay pinned; interior elements are evenly
 * spread. <3 movable → unchanged. (Center spacing, not edge-gap — adequate for a
 * sketch surface; edge-gap distribution is intentionally out of scope.)
 */
export function distributeElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  axis: DistributeAxis,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = asSet(ids)
  const movable = els.filter((el) => set.has(el.id) && !el.locked)
  if (movable.length < 3) return els
  const items = movable
    .map((el) => {
      const b = elementBBox(el, measured?.get(el.id))
      return { id: el.id, center: axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2 }
    })
    .sort((p, q) => p.center - q.center)
  const first = items[0].center
  const last = items[items.length - 1].center
  const gap = (last - first) / (items.length - 1)
  const delta = new Map<string, number>()
  items.forEach((it, i) => {
    if (i === 0 || i === items.length - 1) return
    delta.set(it.id, Math.round(first + gap * i - it.center))
  })
  return els.map((el) => {
    const d = delta.get(el.id)
    if (d === undefined || d === 0) return el
    return axis === 'h' ? shiftElement(el, d, 0) : shiftElement(el, 0, d)
  })
}
