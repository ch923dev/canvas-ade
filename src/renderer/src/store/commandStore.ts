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

/**
 * A settled worker's structured result, snapshotted onto the task in Phase D (collect/merge). The
 * dispatch hook already reads this off `awaitSettled` — we just keep it. Structurally a mirror of
 * the package `BoardResult` / `commandDispatch.WorkerResult` (the fields we surface); declared here
 * because commandStore is a LEAF — `commandDispatch.ts` imports from it, so it can't import back.
 */
export interface TaskResult {
  present?: boolean
  status?: string
  summary?: string
  refs?: string[]
}

/**
 * The worker-launch config chosen in the dispatch dialog (C2d) — remembered as `lastWorkerConfig`
 * to pre-fill the next dispatch. Structural mirror of the terminal command-builder state (presetId
 * + per-option values + a manual raw override); kept layer-independent (no import from the terminal
 * builder) so the store stays a leaf.
 */
export interface WorkerConfig {
  presetId: string
  values: Record<string, string | boolean>
  rawOverride: string | null
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
  /** Smart Title-Case intent name for the spawned zone (the LLM `eng.title`), set after engineering. */
  zoneName?: string
  /**
   * The engineered agent instruction — set after engineering, EDITABLE in the config dialog, handed
   * to the worker once ready, and revealed on the kanban card. Absent until engineering completes.
   */
  prompt?: string
  /**
   * The worker's launch command chosen in the config dialog (C2d). A queued task is only
   * "ready to dispatch" (the pump spawns it) once this is set; absent = still being configured /
   * config cancelled. No hardcoded default — the dialog (default preset `claude`) owns it.
   */
  launchCommand?: string
  /** Phase D — the worker's settled result (status·summary·refs), snapshotted at settle. */
  result?: TaskResult
  /** Phase D — the raw `git diff HEAD` captured at settle (cached for the chip + view-diff; '' = none). */
  diff?: string
  /** Phase D — wall-clock ms when the task reached done/failed (the recap TIMELINE timestamp). */
  finishedAt?: number
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

/**
 * Phase D — split tasks into the flip-to-recap face's two zones. NOW = in-flight tasks (routing ·
 * executing · reporting) in queue order; TIMELINE = finished tasks (done · failed) NEWEST-FIRST
 * (by `finishedAt`, falling back to a stable order when a timestamp is absent — e.g. a board-gone
 * failure). Pure + unit-testable; the single source of the recap bucketing.
 */
const NOW_STATUSES: ReadonlySet<TaskStatus> = new Set(['routing', 'executing', 'reporting'])
export function recapBuckets(tasks: ReadonlyArray<CommandTask>): {
  now: CommandTask[]
  timeline: CommandTask[]
} {
  const now = tasks.filter((t) => NOW_STATUSES.has(t.status))
  const timeline = tasks
    .filter((t) => t.status === 'done' || t.status === 'failed')
    .map((t, i) => ({ t, i }))
    // newest first; ties / missing timestamps keep their relative array order (stable).
    .sort((a, b) => (b.t.finishedAt ?? 0) - (a.t.finishedAt ?? 0) || a.i - b.i)
    .map(({ t }) => t)
  return { now, timeline }
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
  /**
   * The task whose WORKER CONFIG dialog is open (C2d) — the single-at-a-time lock. Set after a task's
   * prompt is engineered; cleared on Dispatch (task becomes ready) or Cancel. `null` = no dialog.
   */
  configuringTaskId: string | null
  /** The worker config chosen on the LAST dispatch — pre-fills the next config dialog. Session-scoped. */
  lastWorkerConfig: WorkerConfig | null
  setView: (view: CommandView) => void
  /** Set collapsed; pass the pre-collapse height when collapsing so expand can restore it. */
  setCollapsed: (collapsed: boolean, expandedHeight?: number) => void
  /**
   * Enqueue a new `queued` task (the submit well), carrying the requested `composition`. Trims the
   * title and IGNORES a blank one, returning the new task id or `null`. The task is NOT yet
   * dispatchable — the hook engineers its prompt, then opens the config dialog; only after Dispatch
   * (a `launchCommand` set via `setTaskConfig`) does the pump spawn it.
   */
  addTask: (title: string, composition?: Composition) => string | null
  /** Store the engineered prompt + smart zone name on a task (after engineering, before the dialog). */
  setTaskPrompt: (id: string, prompt: string, zoneName: string) => void
  /** Open/close the worker-config dialog for a task (the single-at-a-time lock). */
  setConfiguring: (id: string | null) => void
  /**
   * Commit the config dialog's result (C2d Dispatch): the chosen `launchCommand` + the (possibly
   * edited) `prompt`. Setting `launchCommand` marks the task READY so the pump spawns it.
   */
  setTaskConfig: (id: string, config: { launchCommand: string; prompt: string }) => void
  /** Remember the dialog's config to pre-fill the next dispatch. */
  setLastWorkerConfig: (config: WorkerConfig) => void
  /** Attach the spawned worker group to a task (set when routing starts). Runtime-only. */
  setTaskGroup: (id: string, group: TaskGroup) => void
  /**
   * Phase D (collect/merge) — snapshot a settled worker's result + its captured raw diff onto the
   * task and stamp `finishedAt`. Called once at settle, before the final done/failed transition;
   * the recap TIMELINE + the card result zone read it. No-op if the task is gone (cleared mid-flight).
   */
  setTaskResult: (id: string, result: TaskResult, diff: string) => void
  /**
   * Move a task to a new lifecycle status — the kanban transition primitive. Phase C drives this
   * live from the dispatch choreography + the worker status push.
   */
  setTaskStatus: (id: string, status: TaskStatus) => void
  /**
   * Re-queue a failed task (the Done-column failed card's retry affordance) — clears its old group
   * so the dispatch pump re-spawns a fresh one. KEEPS the stored `launchCommand`/`prompt` so the
   * retry reuses the config (no re-config dialog). No-op if not failed.
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
  'tasks' | 'view' | 'collapsed' | 'expandedHeight' | 'configuringTaskId' | 'lastWorkerConfig'
> {
  return {
    tasks: [],
    view: 'kanban',
    collapsed: false,
    expandedHeight: null,
    configuringTaskId: null,
    lastWorkerConfig: null
  }
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
  setTaskPrompt: (id, prompt, zoneName) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, prompt, zoneName } : t)) })),
  setConfiguring: (id) => set({ configuringTaskId: id }),
  setTaskConfig: (id, config) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, launchCommand: config.launchCommand, prompt: config.prompt } : t
      )
    })),
  setLastWorkerConfig: (config) => set({ lastWorkerConfig: config }),
  setTaskGroup: (id, group) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, group } : t)) })),
  setTaskResult: (id, result, diff) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, result, diff, finishedAt: Date.now() } : t))
    })),
  setTaskStatus: (id, status) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) })),
  retryTask: (id) =>
    set((s) => ({
      // failed → queued; clear the group AND the prior run's result/diff/finishedAt so the
      // re-spawn starts clean (KEEPS launchCommand/prompt so the retry reuses the config).
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === 'failed'
          ? {
              ...t,
              status: 'queued',
              group: undefined,
              result: undefined,
              diff: undefined,
              finishedAt: undefined
            }
          : t
      )
    })),
  clearTasks: () => set({ tasks: [], configuringTaskId: null })
}))
