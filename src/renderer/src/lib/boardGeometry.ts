/**
 * Pure board-geometry helpers for the canvas hot paths. No React, no store — unit-tested
 * like the other lib/*.ts. Extracted so the per-drag-frame snap pass and the fit framing
 * stop re-allocating: `snapOthers` is precomputed ONCE at gesture-start (the other boards
 * don't move while one is dragged/resized) and `boardsBounds` replaces four
 * `Math.min/max(...spread)` passes with a single linear scan.
 */
import type { Rect } from './alignmentGuides'

/** The minimal board geometry the hot paths read (a subset of `Board`). */
export interface BoardRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * The OTHER boards' world rects for a snap pass — every board except `excludeId`, as
 * plain {x,y,w,h}. Returns a fresh array so the caller can safely cache it across a
 * gesture without aliasing the live board list.
 */
export function snapOthers(boards: BoardRect[], excludeId: string): Rect[] {
  const out: Rect[] = []
  for (const b of boards) {
    if (b.id === excludeId) continue
    out.push({ x: b.x, y: b.y, w: b.w, h: b.h })
  }
  return out
}

/** World-space extremes of a board set. */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * World-space bounds of a board set in a single pass (no `Math.min(...spread)`
 * allocations, which also avoids the spread's argument-count stack ceiling on large sets).
 * Returns null for an empty set so callers fall back to a default frame.
 */
export function boardsBounds(boards: BoardRect[]): Bounds | null {
  if (boards.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boards) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  return { minX, minY, maxX, maxY }
}
