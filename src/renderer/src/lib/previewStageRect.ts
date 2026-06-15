/**
 * Pure preview screen-geometry: project a Browser board's device-stage rect into screen
 * (window CSS px) space under the current camera. No DOM, no React, no ref closures.
 *
 * Extracted from the deleted `previewGeom.ts` in OS-3 Phase 5C: `stageScreenRect` is the one
 * helper the surviving offscreen path still needs — `useOffscreenLiveness` resolves each
 * board's on-screen rect with it to decide visibility + the MAX_LIVE ranking. (The native
 * manager's `boundsFor`/`zoomFor`/`boundsAndZoom` siblings went with the engine.)
 */
import { worldRectToScreen } from './cameraBounds'
import type { Rect, Viewport } from './cameraBounds'
import { deviceStageRect, toWorldRect } from './browserLayout'
import type { BrowserViewport } from './boardSchema'

/** Minimal per-board geometry (world-space origin + size + responsive preset). The short
 *  `w`/`h` field names mirror the canvas store's `BoardGeom` snapshot. */
export interface PreviewGeom {
  x: number
  y: number
  w: number
  h: number
  viewport: BrowserViewport
}

/** The canvas pane's top-left in window CSS px (added once to translate pane-local → window). */
export interface Offset {
  x: number
  y: number
}

/**
 * The board's device-stage rect in screen (window CSS px) space — RAW / un-rounded.
 *
 * Derives the rect by computing the device-stage rect in board-local coords
 * (`deviceStageRect`), translating it to world space via the board's origin (`toWorldRect`),
 * then projecting it to screen space under the current camera (`worldRectToScreen`). Fractional
 * precision is kept on purpose: the liveness ranking compares viewport distances where integer
 * rounding would distort comparisons.
 */
export function stageScreenRect(g: PreviewGeom, vp: Viewport, paneOffset: Offset): Rect {
  const stage = deviceStageRect(g.w, g.h, g.viewport)
  return worldRectToScreen(toWorldRect(stage, g.x, g.y), vp, paneOffset)
}
