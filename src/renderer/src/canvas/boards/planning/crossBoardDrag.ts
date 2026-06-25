/**
 * Pure helpers for the Phase-4 cross-board drag (spec §3.C / §4.3) — the math + the
 * drop-target resolution, lifted out of `usePlanningPointer` so they unit-test without a
 * DOM or the store. No React, no DOM: the hook feeds these screen geometry + the live
 * boards snapshot, and they return board-local placement / a resolved target id.
 *
 * The drop reuses the already-merged transfer engine: `transferElements(source, target,
 * ids, mode, at)` (canvasStore) → `extractForTransfer`/`insertTransferred` (elements.ts).
 * The payload is origin-normalized (its union-bbox top-left sits at 0,0), so `at` is the
 * single translate that re-homes it — and the grab-anchor math below makes the grabbed
 * point land under the cursor in the TARGET board's local space.
 */
import { screenToBoard, screenScale } from '../../../lib/pen'

/** The minimal board shape the drop-target resolution reads (id + type). */
export interface DropBoard {
  id: string
  type: string
}

/**
 * Resolve the planning board a cross-board drag is hovering over, from the
 * `data-planning-well` board id hit-tested under the cursor. Returns the id only when it is
 * a DIFFERENT **planning** board than the source (a valid drop target); null otherwise —
 * the source itself, a stale/missing board, or (defensively) a non-planning board. The
 * caller falls back to the within-board drop on null (spec §3.C / E8).
 */
export function resolveDropTarget(
  wellBoardId: string | null,
  sourceId: string,
  boards: ReadonlyArray<DropBoard>
): string | null {
  if (!wellBoardId || wellBoardId === sourceId) return null
  const b = boards.find((x) => x.id === wellBoardId)
  return b && b.type === 'planning' ? b.id : null
}

/**
 * The grab point's offset from the dragged selection's union top-left, in board-local px
 * (§4.3). Because the transferred payload is origin-normalized, adding this offset back at
 * insert time puts the exact point the user grabbed under the cursor on drop.
 */
export function grabAnchorOffset(
  grab: { x: number; y: number },
  unionTopLeft: { x: number; y: number }
): { x: number; y: number } {
  return { x: grab.x - unionTopLeft.x, y: grab.y - unionTopLeft.y }
}

/**
 * Map a screen cursor into the TARGET board's local space and subtract the grab anchor,
 * yielding the payload top-left `at` for `transferElements` (§4.3). The target's screen↔board
 * scale is measured from the target well itself (rendered width ÷ layout width — equals the
 * camera zoom on-canvas, ~1 in a full-view modal), so the mapping is correct across zooms
 * and view modes. Clamped ≥ 0 so a drop near a board's top-left still lands inside it.
 */
export function dropPlacement(args: {
  /** Screen (client) cursor position at drop. */
  cursor: { x: number; y: number }
  /** Target well's `getBoundingClientRect()` (rendered, post-transform). */
  targetRect: { left: number; top: number; width: number }
  /** Target well's `offsetWidth` (layout width, pre-transform). */
  targetLayoutWidth: number
  /** Camera zoom fallback when the target well isn't laid out yet (offsetWidth 0). */
  fallbackZoom: number
  /** Grab anchor from `grabAnchorOffset` (board-local). */
  grabOffset: { x: number; y: number }
}): { x: number; y: number } {
  const { cursor, targetRect, targetLayoutWidth, fallbackZoom, grabOffset } = args
  const zoom = screenScale(targetRect.width, targetLayoutWidth, fallbackZoom)
  const local = screenToBoard(cursor, {
    originX: targetRect.left,
    originY: targetRect.top,
    zoom
  })
  return { x: Math.max(0, local.x - grabOffset.x), y: Math.max(0, local.y - grabOffset.y) }
}
