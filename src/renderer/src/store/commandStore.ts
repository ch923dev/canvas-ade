/**
 * Command board state — the orchestrator's EPHEMERAL face state (Phase A shell).
 *
 * Singleton: there is exactly one Command board on a canvas (the single MCP orchestrator face,
 * bound to the synthetic `boardId:'app'` token in MAIN), so a single global store backs it.
 *
 * RUNTIME-ONLY — this store is NEVER serialized into `canvas.json`. The persisted Command board
 * is just `BoardCommon` (`boardSchema.CommandBoard`); the task queue + view/collapse state live
 * here and reset on reload (the scene/session split — like the selected tool / in-flight draft).
 *
 * Phase A is the SHELL: `tasks` stays empty (dispatch → spawn arrives in Phase C); `view` drives
 * the titlebar seg control; `collapsed`/`expandedHeight` back the expand↔rail toggle. Later phases
 * fill `tasks` (B kanban / C dispatch) and add result/recap state (D).
 */
import { create } from 'zustand'

/** The task lifecycle state machine (kanban columns). Cards advance left→right (Phase B). */
export type TaskStatus = 'queued' | 'routing' | 'executing' | 'reporting' | 'done' | 'failed'

/** One orchestrator task. Phase A defines the shape; B/C populate the queue. */
export interface CommandTask {
  id: string
  title: string
  status: TaskStatus
}

/** Which body the titlebar seg control shows. */
export type CommandView = 'kanban' | 'groups'

interface CommandState {
  /** The orchestrator task queue, bucketed into kanban columns by `status`. EMPTY in Phase A. */
  tasks: CommandTask[]
  /** Titlebar seg selection. */
  view: CommandView
  /** Collapsed (one-line rail) vs expanded (full board). Ephemeral → resets to expanded on reload. */
  collapsed: boolean
  /** Board height (px) remembered at collapse time, restored on expand. */
  expandedHeight: number | null
  setView: (view: CommandView) => void
  /** Set collapsed; pass the pre-collapse height when collapsing so expand can restore it. */
  setCollapsed: (collapsed: boolean, expandedHeight?: number) => void
}

/**
 * The shipped reset state. Reused by the store's initial value AND the reset sites (project load
 * in `canvasStore.applyLoadedDoc`, e2e `reset()`) so the default shape never drifts between them.
 */
export function commandStoreDefaults(): Pick<
  CommandState,
  'tasks' | 'view' | 'collapsed' | 'expandedHeight'
> {
  return { tasks: [], view: 'kanban', collapsed: false, expandedHeight: null }
}

export const useCommandStore = create<CommandState>((set) => ({
  ...commandStoreDefaults(),
  setView: (view) => set({ view }),
  setCollapsed: (collapsed, expandedHeight) =>
    set((s) => ({ collapsed, expandedHeight: expandedHeight ?? s.expandedHeight }))
}))
