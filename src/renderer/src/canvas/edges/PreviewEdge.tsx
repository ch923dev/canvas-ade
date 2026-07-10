/**
 * Preview-link connector (Slice C′): a calm accent bezier from a Terminal board to
 * the Browser board it pushed a preview into. "Floating" — endpoints are computed
 * from the two nodes' live geometry (border intersection), so the arrow touches the
 * board edges and reroutes for free when either board moves. No handle UX.
 *
 * Occlusion (ADR 0002): where this SVG crosses a Browser's native WebContentsView it
 * paints under it; endpoints land on board borders (HTML chrome), and native views
 * detach→snapshot during motion, so the arrow shows while dragging. Accepted.
 */
import { memo } from 'react'
import { BaseEdge, useInternalNode, type EdgeProps } from '@xyflow/react'
import { floatingPath } from './floatingPath'

function PreviewEdgeImpl({
  id,
  source,
  target,
  markerEnd,
  style,
  data
}: EdgeProps): React.ReactElement | null {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const stale = (data as { stale?: boolean } | undefined)?.stale ?? false
  const fp = floatingPath(s, t)
  if (!fp) return null
  const { path } = fp
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: 'var(--accent)',
        strokeWidth: 1.5,
        opacity: stale ? 0.4 : 0.9,
        strokeDasharray: stale ? '5 5' : undefined,
        ...style
      }}
    />
  )
}

/**
 * M10: `buildCanvasEdges` rebuilds the edge array (and a fresh `data`/`style` wrapper object) every
 * time boards/connectors change — including every board-drag frame — so a bare `React.memo`'s
 * default shallow-prop compare would still see "new" `data`/`style` references and re-render anyway.
 * Compare the fields that actually drive this component's output instead of the wrapper identity
 * (`markerEnd` is a module-level constant in canvasEdges.ts, so `===` is meaningful there too).
 */
export const PreviewEdge = memo(
  PreviewEdgeImpl,
  (prev, next) =>
    prev.id === next.id &&
    prev.source === next.source &&
    prev.target === next.target &&
    prev.markerEnd === next.markerEnd &&
    (prev.data as { stale?: boolean } | undefined)?.stale ===
      (next.data as { stale?: boolean } | undefined)?.stale
)
