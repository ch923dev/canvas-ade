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
 * Phase B fills the queue: the submit well calls `addTask` to enqueue a `queued` task, cards render
 * bucketed by `status`, and `setTaskStatus`/`retryTask` move them between columns. The LIVE driver
 * of those transitions (worker `subscribeStatus`/settle events) arrives in Phase C — until a task is
 * dispatched to a real worker group it simply sits in `queued`. `view`/`collapsed`/`expandedHeight`
 * back the seg + expand↔rail toggle. Result/recap state lands in D.
 */
import { create } from 'zustand'

/** The task lifecycle state machine (kanban columns). Cards advance left→right as workers progress. */
export type TaskStatus = 'queued' | 'routing' | 'executing' | 'reporting' | 'done' | 'failed'

/** One orchestrator task. Phase A defined the shape; Phase B populates + transitions the queue. */
export interface CommandTask {
  id: string
  title: string
  status: TaskStatus
}

/**
 * Tasks belonging to a kanban column. `failed` has no column of its own — failed tasks bucket into
 * Done (rendered with a retry affordance), matching the COLUMNS contract in CommandBoard. Pure +
 * unit-testable; the single source of truth for the failed→Done bucketing (column lists + counts).
 */
export function tasksInColumn(
  tasks: ReadonlyArray<CommandTask>,
  column: TaskStatus
): CommandTask[] {
  return column === 'done'
    ? tasks.filter((t) => t.status === 'done' || t.status === 'failed')
    : tasks.filter((t) => t.status === column)
}

/** Monotonic per-session task id. Internal to commandStore (tasks are ephemeral, never serialized). */
let taskSeq = 0
const newTaskId = (): string => `task-${++taskSeq}`

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
  /**
   * Enqueue a new `queued` task (the submit well). Trims the title and IGNORES a blank one,
   * returning the new task id or `null`. Phase B stops here (the card sits in Queued); Phase C
   * extends this same entry point to also decompose + spawn a worker group + dispatch.
   */
  addTask: (title: string) => string | null
  /**
   * Move a task to a new lifecycle status — the kanban transition primitive. Phase C drives this
   * live from worker `subscribeStatus`/settle events; Phase B exercises it from tests/seams.
   */
  setTaskStatus: (id: string, status: TaskStatus) => void
  /** Re-queue a failed task (the Done-column failed card's retry affordance). No-op if not failed. */
  retryTask: (id: string) => void
  /** Drop all tasks (reset / future "clear completed"). */
  clearTasks: () => void
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
    set((s) => ({ collapsed, expandedHeight: expandedHeight ?? s.expandedHeight })),
  addTask: (title) => {
    const t = title.trim()
    if (!t) return null
    const id = newTaskId()
    set((s) => ({ tasks: [...s.tasks, { id, title: t, status: 'queued' }] }))
    return id
  },
  setTaskStatus: (id, status) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) })),
  retryTask: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === 'failed' ? { ...t, status: 'queued' } : t
      )
    })),
  clearTasks: () => set({ tasks: [] })
}))
