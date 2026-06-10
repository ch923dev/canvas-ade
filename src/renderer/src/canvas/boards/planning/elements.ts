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
  ImageElement,
  NoteElement,
  NoteTint,
  PlanningElement,
  StrokeElement,
  TextElement
} from '../../../lib/boardSchema'
import { noteRotation, TINT_CYCLE } from './tints'
import { MIN_TEXT_WIDTH_PX, type FontSizeToken } from './textStyle'

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

/** A new free-text element anchored at the drop point. `opts.width` ⇒ area text (wrap box). */
export function makeText(
  id: string,
  at: { x: number; y: number },
  opts?: { width?: number; fontSize?: FontSizeToken }
): TextElement {
  const base: TextElement = { id, kind: 'text', x: Math.round(at.x), y: Math.round(at.y), text: '' }
  if (opts?.fontSize !== undefined) base.fontSize = opts.fontSize
  if (opts?.width !== undefined) {
    // Defense-in-depth: callers already clamp, but guarantee a sane area-text width at the
    // factory too — a finite value of at least MIN_TEXT_WIDTH_PX (the schema validator rejects
    // ≤0 / non-finite on load; this keeps a direct caller from minting one in the first place).
    const w = Math.round(opts.width)
    base.width = Number.isFinite(w) ? Math.max(MIN_TEXT_WIDTH_PX, w) : MIN_TEXT_WIDTH_PX
  }
  return base
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

/** Max longest-side (board-local px) a pasted/dropped image is fit to. */
export const IMAGE_MAX = 360

/** Scale natural dimensions to fit `max` on the longest side (never upscale); floor 16. */
export function fitImageSize(
  natW: number,
  natH: number,
  max = IMAGE_MAX
): { w: number; h: number } {
  if (!(natW > 0) || !(natH > 0)) return { w: max, h: max }
  const scale = Math.min(1, max / Math.max(natW, natH))
  return { w: Math.max(16, Math.round(natW * scale)), h: Math.max(16, Math.round(natH * scale)) }
}

/** A new image element centred on the drop/paste point (top-left like a note). */
export function makeImage(
  id: string,
  at: { x: number; y: number },
  assetId: string,
  w: number,
  h: number
): ImageElement {
  return {
    id,
    kind: 'image',
    x: Math.round(at.x - w / 2),
    y: Math.round(at.y - h / 2),
    w,
    h,
    assetId
  }
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
  return els.map((el) => (el.id === id ? shiftElement(el, dx, dy) : el))
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

// ── Bounding boxes + anchors (W2: marquee selection + snapping) ───────────────

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}
export interface Measured {
  w: number
  h: number
}
export interface Anchors {
  left: number
  centerX: number
  right: number
  top: number
  centerY: number
  bottom: number
}

/** Nominal box for an auto-sized free-text element when no live DOM measurement exists. */
export const TEXT_NOMINAL: Measured = { w: 120, h: 22 }

// Approx ChecklistCard row metrics — single source of truth (erase.ts imports
// nominalChecklistHeight rather than duplicating these). Keep roughly in step with
// ChecklistCard.tsx if its layout changes.
const CHECKLIST_HEADER_H = 30
const CHECKLIST_ROW_H = 24
const CHECKLIST_FOOTER_H = 24

/** Approximate rendered checklist height from its item count (board-local px). */
export function nominalChecklistHeight(itemCount: number): number {
  return CHECKLIST_HEADER_H + itemCount * CHECKLIST_ROW_H + CHECKLIST_FOOTER_H
}

/**
 * Board-local bounding box for any element kind. `measured` (a live DOM size) refines
 * the auto-sized kinds — text has no persisted w/h; checklist persists h:0 and grows.
 * Pure: tests pass `measured` explicitly; the board supplies it from a ref map at runtime.
 * Arrows/strokes have NO single top-left → use the point/endpoint extent (never w/h).
 */
export function elementBBox(el: PlanningElement, measured?: Measured): BBox {
  switch (el.kind) {
    case 'note':
      // Prefer the live measured height when positive (NoteCard auto-sizes its textarea,
      // so el.h is only the initial schema default of 96 — BUG-050). A zero measured
      // height means the DOM has not laid out yet; fall back to el.h in that case.
      return { x: el.x, y: el.y, w: el.w, h: measured && measured.h > 0 ? measured.h : el.h }
    case 'checklist':
      return {
        x: el.x,
        y: el.y,
        w: el.w,
        h: measured?.h ?? nominalChecklistHeight(el.items.length)
      }
    case 'text': {
      const m = measured ?? TEXT_NOMINAL
      return { x: el.x, y: el.y, w: m.w, h: m.h }
    }
    case 'arrow':
      return {
        x: Math.min(el.x, el.x2),
        y: Math.min(el.y, el.y2),
        w: Math.abs(el.x2 - el.x),
        h: Math.abs(el.y2 - el.y)
      }
    case 'stroke': {
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
    // W4: image element — bbox is its explicit w/h (renderer task handles display).
    case 'image':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
  }
}

/** Six alignment anchors (edges + centers) of a box. */
export function anchors(b: BBox): Anchors {
  return {
    left: b.x,
    centerX: b.x + b.w / 2,
    right: b.x + b.w,
    top: b.y,
    centerY: b.y + b.h / 2,
    bottom: b.y + b.h
  }
}

/** Smallest box covering every input box. Empty input → a zero box at the origin. */
export function unionBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Shift one element by a board-local delta, correctly per kind (the shared core of
 * translateElement + translateMany): note/text/checklist move their top-left; arrow
 * moves both endpoints; stroke moves every point pair (and keeps x/y in lockstep).
 */
export function shiftElement<E extends PlanningElement>(el: E, dx: number, dy: number): E {
  if (el.kind === 'arrow') {
    return { ...el, x: el.x + dx, y: el.y + dy, x2: el.x2 + dx, y2: el.y2 + dy }
  }
  if (el.kind === 'stroke') {
    return {
      ...el,
      x: el.x + dx,
      y: el.y + dy,
      points: el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
    }
  }
  return { ...el, x: el.x + dx, y: el.y + dy }
}

/** Translate EVERY element whose id is in `ids` by (dx,dy); others untouched. Immutable. */
export function translateMany(
  els: PlanningElement[],
  ids: Iterable<string>,
  dx: number,
  dy: number
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  return els.map((el) => (set.has(el.id) ? shiftElement(el, dx, dy) : el))
}

// ── D3-B: arrow endpoint editing ────────────────────────────────────────────────

/** Which end of an arrow a transform targets: 'start' = the tail (x/y), 'end' = the head (x2/y2). */
export type ArrowEnd = 'start' | 'end'

/**
 * Move ONE endpoint of an arrow to a new board-local point; the other endpoint is
 * untouched, so the bezier re-bows around the fixed end. No-op (same element refs
 * back) when the id is absent or not an arrow. Immutable. Powers both the live
 * drag preview and the pointer-up commit so the two can never disagree.
 */
export function setArrowEndpoint<E extends PlanningElement>(
  els: E[],
  id: string,
  end: ArrowEnd,
  x: number,
  y: number
): E[] {
  return els.map((el) =>
    el.id === id && el.kind === 'arrow'
      ? end === 'start'
        ? { ...el, x, y }
        : { ...el, x2: x, y2: y }
      : el
  )
}

// ── W3: lock + group + duplicate ───────────────────────────────────────────────

/** The single lock predicate. Absent flag ⇒ unlocked. */
export function isLocked(el: PlanningElement): boolean {
  return el.locked === true
}

/** Drop the `groupId` key from a copy (immutable, key removed not set-undefined). */
function withoutGroup<E extends PlanningElement>(el: E): E {
  if (el.groupId === undefined) return el
  const next = { ...el }
  delete next.groupId
  return next
}

/**
 * Expand a selection to whole groups: for every selected element that has a
 * `groupId`, add all elements sharing that id. Ungrouped ids pass through.
 * Idempotent. Returns a superset of `ids`.
 */
export function expandGroups(els: PlanningElement[], ids: Iterable<string>): Set<string> {
  const set = new Set(ids)
  const groups = new Set<string>()
  for (const el of els) if (set.has(el.id) && el.groupId) groups.add(el.groupId)
  if (groups.size === 0) return set
  for (const el of els) if (el.groupId && groups.has(el.groupId)) set.add(el.id)
  return set
}

/** Assign one fresh `groupId` to every element in `ids`. */
export function groupElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  groupId: string
): PlanningElement[] {
  const set = new Set(ids)
  return els.map((el) => (set.has(el.id) ? { ...el, groupId } : el))
}

/** Clear `groupId` on every element belonging to a group represented in `ids`. */
export function ungroupElements(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = new Set(ids)
  const groups = new Set<string>()
  for (const el of els) if (set.has(el.id) && el.groupId) groups.add(el.groupId)
  return els.map((el) => (el.groupId && groups.has(el.groupId) ? withoutGroup(el) : el))
}

/**
 * Set the tint on every NOTE element in `ids` (D3-A tint picker). Non-note
 * elements and locked notes are skipped. Returns the input array BY REFERENCE
 * when nothing changes (no notes in the selection, all locked, or all already
 * that tint) so `updateBoard`'s reference compare treats it as a true no-op and
 * never consumes the pending undo checkpoint (no phantom step).
 */
export function setNoteTint(
  els: PlanningElement[],
  ids: Iterable<string>,
  tint: NoteTint
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  let changed = false
  const next = els.map((el) => {
    if (el.kind !== 'note' || !set.has(el.id) || isLocked(el) || el.tint === tint) return el
    changed = true
    return { ...el, tint }
  })
  return changed ? next : els
}

/** Set (or remove) the `locked` flag across `ids`. */
export function setLocked(
  els: PlanningElement[],
  ids: Iterable<string>,
  locked: boolean
): PlanningElement[] {
  const set = new Set(ids)
  return els.map((el) => {
    if (!set.has(el.id)) return el
    if (locked) return { ...el, locked: true }
    if (el.locked === undefined) return el
    const next = { ...el }
    delete next.locked
    return next
  })
}

/**
 * Clone every element in `ids` (caller expands groups first), assigning a fresh id
 * per copy and shifting by (dx,dy). Each ORIGINAL group becomes ONE fresh group
 * among the copies. Originals are left untouched. Returns the full new array
 * (originals + copies) plus the copy ids (for reselection).
 */
export function duplicateElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  dx: number,
  dy: number,
  newId: () => string
): { elements: PlanningElement[]; newIds: string[] } {
  const set = new Set(ids)
  const groupRemap = new Map<string, string>()
  const newIds: string[] = []
  const copies: PlanningElement[] = []
  for (const el of els) {
    if (!set.has(el.id)) continue
    const id = newId()
    newIds.push(id)
    let copy = shiftElement({ ...el, id }, dx, dy)
    if (el.groupId) {
      let g = groupRemap.get(el.groupId)
      if (!g) {
        g = newId()
        groupRemap.set(el.groupId, g)
      }
      copy = { ...copy, groupId: g }
    }
    copies.push(copy)
  }
  return { elements: [...els, ...copies], newIds }
}
