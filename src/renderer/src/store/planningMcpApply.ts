import type { PlanningElement, ChecklistItem } from '../lib/boardSchema'
import type { PlanningOp, PlanningOpTint } from '../../../shared/mcpTypes'
import {
  NOTE_SIZE,
  CHECKLIST_W,
  DIAGRAM_SIZE,
  TEXT_NOMINAL,
  nominalChecklistHeight,
  elementBBox,
  unionBBox
} from '../canvas/boards/planning/elements'

/**
 * Renderer-side materialization of MCP planning-write ops (S2). MAIN validates + sanitizes +
 * caps the agent's content and posts already-clean {@link PlanningOp}s over the command
 * channel; this turns each into a full {@link PlanningElement} — minting ids, laying the batch
 * out as a tidy GRID below the board's existing content, and default sizes. Pure (reads
 * `existing`, returns a fresh array); the applier re-validates the result with
 * `assertPlanningElement` (defense in depth) before it lands.
 *
 * GRID, not a column (the layout fix): a batch fills ~√n columns (capped at
 * {@link MAX_GRID_COLS}) in the agent's order, row-major, so a multi-element plan reads
 * left→right, top→bottom as a wide board instead of one tall strip. Columns align (per-column
 * width) and each row is as tall as its tallest card (per-row height) — a tidy table. The
 * applier grows the board in BOTH width and height to fit ({@link neededBoardWidth} +
 * {@link neededBoardHeight}).
 *
 * Geometry helpers (`elementBBox`/`unionBBox`/sizes) are imported from `planning/elements`
 * (read-only) so a materialized element measures + lays out identically to a user-created one.
 */

/**
 * `PlanningOp` / `PlanningOpTint` are the canonical MCP planning-write-op types, defined once in
 * the cross-bundle module `src/shared/mcpTypes.ts` (W1-D / F9) and re-exported here so this
 * module's callers (the unit tests, anything reaching for them via `./planningMcpApply`) keep
 * resolving unchanged. Already sanitized + fully-specified by MAIN (`tint`/`done` required).
 */
export type { PlanningOp, PlanningOpTint }

/**
 * Cumulative cap on total elements one planning board may hold. MAIN caps each BATCH; the
 * renderer enforces this long-term-accretion bound because only it knows the live count. A
 * write that would exceed it is rejected (not truncated) so the agent learns nothing landed.
 */
export const MAX_PLANNING_BOARD_ELEMENTS = 300

const MARGIN = 24
const GAP = 16
/** Board chrome the content sits below (mirrors PlanningBoard.growForChecklist). */
const TITLEBAR_H = 34
const WELL_PAD = 14
/**
 * Max columns the grid packs one batch into. The count is ~√n (so a small batch stays compact
 * and a big plan reads as a wide grid) clamped to this cap so the board never sprawls absurdly
 * wide. A 13-element phase plan lands at 4 columns (ceil(√13)), matching the approved mock.
 */
const MAX_GRID_COLS = 5

function newId(): string {
  return crypto.randomUUID()
}

/** Top-left where this batch's grid begins: below existing content, else a margin. */
function layoutStart(existing: PlanningElement[]): { x: number; y: number } {
  if (existing.length === 0) return { x: MARGIN, y: MARGIN }
  const box = unionBBox(existing.map((e) => elementBBox(e)))
  return { x: Math.round(box.x), y: Math.round(box.y + box.h + GAP) }
}

/** Board-local layout footprint the grid reserves for one op (drives column/row sizing). */
function opCellSize(op: PlanningOp): { w: number; h: number } {
  switch (op.kind) {
    case 'note':
      return { w: NOTE_SIZE.w, h: NOTE_SIZE.h }
    case 'checklist':
      return { w: CHECKLIST_W, h: nominalChecklistHeight(op.items.length) }
    case 'text':
      // Point text (no persisted w/h) — reserve its nominal box so column/board sizing matches
      // what `elementBBox` reports for it (TEXT_NOMINAL); the card refines on measure.
      return { w: TEXT_NOMINAL.w, h: TEXT_NOMINAL.h }
    case 'arrow':
      return { w: Math.max(GAP, Math.abs(op.dx)), h: Math.max(GAP, Math.abs(op.dy)) }
    case 'diagram':
      return { w: DIAGRAM_SIZE.w, h: DIAGRAM_SIZE.h }
  }
}

/** Preferred column count for `n` ops — ~√n, capped at {@link MAX_GRID_COLS}, so a batch reads
 *  as a wide grid (≈4 columns for a multi-phase plan) instead of one tall column. */
function gridColumns(n: number): number {
  if (n <= 1) return 1
  return Math.min(MAX_GRID_COLS, Math.ceil(Math.sqrt(n)))
}

/**
 * Materialize sanitized ops into full elements, laid out as a tidy GRID below `existing`. Mints
 * ids (board element + checklist items), assigns positions + default sizes. The batch fills
 * `gridColumns(n)` columns in the agent's order, row-major; columns align (per-column width)
 * and each row is as tall as its tallest card (per-row height). Checklists persist `h: 0`
 * exactly like user-created ones (the card self-measures + grows on render); the nominal height
 * only sizes the grid row.
 */
export function materializePlanningOps(
  ops: PlanningOp[],
  existing: PlanningElement[]
): PlanningElement[] {
  const origin = layoutStart(existing)
  const cols = gridColumns(ops.length)
  const rows = Math.ceil(ops.length / cols)
  const sizes = ops.map(opCellSize)

  // Per-column widths + per-row heights → a table where columns align and rows are as tall as
  // their tallest card. Order-preserving row-major fill (col = i%cols, row = ⌊i/cols⌋).
  const colW = new Array<number>(cols).fill(0)
  const rowH = new Array<number>(rows).fill(0)
  sizes.forEach((s, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    if (s.w > colW[c]) colW[c] = s.w
    if (s.h > rowH[r]) rowH[r] = s.h
  })
  // Cumulative left/top edges of each column/row from the batch origin.
  const colX = new Array<number>(cols)
  for (let c = 0, x = origin.x; c < cols; x += colW[c] + GAP, c++) colX[c] = x
  const rowY = new Array<number>(rows)
  for (let r = 0, y = origin.y; r < rows; y += rowH[r] + GAP, r++) rowY[r] = y

  const out: PlanningElement[] = []
  ops.forEach((op, i) => {
    const x = colX[i % cols]
    const y = rowY[Math.floor(i / cols)]
    switch (op.kind) {
      case 'note':
        out.push({
          id: newId(),
          kind: 'note',
          x,
          y,
          w: NOTE_SIZE.w,
          h: NOTE_SIZE.h,
          tint: op.tint,
          text: op.text
        })
        break
      case 'checklist': {
        const items: ChecklistItem[] = op.items.map((it) => ({
          id: newId(),
          label: it.label,
          done: it.done
        }))
        out.push({
          id: newId(),
          kind: 'checklist',
          x,
          y,
          w: CHECKLIST_W,
          h: 0,
          title: op.title,
          items
        })
        break
      }
      case 'text':
        out.push({ id: newId(), kind: 'text', x, y, text: op.text })
        break
      case 'arrow':
        out.push({ id: newId(), kind: 'arrow', x, y, x2: x + op.dx, y2: y + op.dy })
        break
      case 'diagram':
        // No svgCache: the DiagramCard renders the source via the worker on display + caches it.
        out.push({
          id: newId(),
          kind: 'diagram',
          x,
          y,
          w: DIAGRAM_SIZE.w,
          h: DIAGRAM_SIZE.h,
          source: op.source,
          engine: 'mermaid'
        })
        break
    }
  })
  return out
}

/**
 * Board height (board-local px) needed to contain all `elements`, mirroring
 * PlanningBoard.growForChecklist (content bottom + titlebar + well padding). 0 for an empty
 * board. The card's own measured-height grow refines this on render; this is the initial fit.
 */
export function neededBoardHeight(elements: PlanningElement[]): number {
  if (elements.length === 0) return 0
  const box = unionBBox(elements.map((e) => elementBBox(e)))
  return Math.ceil(box.y + box.h + TITLEBAR_H + WELL_PAD)
}

/**
 * Board WIDTH (board-local px) needed to contain all `elements` (content right edge + well
 * padding). 0 for an empty board. Pairs with {@link neededBoardHeight} so the planning-write
 * path grows the board to fit the grid in BOTH dimensions — without this a wide batch would be
 * clipped by the well's `overflow:hidden` on the right. The card's measured size refines this
 * on render; this is the initial fit.
 */
export function neededBoardWidth(elements: PlanningElement[]): number {
  if (elements.length === 0) return 0
  const box = unionBBox(elements.map((e) => elementBBox(e)))
  return Math.ceil(box.x + box.w + WELL_PAD)
}
