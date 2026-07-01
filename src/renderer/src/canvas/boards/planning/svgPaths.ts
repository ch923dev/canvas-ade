/**
 * Pure SVG path builders for the Planning whiteboard's vector layer (no React).
 * Kept separate from `WhiteboardSvg.tsx` so the path math is unit-testable and so
 * the component file only exports a component (react-refresh friendly).
 *
 * - `arrowPath` — a cubic bezier from an arrow's start→end with a gentle bow,
 *   drawn 1.5px `--border-strong` + arrowhead marker (DESIGN.md §7.3).
 * - `arrowheadMarkerId` — per-board `<marker>` id so multiple Planning boards
 *   never share a DOM id.
 * - `strokeToPath` — a freehand point list → a filled outline path via the
 *   vendored perfect-freehand (ADR 0001). `simulatePressure: false` because a
 *   mouse/trackpad has no real pressure.
 */
import type { ArrowElement } from '../../../lib/boardSchema'
import getStroke from '../../../../../vendor/perfect-freehand'
import type { StrokeOptions } from '../../../../../vendor/perfect-freehand'
import { pointsToPairs } from '../../../lib/pen'

/** Pen feel — mouse/trackpad has no real pressure, so simulate it off. */
export const STROKE_OPTIONS: StrokeOptions = {
  size: 4,
  thinning: 0,
  smoothing: 0.62,
  streamline: 0.5,
  simulatePressure: false
}

/** A cubic bezier from start→end with a gentle control-point bow. */
export function arrowPath(a: ArrowElement): string {
  const dx = a.x2 - a.x
  const dy = a.y2 - a.y
  const c1x = a.x + dx * 0.4
  const c1y = a.y + dy * 0.1
  const c2x = a.x + dx * 0.6
  const c2y = a.y2 - dy * 0.1
  return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${a.x2} ${a.y2}`
}

/** Per-board SVG <marker> id so multiple Planning boards never share a DOM id. */
export function arrowheadMarkerId(boardId: string): string {
  return `pl-arrowhead-${boardId}`
}

/** Flat board-local point list → an SVG fill path for a perfect-freehand outline. `size` overrides
 *  the pen width (P4b `strokeWidth`); omitted ⇒ STROKE_OPTIONS.size (4), byte-identical to pre-P4b. */
export function strokeToPath(points: number[], size: number = STROKE_OPTIONS.size ?? 4): string {
  const outline = getStroke(pointsToPairs(points), { ...STROKE_OPTIONS, size })
  if (outline.length === 0) return ''
  const d = outline.reduce(
    (acc: string, [x, y]: [number, number], i: number) =>
      acc + (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`),
    ''
  )
  return `${d} Z`
}
