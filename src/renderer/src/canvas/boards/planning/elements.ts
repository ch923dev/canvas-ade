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
  DiagramElement,
  FileRefElement,
  ImageElement,
  NoteElement,
  NoteTint,
  PlanningElement,
  StrokeElement,
  TextElement
} from '../../../lib/boardSchema'
import { noteRotation, TINT_CYCLE } from './tints'
import { MIN_TEXT_WIDTH_PX, type FontSizeToken } from './textStyle'
import type { StrokeColorToken, StrokeWidthToken } from './strokeStyle'
// Geometry lives in the unified rail now; `BBox` is used internally by anchors()/unionBBox()
// and `elementBBox` by the transfer engine's origin-normalization.
import { elementBBox, type BBox } from './elementRegistry'

// Re-export the geometry rail's public surface (canonical source = ./elementRegistry) so
// existing `./elements` importers keep their import paths unchanged — behavior-identical (S3).
export { nominalChecklistHeight, TEXT_NOMINAL, type Measured } from './elementRegistry'
export { elementBBox }
export type { BBox }

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

/** Default board-local size for a freshly-placed diagram element. */
export const DIAGRAM_SIZE = { w: 280, h: 200 } as const

/** Starter Mermaid source for a new diagram (the wireframe's Plan → Build → Verify flow). */
export const DIAGRAM_STARTER_SOURCE = 'graph TD\n  A[Plan] --> B[Build]\n  B --> C[Verify]'

/** A new Mermaid diagram element centred on the placement point (top-left like a note). The SVG
 *  cache is absent until the card renders it via the hidden MAIN worker. */
export function makeDiagram(id: string, at: { x: number; y: number }): DiagramElement {
  return {
    id,
    kind: 'diagram',
    x: Math.round(at.x - DIAGRAM_SIZE.w / 2),
    y: Math.round(at.y - DIAGRAM_SIZE.h / 2),
    w: DIAGRAM_SIZE.w,
    h: DIAGRAM_SIZE.h,
    source: DIAGRAM_STARTER_SOURCE,
    engine: 'mermaid'
  }
}

// ── File-reference chip (file-tree S4) ─────────────────────────────────────────

/** Default board-local size for a freshly-dropped file-reference chip. */
export const FILEREF_SIZE = { w: 224, h: 46 } as const

/** Minimum board-local size for a resized file-reference chip (keeps the icon + a sliver of label). */
export const FILEREF_MIN = { w: 120, h: 40 } as const

/**
 * A new file-reference chip centred on the drop point (top-left like a note/image). `path` is the
 * project-relative POSIX path (the `openFileBoard`/`file:*` contract); `label` is the display name
 * (typically the basename). Clicking the rendered chip opens `path` as a File board.
 */
export function makeFileRef(
  id: string,
  at: { x: number; y: number },
  path: string,
  label: string
): FileRefElement {
  return {
    id,
    kind: 'fileref',
    x: Math.round(at.x - FILEREF_SIZE.w / 2),
    y: Math.round(at.y - FILEREF_SIZE.h / 2),
    w: FILEREF_SIZE.w,
    h: FILEREF_SIZE.h,
    path,
    label
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
// `BBox`/`Measured` + `elementBBox` + the nominal sizes (`TEXT_NOMINAL`,
// `nominalChecklistHeight`) now live in the unified geometry rail `./elementRegistry`
// (co-located with `eraseHitTest` so a card-layout change updates both in one place — the
// R4 drift class). They are re-exported at the top of this file so `./elements` import
// paths keep working. The box-algebra helpers (`anchors`, `unionBBox`) stay here.

export interface Anchors {
  left: number
  centerX: number
  right: number
  top: number
  centerY: number
  bottom: number
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

// ── Cross-board transfer engine (Phase 1, pure half of transferElements) ─────────
// One pure transform pair drives all three transfer triggers (picker / copy-paste /
// cross-board drag — spec §4). `extractForTransfer` lifts a selection off the SOURCE
// board into a normalized, source-independent payload; `insertTransferred` materializes
// that payload into a TARGET board with fresh identity. The store action `transferElements`
// (canvasStore.ts) sequences them as one undo step. No schema change — reuses existing kinds
// + the project-scoped content-addressed asset store (an in-project asset ref is a plain
// string copy: §1.1).

/** Re-home (remove from source) vs. share a duplicate (source left intact). */
export type TransferMode = 'copy' | 'move'

/**
 * Lift a selection off a source board for a cross-board transfer (spec §4.1).
 *
 * - `payload`: the **group-expanded** (`expandGroups`) selection, **deep-cloned**
 *   (`structuredClone` → no array/object aliasing back to the source) and **normalized** so
 *   the selection's union-bbox top-left sits at the origin `(0,0)`. Placement is then a single
 *   translate at insert time (§4.3). Element ids + `groupId`s are PRESERVED here — they are
 *   reset on insert. Asset refs (`assetId`/`source`/`svgCache`/`path`) ride along verbatim
 *   (same project → valid references; §1.1).
 * - `remaining`: the source array AFTER the transfer:
 *   - `'copy'` (default): the source is untouched → `remaining` is `els` (same ref → the store
 *     leaves the source board alone, no second undo write).
 *   - `'move'`: source minus the moved ids, applying **lock-precedence** (Q1) — locked members
 *     **stay in source** and are **NOT** in `payload` (a Move never silently re-homes a locked
 *     element, mirroring Delete/Cut). Copy is unaffected: locked elements copy normally.
 *
 * Pure + immutable: the input array and its elements are never mutated.
 */
export function extractForTransfer(
  els: PlanningElement[],
  ids: Iterable<string>,
  mode: TransferMode = 'copy'
): { payload: PlanningElement[]; remaining: PlanningElement[] } {
  const selected = expandGroups(els, ids)
  // What actually moves: the selection, minus locked members on a MOVE (lock-precedence).
  // On a COPY every selected element is taken (locked elements copy normally).
  const isMoving = (el: PlanningElement): boolean =>
    selected.has(el.id) && (mode === 'copy' || !isLocked(el))
  const taken = els.filter(isMoving)
  // Nothing to take (empty selection, or a move whose every member is locked) → empty payload;
  // signal "source unchanged" with the same `els` ref so the store no-ops without arming undo.
  if (taken.length === 0) return { payload: [], remaining: els }
  // Normalize to the origin: subtract the selection's union-bbox top-left. With no live DOM
  // measurement, `elementBBox` uses the nominal sizes — deterministic + unit-testable. `shiftElement`
  // is per-kind correct (arrow shifts both endpoints; stroke shifts every point pair).
  const origin = unionBBox(taken.map((el) => elementBBox(el)))
  const payload = taken.map((el) => shiftElement(structuredClone(el), -origin.x, -origin.y))
  const remaining = mode === 'move' ? els.filter((el) => !isMoving(el)) : els
  return { payload, remaining }
}

/**
 * Materialize an extracted `payload` into a target board's element array (spec §4.1).
 *
 * Each payload element gets a **fresh id** and its `groupId` is **remapped** — every original
 * group becomes ONE fresh group among the inserts (the `duplicateElements` remap logic), so a
 * transferred cluster lands as a cohesive group in the target without colliding with the
 * source's group ids. The whole payload is then translated by `at` (per-kind correct via
 * `shiftElement`) and appended. `targetEls` is never mutated.
 *
 * Each insert is independently deep-cloned (`structuredClone`), so the SAME payload may be
 * inserted repeatedly (paste-twice, later phases) without the inserts aliasing one another.
 * Returns the new element array plus the fresh ids (for reselection in the target).
 */
export function insertTransferred(
  targetEls: PlanningElement[],
  payload: PlanningElement[],
  at: { x: number; y: number },
  newId: () => string
): { elements: PlanningElement[]; newIds: string[] } {
  const groupRemap = new Map<string, string>()
  const newIds: string[] = []
  const inserts: PlanningElement[] = []
  for (const el of payload) {
    const id = newId()
    newIds.push(id)
    let copy = shiftElement({ ...structuredClone(el), id }, at.x, at.y)
    if (el.groupId) {
      let g = groupRemap.get(el.groupId)
      if (!g) {
        g = newId()
        groupRemap.set(el.groupId, g)
      }
      copy = { ...copy, groupId: g }
    }
    inserts.push(copy)
  }
  return { elements: [...targetEls, ...inserts], newIds }
}

// ── P4b: z-order (paint order == array order) + appearance batch setters ─────────
// Paint order IS `elements[]` order — later in the array = drawn on top. These four reorders and the
// three value setters power the inspector's Appearance sub-block. Every one is REF-STABLE on a no-op
// (returns the input `els` by reference when nothing moves/changes) so — like `setNoteTint` — a
// redundant action never consumes the pending undo checkpoint (no phantom step). A LOCKED element
// ignores every inspector edit (mirrors `setNoteTint` skipping locked notes); the caller passes the
// group-expanded selection, and these operate on the unlocked members of it.

/** The selected AND unlocked ids — the set the P4b transforms actually touch. */
function editableSet(els: PlanningElement[], ids: Iterable<string>): Set<string> {
  const want = ids instanceof Set ? ids : new Set(ids)
  const set = new Set<string>()
  for (const el of els) if (want.has(el.id) && !isLocked(el)) set.add(el.id)
  return set
}

/** Same element identities in the same order (per-slot ref compare)? Drives the no-op ref return. */
function sameOrder(a: PlanningElement[], b: PlanningElement[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Move the (unlocked) selected elements to the FRONT — the end of the array = painted last = on top —
 * preserving their relative order and the relative order of the rest. Ref-stable no-op when the
 * selection is already the contiguous tail.
 */
export function bringToFront(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = editableSet(els, ids)
  if (set.size === 0) return els
  const rest = els.filter((el) => !set.has(el.id))
  const sel = els.filter((el) => set.has(el.id))
  const next = [...rest, ...sel]
  return sameOrder(els, next) ? els : next
}

/** Move the (unlocked) selected elements to the BACK (start of the array = painted first = behind). */
export function sendToBack(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = editableSet(els, ids)
  if (set.size === 0) return els
  const sel = els.filter((el) => set.has(el.id))
  const rest = els.filter((el) => !set.has(el.id))
  const next = [...sel, ...rest]
  return sameOrder(els, next) ? els : next
}

/**
 * Raise each (unlocked) selected element ONE step toward the front — past its next unselected
 * neighbour. A contiguous selected block moves forward together. Ref-stable no-op when nothing rises.
 */
export function bringForward(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = editableSet(els, ids)
  if (set.size === 0) return els
  const arr = [...els]
  let changed = false
  // Top-down so a selected block hops its unselected neighbour as a unit without a selected element
  // overtaking another selected element.
  for (let i = arr.length - 2; i >= 0; i--) {
    if (set.has(arr[i].id) && !set.has(arr[i + 1].id)) {
      const tmp = arr[i]
      arr[i] = arr[i + 1]
      arr[i + 1] = tmp
      changed = true
    }
  }
  return changed ? arr : els
}

/** Lower each (unlocked) selected element ONE step toward the back — behind its previous unselected
 *  neighbour. Ref-stable no-op when nothing sinks. */
export function sendBackward(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = editableSet(els, ids)
  if (set.size === 0) return els
  const arr = [...els]
  let changed = false
  for (let i = 1; i < arr.length; i++) {
    if (set.has(arr[i].id) && !set.has(arr[i - 1].id)) {
      const tmp = arr[i]
      arr[i] = arr[i - 1]
      arr[i - 1] = tmp
      changed = true
    }
  }
  return changed ? arr : els
}

/** A line kind carries stroke colour/width (arrow = SVG stroke, pen = perfect-freehand fill). */
function isLineKind(el: PlanningElement): boolean {
  return el.kind === 'arrow' || el.kind === 'stroke'
}

/** Set `opacity` on every (unlocked) selected element (all kinds). Ref-stable when nothing changes. */
export function setOpacity(
  els: PlanningElement[],
  ids: Iterable<string>,
  opacity: number
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  let changed = false
  const next = els.map((el) => {
    if (!set.has(el.id) || isLocked(el) || el.opacity === opacity) return el
    changed = true
    return { ...el, opacity }
  })
  return changed ? next : els
}

/** Set `strokeColor` on every (unlocked) selected LINE element (arrow/pen). Non-line kinds + locked
 *  are skipped. Ref-stable when nothing changes. */
export function setStrokeColor(
  els: PlanningElement[],
  ids: Iterable<string>,
  strokeColor: StrokeColorToken
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  let changed = false
  const next = els.map((el) => {
    if (!set.has(el.id) || isLocked(el) || !isLineKind(el) || el.strokeColor === strokeColor) {
      return el
    }
    changed = true
    return { ...el, strokeColor }
  })
  return changed ? next : els
}

/** Set `strokeWidth` on every (unlocked) selected LINE element (arrow/pen). Ref-stable when unchanged. */
export function setStrokeWidth(
  els: PlanningElement[],
  ids: Iterable<string>,
  strokeWidth: StrokeWidthToken
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  let changed = false
  const next = els.map((el) => {
    if (!set.has(el.id) || isLocked(el) || !isLineKind(el) || el.strokeWidth === strokeWidth) {
      return el
    }
    changed = true
    return { ...el, strokeWidth }
  })
  return changed ? next : els
}
