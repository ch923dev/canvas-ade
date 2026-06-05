/**
 * Pure geometry for drag-to-create board placement (no React/DOM). Used by
 * useBoardPlacement to turn a press→drag→release into a board rect, and to draw the
 * screen-space ghost. Unit-tested like tidyLayout.ts / marquee.ts.
 */
import { MIN_BOARD_SIZE } from './boardSchema'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Normalize two corner points (any order) to a positive-size box. */
export function normalizeBox(ax: number, ay: number, bx: number, by: number): Box {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** Below `threshold` px of displacement on BOTH axes counts as a click, not a drag. */
export function isClickGesture(dx: number, dy: number, threshold = 5): boolean {
  return Math.abs(dx) < threshold && Math.abs(dy) < threshold
}

/**
 * Two WORLD corners → a normalized board rect, clamped up to the minimum board size
 * (grown from the top-left so a sub-min drag never inverts the rect).
 */
export function placementRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  min: { w: number; h: number } = MIN_BOARD_SIZE
): Box {
  const box = normalizeBox(a.x, a.y, b.x, b.y)
  return { x: box.x, y: box.y, w: Math.max(min.w, box.w), h: Math.max(min.h, box.h) }
}
