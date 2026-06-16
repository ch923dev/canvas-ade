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
 * Phase C makes it LIVE: `addTask` enqueues a `queued` task carrying its requested `composition`;
 * the dispatch hook (`useCommandDispatch`) spawns a worker group, attaches it via `setTaskGroup`,
 * and drives `setTaskStatus` through routing → executing → done/failed (the authoritative verdict
 * comes from `handoffPrompt`'s settle). `view`/`collapsed`/`expandedHeight` back the seg + expand↔rail
 * toggle. Result/recap state lands in D. Everything here is ephemeral — never serialized.
 */
import { create } from 'zustand'

/** The task lifecycle state machine (kanban columns). Cards advance left→right as workers progress. */
export type TaskStatus = 'queued' | 'routing' | 'executing' | 'reporting' | 'done' | 'failed'

/** Which worker boards a task's group spawns. Terminal is always present (implicit). */
export interface Composition {
  planning: boolean
  browser: boolean
}

/** The named group a dispatched task owns (mirrors the orchestrator's `SpawnGroupResult`). */
export interface TaskGroup {
  groupId: string
  terminalId: string
  planningId?: string
  browserId?: string
}

/** One orchestrator task. Phase C adds the requested `composition` + the spawned `group` (runtime). */
export interface CommandTask {
  id: string
  title: string
  status: TaskStatus
  /** Composition requested at submit (drives `spawnGroup` + slot accounting). Default terminal-only. */
  composition?: Composition
  /** The spawned worker group, attached once routing starts. Runtime-only — never serialized. */
  group?: TaskGroup
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
   * Enqueue a new `queued` task (the submit well), carrying the requested `composition`. Trims the
   * title and IGNORES a blank one, returning the new task id or `null`. The dispatch hook picks the
   * queued task up and runs the spawn → dispatch choreography (serialized at the spawn cap).
   */
  addTask: (title: string, composition?: Composition) => string | null
  /** Attach the spawned worker group to a task (set when routing starts). Runtime-only. */
  setTaskGroup: (id: string, group: TaskGroup) => void
  /**
   * Move a task to a new lifecycle status — the kanban transition primitive. Phase C drives this
   * live from the dispatch choreography + the worker status push.
   */
  setTaskStatus: (id: string, status: TaskStatus) => void
  /**
   * Re-queue a failed task (the Done-column failed card's retry affordance) — clears its old group
   * so the dispatch pump re-spawns a fresh one. No-op if not failed.
   */
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
  addTask: (title, composition) => {
    const t = title.trim()
    if (!t) return null
    const id = newTaskId()
    set((s) => ({ tasks: [...s.tasks, { id, title: t, status: 'queued', composition }] }))
    return id
  },
  setTaskGroup: (id, group) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, group } : t)) })),
  setTaskStatus: (id, status) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) })),
  retryTask: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === 'failed' ? { ...t, status: 'queued', group: undefined } : t
      )
    })),
  clearTasks: () => set({ tasks: [] })
}))
