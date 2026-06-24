import type { PlanningElement, ChecklistItem } from '../lib/boardSchema'
import type { PlanningOp, PlanningOpTint } from '../../../shared/mcpTypes'
import {
  CHECKLIST_W,
  DIAGRAM_SIZE,
  elementBBox,
  unionBBox
} from '../canvas/boards/planning/elements'

/**
 * Renderer-side materialization of MCP planning-write ops (S2). MAIN validates + sanitizes +
 * caps the agent's content and posts already-clean {@link PlanningOp}s over the command
 * channel; this turns each into a full {@link PlanningElement} — minting ids, laying the batch
 * out as tidy column masonry below the board's existing content, and default sizes. Pure (reads
 * `existing`, returns a fresh array); the applier re-validates the result with
 * `assertPlanningElement` (defense in depth) before it lands.
 *
 * MASONRY, not a column (the layout fix): a batch fills ~√n columns (capped at
 * {@link MAX_GRID_COLS}); each card drops into the currently-shortest column, so a multi-element
 * plan reads as a balanced wide board instead of one tall strip — with NO row-alignment gaps when
 * card heights vary wildly (a prose note beside a short checklist). Card heights are ESTIMATED
 * from content (a note's text wraps to many lines; a checklist grows with its item count) so a
 * tall card never overlaps the next card in its column — the actual rendered height (cards
 * self-measure taller than their seed) is biased to leave a small gap, never an overlap. The
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
 * Max columns the masonry packs one batch into. The count is ~√n (so a small batch stays compact
 * and a big plan reads as a wide board) clamped to this cap so the board never sprawls absurdly
 * wide. A 13-element phase plan lands at 4 columns (ceil(√13)), matching the approved mock.
 */
const MAX_GRID_COLS = 5

// ── Card widths + content-height estimates (board-local px) ────────────────────────
// Agent content is prose-heavy. Cards are sized so columns are roughly uniform, and each card's
// rendered height is ESTIMATED from its content so the masonry never overlaps two cards in a
// column. Estimates are biased to slightly OVER-shoot (a small gap is fine; an overlap is not),
// since notes/checklists self-measure a little taller than these seeds on render.
/** Prose-readable width for an agent note/text — wider than the 156px sticky default so a
 *  multi-paragraph note reads in a few lines instead of a tall narrow ribbon. */
const MCP_NOTE_W = 232
const NOTE_LINE_H = 16 // NoteCard text line-height (12px font / 16px line)
const NOTE_PAD_V = 18 // 9px top + 9px bottom
const NOTE_PAD_H = 22 // 11px each side → wrap width = w − 22
const NOTE_CHAR_W = 7 // conservative avg char advance (incl. word-wrap slack) at the 12px font
const CHECK_HEAD = 52 // checklist title + progress bar + top pad
const CHECK_ROW = 38 // one (single-line) item row
const CHECK_FOOT = 36 // "Add item" affordance + bottom pad

function newId(): string {
  return crypto.randomUUID()
}

/** Estimated rendered height of wrapped text at `width` (board-local px). Conservative. */
function estimateTextHeight(text: string, width: number): number {
  const charsPerLine = Math.max(8, Math.floor((width - NOTE_PAD_H) / NOTE_CHAR_W))
  let lines = 0
  for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(para.length / charsPerLine))
  return lines * NOTE_LINE_H + NOTE_PAD_V + 6
}

/** Estimated rendered height of a checklist from its item count (board-local px). Conservative. */
function estimateChecklistHeight(items: number): number {
  return CHECK_HEAD + items * CHECK_ROW + CHECK_FOOT
}

/** Board-local layout footprint (width + estimated rendered height) the masonry reserves. */
function opCell(op: PlanningOp): { w: number; h: number } {
  switch (op.kind) {
    case 'note':
    case 'text':
      return { w: MCP_NOTE_W, h: estimateTextHeight(op.text, MCP_NOTE_W) }
    case 'checklist':
      return { w: CHECKLIST_W, h: estimateChecklistHeight(op.items.length) }
    case 'arrow':
      return { w: Math.max(GAP, Math.abs(op.dx)), h: Math.max(GAP, Math.abs(op.dy)) }
    case 'diagram':
      return { w: DIAGRAM_SIZE.w, h: DIAGRAM_SIZE.h }
  }
}

/** Top-left where this batch's masonry begins: below existing content, else a margin. */
function layoutStart(existing: PlanningElement[]): { x: number; y: number } {
  if (existing.length === 0) return { x: MARGIN, y: MARGIN }
  const box = unionBBox(existing.map((e) => elementLayoutBox(e)))
  return { x: Math.round(box.x), y: Math.round(box.y + box.h + GAP) }
}

/** Preferred column count for `n` ops — ~√n, capped at {@link MAX_GRID_COLS}, so a batch reads
 *  as a wide board (≈4 columns for a multi-phase plan) instead of one tall column. */
function gridColumns(n: number): number {
  if (n <= 1) return 1
  return Math.min(MAX_GRID_COLS, Math.ceil(Math.sqrt(n)))
}

/**
 * Materialize sanitized ops into full elements, laid out as column MASONRY below `existing`.
 * Mints ids (board element + checklist items) + default sizes. Columns are a uniform width (the
 * widest card in the batch) so their x-positions are known up front; each card (in agent order)
 * drops into the currently-shortest column using its ESTIMATED content height — so a tall prose
 * note never overlaps the card beneath it and the columns stay balanced (no row-alignment gaps).
 * Notes seed their estimated height (the textarea then auto-grows to the real height); checklists
 * persist `h: 0` like user-created ones (the card self-measures + grows the board on render).
 */
export function materializePlanningOps(
  ops: PlanningOp[],
  existing: PlanningElement[]
): PlanningElement[] {
  const origin = layoutStart(existing)
  const cols = gridColumns(ops.length)
  const cells = ops.map(opCell)
  // Uniform column width = the widest card in the batch → column x-positions are known up front
  // (required to place into the shortest column); narrower cards are left-aligned in their column.
  let colW = 0
  for (const c of cells) if (c.w > colW) colW = c.w
  const colBottom = new Array<number>(cols).fill(0) // running height of each column (from origin.y)

  const out: PlanningElement[] = []
  ops.forEach((op, i) => {
    // Shortest column wins (ties → leftmost) — balances the columns, keeps the top row in order.
    let c = 0
    for (let k = 1; k < cols; k++) if (colBottom[k] < colBottom[c]) c = k
    const x = origin.x + c * (colW + GAP)
    const y = origin.y + colBottom[c]
    const cell = cells[i]
    switch (op.kind) {
      case 'note':
        out.push({
          id: newId(),
          kind: 'note',
          x,
          y,
          w: MCP_NOTE_W,
          h: cell.h,
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
        // Wrap agent prose to the card width (area text) so a long line can't shoot off the
        // board and break the column — it reads like a note.
        out.push({ id: newId(), kind: 'text', x, y, text: op.text, width: MCP_NOTE_W })
        break
      case 'arrow': {
        // Anchor at the cell's far edge for a negative delta so the arrow body stays inside the
        // reserved column/row (opCell reserves |dx|×|dy| rightward+downward of the origin); else a
        // left/up-pointing arrow would shoot into the preceding column and escape neededBoardWidth.
        const ax = op.dx < 0 ? x + Math.abs(op.dx) : x
        const ay = op.dy < 0 ? y + Math.abs(op.dy) : y
        out.push({ id: newId(), kind: 'arrow', x: ax, y: ay, x2: ax + op.dx, y2: ay + op.dy })
        break
      }
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
    colBottom[c] += cell.h + GAP
  })
  return out
}

/**
 * Layout-aware bounding box for board-sizing — like {@link elementBBox} but using the SAME
 * content-height estimates the masonry lays out with, for the kinds whose `elementBBox` reports
 * a too-small nominal before measurement: a checklist (nominal under-counts its real row height)
 * and an area-text element (`elementBBox` ignores its wrap width). For every other kind it is
 * exactly `elementBBox`. Keeps the board grown tall/wide enough that no card is clipped before
 * the cards self-measure.
 */
function elementLayoutBox(el: PlanningElement): { x: number; y: number; w: number; h: number } {
  if (el.kind === 'checklist') {
    return { x: el.x, y: el.y, w: el.w, h: estimateChecklistHeight(el.items.length) }
  }
  if (el.kind === 'text' && typeof el.width === 'number') {
    return { x: el.x, y: el.y, w: el.width, h: estimateTextHeight(el.text, el.width) }
  }
  return elementBBox(el)
}

/**
 * Board height (board-local px) needed to contain all `elements`, mirroring
 * PlanningBoard.growForChecklist (content bottom + titlebar + well padding). 0 for an empty
 * board. Uses {@link elementLayoutBox} so a freshly-materialized checklist/note seeds a board
 * tall enough not to clip; the card's own measured-height grow refines it on render.
 */
export function neededBoardHeight(elements: PlanningElement[]): number {
  if (elements.length === 0) return 0
  const box = unionBBox(elements.map((e) => elementLayoutBox(e)))
  return Math.ceil(box.y + box.h + TITLEBAR_H + WELL_PAD)
}

/**
 * Board WIDTH (board-local px) needed to contain all `elements` (content right edge + well
 * padding). 0 for an empty board. Pairs with {@link neededBoardHeight} so the planning-write
 * path grows the board to fit the masonry in BOTH dimensions — without this a wide batch would be
 * clipped by the well's `overflow:hidden` on the right.
 */
export function neededBoardWidth(elements: PlanningElement[]): number {
  if (elements.length === 0) return 0
  const box = unionBBox(elements.map((e) => elementLayoutBox(e)))
  return Math.ceil(box.x + box.w + WELL_PAD)
}
