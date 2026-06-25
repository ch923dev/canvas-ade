import type { Board, PlanningBoard, PlanningElement } from '../lib/boardSchema'
import {
  extractForTransfer,
  insertTransferred,
  type TransferMode
} from '../canvas/boards/planning/elements'

/**
 * Cross-board element transfer (planning ↔ planning, same canvas — spec §4.2). `'move'`
 * re-homes the selection (removes it from the source); `'copy'` shares a fresh duplicate
 * (the source is left intact). `ids` is the source selection (groups are expanded + locked
 * members are skipped on a move — the engine's lock-precedence); `at` is the board-local
 * top-left where the payload lands (the caller computes placement per §4.3).
 *
 * ONE tracked undo step: `beginChange()` once, then `updateBoard(target)` and — on a move —
 * `updateBoard(source)` coalesce (the first consumes the pending checkpoint, the second adds
 * none), so a single Ctrl+Z restores BOTH boards. No-op guards (non-planning endpoint, a move
 * onto the same board, or an empty payload) return WITHOUT arming a checkpoint (the
 * phantom-undo discipline). Returns the fresh target-side ids for reselection.
 */
export type TransferElements = (
  sourceId: string,
  targetId: string,
  ids: Iterable<string>,
  mode: TransferMode,
  at: { x: number; y: number }
) => { newIds: string[] }

/**
 * The minimal store surface `transferElements` reaches. Structural (not the full `CanvasState`)
 * so this module needs no `canvasStore` import — there is no type cycle, and `get` from the
 * store creator is assignable here.
 */
interface TransferHost {
  boards: Board[]
  beginChange: () => void
  updateBoard: (id: string, patch: { elements: PlanningElement[] }) => void
}

/**
 * Builds the `transferElements` store action over the store's `get` and id factory. Extracted
 * from `canvasStore.ts` to keep that file under the max-lines ratchet; the action body (no-op
 * guards, the Phase-1 extract/insert engine, the one-undo-step orchestration) is unchanged.
 */
export function makeTransferElements(
  get: () => TransferHost,
  newId: () => string
): TransferElements {
  return (sourceId, targetId, ids, mode, at) => {
    const s = get()
    const source = s.boards.find((b) => b.id === sourceId)
    const target = s.boards.find((b) => b.id === targetId)
    // No-op guards (arm NO checkpoint — phantom-undo discipline): both endpoints must be
    // planning boards, and a MOVE onto the same board is a no-op (within-board moves are the
    // drag path, not this). Returning before beginChange() leaves the undo rail untouched.
    if (!source || source.type !== 'planning') return { newIds: [] }
    if (!target || target.type !== 'planning') return { newIds: [] }
    if (mode === 'move' && sourceId === targetId) return { newIds: [] }
    const { payload, remaining } = extractForTransfer(source.elements, ids, mode)
    // Empty payload (nothing selected, or a move whose every member is locked) → no-op.
    if (payload.length === 0) return { newIds: [] }
    const { elements: nextTarget, newIds } = insertTransferred(target.elements, payload, at, newId)
    // ONE undo step (§1.3): beginChange() arms the lazy checkpoint; the FIRST updateBoard
    // consumes it (pushing the pre-transfer snapshot of ALL boards) and the SECOND coalesces
    // (the checkpoint is already spent), so a single Ctrl+Z restores both boards together.
    get().beginChange()
    get().updateBoard(targetId, { elements: nextTarget })
    if (mode === 'move') get().updateBoard(sourceId, { elements: remaining })
    return { newIds }
  }
}

/**
 * The OTHER planning boards on the canvas — every planning board except `sourceId`, in board
 * order. The "Send to board…" picker's destination list (spec §3.A) + the keyboard-paste /
 * cross-board-drop target set all read from this. A pure selector (takes `boards`, returns a
 * filtered slice) so it is unit-testable and usable both reactively
 * (`useCanvasStore((s) => selectOtherPlanningBoards(s.boards, id))`) and imperatively
 * (`selectOtherPlanningBoards(useCanvasStore.getState().boards, id)`).
 */
export function selectOtherPlanningBoards(boards: Board[], sourceId: string): PlanningBoard[] {
  return boards.filter((b): b is PlanningBoard => b.type === 'planning' && b.id !== sourceId)
}
