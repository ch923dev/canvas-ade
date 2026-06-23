import type { PlanningElement, ChecklistItem } from '../lib/boardSchema'
import type { PlanningOp, PlanningOpTint } from '../../../shared/mcpTypes'
import {
  NOTE_SIZE,
  CHECKLIST_W,
  DIAGRAM_SIZE,
  nominalChecklistHeight,
  elementBBox,
  unionBBox
} from '../canvas/boards/planning/elements'

/**
 * Renderer-side materialization of MCP planning-write ops (S2). MAIN validates + sanitizes +
 * caps the agent's content and posts already-clean {@link PlanningOp}s over the command
 * channel; this turns each into a full {@link PlanningElement} — minting ids, stacking
 * positions vertically below the board's existing content, and default sizes. Pure (reads
 * `existing`, returns a fresh array); the applier re-validates the result with
 * `assertPlanningElement` (defense in depth) before it lands.
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
/** Layout advance for point text (no persisted h); ≈ `TEXT_NOMINAL.h` + breathing room. */
const TEXT_ADVANCE = 28
/** Board chrome the content sits below (mirrors PlanningBoard.growForChecklist). */
const TITLEBAR_H = 34
const WELL_PAD = 14

function newId(): string {
  return crypto.randomUUID()
}

/** Top-left where the next appended block starts: below existing content, else a margin. */
function layoutStart(existing: PlanningElement[]): { x: number; y: number } {
  if (existing.length === 0) return { x: MARGIN, y: MARGIN }
  const box = unionBBox(existing.map((e) => elementBBox(e)))
  return { x: Math.round(box.x), y: Math.round(box.y + box.h + GAP) }
}

/**
 * Materialize sanitized ops into full elements, stacked vertically below `existing`. Mints
 * ids (board element + checklist items), assigns positions + default sizes. Checklists
 * persist `h: 0` exactly like user-created ones (the card self-measures + grows on render);
 * the nominal height only advances the layout cursor.
 */
export function materializePlanningOps(
  ops: PlanningOp[],
  existing: PlanningElement[]
): PlanningElement[] {
  const { x, y: startY } = layoutStart(existing)
  let y = startY
  const out: PlanningElement[] = []
  for (const op of ops) {
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
        y += NOTE_SIZE.h + GAP
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
        y += nominalChecklistHeight(items.length) + GAP
        break
      }
      case 'text':
        out.push({ id: newId(), kind: 'text', x, y, text: op.text })
        y += TEXT_ADVANCE + GAP
        break
      case 'arrow':
        out.push({ id: newId(), kind: 'arrow', x, y, x2: x + op.dx, y2: y + op.dy })
        y += Math.max(GAP, Math.abs(op.dy)) + GAP
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
        y += DIAGRAM_SIZE.h + GAP
        break
    }
  }
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
