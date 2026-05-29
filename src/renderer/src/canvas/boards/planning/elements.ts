/**
 * Pure factories + immutable mutators for Planning whiteboard elements (no React,
 * no store). The board component wires these to `store.updateBoard(id, { elements
 * })`; keeping the array transforms here makes the CRUD + checklist-toggle logic
 * unit-testable in isolation (`elements.test.ts`).
 *
 * Every element is created at a board-local point (the cursor position mapped via
 * `lib/pen.screenToBoard`). Ids are caller-supplied so these stay deterministic.
 */
import type {
  ArrowElement,
  ChecklistElement,
  ChecklistItem,
  NoteElement,
  NoteTint,
  PlanningElement,
  StrokeElement,
  TextElement
} from '../../../lib/boardSchema'
import { noteRotation, TINT_CYCLE } from './tints'

/** Default sizes for the card-shaped elements (board-local px). */
export const NOTE_SIZE = { w: 156, h: 96 } as const
export const CHECKLIST_W = 240

/**
 * Pick the tint/rotation slot for the next note from the EXISTING notes, choosing
 * the least-used tint (ties → earliest in TINT_CYCLE). Indexing off the live note
 * COUNT (the old behaviour) collides + loses variety after a deletion — drop note
 * A of {A,B,C} and the next note reuses C's tint/tilt (#27). Counting actual tints
 * is stable across deletions and reloads (it reads only persisted note data).
 */
export function nextNoteIndex(els: PlanningElement[]): number {
  const counts = TINT_CYCLE.map(
    (tint) => els.filter((e) => e.kind === 'note' && (e as NoteElement).tint === tint).length
  )
  let best = 0
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] < counts[best]) best = i
  }
  return best
}

/** A new sticky note centred-ish on the drop point, tinted + tilted by index. */
export function makeNote(
  id: string,
  at: { x: number; y: number },
  index: number,
  tint?: NoteTint
): NoteElement {
  return {
    id,
    kind: 'note',
    x: Math.round(at.x - NOTE_SIZE.w / 2),
    y: Math.round(at.y - 20),
    w: NOTE_SIZE.w,
    h: NOTE_SIZE.h,
    tint: tint ?? TINT_CYCLE[index % TINT_CYCLE.length],
    rotation: noteRotation(index),
    text: ''
  }
}

/** A new free-text element anchored at the drop point. */
export function makeText(id: string, at: { x: number; y: number }): TextElement {
  return { id, kind: 'text', x: Math.round(at.x), y: Math.round(at.y), text: '' }
}

/** A new checklist card with one empty starter item. */
export function makeChecklist(
  id: string,
  itemId: string,
  at: { x: number; y: number }
): ChecklistElement {
  return {
    id,
    kind: 'checklist',
    x: Math.round(at.x - CHECKLIST_W / 2),
    y: Math.round(at.y - 16),
    w: CHECKLIST_W,
    h: 0, // grows with content; height is intrinsic, not enforced
    title: 'Checklist',
    items: [{ id: itemId, label: '', done: false }]
  }
}

/** A zero-length arrow seed (the drag updates `x2/y2` until pointer-up). */
export function makeArrow(id: string, at: { x: number; y: number }): ArrowElement {
  return { id, kind: 'arrow', x: at.x, y: at.y, x2: at.x, y2: at.y }
}

/** A freehand stroke from a flat board-local point list. */
export function makeStroke(id: string, points: number[]): StrokeElement {
  return { id, kind: 'stroke', x: 0, y: 0, points }
}

// ── Immutable array transforms ────────────────────────────────────────────────

/** Replace one element by id with the result of `fn` (no-op if absent). */
export function patchElement<E extends PlanningElement>(
  els: PlanningElement[],
  id: string,
  fn: (el: E) => E
): PlanningElement[] {
  return els.map((el) => (el.id === id ? fn(el as E) : el))
}

/** Remove one element by id. */
export function removeElement(els: PlanningElement[], id: string): PlanningElement[] {
  return els.filter((el) => el.id !== id)
}

/** Move an element to a new board-local top-left. */
export function moveElement(
  els: PlanningElement[],
  id: string,
  x: number,
  y: number
): PlanningElement[] {
  return els.map((el) => (el.id === id ? { ...el, x, y } : el))
}

/**
 * Translate one element by a board-local delta, correctly for EVERY kind so a
 * drag never deforms a vector (#28, #37):
 * - note / text / checklist carry a single top-left → shift x/y.
 * - arrow stores both endpoints (x/y AND x2/y2) → shift both so the bow is
 *   preserved (shifting x/y alone would drag only the tail).
 * - stroke pins its origin at x:0,y:0 and renders `points` in absolute board
 *   space → shift every point pair (and keep x/y in lockstep).
 * No-op if the element is absent. Immutable.
 */
export function translateElement(
  els: PlanningElement[],
  id: string,
  dx: number,
  dy: number
): PlanningElement[] {
  return els.map((el) => {
    if (el.id !== id) return el
    if (el.kind === 'arrow') {
      return { ...el, x: el.x + dx, y: el.y + dy, x2: el.x2 + dx, y2: el.y2 + dy }
    }
    if (el.kind === 'stroke') {
      const points = el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
      return { ...el, x: el.x + dx, y: el.y + dy, points }
    }
    return { ...el, x: el.x + dx, y: el.y + dy }
  })
}

/** Toggle one checklist item's `done` flag (live progress). */
export function toggleItem(
  els: PlanningElement[],
  elementId: string,
  itemId: string
): PlanningElement[] {
  return patchElement<ChecklistElement>(els, elementId, (cl) => ({
    ...cl,
    items: cl.items.map((it) => (it.id === itemId ? { ...it, done: !it.done } : it))
  }))
}

/** Append an empty item to a checklist; `itemId` is the caller-supplied new id. */
export function addItem(
  els: PlanningElement[],
  elementId: string,
  itemId: string
): PlanningElement[] {
  const fresh: ChecklistItem = { id: itemId, label: '', done: false }
  return patchElement<ChecklistElement>(els, elementId, (cl) => ({
    ...cl,
    items: [...cl.items, fresh]
  }))
}

/** Remove a checklist item by id. */
export function removeItem(
  els: PlanningElement[],
  elementId: string,
  itemId: string
): PlanningElement[] {
  return patchElement<ChecklistElement>(els, elementId, (cl) => ({
    ...cl,
    items: cl.items.filter((it) => it.id !== itemId)
  }))
}

/** Set a checklist item's label. */
export function setItemLabel(
  els: PlanningElement[],
  elementId: string,
  itemId: string,
  label: string
): PlanningElement[] {
  return patchElement<ChecklistElement>(els, elementId, (cl) => ({
    ...cl,
    items: cl.items.map((it) => (it.id === itemId ? { ...it, label } : it))
  }))
}

/** done / total counts + integer percent for a checklist (live progress bar). */
export function checklistProgress(cl: ChecklistElement): {
  done: number
  total: number
  pct: number
} {
  const total = cl.items.length
  const done = cl.items.filter((i) => i.done).length
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) }
}
