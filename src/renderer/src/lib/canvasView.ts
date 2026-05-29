/**
 * Canvas view constants + zoom-derived visual helpers (pure, no React/DOM).
 *
 * The camera range, LOD threshold, and grid lattice come from DESIGN.md §5.
 * `gridDotOpacity` fades the dot grid out as the camera zooms past the overview
 * band so the zoomed-out canvas reads clean (DESIGN.md §5: "Grid dot opacity
 * fades out below 30% zoom"). Kept pure so it can be unit-tested and called from
 * a viewport-change subscription without DOM coupling.
 */

/** Camera zoom range (React Flow minZoom/maxZoom). */
export const Z_MIN = 0.1
export const Z_MAX = 2.5

/** Below this camera zoom a board renders as an LOD card (glyph + title + dot). */
export const LOD_ZOOM = 0.4

/** Dot-grid lattice spacing in world px. */
export const GRID_GAP = 24

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** True when the camera is zoomed out far enough that boards should show LOD. */
export function isLod(zoom: number): boolean {
  return zoom < LOD_ZOOM
}

/**
 * Opacity for the dot grid at a given camera zoom. Ramps from a 0.15 floor at
 * heavy zoom-out up to 1 by ~40% zoom, so the lattice fades into the void in the
 * overview band. Matches the prototype curve `clamp((z - 0.18) / 0.22, 0.15, 1)`.
 */
export function gridDotOpacity(zoom: number): number {
  return clamp((zoom - 0.18) / 0.22, 0.15, 1)
}
