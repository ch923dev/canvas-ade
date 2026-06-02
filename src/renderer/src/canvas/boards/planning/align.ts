/**
 * Pure align + distribute math for the Planning whiteboard (W3). Operates on the
 * selection set via the existing bbox/anchor helpers in `elements.ts`, so every
 * kind (note/text/checklist/arrow/stroke) aligns by its BOUNDING BOX — never by a
 * raw top-left (arrows/strokes have none). No React, no store; unit-tested in
 * isolation. Shifts are applied through `shiftElement` so vectors keep their shape.
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { anchors, elementBBox, shiftElement, unionBBox, type BBox, type Measured } from './elements'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeAxis = 'h' | 'v'

const HORIZONTAL_EDGES: readonly AlignEdge[] = ['left', 'centerX', 'right']

/**
 * Align every selected element's `edge` anchor to the selection's union `edge`.
 * Horizontal edges move x only; vertical edges move y only. <2 selected ⇒ no-op
 * (returns the input array by reference, so callers can skip a checkpoint).
 */
export function alignElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  edge: AlignEdge,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = new Set(ids)
  const selected = els.filter((e) => set.has(e.id))
  if (selected.length < 2) return els
  const boxById = new Map<string, BBox>(selected.map((e) => [e.id, elementBBox(e, measured?.get(e.id))]))
  const target = anchors(unionBBox([...boxById.values()]))[edge]
  const horizontal = HORIZONTAL_EDGES.includes(edge)
  return els.map((el) => {
    const box = boxById.get(el.id)
    if (!box) return el
    const delta = target - anchors(box)[edge]
    return horizontal ? shiftElement(el, delta, 0) : shiftElement(el, 0, delta)
  })
}

/**
 * Distribute the selection so the GAPS between successive bounding boxes are equal
 * along the axis. The two extreme elements are pinned; only the interior elements
 * move. <3 selected ⇒ no-op (returns the input array by reference).
 */
export function distributeElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  axis: DistributeAxis,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = new Set(ids)
  const horizontal = axis === 'h'
  const lo = (b: BBox): number => (horizontal ? b.x : b.y)
  const size = (b: BBox): number => (horizontal ? b.w : b.h)
  const items = els
    .filter((e) => set.has(e.id))
    .map((e) => ({ id: e.id, box: elementBBox(e, measured?.get(e.id)) }))
    .sort((p, q) => lo(p.box) - lo(q.box))
  if (items.length < 3) return els
  const first = items[0].box
  const last = items[items.length - 1].box
  const span = lo(last) + size(last) - lo(first)
  const totalSize = items.reduce((s, it) => s + size(it.box), 0)
  const gap = (span - totalSize) / (items.length - 1)
  const shifts = new Map<string, number>()
  let cursor = lo(first) + size(first) + gap
  for (let i = 1; i < items.length - 1; i++) {
    shifts.set(items[i].id, cursor - lo(items[i].box))
    cursor += size(items[i].box) + gap
  }
  return els.map((el) => {
    const s = shifts.get(el.id)
    if (s === undefined) return el
    return horizontal ? shiftElement(el, s, 0) : shiftElement(el, 0, s)
  })
}
