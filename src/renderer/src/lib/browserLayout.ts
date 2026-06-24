/**
 * Browser-board device-frame geometry (pure, no DOM, no React).
 *
 * A Browser board is a React Flow node occupying a world-space rect (x, y, w, h).
 * The native `WebContentsView` paints the running localhost app, but a native view
 * CANNOT be clipped/rounded (ADR 0002) — so the rounded device frame, notch, URL
 * bar and titlebar are all HTML chrome drawn AROUND an unrounded native rect. This
 * module computes, in WORLD coordinates, exactly where that native rect sits inside
 * the board, so the preview layer can position the view with `worldRectToScreen`
 * (cameraBounds) without ever measuring the DOM.
 *
 * Why world-space: the whole RF node scales by the camera (`scale(camZoom)`), so a
 * board's interior is measured in its intrinsic world px and scaled as a unit. The
 * device frame is laid out to FIT the preset's aspect ratio inside the content well
 * (titlebar + URL bar removed, a gutter inset), centred, and scaled so the preset's
 * pixel box fills the frame. That scale is the page's responsive trick (cameraBounds
 * `fitZoomFactor`): the page lays out at exactly the preset CSS width W, then the
 * native view is scaled to render at the frame's world size, scaled again by camera.
 *
 * Keep this pure + tested: the rAF preview pump calls `deviceStageRect` every frame.
 */

import type { Rect } from './cameraBounds'
import type { BrowserViewport } from './boardSchema'

/** Title bar height (world px) — mirrors the `--titlebar-h` token (34). */
export const TITLEBAR_H = 34
/** URL/route bar height (world px) — DESIGN.md §7.2 ("compact URL bar"). */
export const URLBAR_H = 30
/** Gutter between the content well and the device frame (world px). */
export const STAGE_PAD = 14
/** Largest the device frame may scale up to (so small presets don't balloon). */
export const MAX_FIT_SCALE = 1.1

/** A responsive preset: the held CSS width/height the page lays out at. */
export interface ViewportPreset {
  /** CSS width the page is held at (drives media queries). */
  w: number
  /** CSS height (drives the device-frame aspect ratio). */
  h: number
  /** Device-frame corner radius (world px before camera scale). */
  radius: number
  /** Show the mobile status-bar notch. */
  notch: boolean
}

/**
 * Viewport presets (DESIGN.md §7.2): Mobile 390×844, Tablet 834×1112, Desktop 1280×800,
 * 1440p (qhd) 2560×1440, 4K (uhd) 3840×2160. The page lays out at the preset CSS width, so a
 * responsive site reflows at the true breakpoint (M4); `qhd`/`uhd` are the wide-desktop tier
 * surfaced behind the viewport-control dropdown (BrowserBoard `ViewportControl`). uhd's 3840
 * width sits under the `sanitizeOsrSize` 4096 logical cap, and the renderer clamps the
 * supersample to ≤2, so the physical render surface stays within GPU texture limits.
 */
export const VIEWPORT_PRESETS: Record<BrowserViewport, ViewportPreset> = {
  mobile: { w: 390, h: 844, radius: 22, notch: true },
  tablet: { w: 834, h: 1112, radius: 12, notch: false },
  desktop: { w: 1280, h: 800, radius: 8, notch: false },
  qhd: { w: 2560, h: 1440, radius: 8, notch: false },
  uhd: { w: 3840, h: 2160, radius: 8, notch: false }
}

/** The content well (below titlebar + URL bar), in board-LOCAL world px. */
export function contentWellRect(boardW: number, boardH: number): Rect {
  const top = TITLEBAR_H + URLBAR_H
  return {
    x: 0,
    y: top,
    width: Math.max(0, boardW),
    height: Math.max(0, boardH - top)
  }
}

/**
 * Scale that fits the preset's aspect box inside the available (gutter-inset) well,
 * capped at {@link MAX_FIT_SCALE}. Mirrors the prototype `DeviceStage` fit. Never
 * negative/zero for a sane board (the caller clamps the well to ≥ 0).
 */
export function deviceFitScale(boardW: number, boardH: number, vp: BrowserViewport): number {
  const well = contentWellRect(boardW, boardH)
  const availW = well.width - STAGE_PAD * 2
  const availH = well.height - STAGE_PAD * 2
  const p = VIEWPORT_PRESETS[vp]
  if (availW <= 0 || availH <= 0) return 0
  return Math.min(availW / p.w, availH / p.h, MAX_FIT_SCALE)
}

/**
 * The device-frame OUTER rect in board-LOCAL world coordinates (top-left relative
 * to the board's own origin): the preset box scaled by {@link deviceFitScale} and
 * centred in the content well.
 */
export function deviceFrameRect(boardW: number, boardH: number, vp: BrowserViewport): Rect {
  const well = contentWellRect(boardW, boardH)
  const p = VIEWPORT_PRESETS[vp]
  const scale = deviceFitScale(boardW, boardH, vp)
  const width = p.w * scale
  const height = p.h * scale
  return {
    x: well.x + (well.width - width) / 2,
    y: well.y + (well.height - height) / 2,
    width,
    height
  }
}

/**
 * The native view's rect in board-LOCAL world coordinates: the device-frame outer
 * rect inset by its 1px border (1 world px each side, so the unrounded native rect
 * tucks just inside the rounded HTML frame and the border reads as a bezel).
 */
export function deviceStageRect(boardW: number, boardH: number, vp: BrowserViewport): Rect {
  const f = deviceFrameRect(boardW, boardH, vp)
  const border = 1
  return {
    x: f.x + border,
    y: f.y + border,
    width: Math.max(0, f.width - border * 2),
    height: Math.max(0, f.height - border * 2)
  }
}

/**
 * Translate a board-local rect into a world-space rect by adding the board's world
 * origin. The preview layer then runs the result through `worldRectToScreen`.
 */
export function toWorldRect(localRect: Rect, boardX: number, boardY: number): Rect {
  return {
    x: localRect.x + boardX,
    y: localRect.y + boardY,
    width: localRect.width,
    height: localRect.height
  }
}
