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

export function PreviewEdge({
  id,
  source,
  target,
  markerEnd,
  style
}: EdgeProps): React.ReactElement | null {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const sBox = box(s.internals.positionAbsolute, s.measured.width ?? 0, s.measured.height ?? 0)
  const tBox = box(t.internals.positionAbsolute, t.measured.width ?? 0, t.measured.height ?? 0)
  const sp = borderPoint(sBox, tBox)
  const tp = borderPoint(tBox, sBox)
  const [path] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    targetX: tp.x,
    targetY: tp.y,
    sourcePosition: Position.Right,
    targetPosition: Position.Left
  })
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{ stroke: 'var(--accent)', strokeWidth: 1.5, opacity: 0.9, ...style }}
    />
  )
}
