/**
 * Shared "floating edge" geometry for canvas connectors (extracted from PreviewEdge in
 * M2 T2.3 so PreviewEdge and OrchestrationEdge compute identical border-to-border paths).
 *
 * Endpoints are derived from the two nodes' live geometry (border intersection toward the
 * other's center), so an edge touches the board edges and reroutes for free when either
 * board moves. The source/target Position pair follows the dominant axis between the two
 * centers (Bug M4) so the bezier control arms never fishhook. Pure except `floatingPath`,
 * which reads React Flow's measured node geometry.
 */
import { getBezierPath, Position, type InternalNode } from '@xyflow/react'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function box(positionAbsolute: { x: number; y: number }, w: number, h: number): Box {
  return { x: positionAbsolute.x + w / 2, y: positionAbsolute.y + h / 2, w, h }
}

/** Point on `from`'s border along the line toward `to`'s center. */
export function borderPoint(from: Box, to: Box): { x: number; y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y }
  const sx = from.w / 2
  const sy = from.h / 2
  const scale = 1 / Math.max(Math.abs(dx) / sx, Math.abs(dy) / sy)
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

/**
 * Derive the source/target `Position` pair from the two centers' geometry so the bezier
 * control arms pull toward the actual relationship between the boards (Bug M4). Pick the
 * dominant axis (larger absolute delta) and orient along it.
 */
export function edgePositions(
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

export interface FloatingPath {
  /** SVG path `d` for the border-to-border bezier. */
  path: string
  /** Midpoint (for an edge label / ✕ affordance). */
  labelX: number
  labelY: number
}

/**
 * Compute the floating bezier between two React Flow internal nodes. Returns null if
 * either node has not been measured yet (the caller renders nothing).
 */
export function floatingPath(s: InternalNode, t: InternalNode): FloatingPath | null {
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
  return { path, labelX, labelY }
}
