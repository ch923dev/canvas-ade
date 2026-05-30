/**
 * Camera → bounds math (pure, no DOM, no React).
 *
 * This is the load-bearing transform for native-overlay positioning. A React Flow
 * canvas paints its content under a single CSS transform on `.react-flow__viewport`:
 *
 *     transform: translate(vp.x, vp.y) scale(vp.zoom)   // origin 0 0
 *
 * So a world-space point (wx, wy) maps to a pane-local screen point:
 *
 *     sx = vp.x + wx * vp.zoom
 *     sy = vp.y + wy * vp.zoom
 *
 * and a world-space size scales by `vp.zoom`. Those screen coords are relative to the
 * top-left of the React Flow pane, NOT the window. In this app the pane (`.panel`) sits
 * BELOW the 44px topbar + the tabs row, so the pane's origin is offset within the window.
 * `WebContentsView.setBounds` wants window-content (DIP) coordinates, so we add a
 * `paneOffset` = `panel.getBoundingClientRect()` (its top-left in window CSS px). Compute
 * that once per layout (ResizeObserver on the pane), never per frame.
 *
 * Keep this module pure: the rAF sync loop calls `worldRectToScreen` (cheap, no layout
 * thrash) every frame, `roundRect` to satisfy integer setBounds, and `rectsEqual` to
 * diff-skip IPC when nothing moved.
 */

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * World-space node rect → screen-space rect under a React Flow viewport.
 * React Flow viewport = translate(x,y) scale(zoom) on `.react-flow__viewport`, origin 0 0.
 * paneOffset = the canvas container's top-left in window CSS px. NOT (0,0) in this app:
 * the topbar (44px) + tabs sit above `.panel`, so paneOffset = panel.getBoundingClientRect().
 * Pure: does not mutate `node`, `vp`, or `paneOffset`.
 */
export function worldRectToScreen(node: Rect, vp: Viewport, paneOffset = { x: 0, y: 0 }): Rect {
  return {
    x: paneOffset.x + vp.x + node.x * vp.zoom,
    y: paneOffset.y + vp.y + node.y * vp.zoom,
    width: node.width * vp.zoom,
    height: node.height * vp.zoom
  }
}

/** WebContentsView.setBounds wants integers — round each field. */
export function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  }
}

/** Skip a setBounds IPC when nothing moved (diff-skip for the rAF loop). */
export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Responsive reflow (1-E). A Browser board holds its page at a fixed CSS width W
 * (390 mobile / 834 tablet / 1280 desktop) and scales it to fill the node. The
 * native view's bounds width is the node's screen width (`nodeWorldW * camZoom`);
 * setting `setZoomFactor` to this value makes the page lay out at exactly W CSS px
 * (`bounds.width / zoomFactor === W`), so its media queries fire at the breakpoint —
 * then the whole thing is scaled as a unit by the camera:
 *
 *     zoomFactor = (nodeWorldW / presetW) * camZoom
 *
 * Clamped to Chromium's zoom-factor range [0.25, 5]. Below ~40% camera zoom a board
 * shows a snapshot (detached), so the clamp only bites at extreme zoom-out.
 */
export function fitZoomFactor(nodeWorldW: number, presetW: number, camZoom: number): number {
  const z = (nodeWorldW / presetW) * camZoom
  return Math.min(5, Math.max(0.25, z))
}

/**
 * The consumer applies `setBounds(round(rect))` (integer native pixels) but must keep
 * the documented invariant `bounds.width / zoomFactor === presetW` exactly, so the
 * responsive page lays out at precisely 390/834/1280 CSS px. Deriving the factor from
 * the UN-rounded stage width instead drifts by the ≤0.5px integer-bounds rounding
 * (Bug #20). Derive it from the SAME rounded bounds width that is fed to setBounds:
 *
 *     zoomFactor = clamp(roundedBoundsWidth / presetW)   → bounds.width / zoomFactor === presetW
 *
 * Same [0.25, 5] Chromium clamp as `fitZoomFactor`; in the unclamped (working-zoom)
 * band the invariant holds exactly.
 */
export function fitZoomFactorForBounds(roundedBoundsWidth: number, presetW: number): number {
  return Math.min(5, Math.max(0.25, roundedBoundsWidth / presetW))
}
