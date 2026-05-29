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
