/**
 * VENDORED — perfect-freehand v1.2.2 (git tag v1.2.3), MIT. See ./VERSION.md + ./LICENSE.
 * Source: github.com/steveruizok/perfect-freehand packages/perfect-freehand/src/getStrokeRadius.ts
 * Verbatim apart from this header (ADR 0001: vendored, NOT an npm dependency).
 */

/**
 * Compute a radius based on the pressure.
 * @param size
 * @param thinning
 * @param pressure
 * @param easing
 * @internal
 */
export function getStrokeRadius(
  size: number,
  thinning: number,
  pressure: number,
  easing: (t: number) => number = (t) => t
) {
  return size * easing(0.5 - thinning * (0.5 - pressure))
}
