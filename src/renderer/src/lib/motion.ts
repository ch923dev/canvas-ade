/**
 * Motion primitives (DESIGN.md §9). Single source for the canvas easing curve and
 * the reduced-motion gate so every camera op tells the same story.
 *
 * §9: camera `fit` / `focus` animate `200ms cubic-bezier(.2,.7,.2,1)`; pan/wheel-zoom
 * stay direct (no easing). `prefers-reduced-motion` collapses animated ops to instant.
 * CSS loops (spinner/progress/caret) are dropped in index.css under the same query.
 */

/** Camera-animation duration in ms (DESIGN.md §9 — fit/focus). */
export const CAMERA_MS = 200

/**
 * Cubic-bezier easing solver for the unit curve (0,0)→(1,1) with control points
 * (x1,y1),(x2,y2). Returns ease(t∈[0,1])→[0,1]. Newton-Raphson on x (8 iters) then
 * sample y — ample precision for a 200ms camera tween.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  const solveX = (x: number): number => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-6) return t
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    return t
  }
  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return sampleY(solveX(x))
  }
}

/** The one canvas easing curve (DESIGN.md §9): cubic-bezier(.2,.7,.2,1). */
export const EASE_STANDARD = cubicBezier(0.2, 0.7, 0.2, 1)

/** True when the OS requests reduced motion. Read live (the setting can change). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Wrap React Flow viewport-op options with the §9 camera animation: 200ms +
 * the standard curve, collapsed to instant (duration 0) under reduced-motion.
 * Read at call time so a runtime preference change is honored.
 */
export function cameraAnim<T extends object>(
  opts: T
): T & { duration: number; ease: (t: number) => number } {
  return {
    ...opts,
    duration: prefersReducedMotion() ? 0 : CAMERA_MS,
    ease: EASE_STANDARD
  }
}
