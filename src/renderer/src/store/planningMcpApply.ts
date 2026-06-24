import type { PlanningElement, ChecklistItem } from '../lib/boardSchema'
import type { PlanningOp, PlanningOpTint } from '../../../shared/mcpTypes'
import { elementBBox, unionBBox } from '../canvas/boards/planning/elements'

/**
 * Renderer-side materialization of MCP planning-write ops (S2). MAIN validates + sanitizes +
 * caps the agent's content and posts already-clean {@link PlanningOp}s over the command
 * channel; this turns each into a full {@link PlanningElement} — minting ids, laying the batch
 * out as tidy column masonry below the board's existing content, and default sizes. Pure (reads
 * `existing`, returns a fresh array); the applier re-validates the result with
 * `assertPlanningElement` (defense in depth) before it lands.
 *
 * Two layout modes (the placement is computed first, then a single loop materializes each op):
 *
 * - SECTIONED (2a — agent opts in by tagging ≥1 op with a non-empty `section`): one COLUMN PER
 *   SECTION, columns ordered left→right by each section's FIRST APPEARANCE, each section's cards
 *   stacked top-to-bottom in AGENT (array) ORDER. The agent owns the plan's structure — placement
 *   is deterministic, not height-balanced, so it never reads as "random" and there are no
 *   rebalance gaps (ragged column bottoms are expected). Column width = the widest card in that
 *   section (columns are independent).
 * - MASONRY (the default when no op carries a section — older agents + a section-less write): a
 *   batch fills ~√n uniform-width columns (capped at {@link MAX_GRID_COLS}); each card drops into
 *   the currently-shortest column, so the plan reads as a balanced wide board instead of one tall
 *   strip, with no row-alignment gaps when card heights vary wildly.
 *
 * Either way, card heights are ESTIMATED from content (a note's text wraps to many lines; a
 * checklist grows with its item count) so a tall card never overlaps the next card in its column —
 * the actual rendered height (cards self-measure taller than their seed) is biased to leave a small
 * gap, never an overlap. The applier grows the board in BOTH width and height to fit
 * ({@link neededBoardWidth} + {@link neededBoardHeight}).
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
/**
 * Width an MCP-authored checklist materializes at (2c) — wider than the shared 240px `CHECKLIST_W`
 * default so an agent's task labels truncate less in the single-line item `<input>` (true wrap =
 * an `<input>`→`<textarea>` change in `ChecklistCard`, deferred to the cross-board-transfer
 * umbrella). User-created checklists keep the 240px default; this is only the MCP seed width.
 */
const MCP_CHECKLIST_W = 300
const NOTE_LINE_H = 16 // NoteCard text line-height (12px font / 16px line)
const NOTE_PAD_V = 18 // 9px top + 9px bottom
const NOTE_PAD_H = 22 // 11px each side → wrap width = w − 22
const NOTE_CHAR_W = 7 // conservative avg char advance (incl. word-wrap slack) at the 12px font
// Checklist height estimate (2c, tightened). Real interactive render ≈ 77 + 24·L px (header 16 +
// 3px bar + L×16px label LINES + 8px inter-row gaps + footer + 11/12/12 pad; checkbox is 16×16). The
// estimate must stay ≥ the real height — a sibling card is absolutely positioned, so UNDER-counting
// would overlap it — so CHECK_ROW (26) keeps a small per-line cushion over the real 24 (line+gap).
const CHECK_HEAD = 52 // title + progress bar + top pad (≈ real 49, +3 cushion)
const CHECK_ROW = 26 // one wrapped label line + its share of the row gap (≈ real 24, +2 cushion)
const CHECK_FOOT = 36 // "Add item" affordance + bottom pad (folds the last row's absent gap as cushion)
// Horizontal px a checklist row spends on chrome before the label text: card h-pad (12+12) +
// checkbox (16) + row gap (9). The label's wrap width = card width − this, so a long label wraps
// to several lines (W-label-wrap renders item labels in an auto-growing, wrapping textarea).
const CHECK_ROW_INSET = 49
// MCP diagram footprints (2c) — host honors the agent's source orientation. Both are bigger than the
// 280×200 `DIAGRAM_SIZE` user default so an agent flow/ERD is legible; the SVG is vector + object-fit
// contain, so a larger box scales it up crisply (no re-render).
const DIAGRAM_WIDE = { w: 460, h: 300 } as const // landscape: graph LR/RL, erDiagram, gantt, …
const DIAGRAM_TALL = { w: 340, h: 400 } as const // portrait: graph TD/TB/BT, sequence, default

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

/**
 * Estimated rendered height of a checklist (board-local px). Conservative — must stay ≥ the real
 * render so a sibling card stacked below it in a column is never overlapped. Each item contributes
 * `CHECK_ROW` per WRAPPED line: labels render in an auto-growing, wrapping textarea (W-label-wrap),
 * so a long agent label occupies several lines at this card `width`. Counting wrapped lines (not
 * just the item count) keeps the estimate above the real height when labels wrap; it reduces to the
 * single-line `count × CHECK_ROW` when every label fits one line.
 */
function estimateChecklistHeight(items: ReadonlyArray<{ label: string }>, width: number): number {
  const charsPerLine = Math.max(8, Math.floor((width - CHECK_ROW_INSET) / NOTE_CHAR_W))
  let lines = 0
  for (const it of items) lines += Math.max(1, Math.ceil(it.label.length / charsPerLine))
  return CHECK_HEAD + lines * CHECK_ROW + CHECK_FOOT
}

/**
 * Pick an MCP diagram's footprint (2c) from its Mermaid `source` — the host honors the orientation
 * the agent already expressed (it adds no schema field). A horizontally-laid-out diagram (a
 * `graph/flowchart LR|RL`, an `erDiagram`, a `gantt`/`timeline`/`journey`/`gitGraph`, or a
 * `direction LR|RL` in a class/state diagram) reads WIDE; a vertical flow / sequence / unknown reads
 * TALL (the conservative default). `source` is already MAIN-sanitized (control chars stripped).
 */
export function diagramFootprint(source: string): { w: number; h: number } {
  const lower = source.toLowerCase()
  const firstLine =
    lower
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  // Flowchart/graph with an explicit direction: LR/RL ⇒ wide, TB/TD/BT ⇒ tall.
  const flow = firstLine.match(/^(?:graph|flowchart)\s+(tb|td|bt|lr|rl)\b/)
  if (flow) return flow[1] === 'lr' || flow[1] === 'rl' ? DIAGRAM_WIDE : DIAGRAM_TALL
  // Diagram types that lay out horizontally by nature.
  if (/^(erdiagram|gantt|timeline|journey|gitgraph)\b/.test(firstLine)) return DIAGRAM_WIDE
  // class/state diagrams declare direction as a line-level statement (after leading whitespace).
  // Anchor to line-start (multiline) so the phrase inside a node label / comment can't false-match
  // and force a TD/sequence/pie diagram wide.
  if (/^\s*direction\s+(lr|rl)\b/m.test(lower)) return DIAGRAM_WIDE
  return DIAGRAM_TALL
}

/** Board-local layout footprint (width + estimated rendered height) the masonry reserves. */
function opCell(op: PlanningOp): { w: number; h: number } {
  switch (op.kind) {
    case 'note':
    case 'text':
      return { w: MCP_NOTE_W, h: estimateTextHeight(op.text, MCP_NOTE_W) }
    case 'checklist':
      return { w: MCP_CHECKLIST_W, h: estimateChecklistHeight(op.items, MCP_CHECKLIST_W) }
    case 'arrow':
      return { w: Math.max(GAP, Math.abs(op.dx)), h: Math.max(GAP, Math.abs(op.dy)) }
    case 'diagram':
      return diagramFootprint(op.source)
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

/** A board-local top-left where one op's card is placed. */
interface Placement {
  x: number
  y: number
}

/**
 * MASONRY placement (the section-less default): ~√n uniform-width columns; each card (in agent
 * order) drops into the currently-shortest column by its estimated height, so columns stay
 * balanced with no row-alignment gaps. Returns one {@link Placement} per op (index-aligned).
 */
function placeMasonry(
  cells: ReadonlyArray<{ w: number; h: number }>,
  origin: Placement
): Placement[] {
  const cols = gridColumns(cells.length)
  // Uniform column width = the widest card in the batch → column x-positions are known up front
  // (required to place into the shortest column); narrower cards are left-aligned in their column.
  let colW = 0
  for (const c of cells) if (c.w > colW) colW = c.w
  const colBottom = new Array<number>(cols).fill(0) // running height of each column (from origin.y)
  return cells.map((cell) => {
    // Shortest column wins (ties → leftmost) — balances the columns, keeps the top row in order.
    let c = 0
    for (let k = 1; k < cols; k++) if (colBottom[k] < colBottom[c]) c = k
    const x = origin.x + c * (colW + GAP)
    const y = origin.y + colBottom[c]
    colBottom[c] += cell.h + GAP
    return { x, y }
  })
}

/**
 * SECTIONED placement (2a — agent-declared columns): group ops by `section` (key `''` for an
 * un-tagged op), order the columns by each section's FIRST APPEARANCE, and stack each section's
 * cards top-to-bottom in AGENT (array) order. Column width = the widest card in that section, so
 * columns are independent (a diagram-bearing section is wider). Deterministic — no height-balancing
 * → placement reflects the agent's grouping, not column lengths. Returns index-aligned placements.
 */
function placeSectioned(
  ops: PlanningOp[],
  cells: ReadonlyArray<{ w: number; h: number }>,
  origin: Placement
): Placement[] {
  const order: string[] = []
  const groups = new Map<string, number[]>()
  ops.forEach((op, i) => {
    const key = op.section ?? ''
    let g = groups.get(key)
    if (!g) {
      g = []
      groups.set(key, g)
      order.push(key)
    }
    g.push(i)
  })
  const placements = new Array<Placement>(ops.length)
  let colX = origin.x
  for (const key of order) {
    const idxs = groups.get(key) as number[]
    let colW = 0
    for (const i of idxs) if (cells[i].w > colW) colW = cells[i].w
    let y = origin.y
    for (const i of idxs) {
      placements[i] = { x: colX, y }
      y += cells[i].h + GAP
    }
    colX += colW + GAP
  }
  return placements
}

/**
 * Materialize sanitized ops into full elements below `existing`, laid out as agent-declared
 * SECTION columns when any op carries a `section`, else as balanced column MASONRY (see the module
 * doc). Mints ids (board element + checklist items) + default sizes. Notes seed their estimated
 * height (the textarea then auto-grows to the real height); checklists persist `h: 0` like
 * user-created ones (the card self-measures + grows the board on render).
 */
export function materializePlanningOps(
  ops: PlanningOp[],
  existing: PlanningElement[]
): PlanningElement[] {
  const origin = layoutStart(existing)
  const cells = ops.map(opCell)
  // Sectioned the moment the agent tags ANY op with a non-empty section; else the masonry default.
  const sectioned = ops.some((op) => (op.section ?? '').length > 0)
  const placements = sectioned ? placeSectioned(ops, cells, origin) : placeMasonry(cells, origin)

  const out: PlanningElement[] = []
  ops.forEach((op, i) => {
    const { x, y } = placements[i]
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
          w: MCP_CHECKLIST_W,
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
        // Footprint follows the agent's source orientation (2c, see diagramFootprint); cell.w/h
        // already carry it. No svgCache: DiagramCard renders the source via the worker on display.
        out.push({
          id: newId(),
          kind: 'diagram',
          x,
          y,
          w: cell.w,
          h: cell.h,
          source: op.source,
          engine: 'mermaid'
        })
        break
    }
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
    return { x: el.x, y: el.y, w: el.w, h: estimateChecklistHeight(el.items, el.w) }
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
