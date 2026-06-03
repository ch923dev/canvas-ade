/**
 * Pure in-board snapping (W2.2). Aligns a dragged element's union box to neighbor
 * edges/centers within a BOARD-LOCAL tolerance, returning the delta correction to ADD
 * to the raw drag delta + the guide lines to draw. Zoom-stable because every input is
 * board-local px (the caller maps screen→board before calling). No React/DOM.
 */
import { anchors, type BBox } from './elements'

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

/** Snap radius in board-local px (zoom-stable). */
export const SNAP_TOL = 6

const X_KEYS = ['left', 'centerX', 'right'] as const
const Y_KEYS = ['top', 'centerY', 'bottom'] as const

type AnchorKey = keyof ReturnType<typeof anchors>

/** Nearest in-tolerance alignment of `moving`'s anchors to any static neighbor's anchors, one axis. */
function bestAxis(
  moving: BBox,
  statics: BBox[],
  keys: readonly AnchorKey[],
  tol: number
): { delta: number; at: number | null; neighbor: BBox | null } {
  const mv = anchors(moving)
  let delta = 0
  let dist = tol + 1
  let at: number | null = null
  let neighbor: BBox | null = null
  for (const s of statics) {
    const sa = anchors(s)
    for (const mk of keys) {
      for (const sk of keys) {
        const d = sa[sk] - mv[mk]
        const ad = Math.abs(d)
        if (ad <= tol && ad < dist) {
          dist = ad
          delta = d
          at = sa[sk]
          neighbor = s
        }
      }
    }
  }
  return { delta, at, neighbor }
}

/**
 * @param moving  union bbox of the moving set AFTER the raw drag delta is applied.
 * @param statics bboxes of the static (non-moving) neighbor elements.
 * @param tol     snap radius (board-local px).
 */
export function computeSnap(moving: BBox, statics: BBox[], tol: number): SnapResult {
  const sx = bestAxis(moving, statics, X_KEYS, tol)
  const sy = bestAxis(moving, statics, Y_KEYS, tol)
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
