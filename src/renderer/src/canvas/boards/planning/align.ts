/**
 * Align + distribute for the Planning whiteboard (W3). Both operate on the selection
 * via the bbox helpers in `elements.ts` (so every kind aligns by its bounding box, not
 * a raw top-left), and both keep their result INSIDE the board well — never off-board.
 *
 * Align is "align to a BOARD edge + auto-space": it flushes the chosen edge to the
 * board (left/right/center horizontally, top/middle/bottom vertically) AND fans the
 * cards along the cross axis in their current order with a small gap, so two cards on
 * the same row no longer collapse onto each other (the old union-edge align hid one
 * behind another). align-left → a left-flush column; align-top → a top-flush row.
 *
 * No React, no store; unit-tested in isolation. `board` is the well's content size in
 * board-local px (the caller passes the live well offset size).
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, shiftElement, type BBox, type Measured } from './elements'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeAxis = 'h' | 'v'

/** The board well's usable content size in board-local px. */
export interface AlignBoard {
  w: number
  h: number
}

const HORIZONTAL_EDGES: readonly AlignEdge[] = ['left', 'centerX', 'right']
/** Inset from the well edge when flushing to the board. */
export const ALIGN_PAD = 12
/** Minimum gap between packed cards (the no-overlap fan + overflow distribute). */
export const ALIGN_GAP = 14

/**
 * Align the selection to a board edge and fan the cards along the cross axis (current
 * order, ALIGN_GAP between bboxes, no overlap), clamped inside the board well. <2
 * selected ⇒ no-op (returns the input array by reference).
 */
export function alignElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  edge: AlignEdge,
  board: AlignBoard,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = new Set(ids)
  const items = els
    .filter((e) => set.has(e.id))
    .map((e) => ({ el: e, b: elementBBox(e, measured?.get(e.id)) }))
  if (items.length < 2) return els
  const horizontal = HORIZONTAL_EDGES.includes(edge)

  // Primary axis: the aligned edge → a board-relative position for a card of `size`.
  const primaryPos = (size: number): number => {
    if (horizontal) {
      if (edge === 'left') return ALIGN_PAD
      if (edge === 'right') return Math.max(ALIGN_PAD, board.w - ALIGN_PAD - size)
      return Math.max(ALIGN_PAD, Math.round((board.w - size) / 2))
    }
    if (edge === 'top') return ALIGN_PAD
    if (edge === 'bottom') return Math.max(ALIGN_PAD, board.h - ALIGN_PAD - size)
    return Math.max(ALIGN_PAD, Math.round((board.h - size) / 2))
  }

  // Cross axis: fan in current order, clamped into the board.
  const crossLo = (b: BBox): number => (horizontal ? b.y : b.x)
  const crossSize = (b: BBox): number => (horizontal ? b.h : b.w)
  const crossMax = horizontal ? board.h : board.w
  const avail = crossMax - 2 * ALIGN_PAD
  const ordered = [...items].sort((p, q) => crossLo(p.b) - crossLo(q.b))
  const runLength =
    ordered.reduce((sum, o) => sum + crossSize(o.b), 0) + ALIGN_GAP * (ordered.length - 1)
  const crossPos = new Map<string, number>()
  if (runLength <= avail) {
    // Fits: pack with ALIGN_GAP from the group's current start, pulled back to stay in board.
    let start = Math.max(ALIGN_PAD, Math.min(...ordered.map((o) => crossLo(o.b))))
    if (start + runLength > crossMax - ALIGN_PAD) {
      start = Math.max(ALIGN_PAD, crossMax - ALIGN_PAD - runLength)
    }
    let cursor = start
    for (const o of ordered) {
      crossPos.set(o.el.id, cursor)
      cursor += crossSize(o.b) + ALIGN_GAP
    }
  } else {
    // Too big to fit without overlap → spread evenly across [PAD, crossMax-PAD] so the
    // run stays IN BOUNDS (the user's clamp rule), accepting overlap only when the cards
    // are genuinely wider/taller than the board allows.
    const lastSize = crossSize(ordered[ordered.length - 1].b)
    const step = ordered.length > 1 ? Math.max(0, (avail - lastSize) / (ordered.length - 1)) : 0
    ordered.forEach((o, i) => crossPos.set(o.el.id, Math.round(ALIGN_PAD + i * step)))
  }

  return els.map((e) => {
    const it = items.find((x) => x.el.id === e.id)
    if (!it) return e
    const b = it.b
    const newPrimary = primaryPos(horizontal ? b.w : b.h)
    const newCross = crossPos.get(e.id) ?? crossLo(b)
    const dPrimary = newPrimary - (horizontal ? b.x : b.y)
    const dCross = newCross - (horizontal ? b.y : b.x)
    return horizontal ? shiftElement(e, dPrimary, dCross) : shiftElement(e, dCross, dPrimary)
  })
}

/**
 * Distribute the selection so the GAPS between successive bboxes are equal along the
 * axis. Normally the two extreme cards are pinned and the interior spreads. If the
 * cards don't fit between the current endpoints (would overlap → negative gap), they
 * are instead packed from the start edge with ALIGN_GAP and clamped into the board, so
 * distribute never overlaps or clips. <3 selected ⇒ no-op (input returned by reference).
 */
export function distributeElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  axis: DistributeAxis,
  board: AlignBoard,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = new Set(ids)
  const horizontal = axis === 'h'
  const lo = (b: BBox): number => (horizontal ? b.x : b.y)
  const size = (b: BBox): number => (horizontal ? b.w : b.h)
  const items = els
    .filter((e) => set.has(e.id))
    .map((e) => ({ el: e, b: elementBBox(e, measured?.get(e.id)) }))
    .sort((p, q) => lo(p.b) - lo(q.b))
  if (items.length < 3) return els
  const boardMax = horizontal ? board.w : board.h
  const totalSize = items.reduce((sum, o) => sum + size(o.b), 0)
  const first = items[0].b
  const last = items[items.length - 1].b
  const span = lo(last) + size(last) - lo(first)
  const gap = (span - totalSize) / (items.length - 1)

  const shifts = new Map<string, number>()
  if (gap >= 0) {
    // Normal: pin the endpoints, space the interior with the equal gap.
    let cursor = lo(first) + size(first) + gap
    for (let i = 1; i < items.length - 1; i++) {
      shifts.set(items[i].el.id, cursor - lo(items[i].b))
      cursor += size(items[i].b) + gap
    }
  } else {
    // Overflow: cards don't fit between the endpoints → pack from a clamped start.
    const need = totalSize + ALIGN_GAP * (items.length - 1)
    let start = Math.max(ALIGN_PAD, Math.min(lo(first), boardMax - ALIGN_PAD - need))
    if (start < ALIGN_PAD) start = ALIGN_PAD
    let cursor = start
    for (const o of items) {
      shifts.set(o.el.id, cursor - lo(o.b))
      cursor += size(o.b) + ALIGN_GAP
    }
  }

  return els.map((e) => {
    const s = shifts.get(e.id)
    if (s === undefined) return e
    return horizontal ? shiftElement(e, s, 0) : shiftElement(e, 0, s)
  })
}
