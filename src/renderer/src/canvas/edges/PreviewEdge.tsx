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
import { BaseEdge, useInternalNode, type EdgeProps } from '@xyflow/react'
import { floatingPath } from './floatingPath'

export function PreviewEdge({
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
