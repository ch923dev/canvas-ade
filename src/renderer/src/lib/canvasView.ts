/**
 * Canvas view constants + zoom-derived visual helpers (pure, no React/DOM).
 *
 * The camera range, LOD threshold, and grid lattice come from DESIGN.md §5.
 * `gridDotOpacity` fades the dot grid out as the camera zooms past the overview
 * band so the zoomed-out canvas reads clean (DESIGN.md §5: "Grid dot opacity
 * fades out below 30% zoom"). Kept pure so it can be unit-tested and called from
 * a viewport-change subscription without DOM coupling.
 */
import type { FitViewOptions } from '@xyflow/react'

/** Camera zoom range (React Flow minZoom/maxZoom). */
export const Z_MIN = 0.1
export const Z_MAX = 2.5

// ── Camera framing presets (DESIGN.md §5/§8/§9) ───────────────────────────────
// Single source of truth shared by Canvas (keys 1/0, fit-on-load, RF defaults) and
// AppChrome (the camera-cluster buttons) so the two can't drift. Each callsite wraps
// these in `cameraAnim` for the §9 200ms tween (reduced-motion safe).

/**
 * "Zoom to fit" — frame ALL boards with a 64px margin (DESIGN.md §122). `maxZoom: 2`
 * lets a small board/cluster zoom IN to fill the viewport instead of being stranded
 * small at 100%, while staying readable for raster boards (terminal/browser).
 *
 * History: was `{ padding: 0.2, maxZoom: 1 }` — the 0.2 proportional pad is ≈8.3%
 * of the viewport PER SIDE (≈230px on a wide pane), and the 100% cap blocked any
 * fill-in; together they left the large empty margins the design forbids. The 64px
 * fixed pad matches the spec exactly.
 *
 * NOTE: residual slack remains ONLY when the content cluster's aspect ratio differs
 * from the viewport's — that is inherent to aspect-preserving fit (`zoom =
 * min(xZoom, yZoom)`) and cannot be removed by any padding/zoom tweak. Tidy
 * (`tidyLayout`) repacks boards toward the viewport aspect so the subsequent fit
 * actually fills the screen.
 */
export const FIT_FRAME: FitViewOptions = { padding: '64px', maxZoom: 2 }

/** "Reset zoom" (the % button / key 0): recenter content pinned at 100% so a far
 *  pan/zoom can't strand every board off-screen (#41). */
export const RESET_FRAME: FitViewOptions = { padding: '64px', maxZoom: 1, minZoom: 1 }

/** "Overview": frame all boards with extra breathing room (intentionally airier
 *  than fit — a bird's-eye, not a tight crop). Proportional pad scales with the pane.
 *  maxZoom is capped at FIT_FRAME's limit (2) so Overview never frames TIGHTER than
 *  Fit for small clusters (without a cap the flow's Z_MAX 2.5 applies and the
 *  bird's-eye button can zoom in 25% past the tight-crop button). */
export const OVERVIEW_FRAME: FitViewOptions = { padding: 0.3, maxZoom: 1 }

/** Below this camera zoom a board renders as an LOD card (glyph + title + dot). */
export const LOD_ZOOM = 0.4

// ── Settled-zoom snap band + crisp-zoom predicate (terminal raster fix) ────────
// The xterm WebGL canvas is a fixed-dpr bitmap: at any camera zoom ≠ 1 the
// compositor resamples it (blurry), and Chromium's at-rest re-raster rescues DOM
// text but never canvases. See docs/research/2026-06-11-terminal-font-blur.md.
// Two levers ride on these: useZoomSettle snaps a SETTLED zoom inside the band to
// exactly 100% (the working band lands pixel-exact), and useTerminalWebgl holds a
// GL context only at crisp zoom (DOM renderer re-rasters sharp everywhere else).

/** Snap band, asymmetric: a 5% undershoot or 6% overshoot around 100% is almost
 *  never an intentional zoom level, while 0.9 / 1.1 plausibly are. */
export const ZOOM_SNAP_LO = 0.95
export const ZOOM_SNAP_HI = 1.06

/** Snap a SETTLED camera zoom to exactly 1 inside the band; pass-through outside.
 *  Never applied mid-gesture — only after the camera comes to rest. */
export function snapZoom(zoom: number): number {
  return zoom >= ZOOM_SNAP_LO && zoom <= ZOOM_SNAP_HI ? 1 : zoom
}

/** True when a settled zoom renders raster content (the WebGL terminal canvas)
 *  pixel-exact — i.e. the camera scale is 1 within float tolerance. */
export function isCrispZoom(zoom: number): boolean {
  return Math.abs(zoom - 1) < 1e-3
}

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
