/**
 * Swarm run-ledger contract (orchestration S2) — the ONE declaration of the durable run shape
 * and of every MAIN⇄renderer projection built from it.
 *
 * Imported by MAIN (`src/main/swarmLedger.ts`, `swarmChatIpc.ts`), the preload bridge, and the
 * renderer (`swarmStore`, the Swarm board). Same rationale as `src/shared/mcpTypes.ts`: a field
 * drift between the two sides would pass both sides' unit tests and only surface at runtime, so
 * there is exactly one declaration and a drift is a compile error on whichever side lags.
 *
 * Unlike `mcpTypes.ts` this module DOES carry value exports (the closed vocabularies + the caps),
 * following the `shared/rolePacks.ts` precedent — plain literals with no imports, so nothing
 * Node-flavoured can leak into the renderer bundle. 🔒 Do not add Node/DOM/Electron imports here.
 *
 * Design contract: `docs/orchestration/s2-design-artifact.html` §6 (signed off 2026-07-26).
 * The ledger is a project sidecar at `<project>/.canvas/memory/run-<boardId>.json` — it is NOT a
 * board-schema field, so S2 bumps no canvas schema and touches no `PATCHABLE_KEYS`.
 */

/** Ledger file format version. Bump only on a BREAKING shape change (a reader rejects unknowns). */
export const SWARM_LEDGER_VERSION = 1

/**
 * No ledger-observable activity for this long ⇒ the task is surfaced as STALLED (design D4).
 * Sits deliberately between the transcript-idle threshold (`IDLE_AFTER_MS`, 60s — far too eager;
 * a coding agent thinks for minutes) and the barrier backstop (30m — far too late to be triage).
 * ALWAYS disclosed in the UI string next to the elapsed time; never a silent cap (06 §2).
 */
export const SWARM_STALL_THRESHOLD_MS = 10 * 60 * 1000

/** Retention: newest N run ledgers per project, pruned by `lastActiveAt` on write (09 Q16). */
export const MAX_RUNS_PER_PROJECT = 20

/** Per-run caps. A runaway orchestrator must not grow one sidecar unbounded. */
export const MAX_LEDGER_TASKS = 200
export const MAX_LEDGER_PLAN_ITEMS = 100
/** Bounded event TAIL (not a full event log — S3 grows this into `09 §3`'s log, D3). */
export const MAX_LEDGER_EVENTS = 500
export const MAX_LEDGER_REFS = 256

/** String clamps, matching the caps the swarm tool executor already applies to model output. */
export const MAX_LEDGER_FIELD = 4000
export const MAX_LEDGER_LINE = 500

/** A run's lifecycle. `interrupted` = the orchestrator died with live workers (failure case B). */
export const SWARM_RUN_STATES = ['live', 'interrupted', 'done'] as const
export type SwarmRunState = (typeof SWARM_RUN_STATES)[number]

/** A task's lifecycle (09 §3). `blocked` is orthogonal to the terminal states. */
export const SWARM_TASK_STATES = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled'
] as const
export type SwarmTaskState = (typeof SWARM_TASK_STATES)[number]

/**
 * The CLOSED triage vocabulary. Tags, never prose — "you cannot write a triage rule against a
 * paragraph" (09 §3). Array order IS the risk order the triage queue sorts by (design §5).
 */
export const SWARM_BLOCKED_TAGS = [
  'needs_input',
  'lost',
  'failing_check',
  'stalled',
  'dependency',
  'unreviewed'
] as const
export type SwarmBlockedTag = (typeof SWARM_BLOCKED_TAGS)[number]

/**
 * Result provenance (09 §1). `claimed` = the worker's own `write_result`, unchecked. `synthesized`
 * = derived by `boardResultSynth` from the transcript. S2 never upgrades one to the other, and the
 * narrative may never present a claim as a verification.
 */
export const SWARM_PROVENANCES = ['claimed', 'synthesized'] as const
export type SwarmProvenance = (typeof SWARM_PROVENANCES)[number]

/** The actions a triage row may offer. The renderer renders them; MAIN re-validates every one. */
export const SWARM_TRIAGE_ACTIONS = ['open', 'reassign', 'accept', 'wait', 'dismiss'] as const
export type SwarmTriageAction = (typeof SWARM_TRIAGE_ACTIONS)[number]

/** One plan-strip item, mirrored from the run's Planning-board checklist (join key = `id`). */
export interface SwarmPlanItem {
  /** The PLANNING checklist item's own id — stable across adds/removes, unlike an index. */
  id: string
  label: string
  done: boolean
  /** The task currently working this item, when one owns it (drives the chip's owner dot). */
  ownerTaskId?: string
}

/** The four-field task spec every dispatch carries (07 §4.1). */
export interface SwarmTaskSpec {
  objective: string
  context: string
  boundaries: string
  outputFormat: string
}

/** What a task was dispatched to, and the liveness facts the stall detector reads. */
export interface SwarmAssignment {
  /** The worker terminal board's id — the stable join key across a restart (A4-F7). */
  boardId: string
  role: string
  spec: SwarmTaskSpec
  dispatchedAt: number
  /** Last ledger-observable activity. The stall detector measures `now - lastActivityAt`. */
  lastActivityAt: number
  /** Counted stall transitions (Magentic-One's stall counter), NOT a vibe. */
  stallCount: number
  /**
   * 🔒 S3 populates these. S2 writes `null` deliberately so the field EXISTS in the schema today
   * and Phase 3 needs no format bump — the kickoff calls this out explicitly. Nothing in S2 reads
   * them and no chip renders from them.
   */
  worktree: string | null
  branch: string | null
}

/** A task's settled result, carrying its provenance so the UI can never launder a claim. */
export interface SwarmTaskResult {
  status: string
  summary: string
  refs: string[]
  provenance: SwarmProvenance
  at: number
  /** The human pressed Accept on a salvaged result. Acceptance is NOT verification. */
  acceptedByHuman?: true
}

/** One unit of work. `content`/`activeForm` are the dual-label rule (09 §3). */
export interface SwarmTask {
  taskId: string
  /** The plan item this task fulfils, when it maps to one. */
  planItemId?: string
  /** Imperative — "Migrate the settings schema". Reads correctly in a recap. */
  content: string
  /** Present-continuous — "Migrating settings schema…". Reads correctly on a live card. */
  activeForm: string
  state: SwarmTaskState
  blockedTag?: SwarmBlockedTag
  assignment?: SwarmAssignment
  result?: SwarmTaskResult
  /** The human pressed Wait on a stall row — suppresses re-surfacing until this timestamp. */
  snoozedUntil?: number
}

/** The bounded event tail. Enough to count stalls and narrate; not yet a full event log (D3). */
export type SwarmLedgerEvent =
  | { seq: number; at: number; kind: 'runCreated'; title: string }
  | { seq: number; at: number; kind: 'taskCreated'; taskId: string }
  | { seq: number; at: number; kind: 'assigned'; taskId: string; boardId: string; role: string }
  | {
      seq: number
      at: number
      kind: 'status'
      taskId: string
      state: SwarmTaskState
      provenance?: SwarmProvenance
    }
  | { seq: number; at: number; kind: 'blocked'; taskId: string; tag: SwarmBlockedTag }
  | { seq: number; at: number; kind: 'stall'; taskId: string; count: number; silentMs: number }
  | {
      seq: number
      at: number
      kind: 'salvaged'
      taskId: string
      boardId: string
      provenance: SwarmProvenance
    }
  | { seq: number; at: number; kind: 'interrupted'; liveTasks: number }
  | { seq: number; at: number; kind: 'restored'; workers: number; results: number }

/**
 * The durable run record — ONE file, `<project>/.canvas/memory/run-<boardId>.json`.
 * `runId === boardId` (the swarm board's id), which is what makes restore a filename lookup and
 * lets the existing `isSafeId` path guard apply verbatim.
 */
export interface SwarmRunLedger {
  version: number
  runId: string
  boardId: string
  title: string
  createdAt: number
  lastActiveAt: number
  /** When the human last looked at this run — bounds the "what did I miss" window (09 §4B). */
  lastSeenAt: number
  state: SwarmRunState
  planBoardId: string | null
  planItems: SwarmPlanItem[]
  tasks: SwarmTask[]
  events: SwarmLedgerEvent[]
  /** Monotonic event sequence, gap-free for the life of the run (the audit-log discipline). */
  eventSeq: number
}

// ── MAIN → renderer projections (pushed over the EXISTING `swarm:runEvent` channel) ──

/**
 * Per-worker ledger state the card renders BEYOND what attention/PTY-running already say.
 * `disclose` is composed MAIN-side so the mono third line has ONE source of truth — the S1
 * eyeball bug (a reason not carried in the visible string is a reason that does not exist).
 */
export interface SwarmWorkerLedgerState {
  boardId: string
  taskId?: string
  role?: string
  /** The task's `activeForm` — a specific verb, never a spinner (09 §4A). */
  activity?: string
  /** Beyond the S1 states: the two S2 additions. Absent ⇒ S1's derivation stands. */
  state?: 'stalled' | 'lost'
  provenance?: SwarmProvenance
  /** The card's mono disclosure line, already formatted (threshold / exit reason / counts). */
  disclose?: string
}

/**
 * One triage-queue row. Carries `boardId`, NOT a title — the renderer already resolves titles
 * against the live canvas (S1's `titleOf`), and MAIN must not become a second title authority.
 */
export interface SwarmTriageRow {
  /** Stable React key + the id every action re-validates against (a taskId, else a boardId). */
  id: string
  tag: SwarmBlockedTag
  boardId: string
  /** The sentence tail rendered after the bold worker title. */
  text: string
  actions: SwarmTriageAction[]
}

/** The whole renderer-facing projection of a run's durable state. Bounded: no raw task specs. */
export interface SwarmLedgerSnapshot {
  runId: string
  state: SwarmRunState
  /** True on the push that follows a rehydrate — drives the header's `restored` chip. */
  restored: boolean
  createdAt: number
  planBoardId: string | null
  counts: { workers: number; results: number }
  workers: SwarmWorkerLedgerState[]
  /** Already risk-ordered by `SWARM_BLOCKED_TAGS` order; the renderer does not re-sort. */
  triage: SwarmTriageRow[]
}
