/**
 * Routing overlay edge (Phase C / C3): an EPHEMERAL dashed accent cable from the Command board to a
 * worker board it dispatched, shown while the task is in flight (routing → executing) and gone the
 * instant it settles (the edge set is derived from the live task→group map — see `lib/routingEdges`).
 *
 * Distinct from the two persisted edges: the neutral `orchestration` connector (a user-drawn cable)
 * and the solid accent `preview` link. This one is a flowing DASHED accent (`.ca-routing-edge` animates
 * the dash offset toward the worker) reading as transient / in-motion — fainter while the group is
 * still spawning (`routing`) than once the worker is busy (`executing`). Floating geometry via
 * `floatingPath`, so it reroutes for free as boards move (no separate SVG layer to camera-sync). No
 * affordances (not selectable / deletable — it is not a persisted connector).
 */
import { BaseEdge, useInternalNode, type EdgeProps } from '@xyflow/react'
import { floatingPath } from './floatingPath'

export function RoutingEdge({
  id,
  source,
  target,
  markerEnd,
  data
}: EdgeProps): React.ReactElement | null {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const fp = floatingPath(s, t)
  if (!fp) return null
  const spawning = (data as { phase?: string } | undefined)?.phase === 'routing'
  return (
    <BaseEdge
      id={id}
      path={fp.path}
      markerEnd={markerEnd}
      className="ca-routing-edge"
      style={{
        stroke: 'var(--accent)',
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
        // Fainter while the group is still spawning; brighter once the worker is executing.
        opacity: spawning ? 0.5 : 0.8
      }}
    />
  )
}
