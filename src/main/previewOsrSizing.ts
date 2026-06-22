/**
 * Pure OSR render-size cores, extracted from previewOsr.ts (file-size doctrine: a NEW concern lands
 * in its own module rather than growing a file at its cap). The render-surface math is `xCore(args,
 * deps)`-style — a structural target is injected — so it is unit-tested without a real `BrowserWindow`
 * (see previewOsr.test.ts). M1 supersample + M4 responsive logical reflow.
 */

/** INITIAL render size — desktop-preset aspect. The live size is driven per-board by
 *  `preview:osrResize` (M1 supersample + M4 responsive logical width); this is just the
 *  size the window is born at before the first resize arrives. */
export const OSR_WIDTH = 1280
export const OSR_HEIGHT = 800

/** A renderer-requested offscreen render size (`computeOsrSize` → `preview:osrResize`). */
export interface OsrSizeRequest {
  /** Page CSS width (the preset width → real breakpoint reflow, M4). */
  logicalW: number
  /** Page CSS height. */
  logicalH: number
  /** Supersample factor S — render at S×, downscale into the stage canvas (M1). */
  supersample: number
}

/** Minimal hidden-window surface `applyOsrSize` drives — so the resize logic is unit-testable
 *  without a real Electron `BrowserWindow`. A `BrowserWindow` satisfies it structurally. */
export interface OsrResizeTarget {
  setContentSize(width: number, height: number): void
  webContents: { setZoomFactor(factor: number): void; invalidate(): void }
}
/** The mutable size state `applyOsrSize` reads/writes (the live `OsrEntry` satisfies it). */
export interface OsrSizeState {
  logicalW: number
  logicalH: number
  superSample: number
  sizeKey?: string
}

/**
 * Clamp/round a renderer-supplied size to a safe, finite render surface. Defense-in-depth:
 * the renderer computes these (clamped to S≤2), but MAIN must never `setContentSize` to a
 * garbage / non-finite / absurd value if the channel is driven directly. Hard-caps S at 4
 * and each logical dimension at 4096px (a sane max render surface — keeps physical = logical·S
 * within GPU texture limits even at S=4).
 */
export function sanitizeOsrSize(args: OsrSizeRequest): OsrSizeRequest {
  const pos = (n: number, fallback: number): number => (Number.isFinite(n) && n > 0 ? n : fallback)
  return {
    logicalW: Math.min(4096, Math.round(pos(args.logicalW, OSR_WIDTH))),
    logicalH: Math.min(4096, Math.round(pos(args.logicalH, OSR_HEIGHT))),
    supersample: Math.max(1, Math.min(4, pos(args.supersample, 1)))
  }
}

/**
 * Apply an offscreen render size (M1 supersample + M4 logical reflow):
 *   - `setContentSize(logical·S)` sets the PHYSICAL surface — a sharper buffer for the stage;
 *   - `setZoomFactor(S)` lays the page out at the LOGICAL width (contentSize/zoom = logical),
 *     so a responsive site reflows at the true breakpoint instead of always at 1280;
 *   - `invalidate()` repaints at the new surface (also clears a stale frame on resume).
 * No-op-guarded via `sizeKey` so a redundant resize never forces a relayout. `superSample` is
 * always updated (applyZoom re-applies it on the next did-finish-load).
 *
 * Returns `true` when the surface ACTUALLY changed (so the caller can schedule a settle-catching
 * follow-up invalidate — an idle page re-renders asynchronously after a large size jump like a
 * full-view enter, and the single synchronous invalidate above can capture the surface before that
 * re-render lands, leaving the canvas blank until the next resize); `false` on a no-op.
 */
export function applyOsrSize(
  win: OsrResizeTarget,
  state: OsrSizeState,
  size: OsrSizeRequest
): boolean {
  const key = `${size.logicalW}x${size.logicalH}@${size.supersample}`
  state.superSample = size.supersample
  state.logicalW = size.logicalW
  state.logicalH = size.logicalH
  if (state.sizeKey === key) return false // identical surface → skip the relayout
  state.sizeKey = key
  try {
    win.setContentSize(
      Math.round(size.logicalW * size.supersample),
      Math.round(size.logicalH * size.supersample)
    )
    win.webContents.setZoomFactor(size.supersample)
    win.webContents.invalidate()
  } catch {
    /* window gone / not OSR-capable */
  }
  return true
}
