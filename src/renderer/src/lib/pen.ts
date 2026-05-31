/**
 * Screen → board-local coordinate mapping for the Planning whiteboard (pure, no
 * React/DOM). The single load-bearing fact (handoff 2.3 / DESIGN.md §7.3): a
 * Planning board's content well lives INSIDE React Flow's viewport transform, so
 * it is already scaled by the camera zoom. A raw screen pointer position must be
 * (1) made relative to the content well's on-screen top-left, then (2) DIVIDED BY
 * the camera zoom to land in the board-local space that whiteboard elements are
 * stored in. Get that wrong and freehand strokes drift away from the cursor as
 * you zoom — hence this is unit-tested in `pen.test.ts`.
 *
 * Board-local space = pixels measured from the content well's top-left corner at
 * zoom 1. It is the same space `NoteElement.x/y`, `StrokeElement.points`, etc.
 * are persisted in, so it stays stable across pan/zoom (the camera only changes
 * how that space is projected to the screen).
 */

/** A screen-space (client) pixel position, e.g. from a PointerEvent. */
export interface ScreenPoint {
  x: number
  y: number
}

/** The content well's on-screen top-left + the live camera zoom. */
export interface ViewMapping {
  /** `getBoundingClientRect().left` of the whiteboard content well. */
  originX: number
  /** `getBoundingClientRect().top` of the whiteboard content well. */
  originY: number
  /** React Flow camera zoom (`useStore((s) => s.transform[2])`). */
  zoom: number
}

/** A point in board-local coordinates (zoom-1 px from the content top-left). */
export interface BoardPoint {
  x: number
  y: number
}

/**
 * Map a screen pointer position to a board-local point: subtract the content
 * well's on-screen origin, then divide by zoom. This is the inverse of how the
 * content is projected (`screen = origin + local * zoom`). A non-finite or
 * non-positive zoom is treated as 1 to avoid producing NaN/Infinity from a
 * transient camera state.
 */
export function screenToBoard(p: ScreenPoint, view: ViewMapping): BoardPoint {
  const z = view.zoom > 0 && Number.isFinite(view.zoom) ? view.zoom : 1
  return {
    x: (p.x - view.originX) / z,
    y: (p.y - view.originY) / z
  }
}

/**
 * Screen↔board scale measured from the well itself: rendered width (getBoundingClientRect,
 * which includes any CSS transform) ÷ layout width (offsetWidth, pre-transform). On the
 * camera-transformed canvas this equals the camera zoom; inside the untransformed full-view
 * modal it is ~1 — so board-local mapping is correct in both modes without a fullView flag.
 * Falls back to `fallbackZoom` when the well isn't laid out yet (offsetWidth 0).
 */
export function screenScale(renderedWidth: number, layoutWidth: number, fallbackZoom = 1): number {
  if (layoutWidth > 0 && renderedWidth > 0) return renderedWidth / layoutWidth
  return fallbackZoom
}

/**
 * Append a board-local point to a flat point list (`[x0, y0, x1, y1, …]`, the
 * `StrokeElement.points` shape). Returns a new array; never mutates the input.
 */
export function pushBoardPoint(points: number[], p: BoardPoint): number[] {
  return [...points, p.x, p.y]
}

/**
 * Flat point list → `[x, y]` pairs (the input shape `perfect-freehand` expects).
 * Trailing odd coordinate (shouldn't happen) is dropped.
 */
export function pointsToPairs(points: number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (let i = 0; i + 1 < points.length; i += 2) {
    pairs.push([points[i], points[i + 1]])
  }
  return pairs
}
