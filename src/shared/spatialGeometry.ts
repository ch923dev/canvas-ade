/**
 * Shared spatial geometry (spatial-awareness C2) — the ONE definition of "fits" and "on screen"
 * that both sides of the IPC boundary use: MAIN's `canvas://layout` digest reports
 * `fit.zoomToFitAll` / `onScreen`, and the renderer's `fitLayout` packer scores its candidate
 * arrangements, with the same numbers. If the two computed "fits" differently, an agent would
 * read `readable:true` from the digest and then see an unreadable tidy (or the reverse).
 *
 * Pure TypeScript — NO Node / DOM / Electron / renderer imports — because tsconfig.node AND
 * tsconfig.web both compile `src/shared/**`. That is also why the camera constants below are
 * MIRRORED from `src/renderer/src/lib/canvasView.ts` rather than imported; the renderer-side
 * `spatialGeometry.parity.test.ts` pins each mirror to its source so they cannot drift.
 */

/** An axis-aligned world-space rectangle (top-left + size). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Below this camera zoom boards render as LOD placeholders (= `canvasView.LOD_ZOOM`). */
export const READABLE_ZOOM = 0.4
/** Fixed screen-px margin "zoom to fit" leaves on every side (= `canvasView.FIT_FRAME.padding`). */
export const FIT_PADDING_PX = 64
/** "Zoom to fit" never zooms in past this (= `canvasView.FIT_FRAME.maxZoom`). */
export const FIT_MAX_ZOOM = 2
/** The camera's zoom floor — a fit can never zoom out further (= `canvasView.Z_MIN`). */
export const FIT_MIN_ZOOM = 0.1

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * The camera zoom at which `bbox` fits inside `pane` with `FIT_PADDING_PX` on every side —
 * `clamp(min((pane.w - 2P) / bbox.w, (pane.h - 2P) / bbox.h), FIT_MIN_ZOOM, FIT_MAX_ZOOM)`,
 * the same rule React Flow's `fitView(FIT_FRAME)` applies.
 *
 * Degenerate inputs always return a clamp bound, never NaN / Infinity, checked in this order:
 * - any NaN, or a pane no larger than the 2 × padding margin → `FIT_MIN_ZOOM` (nothing fits);
 * - a zero (or negative) bbox side imposes no limit on its axis; both sides zero (an empty
 *   or point-sized bbox) → `FIT_MAX_ZOOM` (it fits at any zoom).
 */
export function fitZoom(bbox: Rect, pane: { w: number; h: number }): number {
  const availW = pane.w - 2 * FIT_PADDING_PX
  const availH = pane.h - 2 * FIT_PADDING_PX
  if (Number.isNaN(availW) || Number.isNaN(availH) || Number.isNaN(bbox.w + bbox.h)) {
    return FIT_MIN_ZOOM
  }
  if (availW <= 0 || availH <= 0) return FIT_MIN_ZOOM
  const zx = bbox.w > 0 ? availW / bbox.w : Infinity
  const zy = bbox.h > 0 ? availH / bbox.h : Infinity
  const z = Math.min(zx, zy)
  // Both axes unconstrained (point bbox, or an infinite pane) — fits at the cap.
  if (!Number.isFinite(z)) return FIT_MAX_ZOOM
  return clamp(z, FIT_MIN_ZOOM, FIT_MAX_ZOOM)
}

/**
 * The world-space rect the camera currently shows. React Flow maps world→screen as
 * `p * zoom + {x, y}`, so screen (0,0) is world `(-x / zoom, -y / zoom)` and the pane spans
 * `pane / zoom` world px. A non-finite or sub-floor zoom is treated as `FIT_MIN_ZOOM` (the
 * camera can never be further out), a non-finite pan as 0 and a negative pane side as 0, so
 * the result is always finite.
 */
export function visibleWorld(
  pane: { w: number; h: number },
  camera: { x: number; y: number; zoom: number }
): Rect {
  const zoom = Number.isFinite(camera.zoom) ? Math.max(FIT_MIN_ZOOM, camera.zoom) : FIT_MIN_ZOOM
  const camX = Number.isFinite(camera.x) ? camera.x : 0
  const camY = Number.isFinite(camera.y) ? camera.y : 0
  const paneW = Number.isFinite(pane.w) ? Math.max(0, pane.w) : 0
  const paneH = Number.isFinite(pane.h) ? Math.max(0, pane.h) : 0
  // Screen (0,0) → world ((0 - x) / zoom, (0 - y) / zoom); `0 - x` (not `-x`) keeps an
  // unpanned camera at +0 rather than -0.
  return { x: (0 - camX) / zoom, y: (0 - camY) / zoom, w: paneW / zoom, h: paneH / zoom }
}

/**
 * True when the two rects' interiors overlap (strict comparisons). Edge-touching rects do NOT
 * intersect — a board flush against the edge of the visible world is not on screen.
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
