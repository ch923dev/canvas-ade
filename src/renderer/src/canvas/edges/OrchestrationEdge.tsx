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
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react'
import { floatingPath } from './floatingPath'

export function OrchestrationEdge({
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
  const onDelete = (data as { onDelete?: () => void } | undefined)?.onDelete
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
