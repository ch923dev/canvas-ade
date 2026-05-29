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
