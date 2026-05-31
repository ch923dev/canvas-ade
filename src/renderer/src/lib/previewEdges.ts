/**
 * Pure derivation of preview-link edges (Slice C′) from board state: one edge per
 * Browser board that has a present `previewSourceId`. DOM/React-Flow free so it is
 * unit-testable; Canvas decorates these with a marker and the custom edge type.
 */
import type { Board } from './boardSchema'

export interface PreviewEdgeDesc {
  id: string
  source: string
  target: string
  type: 'preview'
  data: { stale: boolean }
}

export function previewEdges(
  boards: Board[],
  runningIds: Set<string> = new Set()
): PreviewEdgeDesc[] {
  const ids = new Set(boards.map((b) => b.id))
  const edges: PreviewEdgeDesc[] = []
  for (const b of boards) {
    if (b.type !== 'browser') continue
    const src = b.previewSourceId
    if (src && ids.has(src)) {
      edges.push({
        id: `preview-${b.id}`,
        source: src,
        target: b.id,
        type: 'preview',
        data: { stale: !runningIds.has(src) }
      })
    }
  }
  return edges
}
