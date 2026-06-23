/**
 * Diagram pan/zoom math (S4 / JD-4) — pure, so the focus-gated zoom on a Diagram element is testable
 * without React. The card only enters this mode when SELECTED (focused): React Flow's `.nowheel`/`.nopan`
 * escape hatches hand the wheel/drag to the card, and these helpers compute the clamped zoom + pan.
 */

export const ZOOM_MIN = 1 // 1 = "fit" (object-fit contain); never zoom out past the card
export const ZOOM_MAX = 6
const WHEEL_STEP = 1.15

/** Clamp a zoom factor into the allowed range. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_MIN
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/** Multiplicative wheel zoom: a wheel-up (deltaY < 0) zooms in, down zooms out, clamped. */
export function wheelZoom(current: number, deltaY: number): number {
  const factor = deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
  return clampZoom(current * factor)
}

/** A discrete zoom step for the −/+ buttons. */
export function stepZoom(current: number, dir: 1 | -1): number {
  return clampZoom(current * (dir > 0 ? WHEEL_STEP : 1 / WHEEL_STEP))
}

export interface Vec2 {
  x: number
  y: number
}

/**
 * Clamp a pan offset so the (center-origin) scaled content can't be dragged past its own edges. At zoom
 * Z the content overflows the viewport by `viewport·(Z−1)` total, i.e. `viewport·(Z−1)/2` per side.
 */
export function clampPan(pan: Vec2, viewport: { w: number; h: number }, zoom: number): Vec2 {
  const maxX = Math.max(0, (viewport.w * (zoom - 1)) / 2)
  const maxY = Math.max(0, (viewport.h * (zoom - 1)) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y))
  }
}
