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
import {
  MAX_FED_TASKS,
  type CommandFeedPush,
  type CommandFeedState
} from '../../../shared/commandFeedTypes'

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
  /**
   * The role pack chosen in the dialog (orchestration Phase 0) — `null`/absent = Custom (the
   * pre-pack behavior, unchanged). Kept as a plain id string so the store stays a leaf (the pack
   * registry lives in `lib/rolePacks.ts`); optional so pre-pack fixtures/configs stay valid.
   */
  rolePackId?: string | null
  /**
   * The role brief as shown (editable) in the dialog for a pack dispatch — the user may extend /
   * trim the pack's default standing orders per dispatch, and the remembered value pre-fills the
   * next one. `null`/absent = Custom dispatch (no brief).
   */
  roleBrief?: string | null
  /**
   * v20 OpenRouter routing intent from the dialog's gated section (absent in ungated builds /
   * when routing is off). Structural mirror of `OpenRouterValue` — kept inline so the store
   * stays a leaf. Rides the spawn so MAIN injects the provider env for the worker terminal.
   */
  openRouter?: { enabled: boolean; model: string }
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
  /**
   * The role pack shaping this dispatch (orchestration Phase 0), committed with the config.
   * Drives the role-brief prompt prepend + the write-role concurrency gate in the pump; absent =
   * Custom dispatch (pre-pack semantics, no role gate beyond the global cap).
   */
  rolePackId?: string
  /**
   * The (possibly user-edited) role brief committed with a pack dispatch — prepended to the
   * gated REPL write in place of the pack's default. Absent = use the pack default (pre-feature
   * tasks); '' = brief explicitly cleared for this dispatch.
   */
  roleBrief?: string
  /**
   * v20: the OpenRouter routing intent committed with the config (enabled-only — the pump passes
   * it to `spawnGroup` so the worker terminal's env routes through OpenRouter). Absent = direct.
   */
  openRouter?: { enabled: boolean; model?: string }
  /** Phase D — the worker's settled result (status·summary·refs), snapshotted at settle. */
  result?: TaskResult
  /** Phase D — the raw `git diff HEAD` captured at settle (cached for the chip + view-diff; '' = none). */
  diff?: string
  /** Phase D — wall-clock ms when the task reached done/failed (the recap TIMELINE timestamp). */
  finishedAt?: number
  /**
   * P4 — this task was FED from an external orchestrator's worker (`commandFeed`), not dispatched
   * from this board. Drives the `ext` chip and suppresses every local control: we did not spawn it,
   * so ⚙ Configure / ↻ Retry would be lies (there is no `launchCommand` to re-run and no local
   * pump slot to re-enter). Absent ⇒ a normal locally-dispatched task, byte-identical to before.
   */
  external?: true
  /**
   * P4 — why a fed worker cannot proceed (a `SwarmBlockedTag`, or its own raw blocked status).
   * Orthogonal to `status`: a blocked worker stays in `executing` and grows a warn chip, rather
   * than moving to a column that does not exist. Cleared by the next non-blocked push.
   */
  blockedTag?: string
  /**
   * P4 — the card's one MAIN-composed disclosure line (off-vocabulary status, blocked reason,
   * idle interval). Rendered verbatim: a reason not in the surface does not exist.
   */
  disclose?: string
  /** P4 — the role pack the fed worker was spawned under, when the ledger knows it. Meta chip only. */
  role?: string
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

/** Statuses a task can no longer leave on its own — the settle set both the lookup and eviction read. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'failed'])

/**
 * P4 — the task a FED worker board is currently working, else the last one it finished.
 *
 * 🔒 SCAN NEWEST-FIRST. A worker board is reused: an orchestrator hands the next task to whichever
 * worker went idle, so one board id matches several tasks, and a finished task KEEPS its group (it
 * is the run's only record of who did the work). A first-match scan would pin every later report
 * onto that board's FIRST-EVER task forever — task 2's result would overwrite task 1's while task 2
 * never left `executing`. This is the exact shape of the live `[critical]` S2 shipped a fix for and
 * S3 hit again; `swarmLedger.taskForBoard` is the same function on the ledger side.
 *
 * Prefer an OPEN task so a worker re-reporting on a task it already settled (a legitimate partial →
 * final sequence) still lands on the row it belongs to rather than opening a phantom second card.
 */
export function externalTaskFor(
  tasks: ReadonlyArray<CommandTask>,
  boardId: string
): CommandTask | undefined {
  let newestSettled: CommandTask | undefined
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i]
    if (t.group?.terminalId !== boardId) continue
    if (!TERMINAL_STATUSES.has(t.status)) return t
    newestSettled ??= t
  }
  return newestSettled
}

/**
 * P4 — map the closed feed vocabulary onto the kanban's `TaskStatus`.
 *
 * `blocked` has no column of its own ON PURPOSE: the column axis is LIFECYCLE, and a blocked worker
 * is still executing — it just cannot proceed. Landing it as `executing` + a chip keeps the column
 * counts honest; a sixth column would strand a finished-but-blocked worker outside Done.
 */
export function feedStateToStatus(state: CommandFeedState): TaskStatus {
  return state === 'blocked' ? 'executing' : state
}

/** Monotonic per-session task id. Internal to commandStore (tasks are ephemeral, never serialized). */
let taskSeq = 0
const newTaskId = (): string => `task-${++taskSeq}`
/** Monotonic per-session group id for a FED worker (it has no local `spawnGroup` to mint one). */
let fedSeq = 0

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
  /**
   * P4 — how many FED worker cards the cap has evicted this session. Rendered as the Done column's
   * foot line (`+N more workers not shown · feed cap 50`). A silently-capped feed is worse than no
   * feed: the human reads absence as "nothing happened", so the count is always on the surface.
   */
  fedDropped: number
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
   * edited) `prompt` + the chosen role pack (Phase 0; absent = Custom). Setting `launchCommand`
   * marks the task READY so the pump spawns it.
   */
  setTaskConfig: (
    id: string,
    config: {
      launchCommand: string
      prompt: string
      rolePackId?: string
      roleBrief?: string
      openRouter?: { enabled: boolean; model?: string }
    }
  ) => void
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
   * P4 — apply ONE external-worker feed push (`commandFeed`), upserting the fed task keyed by its
   * worker board id. `title` is resolved by the CALLER against the live canvas (the renderer is the
   * title authority; MAIN carries ids only). Absent push fields mean "unchanged" — a status-only
   * push can never wipe a previously reported result.
   */
  applyFeed: (push: CommandFeedPush, title: string) => void
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
  | 'tasks'
  | 'view'
  | 'collapsed'
  | 'expandedHeight'
  | 'configuringTaskId'
  | 'lastWorkerConfig'
  | 'fedDropped'
> {
  return {
    tasks: [],
    view: 'kanban',
    collapsed: false,
    expandedHeight: null,
    configuringTaskId: null,
    lastWorkerConfig: null,
    fedDropped: 0
  }
}

/**
 * P4 — evict fed tasks down to {@link MAX_FED_TASKS}, OLDEST-SETTLED FIRST, returning the survivors
 * plus how many were dropped. Locally-dispatched tasks are never touched (the human owns those) and
 * a fed task that is still in flight is never evicted — dropping a live worker would erase the very
 * thing the board exists to show. Pure + unit-testable; the caller adds the count to `fedDropped`.
 */
export function evictFedTasks(tasks: ReadonlyArray<CommandTask>): {
  tasks: CommandTask[]
  dropped: number
} {
  const fedCount = tasks.reduce((n, t) => n + (t.external ? 1 : 0), 0)
  if (fedCount <= MAX_FED_TASKS) return { tasks: [...tasks], dropped: 0 }
  let over = fedCount - MAX_FED_TASKS
  const doomed = new Set<string>()
  for (const t of tasks) {
    if (over === 0) break
    if (!t.external || !TERMINAL_STATUSES.has(t.status)) continue
    doomed.add(t.id)
    over -= 1
  }
  if (doomed.size === 0) return { tasks: [...tasks], dropped: 0 }
  return { tasks: tasks.filter((t) => !doomed.has(t.id)), dropped: doomed.size }
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
        t.id === id
          ? {
              ...t,
              launchCommand: config.launchCommand,
              prompt: config.prompt,
              // A reconfigure back to Custom must CLEAR a previously-committed pack + brief
              // (and a routing opt-out must clear a previously-committed openRouter intent).
              rolePackId: config.rolePackId,
              roleBrief: config.roleBrief,
              openRouter: config.openRouter
            }
          : t
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
  applyFeed: (push, title) =>
    set((s) => {
      const existing = externalTaskFor(s.tasks, push.boardId)
      // A push that would only re-open a LOCALLY dispatched task is refused: the local pump owns
      // that task's lifecycle (it is awaiting a settle), and a fed status would race it. The fed
      // half of the board is strictly additive to what the human dispatched here.
      if (existing && !existing.external) return s
      const status = push.state ? feedStateToStatus(push.state) : undefined
      const settled = status !== undefined && TERMINAL_STATUSES.has(status)
      // `blocked` is the ONLY state that carries a tag; any other state clears it, so a stale
      // reason can never outlive the block it described.
      const blockedTag = push.state === 'blocked' ? push.blockedTag : undefined
      const patch = {
        ...(status !== undefined ? { status } : {}),
        // Absent means UNCHANGED, never cleared — a status-only push must not wipe a report.
        ...(push.result !== undefined ? { result: push.result } : {}),
        ...(push.role !== undefined ? { role: push.role } : {}),
        // `disclose` and `blockedTag` are state-scoped: they describe THIS push, so an absent value
        // clears the previous one rather than leaving a stale line on the card.
        disclose: push.disclose,
        blockedTag,
        ...(settled ? { finishedAt: Date.now() } : {})
      }
      if (existing) {
        return { tasks: s.tasks.map((t) => (t.id === existing.id ? { ...t, ...patch } : t)) }
      }
      const task: CommandTask = {
        id: newTaskId(),
        title,
        // A first push with no state is a bare result — the worker is reporting, not queued.
        status: status ?? 'reporting',
        external: true,
        group: { groupId: `fed-${++fedSeq}`, terminalId: push.boardId },
        ...patch
      }
      const { tasks, dropped } = evictFedTasks([...s.tasks, task])
      return { tasks, ...(dropped > 0 ? { fedDropped: s.fedDropped + dropped } : {}) }
    }),
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
  // The fed-drop count describes the tasks that were here; clearing them clears its subject too,
  // otherwise an empty board would still claim workers were hidden.
  clearTasks: () => set({ tasks: [], configuringTaskId: null, fedDropped: 0 })
}))
