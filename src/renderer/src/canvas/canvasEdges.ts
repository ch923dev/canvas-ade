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

/**
 * M10: module-level marker constants — REUSED (not allocated) per render, so `markerEnd` is
 * reference-stable across `buildCanvasEdges` calls for an edge whose selection state hasn't
 * flipped. A fresh `{...}` literal every call would defeat the edge components' React.memo below
 * even though the marker's actual shape never changes.
 */
const PREVIEW_MARKER = {
  type: MarkerType.ArrowClosed,
  color: 'var(--accent)',
  width: 16,
  height: 16
}
const ROUTING_MARKER = {
  type: MarkerType.ArrowClosed,
  color: 'var(--accent)',
  width: 14,
  height: 14
}
const ORCH_MARKER_SELECTED = {
  type: MarkerType.ArrowClosed,
  color: 'var(--connector-selected)',
  width: 16,
  height: 16
}
const ORCH_MARKER_DEFAULT = {
  type: MarkerType.ArrowClosed,
  color: 'var(--connector)',
  width: 16,
  height: 16
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
    markerEnd: PREVIEW_MARKER
  }))
  const orchestration = orchestrationEdges(connectors, boards).map((e) => ({
    ...e,
    selected: e.id === selectedConnectorId,
    // M10: no per-edge closure — `onRemoveConnector` (a Zustand action) is already reference-stable,
    // so passing it through untouched + the plain connectorId lets OrchestrationEdge's memo
    // comparator detect "no real change" instead of always seeing a fresh `() => …` wrapper.
    data: { connectorId: e.id, onRemoveConnector },
    markerEnd: e.id === selectedConnectorId ? ORCH_MARKER_SELECTED : ORCH_MARKER_DEFAULT
  }))
  // Routing overlay: command board → each in-flight worker member. Transient (never persisted) →
  // vanishes automatically when a task settles or its card is cleared.
  const routing = routingEdges(commandTasks, boards).map((e) => ({
    ...e,
    markerEnd: ROUTING_MARKER
  }))
  return [...preview, ...orchestration, ...routing]
}
