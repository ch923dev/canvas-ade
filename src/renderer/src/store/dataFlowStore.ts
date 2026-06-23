/**
 * Data-Flow board EPHEMERAL view state (JD-4). Per dataflow-board-id: which layout tab is active, the
 * focused node, and the regenerate diff baseline + the last MAIN body-lineage edge list. NEVER
 * serialized (the scene/session split — only `sourceBoardId` persists on the board itself); like
 * `osrNetworkStore` / `commandStore`, this is pure runtime state dropped when the board unmounts.
 *
 * The inferred MODEL is not held here — it is derived live from the source board's `osrNetworkStore`
 * capture each render (pure libs); only view state + the diff snapshot + the value-less lineage edge
 * list live here.
 */
import { create } from 'zustand'
import type { DfGraph } from '../lib/dataFlowGraph'
import type { RequestLineageEdge } from '../lib/lineage'

export type DfTab = 'graph' | 'sequence'

export interface DfBoardView {
  tab: DfTab
  /** Focused node id (focus-on-node). Absent ⇒ the board picks a sensible default (busiest endpoint). */
  focusId?: string
  /** Graph snapshot at the last "Regenerate" — the diff baseline. Absent ⇒ no diff shown yet. */
  baseline?: DfGraph
  /** The MAIN body-side lineage edge list from the last opt-in pass (value-less, request-keyed). */
  bodyLineage?: RequestLineageEdge[]
  /** Noise filter — keep only data calls (fetch/xhr/ws), dropping assets/documents. Default ON. */
  apiOnly?: boolean
  /** Noise filter — keep only the bound board's own domain, dropping third-party origins. Default ON. */
  firstParty?: boolean
}

const EMPTY: DfBoardView = { tab: 'graph' }

interface DataFlowState {
  byBoard: Record<string, DfBoardView>
  setTab: (id: string, tab: DfTab) => void
  setFocus: (id: string, focusId: string | undefined) => void
  setBaseline: (id: string, baseline: DfGraph) => void
  setBodyLineage: (id: string, edges: RequestLineageEdge[]) => void
  setApiOnly: (id: string, on: boolean) => void
  setFirstParty: (id: string, on: boolean) => void
  clear: (id: string) => void
}

export const useDataFlowStore = create<DataFlowState>((set) => ({
  byBoard: {},
  setTab: (id, tab) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), tab } } })),
  setFocus: (id, focusId) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), focusId } } })),
  setBaseline: (id, baseline) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), baseline } } })),
  setBodyLineage: (id, bodyLineage) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), bodyLineage } } })),
  setApiOnly: (id, apiOnly) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), apiOnly } } })),
  setFirstParty: (id, firstParty) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), firstParty } } })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.byBoard)) return s
      const byBoard = { ...s.byBoard }
      delete byBoard[id]
      return { byBoard }
    })
}))
