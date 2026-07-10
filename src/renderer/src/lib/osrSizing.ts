/**
 * OSR preview sizing math (pure, no DOM, no React) — OS-3 Phase 1 (M1 sharpness + M4 reflow).
 *
 * The offscreen Browser preview renders a page in a hidden window in MAIN and paints its
 * frames into a DOM `<canvas>`. Two numbers drive how big that offscreen render is:
 *
 *   - **logicalW/H** — the preset's CSS box (Mobile 390×844 / Tablet 834×1112 / Desktop
 *     1280×800). The page is held at this width in MAIN, so a responsive site reflows at the
 *     TRUE breakpoint (M4) instead of always laying out 1280-wide.
 *   - **supersample S** — the on-screen PHYSICAL scale of one logical page px. Rendering the
 *     page at S× and downscaling it into the stage `<canvas>` removes the fixed-bitmap
 *     resample blur (M1). Derivation:
 *
 *         on-screen stage width (physical px) = deviceStageRect.width · camZoom · dpr
 *         logical px across that width          = presetW
 *         ⇒ S = (presetW · deviceFitScale · camZoom · dpr) / presetW
 *             = deviceFitScale · camZoom · dpr
 *
 *     `presetW` cancels OUT of the ratio (it is carried entirely by `logicalW`); the
 *     supersample is just the total on-screen scale of the device stage. `deviceFitScale`
 *     still varies by preset (aspect fit into the same well), so S is NOT identical across
 *     presets — it tracks the actual stage pixel density, which is the point.
 *
 * Mirror of the MAIN render size (`previewOsr.ts`). Kept pure + unit-tested like the other
 * preview-geometry helpers (`previewStageRect.ts`).
 */
import { VIEWPORT_PRESETS, deviceFitScale } from './browserLayout'
import type { BrowserViewport } from './boardSchema'

/** Supersample floor: at S<1 (zoomed far out) we render at native res, not a sub-native
 *  buffer — the LOD/throughput story for far boards is Phase-2 (M2), not a blurrier buffer. */
export const OSR_MIN_SUPERSAMPLE = 1
/** Supersample ceiling for Phase 1: bounds the per-frame buffer cost (S=2 ⇒ 4× pixels).
 *  Lifting it depends on the Phase-2 (M2) CPU/frame-rate gating, not this slice. */
export const OSR_MAX_SUPERSAMPLE = 2
/** Low-RAM (AUDIT §5): cap S at 1× — a 1280 desktop board drops from ~16 MB to ~4 MB per frame,
 *  the 4× cut on the retina-8 GB common case. */
export const OSR_MAX_SUPERSAMPLE_LOW_RAM = 1
/** Quantize S to this step so micro zoom-settles don't churn MAIN's `setContentSize`. */
export const OSR_SUPERSAMPLE_STEP = 0.25

// Low-RAM cap toggle: set ONCE at renderer boot from `window.api.lowRam` (MAIN decides from
// os.totalmem). A settable module flag keeps this file pure + unit-testable — no window access here.
let lowRamMode = false
export function setLowRamMode(on: boolean): void {
  lowRamMode = on
}
/** The effective supersample ceiling for the current mode (2×, or 1× under Low-RAM). */
export function osrMaxSupersample(): number {
  return lowRamMode ? OSR_MAX_SUPERSAMPLE_LOW_RAM : OSR_MAX_SUPERSAMPLE
}

/** The board geometry `computeOsrSize` needs (board world box + responsive preset). */
export interface OsrSizeGeom {
  w: number
  h: number
  viewport: BrowserViewport
}

/** The offscreen render size MAIN applies (`setContentSize(logical·S)+setZoomFactor(S)`). */
export interface OsrSize {
  /** Page CSS width (the preset width → real breakpoint reflow, M4). */
  logicalW: number
  /** Page CSS height. */
  logicalH: number
  /** Supersample factor S (render at S×, downscale into the stage canvas, M1). */
  supersample: number
}

/** Round S to the nearest step, then clamp to [MIN, MAX]. */
export function quantizeSupersample(s: number): number {
  if (!Number.isFinite(s)) return OSR_MIN_SUPERSAMPLE
  const stepped = Math.round(s / OSR_SUPERSAMPLE_STEP) * OSR_SUPERSAMPLE_STEP
  return Math.max(OSR_MIN_SUPERSAMPLE, Math.min(osrMaxSupersample(), stepped))
}

/**
 * The offscreen render size for one Browser board at a settled camera zoom.
 *
 * `settledZoom`/`dpr` are sanitized to positive finite values (a degenerate camera or a
 * 0 DPR falls back to 1 rather than collapsing the surface). `deviceFitScale` can be 0 for
 * a board smaller than its own chrome — that also falls back to 1 (render at native res).
 */
export function computeOsrSize(geom: OsrSizeGeom, settledZoom: number, dpr: number): OsrSize {
  const preset = VIEWPORT_PRESETS[geom.viewport]
  const fit = deviceFitScale(geom.w, geom.h, geom.viewport)
  const safeFit = fit > 0 ? fit : 1
  const safeZoom = Number.isFinite(settledZoom) && settledZoom > 0 ? settledZoom : 1
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return {
    logicalW: preset.w,
    logicalH: preset.h,
    supersample: quantizeSupersample(safeFit * safeZoom * safeDpr)
  }
}

/**
 * PREV-01: the offscreen render size for a board in PORTAL full view.
 *
 * In full view the board's live subtree is portaled OUT of the camera-scaled canvas into the modal
 * host (`useFullView`), so the in-canvas `deviceFitScale × settledZoom` no longer describes how big
 * the preview is on screen — there is no camera transform, and the `.bb-frame` is sized to the
 * preset aspect ratio at (typically) the full window height. Left at the in-canvas size the page
 * stays a small buffer scaled UP → blurry. Here the supersample is the page's true on-screen
 * physical scale: `S = (cssBoxWidth · dpr) / presetW`, where `cssBoxWidth` is the canvas element's
 * laid-out width (read transform-independent via `clientWidth`, so the open/close FLIP animation
 * doesn't perturb it). Logical stays the preset (the page still reflows to the preset width, M4);
 * only the buffer grows — capped at OSR_MAX_SUPERSAMPLE (2×) like the in-canvas path.
 */
export function computeFullViewOsrSize(
  viewport: BrowserViewport,
  cssBoxWidth: number,
  dpr: number
): OsrSize {
  const preset = VIEWPORT_PRESETS[viewport]
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const safeBox = Number.isFinite(cssBoxWidth) && cssBoxWidth > 0 ? cssBoxWidth : preset.w
  return {
    logicalW: preset.w,
    logicalH: preset.h,
    supersample: quantizeSupersample((safeBox * safeDpr) / preset.w)
  }
}
