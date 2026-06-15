/**
 * OS-3 Phase 2 (M2 throughput/CPU gating) — pure decision logic for which offscreen
 * Browser previews should PAINT and which should EXIST.
 *
 * Deliberately self-contained (no DOM, no imports) — like `osrSizing.ts`. The OSR `<canvas>`
 * clips/z-orders like any DOM node, so there is no occlusion demote / focus isolation /
 * chrome-exclusion to compute (the now-deleted native engine needed all that) — OSR liveness
 * is only "is the board on-screen, big enough, and within the cap."
 *
 * The caller (the `useOffscreenLiveness` hook) resolves each board's device-stage rect to
 * SCREEN space (camera + pane offset, via `previewStageRect`) before calling in. This module
 * is the pure, unit-tested core.
 */

/** Axis-aligned rect in screen-space px (left/top + size). */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A screen-space point (the visible-pane centre) for distance-ranking candidates. */
export interface Point {
  x: number
  y: number
}

/**
 * Strict AABB overlap (shared edges / zero-area boxes do NOT overlap). Mirrors
 * `previewPlan.rectsOverlap` semantics but lives here so the OSR path is self-contained.
 */
export function rectsOverlap(a: Box, b: Box): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Inputs for the per-board "should it paint" decision (all screen-space px). */
export interface OsrVisibilityInput {
  /** The board's device-stage rect in screen space. */
  screen: Box
  /** The visible canvas-pane rect in screen space. */
  pane: Box
  /** Current camera zoom. */
  zoom: number
  /** LOD floor — below this the preview freezes (the native snapshot-at-LOD analogue). */
  lod: number
}

/**
 * Is a board visible enough to be worth painting? Unlike the native `isLiveEligible` this
 * needs only INTERSECTION with the pane — a native view can't be clipped above the pane top
 * (`screenY >= paneTop`), but the OSR `<canvas>` clips, so a board half above the pane stays
 * live and paints its visible part. Below LOD or with a degenerate (≤1px) stage → freeze.
 */
export function isOsrVisible(i: OsrVisibilityInput): boolean {
  if (i.zoom < i.lod) return false
  if (i.screen.width <= 1 || i.screen.height <= 1) return false
  return rectsOverlap(i.screen, i.pane)
}

/** One candidate for the MAX_LIVE existence ranking (2B). */
export interface OsrAliveCandidate {
  id: string
  /** Its device-stage rect in screen space (for distance-to-centre ranking). */
  screen: Box
  /** Whether it currently passes `isOsrVisible` (visible boards win alive slots first). */
  visible: boolean
}

export interface OsrAliveInput {
  candidates: OsrAliveCandidate[]
  /** Max concurrent EXISTING offscreen windows (the RAM cap; native `MAX_LIVE` = 4). */
  cap: number
  /** The visible-pane centre — alive slots beyond the visible set go to the nearest boards. */
  center: Point
}

/**
 * Pick which boards' offscreen windows may EXIST under the cap (2B). Ranking:
 *   1. VISIBLE boards first (a board the user can see must always have a live renderer);
 *   2. then NEAREST the pane centre (so panning toward an off-screen board revives it before
 *      a farther one, and headroom under the cap keeps the closest off-screen boards warm);
 *   3. stable ties (original order) so a board on the boundary doesn't flip every settle.
 * Returns the id set that should stay alive; everything else is evicted (window destroyed,
 * last frame frozen on its canvas). Pure + side-effect free.
 */
export function rankOsrAlive(i: OsrAliveInput): Set<string> {
  const cap = Math.max(0, Math.floor(i.cap))
  if (cap === 0) return new Set()
  if (i.candidates.length <= cap) return new Set(i.candidates.map((c) => c.id))
  const dist = (b: Box): number => {
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    return (cx - i.center.x) ** 2 + (cy - i.center.y) ** 2
  }
  const ranked = i.candidates
    .map((c, idx) => ({ c, idx, d: dist(c.screen) }))
    .sort(
      (a, b) =>
        Number(b.c.visible) - Number(a.c.visible) || // visible first
        a.d - b.d || // nearest pane centre
        a.idx - b.idx // stable tie
    )
  return new Set(ranked.slice(0, cap).map((e) => e.c.id))
}
