/**
 * Pure derivation of orchestration connector edges (M2 T2.3) from store state — mirror
 * of `previewEdges`: one RF edge per `orchestration` connector whose BOTH endpoint boards
 * are still present (dangling connectors are skipped, never rendered as half-edges).
 * DOM/React-Flow free → unit-testable; Canvas decorates these with selection state, a
 * delete callback, and a marker.
 */
import type { Board, Connector } from './boardSchema'

export interface OrchestrationEdgeDesc {
  id: string
  source: string
  target: string
  type: 'orchestration'
}

export function orchestrationEdges(
  connectors: Connector[],
  boards: Board[]
): OrchestrationEdgeDesc[] {
  const ids = new Set(boards.map((b) => b.id))
  const edges: OrchestrationEdgeDesc[] = []
  for (const c of connectors) {
    if (c.kind !== 'orchestration') continue
    if (!ids.has(c.sourceId) || !ids.has(c.targetId)) continue
    edges.push({ id: c.id, source: c.sourceId, target: c.targetId, type: 'orchestration' })
  }
  return edges
}
