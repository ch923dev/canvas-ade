// src/renderer/src/canvas/AlignmentGuides.tsx
/**
 * Screen-space SVG overlay for drag-time alignment feedback. Subscribes to the live camera
 * transform (`useStore(s => s.transform)`) so everything tracks pan/zoom and stays crisp (stroke /
 * pill sizes are screen px, NOT scaled by the viewport). `pointer-events:none` — never intercepts
 * the drag. Draws: align lines (slice 1), gap indicators (connector + ticks + Npx pill, slice 2a),
 * and overlap tint rects (slice 2a). Renders nothing when there is nothing active. Must be mounted
 * under <ReactFlowProvider>.
 */
import { type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import {
  projectGuide,
  projectGapGuide,
  projectRect,
  type Guide,
  type Rect
} from '../lib/alignmentGuides'

const TICK = 5 // half-length (screen px) of the perpendicular end ticks on a gap connector

export function AlignmentGuides({
  guides,
  overlaps
}: {
  guides: Guide[]
  overlaps: Rect[]
}): ReactElement | null {
  const transform = useStore((s) => s.transform)
  if (guides.length === 0 && overlaps.length === 0) return null
  return (
    <svg className="align-guides" aria-hidden="true">
      {overlaps.map((o, i) => {
        const r = projectRect(o, transform)
        return <rect key={`o${i}`} className="align-overlap" x={r.x} y={r.y} width={r.w} height={r.h} />
      })}
      {guides.map((g, i) => {
        if (g.kind === 'align') {
          const l = projectGuide(g, transform)
          return <line key={`a${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        }
        const v = projectGapGuide(g, transform)
        // Connector + two perpendicular end ticks. Ticks are perpendicular to the connector axis.
        const vertical = g.axis === 'y'
        const tick = (cx: number, cy: number): ReactElement =>
          vertical ? (
            <line className="align-tick" x1={cx - TICK} y1={cy} x2={cx + TICK} y2={cy} />
          ) : (
            <line className="align-tick" x1={cx} y1={cy - TICK} x2={cx} y2={cy + TICK} />
          )
        return (
          <g key={`g${i}`} className="align-gap">
            <line className="align-connector" x1={v.ax} y1={v.ay} x2={v.bx} y2={v.by} />
            <g>{tick(v.ax, v.ay)}</g>
            <g>{tick(v.bx, v.by)}</g>
            <rect className="align-pill" x={v.lx - 14} y={v.ly - 8} width={28} height={16} rx={3} />
            <text className="align-pill-text" x={v.lx} y={v.ly} textAnchor="middle" dominantBaseline="central">
              {v.distance}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
