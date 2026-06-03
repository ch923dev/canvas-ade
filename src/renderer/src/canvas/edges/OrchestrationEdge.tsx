/**
 * Orchestration connector (M2): a user-drawn cable between two boards — the visual
 * substrate the MCP dispatch layer (M4) later flows along. "Floating" like PreviewEdge:
 * endpoints derive from the two nodes' live geometry, so it reroutes for free on move.
 *
 * Styled DISTINCT from the accent preview edge (DESIGN §7.3): a calm ~2px neutral
 * stroke (no glow/gradient). Hosts the ✕ delete affordance at the path midpoint and
 * highlights when selected.
 *
 * NOTE (T2.2): the box/borderPoint/edgePositions geometry is duplicated from PreviewEdge
 * here; T2.3 extracts it to `edges/floatingPath.ts` shared by both edges.
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  Position,
  type EdgeProps
} from '@xyflow/react'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function box(positionAbsolute: { x: number; y: number }, w: number, h: number): Box {
  return { x: positionAbsolute.x + w / 2, y: positionAbsolute.y + h / 2, w, h }
}

/** Point on `from`'s border along the line toward `to`'s center. */
function borderPoint(from: Box, to: Box): { x: number; y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y }
  const sx = from.w / 2
  const sy = from.h / 2
  const scale = 1 / Math.max(Math.abs(dx) / sx, Math.abs(dy) / sy)
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

/** Dominant-axis source/target Position pair (mirrors PreviewEdge.edgePositions). */
function edgePositions(
  sourceCenter: { x: number; y: number },
  targetCenter: { x: number; y: number }
): { sourcePosition: Position; targetPosition: Position } {
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourcePosition: Position.Right, targetPosition: Position.Left }
      : { sourcePosition: Position.Left, targetPosition: Position.Right }
  }
  return dy >= 0
    ? { sourcePosition: Position.Bottom, targetPosition: Position.Top }
    : { sourcePosition: Position.Top, targetPosition: Position.Bottom }
}

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
  const sBox = box(s.internals.positionAbsolute, s.measured.width ?? 0, s.measured.height ?? 0)
  const tBox = box(t.internals.positionAbsolute, t.measured.width ?? 0, t.measured.height ?? 0)
  const sp = borderPoint(sBox, tBox)
  const tp = borderPoint(tBox, sBox)
  const { sourcePosition, targetPosition } = edgePositions(sBox, tBox)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    targetX: tp.x,
    targetY: tp.y,
    sourcePosition,
    targetPosition
  })
  const onDelete = (data as { onDelete?: () => void } | undefined)?.onDelete
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          // Neutral, calm — distinct from the accent preview edge (DESIGN §7.3).
          stroke: selected ? 'var(--text-1)' : 'var(--border-strong)',
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
