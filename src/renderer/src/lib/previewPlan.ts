/**
 * Pure decision logic for which Browser boards may host a live native view,
 * extracted from BrowserPreviewLayer so the eligibility + cap rules are tested.
 * Geometry is pre-resolved to screen space by the caller (worldRectToScreen).
 */
export interface EligibilityInput {
  zoom: number
  lod: number
  /** Stage top in screen px (pane-local + offset). */
  screenY: number
  /** Pane top in screen px (a native view can't be clipped above the pane). */
  paneTop: number
  /** Stage size in screen px. */
  w: number
  h: number
  /**
   * A board is currently focused (double-click focus / Full view). A native view
   * paints ABOVE all HTML, so the HTML dim-others can't darken it and it would paint
   * over the focused board — when a focus is active, only the focused board may stay
   * live; every other Browser board must demote to its (dimmable) HTML snapshot.
   */
  focusActive?: boolean
  /** This board IS the focused one (only meaningful when `focusActive`). */
  isFocused?: boolean
}

export function isLiveEligible(i: EligibilityInput): boolean {
  // Focus isolation: a non-focused board can never be live while a focus is active
  // (its native view would ignore the HTML dim and paint over the focused board).
  if (i.focusActive && !i.isFocused) return false
  if (i.zoom < i.lod) return false
  if (i.w <= 1 || i.h <= 1) return false
  return i.screenY >= i.paneTop
}

export interface LiveCandidate {
  id: string
  /** Stage left in screen px (pane-local + offset). */
  screenX?: number
  /** Stage top in screen px (pane-local + offset). */
  screenY: number
  w: number
  h: number
}

/** A screen-space point (the viewport centre) for distance-ranking candidates. */
export interface Point {
  x: number
  y: number
}

/**
 * Cap the live set (Bug #8). When a viewport `center` is given, the `cap` candidates
 * whose stage centres are NEAREST that point win the live slots (so panning to a new
 * board makes it live instead of an off-screen earlier one); ties keep first-come
 * order (a stable sort). With no `center` it falls back to first-come (`slice(0, cap)`),
 * preserving the original behaviour. Generic over the geometry the layer carries.
 */
export function pickLive<T extends LiveCandidate>(
  candidates: T[],
  cap: number,
  center?: Point
): string[] {
  if (!center || candidates.length <= cap) {
    return candidates.slice(0, cap).map((c) => c.id)
  }
  const dist = (c: T): number => {
    const cx = (c.screenX ?? 0) + c.w / 2
    const cy = c.screenY + c.h / 2
    return (cx - center.x) ** 2 + (cy - center.y) ** 2
  }
  // Decorate with original index so equal distances keep first-come order (stable).
  return candidates
    .map((c, i) => ({ c, i, d: dist(c) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, cap)
    .map((e) => e.c.id)
}

// ── Static-overlap occlusion (LOT F: #2/#19/#20/#21) ──────────────────────────
// A native WebContentsView paints ABOVE all HTML and can't be clipped/z-ordered, so
// while it sits live at rest it covers an overlapping board's selection ring/handles/
// titlebar (and steals its input), and paints over the app chrome (dock / camera
// cluster / DiagOverlay). The board's HTML *snapshot* DOES respect z-order/clipping,
// so the conservative fix is: demote a live Browser view to its snapshot in exactly
// those at-rest cases. These pure predicates make the decision testable; the layer
// re-runs them whenever `selectedId` or geometry changes (see `applyLiveness`).

/** Axis-aligned bounding box (left/top + width/height), screen-space px. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Strict AABB overlap test (shared edges / zero-area boxes do NOT overlap). Pure.
 * Used both for selected-board overlap (#2/#19/#20) and chrome-zone overlap (#21).
 */
export function rectsOverlap(a: Box, b: Box): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Pane geometry (screen-space, window-content px) the chrome zones derive from. */
export interface PaneBox {
  /** Pane top-left x (paneOffset.x). */
  x: number
  /** Pane top-left y (paneOffset.y). */
  y: number
  /** Pane width in CSS px. */
  w: number
  /** Pane height in CSS px. */
  h: number
}

/**
 * The fixed app-chrome zones (AppChrome.tsx + DiagOverlay.tsx), in screen-space, that
 * a native view must never paint over (#21). Derived from the measured pane so they
 * track window resizes. Two targeted rects (NOT full-width strips) so a non-overlapping
 * live preview is never needlessly demoted:
 *  • dock — top-centre island (AppChrome `top:14`, ~440×40 pill).
 *  • topRight — camera cluster (`top:14 right:16`, ~220×40) + the DiagOverlay below it
 *    (`top:12 right:12`, ~116×80 in dev/diag mode); one rect covers both.
 * Margins are padded for shadow/safety so the band fully clears the chrome.
 */
export function chromeExclusionZones(pane: PaneBox): Box[] {
  const right = pane.x + pane.w
  // Dock: centred horizontally, reserves the top band where the pill sits (moved from
  // bottom→top with the dock relocation, redesign 2026-06-06).
  const dockW = 440
  const dockH = 64
  const dock: Box = {
    x: pane.x + pane.w / 2 - dockW / 2,
    y: pane.y,
    width: dockW,
    height: dockH
  }
  // Top-right: spans the camera cluster + the (taller) DiagOverlay stacked below it.
  const trW = 270
  const trH = 104
  const topRight: Box = {
    x: right - trW,
    y: pane.y,
    width: trW,
    height: trH
  }
  return [dock, topRight]
}

/** Inputs for the static-occlusion demote decision (all screen-space px). */
export interface OcclusionInput {
  /** This Browser board's id. */
  id: string
  /** Its live native device-stage rect (screen-space). */
  stage: Box
  /** The currently selected board's id, or null. */
  selectedId: string | null
  /** The selected board's full screen rect, or null when nothing is selected. */
  selectedRect: Box | null
  /** The fixed chrome zones a native view must not cover (chromeExclusionZones). */
  chromeZones: Box[]
}

/**
 * Decide whether a live Browser view must demote to its (clippable, z-ordered) HTML
 * snapshot at rest. CONSERVATIVE — true only when:
 *  1. (#2/#19/#20) its stage overlaps a DIFFERENT, currently-SELECTED board's rect
 *     (so the board the user is acting on shows its ring/handles/content + takes
 *     input). Selection is the signal the user wants that board interactable; we do
 *     NOT demote on incidental overlap with unselected boards.
 *  2. (#21) its stage overlaps any fixed app-chrome zone (dock / camera / diag).
 * Returns false otherwise → the view stays live. Pure + side-effect free.
 */
export function shouldDemoteForOcclusion(i: OcclusionInput): boolean {
  // #2/#19/#20 — overlaps a different selected board.
  if (i.selectedId !== null && i.selectedId !== i.id && i.selectedRect) {
    if (rectsOverlap(i.stage, i.selectedRect)) return true
  }
  // #21 — overlaps fixed app chrome.
  for (const zone of i.chromeZones) {
    if (rectsOverlap(i.stage, zone)) return true
  }
  return false
}
