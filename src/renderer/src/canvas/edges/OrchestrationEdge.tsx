/**
 * Orchestration connector (M2): a user-drawn cable between two boards — the visual
 * substrate the MCP dispatch layer (M4) later flows along. "Floating" like PreviewEdge:
 * endpoints derive from the two nodes' live geometry, so it reroutes for free on move.
 *
 * Styled DISTINCT from the accent preview edge (DESIGN §7.3): a calm neutral
 * `--border-strong` stroke (no glow/gradient). Hosts the ✕ delete affordance at the
 * path midpoint and highlights when selected. Shares PreviewEdge's geometry via
 * `floatingPath`.
 */
import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react'
import { floatingPath } from './floatingPath'

interface OrchestrationEdgeData {
  connectorId: string
  onRemoveConnector: (id: string) => void
}

function OrchestrationEdgeImpl({
  id,
  source,
  target,
  markerEnd,
  selected,
  data
}: EdgeProps): React.ReactElement | null {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const fp = floatingPath(s, t)
  if (!fp) return null
  const { path, labelX, labelY } = fp
  const d = data as OrchestrationEdgeData | undefined
  const onDelete = d ? () => d.onRemoveConnector(d.connectorId) : undefined
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          // Neutral, calm — distinct from the accent preview edge (DESIGN §7.3).
          // D0-1: was the ghost token --text-1 (never defined → fallback ink).
          stroke: selected ? 'var(--text)' : 'var(--border-strong)',
          strokeWidth: selected ? 2.5 : 2
        }}
      />
      {onDelete && (
        <EdgeLabelRenderer>
          <button
            className="ca-connector-delete nodrag nopan"
            data-connector={id}
            title="Delete connector"
            aria-label="Delete connector"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              width: 18,
              height: 18,
              display: selected ? 'grid' : 'none',
              placeItems: 'center',
              borderRadius: '50%',
              border: '1px solid var(--border-strong)',
              background: 'var(--surface-raised)',
              color: 'var(--text-2)',
              fontSize: 12,
              lineHeight: 1,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/**
 * M10: same rationale as PreviewEdge — `buildCanvasEdges` hands this component a fresh `data`
 * wrapper every recompute, but `data.connectorId`/`data.onRemoveConnector` (and `markerEnd`, a
 * module-level constant in canvasEdges.ts) are themselves stable when this connector's selection
 * hasn't changed, so compare those instead of the wrapper object identities.
 */
export const OrchestrationEdge = memo(OrchestrationEdgeImpl, (prev, next) => {
  const pd = prev.data as OrchestrationEdgeData | undefined
  const nd = next.data as OrchestrationEdgeData | undefined
  return (
    prev.id === next.id &&
    prev.source === next.source &&
    prev.target === next.target &&
    prev.selected === next.selected &&
    prev.markerEnd === next.markerEnd &&
    pd?.connectorId === nd?.connectorId &&
    pd?.onRemoveConnector === nd?.onRemoveConnector
  )
})
