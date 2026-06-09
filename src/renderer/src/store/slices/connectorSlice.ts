/**
 * Connector slice — addConnector + removeConnector extracted from canvasStore via DI seam.
 *
 * HISTORY INVARIANT (read before touching):
 *   Every action here passes `reflectPresent: false` → NONE of them touch `lastRecorded`.
 *   `lastRecorded` and `trackedChange` are OWNED by canvasStore; this slice receives
 *   `trackedChange` by reference and MUST NOT copy, re-implement, or move it. The
 *   `reflectPresent: false` flag keeps these cable ops granularly undoable (same contract
 *   as add/remove/duplicate board); their post-no-op phantom step is the same tolerated
 *   edge (#BUG M3).
 */
import type { Connector, ConnectorKind } from '../../lib/boardSchema'
import type { CanvasState } from '../canvasStore'
import type { SetCanvasState, GetCanvasState, SliceDeps } from './sliceTypes'

export function createConnectorSlice(
  set: SetCanvasState,
  get: GetCanvasState,
  deps: SliceDeps
): Pick<CanvasState, 'addConnector' | 'removeConnector'> {
  const { trackedChange, newId } = deps

  return {
    addConnector: (sourceId: string, targetId: string, kind: ConnectorKind): string | null => {
      const s = get()
      // Reject a self-link, a missing endpoint, or an exact duplicate (same s+t+kind).
      if (sourceId === targetId) return null
      const ids = new Set(s.boards.map((b) => b.id))
      if (!ids.has(sourceId) || !ids.has(targetId)) return null
      if (
        s.connectors.some(
          (c) => c.sourceId === sourceId && c.targetId === targetId && c.kind === kind
        )
      ) {
        return null
      }
      const id = newId()
      const connector: Connector = { id, sourceId, targetId, kind }
      // One tracked step; leaves `boards` untouched (omit selectedId → keep selection).
      // reflectPresent:false matches add/remove/duplicate — keeps the cable granularly
      // undoable; its post-no-op phantom is the same tolerated edge (#BUG M3).
      set((st) =>
        trackedChange(st, { connectors: [...st.connectors, connector] }, { reflectPresent: false })
      )
      return id
    },

    removeConnector: (id: string): void =>
      set((s) => {
        if (!s.connectors.some((c) => c.id === id)) return s // unknown id → no dead step
        return trackedChange(
          s,
          { connectors: s.connectors.filter((c) => c.id !== id) },
          {
            reflectPresent: false
          }
        )
      })
  }
}
