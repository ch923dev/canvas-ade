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
import { noteRotation } from './tints'

/** Default sizes for the card-shaped elements (board-local px). */
export const NOTE_SIZE = { w: 156, h: 96 } as const
export const CHECKLIST_W = 240

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
    tint: tint ?? (['yellow', 'blue', 'green', 'plain'] as NoteTint[])[index % 4],
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
