/**
 * Build the React Flow edge array from store state — extracted from Canvas (the `buildBoardNodes`
 * sibling) to keep that god-file under its max-lines ratchet. Three DERIVED, never-persisted edge
 * families, each from a pure helper (dangling endpoints skipped); this only decorates them with the
 * arrow marker, selection state, and the delete callback:
 *   - preview        (accent)        — a Browser board linked to the terminal that pushed its preview
 *   - orchestration  (neutral)       — user-drawn connector cables (selectable / deletable)
 *   - routing        (accent dashed) — the C3 ephemeral overlay: command board → in-flight workers
 *
 * Marker colors are CSS vars (D0-3): React Flow passes the color into the marker polyline's inline
 * style and quotes the marker-id url, so var() resolves cleanly.
 */
import { MarkerType, type Edge } from '@xyflow/react'
import type { Board, Connector } from '../lib/boardSchema'
import type { CommandTask } from '../store/commandStore'
import { previewEdges } from '../lib/previewEdges'
import { orchestrationEdges } from '../lib/orchestrationEdges'
import { routingEdges } from '../lib/routingEdges'

export interface BuildCanvasEdgesArgs {
  boards: Board[]
  runningIds: Set<string>
  connectors: Connector[]
  selectedConnectorId: string | null
  commandTasks: ReadonlyArray<CommandTask>
  onRemoveConnector: (id: string) => void
}

export function buildCanvasEdges({
  boards,
  runningIds,
  connectors,
  selectedConnectorId,
  commandTasks,
  onRemoveConnector
}: BuildCanvasEdgesArgs): Edge[] {
  const preview = previewEdges(boards, runningIds).map((e) => ({
    ...e,
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)', width: 16, height: 16 }
  }))
  const orchestration = orchestrationEdges(connectors, boards).map((e) => ({
    ...e,
    selected: e.id === selectedConnectorId,
    data: { onDelete: () => onRemoveConnector(e.id) },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: e.id === selectedConnectorId ? 'var(--connector-selected)' : 'var(--connector)',
      width: 16,
      height: 16
    }
  }))
  // Routing overlay: command board → each in-flight worker member. Transient (never persisted) →
  // vanishes automatically when a task settles or its card is cleared.
  const routing = routingEdges(commandTasks, boards).map((e) => ({
    ...e,
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)', width: 14, height: 14 }
  }))
  return [...preview, ...orchestration, ...routing]
}
