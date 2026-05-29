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
}

export function isLiveEligible(i: EligibilityInput): boolean {
  if (i.zoom < i.lod) return false
  if (i.w <= 1 || i.h <= 1) return false
  return i.screenY >= i.paneTop
}

export interface LiveCandidate {
  id: string
  screenY: number
  w: number
  h: number
}

/**
 * Cap the live set (first-come wins, matching the existing slice(0, MAX_LIVE)).
 * Generic over `{ id }` so the layer can pass its board geometry directly.
 */
export function pickLive<T extends { id: string }>(candidates: T[], cap: number): string[] {
  return candidates.slice(0, cap).map((c) => c.id)
}
