/**
 * Pure width-resize math for the right-edge handle on auto-height Planning cards (notes +
 * checklists — PLAN-05). Kept out of the components so the board-local conversion + min-width
 * clamp are unit-testable without React. Mirrors `diagramResize` but constrained to the X axis:
 * these cards grow their own height from content, so only WIDTH is user-sizable.
 *
 * Coordinate model: the handle drag delta is in SCREEN px; elements store BOARD-LOCAL px.
 * `boardScale` is the board-local→screen ratio (`wellRect.width / wellEl.offsetWidth`, the same
 * factor `screenScale` computes), so the board-local delta is the screen delta ÷ boardScale.
 */

/** Minimum board-local widths (px). Notes are compact; checklists need room for a full row. */
export const NOTE_MIN_W = 120
export const CHECKLIST_MIN_W = 180

/**
 * New board-local width from a right-edge handle drag: start width + (screen dx ÷ boardScale),
 * floored at `min` and rounded to whole px. A non-finite/≤0 boardScale falls back to 1 (treat
 * the drag as 1:1) so a missing well measurement never produces NaN/huge widths.
 */
export function widthFromDrag(
  startW: number,
  screenDx: number,
  boardScale: number,
  min: number
): number {
  const s = Number.isFinite(boardScale) && boardScale > 0 ? boardScale : 1
  return Math.max(min, Math.round(startW + screenDx / s))
}
