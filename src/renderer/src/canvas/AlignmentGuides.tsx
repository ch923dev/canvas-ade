// src/renderer/src/canvas/AlignmentGuides.tsx
/**
 * Screen-space SVG overlay drawing the active alignment guide lines while a board is
 * dragged. Subscribes to the live camera transform (`useStore(s => s.transform)`) so the
 * 1px dashed lines track pan/zoom and stay crisp at any zoom (stroke width is screen px,
 * NOT scaled by the viewport). `pointer-events:none` — it never intercepts the drag.
 * Renders nothing when there are no guides. Must be mounted under <ReactFlowProvider>.
 */
import { type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import { projectGuide, type Guide } from '../lib/alignmentGuides'

export function AlignmentGuides({ guides }: { guides: Guide[] }): ReactElement | null {
  const transform = useStore((s) => s.transform)
  if (guides.length === 0) return null
  return (
    <svg className="align-guides" aria-hidden="true">
      {guides.map((g, i) => {
        // Only ALIGN guides draw a line here; GAP guides get their own rendering in slice 2a Task 3.
        if (g.kind !== 'align') return null
        const l = projectGuide(g, transform)
        return <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
      })}
    </svg>
  )
}
