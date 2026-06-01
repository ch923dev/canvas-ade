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
import { BaseEdge, getBezierPath, useInternalNode, Position, type EdgeProps } from '@xyflow/react'

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

/**
 * Bug M4: derive the source/target `Position` pair from the two centers' geometry so
 * the bezier control arms pull toward the actual relationship between the boards. The
 * old code hardcoded Right→Left, which fishhooks/S-curves when the target is to the
 * left, above, or below the source. Pick the dominant axis (the larger absolute delta)
 * and orient along it: the source leaves toward the target, the target receives from
 * the opposite side. Pure — unit-tested over the four cardinal relationships.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper co-located with the edge it serves; exported for its unit test.
export function edgePositions(
  sourceCenter: { x: number; y: number },
  targetCenter: { x: number; y: number }
): { sourcePosition: Position; targetPosition: Position } {
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal-dominant: target right → leave Right / enter Left; else mirror.
    return dx >= 0
      ? { sourcePosition: Position.Right, targetPosition: Position.Left }
      : { sourcePosition: Position.Left, targetPosition: Position.Right }
  }
  // Vertical-dominant: target below → leave Bottom / enter Top; else mirror.
  return dy >= 0
    ? { sourcePosition: Position.Bottom, targetPosition: Position.Top }
    : { sourcePosition: Position.Top, targetPosition: Position.Bottom }
}

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
  const sBox = box(s.internals.positionAbsolute, s.measured.width ?? 0, s.measured.height ?? 0)
  const tBox = box(t.internals.positionAbsolute, t.measured.width ?? 0, t.measured.height ?? 0)
  const sp = borderPoint(sBox, tBox)
  const tp = borderPoint(tBox, sBox)
  const { sourcePosition, targetPosition } = edgePositions(sBox, tBox)
  const [path] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    targetX: tp.x,
    targetY: tp.y,
    sourcePosition,
    targetPosition
  })
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
