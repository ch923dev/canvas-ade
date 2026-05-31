/**
 * Pure smart-alignment detection (Canva/Figma "helper lines"). Given the dragged
 * board's candidate rect and the other boards, find the nearest edge/center alignment
 * per axis within `threshold` (WORLD units) and return the snapped top-left plus the
 * guide line(s) to draw. No React, no store — unit-tested like the other lib/*.ts.
 *
 * Snap math: a stop is `origin + offset`, offset ∈ {0, size/2, size}; to land that stop
 * on `target`, shift the origin by `target - stop`. The single smallest qualifying diff
 * per axis wins (a closer candidate replaces a farther one) — the rule shared by
 * Konva/tldraw/Excalidraw. The caller divides a screen-px threshold by zoom so the
 * "feel" is constant across zoom levels (research: Excalidraw SNAP_DISTANCE/zoom).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A guide line in WORLD coordinates. `axis:'x'` = a vertical line at world-x `pos`
 * spanning world-y [start,end]; `axis:'y'` = a horizontal line at world-y `pos`
 * spanning world-x [start,end].
 */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  start: number
  end: number
}

export interface AlignResult {
  /** Snapped top-left (unchanged on an axis with no match). */
  x: number
  y: number
  /** 0–2 guide lines (≤1 vertical, ≤1 horizontal). */
  guides: Guide[]
}

/** Screen px the dragged edge must be within to snap (caller divides by zoom). */
export const SNAP_THRESHOLD_PX = 8

interface OtherAxis {
  origin: number
  size: number
  perpMin: number
  perpMax: number
}

interface AxisMatch {
  origin: number
  pos: number
  spanMin: number
  spanMax: number
}

/** Stops along an axis: [near edge, center, far edge]. */
function stops(origin: number, size: number): [number, number, number] {
  return [origin, origin + size / 2, origin + size]
}

function bestAxisMatch(
  dragOrigin: number,
  dragSize: number,
  dragPerpMin: number,
  dragPerpMax: number,
  others: OtherAxis[],
  threshold: number
): AxisMatch | null {
  const dStops = stops(dragOrigin, dragSize)
  let best: (AxisMatch & { diff: number }) | null = null
  for (const o of others) {
    const oStops = stops(o.origin, o.size)
    for (const ds of dStops) {
      for (const os of oStops) {
        const diff = Math.abs(ds - os)
        if (diff > threshold) continue
        if (best && diff >= best.diff) continue
        best = {
          diff,
          origin: dragOrigin + (os - ds),
          pos: os,
          spanMin: Math.min(dragPerpMin, o.perpMin),
          spanMax: Math.max(dragPerpMax, o.perpMax)
        }
      }
    }
  }
  if (!best) return null
  return { origin: best.origin, pos: best.pos, spanMin: best.spanMin, spanMax: best.spanMax }
}

export function computeAlignment(rect: Rect, others: Rect[], threshold: number): AlignResult {
  // X axis (vertical guides): origin=x size=w; perpendicular extent = [y, y+h].
  const xMatch = bestAxisMatch(
    rect.x,
    rect.w,
    rect.y,
    rect.y + rect.h,
    others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h })),
    threshold
  )
  // Y axis (horizontal guides): origin=y size=h; perpendicular extent = [x, x+w].
  const yMatch = bestAxisMatch(
    rect.y,
    rect.h,
    rect.x,
    rect.x + rect.w,
    others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w })),
    threshold
  )

  const guides: Guide[] = []
  if (xMatch) guides.push({ axis: 'x', pos: xMatch.pos, start: xMatch.spanMin, end: xMatch.spanMax })
  if (yMatch) guides.push({ axis: 'y', pos: yMatch.pos, start: yMatch.spanMin, end: yMatch.spanMax })
  return { x: xMatch ? xMatch.origin : rect.x, y: yMatch ? yMatch.origin : rect.y, guides }
}
