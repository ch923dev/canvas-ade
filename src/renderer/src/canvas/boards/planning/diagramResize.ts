/**
 * Pure corner-resize math for the DiagramCard handle (S4 follow-up). Kept out of the component so
 * the board-local conversion + min-size clamp are unit-testable without React.
 *
 * Coordinate model: the handle drag delta is in SCREEN px; elements are stored in BOARD-LOCAL px.
 * `boardScale` is the board-local→screen ratio (`wellRect.width / wellEl.offsetWidth`, the same
 * factor `screenScale` computes), so the board-local delta is the screen delta ÷ boardScale.
 */

/** Minimum board-local size for a diagram element (half the default 280×200 spawn box). */
export const DIAGRAM_MIN_W = 140
export const DIAGRAM_MIN_H = 100

/**
 * New board-local {w,h} from a bottom-right corner-handle drag: start size + (screen delta ÷
 * boardScale), floored at the minimum and rounded to whole px. A non-finite/≤0 boardScale falls
 * back to 1 (treat the drag as 1:1) so a missing well measurement never produces NaN/huge sizes.
 */
export function resizeFromDrag(
  start: { w: number; h: number },
  screenDelta: { dx: number; dy: number },
  boardScale: number,
  min: { w: number; h: number } = { w: DIAGRAM_MIN_W, h: DIAGRAM_MIN_H }
): { w: number; h: number } {
  const s = Number.isFinite(boardScale) && boardScale > 0 ? boardScale : 1
  return {
    w: Math.max(min.w, Math.round(start.w + screenDelta.dx / s)),
    h: Math.max(min.h, Math.round(start.h + screenDelta.dy / s))
  }
}
