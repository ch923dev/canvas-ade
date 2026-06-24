/**
 * Non-overlapping auto-placement for a freshly-added board (pure geometry, no store/React).
 *
 * Extracted from `canvasStore` (file-size doctrine — pure logic lives in `lib/*`): the store's
 * `addBoard`/`spawnGroup` call `freeSlot` to tuck a new board into open space, and share `PLACE_GAP`
 * as the inter-board margin. Tidy mirrors the same gap (`tidyLayout`).
 */
import type { Board } from './boardSchema'

/** Gap (world px) kept between boards when auto-placing a new one. */
export const PLACE_GAP = 28
/** How many expanding rings the free-slot search probes before giving up. */
const PLACE_RINGS = 16
/** Search directions for the outward spiral: right/down/left/up first, then diagonals. */
const RING_DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1]
] as const

/**
 * Find a top-left for a new board of `size` near `at` (the viewport centre) that does
 * NOT overlap — with a PLACE_GAP margin — any board already on the canvas, so a freshly
 * added board never lands on top of and hides an existing one (the canvas stays tidy).
 * Returns `at` when it is already clear; otherwise searches outward in expanding rings
 * (one board-step per ring, nearest direction first) and returns the closest free slot,
 * so the new board tucks into open space beside the existing cluster instead of covering
 * it. Deterministic (no randomness) so undo/redo + persistence stay reproducible.
 */
/**
 * True if a box of `size` at top-left `at` overlaps ANY board (within the PLACE_GAP margin) — the
 * canonical separation predicate `freeSlot` searches with, exported so callers can VERIFY a returned
 * slot is actually clear. `freeSlot`'s exhaustion fallback (all rings probed, none free) returns a
 * non-guaranteed-free position, so the canvas-aware nudge re-checks with this before it moves a board.
 * One predicate = no drift between "is this slot free" here and inside `freeSlot`.
 */
export function overlapsAny(
  boards: Board[],
  at: { x: number; y: number },
  size: { w: number; h: number }
): boolean {
  return boards.some(
    (b) =>
      at.x < b.x + b.w + PLACE_GAP &&
      b.x < at.x + size.w + PLACE_GAP &&
      at.y < b.y + b.h + PLACE_GAP &&
      b.y < at.y + size.h + PLACE_GAP
  )
}

export function freeSlot(
  boards: Board[],
  at: { x: number; y: number },
  size: { w: number; h: number }
): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean => overlapsAny(boards, { x, y }, size)
  if (!overlaps(at.x, at.y)) return at
  const strideX = size.w + PLACE_GAP
  const strideY = size.h + PLACE_GAP
  for (let ring = 1; ring <= PLACE_RINGS; ring++) {
    for (const [dx, dy] of RING_DIRS) {
      const x = at.x + dx * ring * strideX
      const y = at.y + dy * ring * strideY
      if (!overlaps(x, y)) return { x, y }
    }
  }
  return { x: at.x + PLACE_GAP, y: at.y + PLACE_GAP }
}

/**
 * World-space point at the CENTRE of the current viewport — the spawn anchor for a user-initiated
 * board/zone, so it lands where the user is looking instead of a fixed canvas origin. React Flow's
 * transform is `screen = world * zoom + pan`, so the world point under screen-centre `(W/2, H/2)` is
 * `(W/2 - pan.x) / zoom`. Returns `fallback` when there is no viewport yet (fresh project, pre-fit).
 * Pure — the caller passes the live window size; `freeSlot` then nudges off any overlap (e.g. the
 * Command board itself sitting at centre), so the zone tucks in beside it, in view.
 */
export function viewportCenterWorld(
  viewport: { x: number; y: number; zoom: number } | null | undefined,
  screen: { w: number; h: number },
  fallback: { x: number; y: number }
): { x: number; y: number } {
  if (!viewport || viewport.zoom <= 0) return fallback
  return {
    x: (screen.w / 2 - viewport.x) / viewport.zoom,
    y: (screen.h / 2 - viewport.y) / viewport.zoom
  }
}
