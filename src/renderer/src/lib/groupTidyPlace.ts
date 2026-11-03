/**
 * Where a PARTIAL tidy lands (spatial I3 — "tidy a group"; pure geometry: no store, no React).
 *
 * The tidy engine (`store/spatialTidy`) arranges the scoped boards — one Named Group, an explicit
 * board list, or what is on screen — in place, anchored at their current top-left, and the
 * arrangement takes whatever room it needs (never clamped to the old box). This module enforces
 * the I3 invariant on that plan: **boards outside the scope never move and are never covered.**
 *
 *  - The footprint (the bbox of every placement at its FINAL size — the engine may resize) is clear
 *    of every outside board ⇒ the plan stands (`relocated: false`).
 *  - Otherwise the WHOLE footprint moves to the nearest clear slot: `freeSlot`'s outward ring search
 *    from the scope's pre-tidy anchor, over the OUTSIDE boards only (the scope's own pre-tidy
 *    positions never block it). Every placement is translated by the same delta, so the
 *    arrangement is kept exactly. A moved footprint also pays the group-outline pad on every side,
 *    so its outline clears even a grouped neighbour's outline (the `FIT_UNIT_GAP > 2 × pad` rule).
 *  - The ring search can run out; the footprint then goes right of every outside board, a spot that
 *    is free by construction. A moved result is always re-verified with `overlapsAny`.
 *
 * "Clear" is the canonical separation predicate (`overlapsAny`: the PLACE_GAP margin, docked
 * terminals ignored) — the spacing every auto-placement keeps, so a group parked at that spacing is
 * not "colliding" and stays put. Deterministic for any input order.
 */
import { freeSlot, overlapsAny, PLACE_GAP } from './freeSlot'
import { MIN_BOARD_SIZE } from './boardDefaults'
import { GROUP_BOX_PAD } from './groupBoxes'
import { isDockedTerminal, type Board } from './boardSchema'
import type { BoardRect } from './boardGeometry'

/** One arranged board (structurally the store's `LayoutPlacement`): w/h only where it is sized. */
export interface ScopedPlacement {
  id: string
  x: number
  y: number
  w?: number
  h?: number
}

export interface PlaceScopedResult {
  /** One placement per scoped board, id-sorted (a board the plan left alone keeps its spot). */
  placements: ScopedPlacement[]
  /** True when the footprint collided and moved to open space. */
  relocated: boolean
  /** The translation every placement got (0 / 0 unless relocated) — the camera follows it. */
  dx: number
  dy: number
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A placement's FINAL size — the same rule `applyPlacements` lands it with. */
function finalSize(p: ScopedPlacement, own: BoardRect): { w: number; h: number } {
  return {
    w: finite(p.w) && p.w > 0 ? Math.max(MIN_BOARD_SIZE.w, p.w) : own.w,
    h: finite(p.h) && p.h > 0 ? Math.max(MIN_BOARD_SIZE.h, p.h) : own.h
  }
}

/**
 * Settle a partial tidy's placements against the boards outside its scope (see the module header).
 *
 * @param placements the engine's arrangement of the scoped boards
 * @param scoped     the scoped boards' CURRENT rects — the size of a placement that carries none,
 *                   and the spot of a scoped board the plan did not place
 * @param outside    every canvas board outside the scope (they never move)
 * @param anchor     the scope's pre-tidy top-left — where the search for open space starts
 */
export function placeScoped(
  placements: readonly ScopedPlacement[],
  scoped: readonly BoardRect[],
  outside: readonly Board[],
  anchor: { x: number; y: number }
): PlaceScopedResult {
  const planned = new Map(placements.map((p) => [p.id, p]))
  const settled: ScopedPlacement[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const own of [...scoped].sort((a, b) => cmpStr(a.id, b.id))) {
    const p = planned.get(own.id) ?? { id: own.id, x: own.x, y: own.y }
    if (!finite(p.x) || !finite(p.y)) continue
    const { w, h } = finalSize(p, own)
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + w)
    maxY = Math.max(maxY, p.y + h)
    settled.push({ ...p })
  }
  const stay: PlaceScopedResult = { placements: settled, relocated: false, dx: 0, dy: 0 }
  if (settled.length === 0) return stay

  const blockers = outside.filter((b) => !isDockedTerminal(b))
  const footprint = { w: maxX - minX, h: maxY - minY }
  if (!overlapsAny(blockers, { x: minX, y: minY }, footprint)) return stay

  // Search with the outline pad around the footprint so a moved group's outline clears too.
  const padded = { w: footprint.w + 2 * GROUP_BOX_PAD, h: footprint.h + 2 * GROUP_BOX_PAD }
  const start = { x: anchor.x - GROUP_BOX_PAD, y: anchor.y - GROUP_BOX_PAD }
  let at = freeSlot(blockers, start, padded)
  if (overlapsAny(blockers, at, padded)) {
    // Exhausted rings: right of every outside board (+ the gap) — free by construction.
    const right = Math.max(...blockers.map((b) => b.x + b.w))
    at = { x: right + PLACE_GAP, y: start.y }
  }
  const dx = at.x + GROUP_BOX_PAD - minX
  const dy = at.y + GROUP_BOX_PAD - minY
  return {
    placements: settled.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    relocated: true,
    dx,
    dy
  }
}
