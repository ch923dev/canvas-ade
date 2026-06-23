/**
 * Pure in-board snapping (W2.2). Aligns a dragged element's union box to neighbor
 * edges/centers within a BOARD-LOCAL tolerance, returning the delta correction to ADD
 * to the raw drag delta + the guide lines to draw. Zoom-stable because every input is
 * board-local px (the caller maps screen→board before calling). No React/DOM.
 */
import { anchors, type Anchors, type BBox } from './elements'

/** A guide line. `axis:'x'` = a VERTICAL line at x=`at` (snapping the X coordinate). */
export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}
export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

/**
 * A static neighbor with its anchors precomputed. The static set is identical for the
 * whole of one move-drag, so the caller builds this ONCE at drag start (precomputeStatics)
 * and reuses it across every pointer-move frame, instead of rebuilding the bboxes + anchors
 * from scratch each frame (SLICE-004). Each entry pairs the neighbor's bbox with its anchors;
 * `bestAxis` reads them directly rather than re-deriving `anchors(s)` per frame.
 */
export interface StaticSnap {
  box: BBox
  anchors: Anchors
}

/** Snap radius in board-local px (zoom-stable). */
export const SNAP_TOL = 6

const X_KEYS = ['left', 'centerX', 'right'] as const
const Y_KEYS = ['top', 'centerY', 'bottom'] as const

type AnchorKey = keyof Anchors

/** Pair each static neighbor's bbox with its anchors (computed once per drag, reused per frame). */
export function precomputeStatics(boxes: BBox[]): StaticSnap[] {
  return boxes.map((box) => ({ box, anchors: anchors(box) }))
}

/** Nearest in-tolerance alignment of `moving`'s anchors to any static neighbor's anchors, one axis. */
function bestAxis(
  movingAnchors: Anchors,
  statics: StaticSnap[],
  keys: readonly AnchorKey[],
  tol: number
): { delta: number; at: number | null; neighbor: BBox | null } {
  const mv = movingAnchors
  let delta = 0
  let dist = tol + 1
  let at: number | null = null
  let neighbor: BBox | null = null
  for (const s of statics) {
    const sa = s.anchors
    for (const mk of keys) {
      for (const sk of keys) {
        const d = sa[sk] - mv[mk]
        const ad = Math.abs(d)
        if (ad <= tol && ad < dist) {
          dist = ad
          delta = d
          at = sa[sk]
          neighbor = s.box
        }
      }
    }
  }
  return { delta, at, neighbor }
}

/**
 * @param moving  union bbox of the moving set AFTER the raw drag delta is applied.
 * @param statics static (non-moving) neighbors. Pass `BBox[]` (rebuilt per call) or a
 *                precomputed `StaticSnap[]` (built once per drag via `precomputeStatics`,
 *                the SLICE-004 hot-path); both yield identical results.
 * @param tol     snap radius (board-local px).
 */
export function computeSnap(moving: BBox, statics: BBox[] | StaticSnap[], tol: number): SnapResult {
  const prepared: StaticSnap[] = isPrecomputed(statics) ? statics : precomputeStatics(statics)
  const mv = anchors(moving)
  const sx = bestAxis(mv, prepared, X_KEYS, tol)
  const sy = bestAxis(mv, prepared, Y_KEYS, tol)
  const guides: Guide[] = []
  if (sx.at !== null && sx.neighbor) {
    guides.push({
      axis: 'x',
      at: sx.at,
      from: Math.min(moving.y, sx.neighbor.y),
      to: Math.max(moving.y + moving.h, sx.neighbor.y + sx.neighbor.h)
    })
  }
  if (sy.at !== null && sy.neighbor) {
    guides.push({
      axis: 'y',
      at: sy.at,
      from: Math.min(moving.x, sy.neighbor.x),
      to: Math.max(moving.x + moving.w, sy.neighbor.x + sy.neighbor.w)
    })
  }
  return { dx: sx.delta, dy: sy.delta, guides }
}

/** Distinguish a precomputed `StaticSnap[]` from a raw `BBox[]` (empty array → treat as raw). */
function isPrecomputed(statics: BBox[] | StaticSnap[]): statics is StaticSnap[] {
  return statics.length > 0 && 'anchors' in statics[0]
}
