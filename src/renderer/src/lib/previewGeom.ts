/**
 * Preview screen-geometry math (pure, no DOM, no React, no closures over refs).
 *
 * These are the free-function equivalents of the `useCallback`s that live in
 * `usePreviewManager.ts` — `boundsFor`, `zoomFor`, and `stageScreenRect` — plus a
 * combined helper `boundsAndZoom` that avoids computing the rounded bounds twice when
 * both results are needed.
 *
 * All functions are pure: they take (g, vp, paneOffset) by value and return a new
 * object without mutating any argument.
 *
 * Math is intentionally identical to the host callbacks; do not "improve" the
 * formulas — the extraction is behaviour-preserving only.
 */

import { roundRect, worldRectToScreen, fitZoomFactorForBounds } from './cameraBounds'
import type { Rect, Viewport } from './cameraBounds'
import { VIEWPORT_PRESETS, deviceStageRect, toWorldRect } from './browserLayout'
import type { BrowserViewport } from './boardSchema'

export type { Rect, Viewport }

/**
 * Minimal per-board geometry consumed by the preview manager.
 * Matches the `BoardGeom` snapshot extracted from the canvas store.
 */
export interface PreviewGeom {
  /** Board world-space x origin (React Flow node position). */
  x: number
  /** Board world-space y origin. */
  y: number
  /** Board world-space width. */
  w: number
  /** Board world-space height. */
  h: number
  /** Responsive preset applied to this board. */
  viewport: BrowserViewport
}

/**
 * The canvas pane's top-left in window CSS px, passed down from a ResizeObserver.
 * `WebContentsView.setBounds` wants window-content (DIP) coordinates, so the pane
 * offset is added once to translate from pane-local screen space to window space.
 */
export interface Offset {
  x: number
  y: number
}

/**
 * The board's native-view stage rect in screen (window DIP) space, INTEGER-ROUNDED
 * for `WebContentsView.setBounds`.
 *
 * Derives the rect by:
 *   1. Computing the device-stage rect in board-local world coords (`deviceStageRect`).
 *   2. Translating it to world space via the board's origin (`toWorldRect`).
 *   3. Projecting it to screen space under the current camera (`worldRectToScreen`).
 *   4. Rounding each field to an integer (`roundRect`).
 */
export function boundsFor(g: PreviewGeom, vp: Viewport, paneOffset: Offset): Rect {
  const stage = toWorldRect(deviceStageRect(g.w, g.h, g.viewport), g.x, g.y)
  return roundRect(worldRectToScreen(stage, vp, paneOffset))
}

/**
 * Zoom factor that holds the page at the preset CSS width (the responsive trick).
 *
 * Bug #20: derive the factor from the SAME rounded bounds width fed to
 * `WebContentsView.setBounds` (i.e. `boundsFor`), NOT from the un-rounded stage
 * width. Rounding introduces ≤0.5px drift; deriving the zoom from the un-rounded
 * width breaks the `bounds.width / zoomFactor === presetW` invariant and causes the
 * page to lay out at e.g. 389.73 instead of exactly 390 CSS px. Using the rounded
 * width keeps the invariant exact in the unclamped (working-zoom) band.
 *
 * Formula: `clamp(roundedBoundsWidth / presetW, 0.25, 5)`.
 */
export function zoomFor(g: PreviewGeom, vp: Viewport, paneOffset: Offset): number {
  return fitZoomFactorForBounds(boundsFor(g, vp, paneOffset).width, VIEWPORT_PRESETS[g.viewport].w)
}

/**
 * Computes `boundsFor` ONCE and derives `zoomFactor` from that SAME rounded width.
 *
 * This is the perf helper that lets the host call one function instead of two when
 * it needs both results (e.g. in `flushBatch` and `attachBoard`). It is exactly
 * equivalent to `{ bounds: boundsFor(g, vp, off), zoomFactor: zoomFor(g, vp, off) }` —
 * the same rounded width drives both fields, preserving the Bug #20 invariant.
 */
export function boundsAndZoom(
  g: PreviewGeom,
  vp: Viewport,
  paneOffset: Offset
): { bounds: Rect; zoomFactor: number } {
  const bounds = boundsFor(g, vp, paneOffset)
  return {
    bounds,
    zoomFactor: fitZoomFactorForBounds(bounds.width, VIEWPORT_PRESETS[g.viewport].w)
  }
}

/**
 * The board's device-stage rect in screen (window DIP) space — RAW / un-rounded.
 *
 * Used for eligibility checks and live-candidate ranking (viewport-distance), where
 * fractional precision matters and integer rounding would distort comparisons. Does
 * NOT call `roundRect`; callers that need integers should use `boundsFor` instead.
 */
export function stageScreenRect(g: PreviewGeom, vp: Viewport, paneOffset: Offset): Rect {
  const stage = deviceStageRect(g.w, g.h, g.viewport)
  return worldRectToScreen(toWorldRect(stage, g.x, g.y), vp, paneOffset)
}
