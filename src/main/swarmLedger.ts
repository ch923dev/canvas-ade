/**
 * Swarm run ledger (orchestration S2) — the DURABLE half of a swarm run, and MAIN's source of
 * truth for it. S1's run state lived entirely in the renderer's ephemeral `swarmStore` plus MAIN's
 * in-memory `SwarmSession`, so a reload erased the whole run; this module is what survives.
 *
 * Storage (design D1, signed off 2026-07-26 — the user's call, overriding the artifact's userData
 * proposal): ONE file per run at `<project>/.canvas/memory/run-<boardId>.json`, beside the board
 * recap sidecars. `runId === the swarm board id`, so:
 *   - restore is a filename lookup, not an index scan;
 *   - `canvasMemory`'s existing `isSafeId` path guard applies verbatim (no new traversal surface);
 *   - a corrupt ledger poisons exactly ONE run instead of every run in the project.
 *
 * Discipline copied from `mcpPendingCommands.ts` (the precedent the kickoff names) even though the
 * location differs: atomic writes, cap-bounded content, lazy load, and a missing/corrupt sidecar
 * that degrades to "no ledger" instead of throwing. A poisoned file must never block a project open.
 *
 * 🔒 Scene/session split: NOTHING here touches the canvas document. The ledger is a sidecar, not a
 * board field — S2 bumps no `schemaVersion` and adds no `PATCHABLE_KEYS` entry.
 * 🔒 Forward compatibility: a ledger written by a FUTURE app version (higher `version`) is never
 * parsed and never overwritten — that run simply runs ephemeral-only this session.
 */
import { createCanvasMemory, type CanvasMemory } from './canvasMemory'
import {
  MAX_LEDGER_EVENTS,
  MAX_LEDGER_FIELD,
  MAX_LEDGER_LINE,
  MAX_LEDGER_PLAN_ITEMS,
  MAX_LEDGER_REFS,
  MAX_LEDGER_TASKS,
  MAX_RUNS_PER_PROJECT,
  SWARM_BLOCKED_TAGS,
  SWARM_LEDGER_VERSION,
  SWARM_PROVENANCES,
  SWARM_RUN_STATES,
  SWARM_TASK_STATES,
  type SwarmAssignment,
  type SwarmBlockedTag,
  type SwarmLedgerEvent,
  type SwarmPlanItem,
  type SwarmProvenance,
  type SwarmRunLedger,
  type SwarmRunState,
  type SwarmTask,
  type SwarmTaskResult,
  type SwarmTaskSpec,
  type SwarmTaskState
} from '../shared/swarmLedgerTypes'

/** The `canvasMemory` slice this module needs — narrowed so tests inject a plain object. */
export type LedgerMemory = Pick<CanvasMemory, 'writeRun' | 'readRun' | 'removeRun' | 'listRunIds'>

export interface SwarmLedgerDeps {
  /** The ACTIVE project dir, re-read on every access. `null` ⇒ no project ⇒ every call no-ops. */
  getProjectDir: () => string | null
  /** Clock seam (default `Date.now`). */
  now?: () => number
  /** Memory-sidecar seam (default `createCanvasMemory(dir)`), rebuilt whenever the dir changes. */
  memoryFor?: (dir: string) => LedgerMemory
}

export interface SwarmLedgerStore {
  /**
   * Load this run's ledger, creating it on first touch. Returns `null` when there is no project,
   * when the id is not path-safe, or when the on-disk file was written by a NEWER app version
   * (never clobbered — the run degrades to ephemeral-only for this session).
   */
  ensureRun(boardId: string, title: string): SwarmRunLedger | null
  /** Read without creating. `null` = no ledger for this board (or unreadable). */
  readRun(boardId: string): SwarmRunLedger | null
  /**
   * Mutate + persist in one step. `fn` receives a MUTABLE draft; the store clamps every cap
   * afterwards, stamps `lastActiveAt`, and writes atomically. Returns the persisted ledger, or
   * `null` when the run is absent/unwritable (callers keep working ephemerally).
   */
  update(boardId: string, fn: (draft: SwarmRunLedger) => void): SwarmRunLedger | null
  /** Append one event to the bounded tail and persist (stamps `seq`/`at` — callers never do). */
  append(boardId: string, ev: LedgerEventInput): SwarmRunLedger | null
  /** Drop a run's ledger — its swarm board was deleted. */
  removeRun(boardId: string): void
  /** Every readable run ledger in the project, newest `lastActiveAt` first. */
  listRuns(): SwarmRunLedger[]
  /** Drop the in-memory cache (project switch / test reset). On-disk state is untouched. */
  invalidate(): void
}

/** An event without its `seq`/`at` — the store stamps both so the sequence stays gap-free. */
export type LedgerEventInput = DistributiveOmit<SwarmLedgerEvent, 'seq' | 'at'>

/** `Omit` that distributes over a union (a plain `Omit` would collapse the variants into one). */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

// ── coercion: every read is hostile input (a hand-edited or half-written sidecar) ──

const str = (v: unknown, cap: number, fallback = ''): string =>
  typeof v === 'string' ? v.slice(0, cap) : fallback

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

const optOneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.includes(v as T) ? (v as T) : undefined

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

function coerceSpec(v: unknown): SwarmTaskSpec {
  const o = obj(v)
  return {
    objective: str(o.objective, MAX_LEDGER_FIELD),
    context: str(o.context, MAX_LEDGER_FIELD),
    boundaries: str(o.boundaries, MAX_LEDGER_FIELD),
    outputFormat: str(o.outputFormat, MAX_LEDGER_FIELD)
  }
}

function coerceAssignment(v: unknown, now: number): SwarmAssignment | undefined {
  const o = obj(v)
  const boardId = str(o.boardId, MAX_LEDGER_LINE)
  if (!boardId) return undefined
  return {
    boardId,
    role: str(o.role, MAX_LEDGER_LINE),
    spec: coerceSpec(o.spec),
    dispatchedAt: num(o.dispatchedAt, now),
    lastActivityAt: num(o.lastActivityAt, num(o.dispatchedAt, now)),
    stallCount: Math.max(0, Math.floor(num(o.stallCount, 0))),
    // 🔒 S3's fields: read through if a future build wrote them, else the S2 null.
    worktree: typeof o.worktree === 'string' ? o.worktree.slice(0, MAX_LEDGER_LINE) : null,
    branch: typeof o.branch === 'string' ? o.branch.slice(0, MAX_LEDGER_LINE) : null
  }
}

function coerceResult(v: unknown, now: number): SwarmTaskResult | undefined {
  const o = obj(v)
  if (o.status === undefined && o.summary === undefined) return undefined
  const out: SwarmTaskResult = {
    status: str(o.status, MAX_LEDGER_LINE, 'unknown'),
    summary: str(o.summary, MAX_LEDGER_FIELD),
    refs: arr(o.refs)
      .slice(0, MAX_LEDGER_REFS)
      .map((r) => str(r, MAX_LEDGER_LINE))
      .filter((r) => r.length > 0),
    provenance: oneOf(o.provenance, SWARM_PROVENANCES, 'claimed'),
    at: num(o.at, now)
  }
  if (o.acceptedByHuman === true) out.acceptedByHuman = true
  return out
}

function coerceTask(v: unknown, now: number): SwarmTask | null {
  const o = obj(v)
  const taskId = str(o.taskId, MAX_LEDGER_LINE)
  if (!taskId) return null
  const task: SwarmTask = {
    taskId,
    content: str(o.content, MAX_LEDGER_LINE),
    activeForm: str(o.activeForm, MAX_LEDGER_LINE),
    state: oneOf(o.state, SWARM_TASK_STATES, 'pending')
  }
  const planItemId = str(o.planItemId, MAX_LEDGER_LINE)
  if (planItemId) task.planItemId = planItemId
  const tag = optOneOf(o.blockedTag, SWARM_BLOCKED_TAGS)
  if (tag) task.blockedTag = tag
  const assignment = coerceAssignment(o.assignment, now)
  if (assignment) task.assignment = assignment
  const result = coerceResult(o.result, now)
  if (result) task.result = result
  if (typeof o.snoozedUntil === 'number' && Number.isFinite(o.snoozedUntil)) {
    task.snoozedUntil = o.snoozedUntil
  }
  if (o.dismissed === true) task.dismissed = true
  return task
}

function coercePlanItem(v: unknown): SwarmPlanItem | null {
  const o = obj(v)
  const id = str(o.id, MAX_LEDGER_LINE)
  if (!id) return null
  const item: SwarmPlanItem = {
    id,
    label: str(o.label, MAX_LEDGER_LINE),
    done: o.done === true
  }
  const owner = str(o.ownerTaskId, MAX_LEDGER_LINE)
  if (owner) item.ownerTaskId = owner
  return item
}

/**
 * Events are the bounded tail, not the source of truth — a malformed one is DROPPED rather than
 * coerced into a lie (a fabricated `kind` would corrupt the stall counter it feeds).
 */
function coerceEvent(v: unknown): SwarmLedgerEvent | null {
  const o = obj(v)
  const seq = num(o.seq, -1)
  const at = num(o.at, -1)
  if (seq < 0 || at < 0 || typeof o.kind !== 'string') return null
  return { ...o, seq, at, kind: o.kind } as SwarmLedgerEvent
}

/**
 * Parse a raw sidecar into a fully-shaped ledger. Returns `null` for anything unusable — including
 * a FUTURE `version`, which the caller must treat as "hands off this file entirely".
 */
export function coerceLedger(raw: unknown, boardId: string, now: number): SwarmRunLedger | null {
  const o = obj(raw)
  const version = num(o.version, 0)
  if (version !== SWARM_LEDGER_VERSION) return null
  // The filename is authoritative for identity: a sidecar whose body claims a different board is
  // either hand-edited or a copy, and must not be able to redirect writes at another run.
  if (str(o.boardId, MAX_LEDGER_LINE) !== boardId) return null
  const events = arr(o.events)
    .map(coerceEvent)
    .filter((e): e is SwarmLedgerEvent => e !== null)
    .slice(-MAX_LEDGER_EVENTS)
  const createdAt = num(o.createdAt, now)
  return {
    version: SWARM_LEDGER_VERSION,
    runId: boardId,
    boardId,
    title: str(o.title, MAX_LEDGER_LINE),
    createdAt,
    lastActiveAt: num(o.lastActiveAt, createdAt),
    lastSeenAt: num(o.lastSeenAt, createdAt),
    state: oneOf(o.state, SWARM_RUN_STATES, 'live'),
    planBoardId: typeof o.planBoardId === 'string' ? o.planBoardId.slice(0, MAX_LEDGER_LINE) : null,
    planItems: arr(o.planItems)
      .slice(0, MAX_LEDGER_PLAN_ITEMS)
      .map(coercePlanItem)
      .filter((i): i is SwarmPlanItem => i !== null),
    tasks: arr(o.tasks)
      .slice(-MAX_LEDGER_TASKS)
      .map((t) => coerceTask(t, now))
      .filter((t): t is SwarmTask => t !== null),
    events,
    // Keep the sequence monotonic across a reload even if `eventSeq` was lost or under-counted.
    eventSeq: Math.max(num(o.eventSeq, 0), ...events.map((e) => e.seq), 0)
  }
}

/** Re-apply every cap after a caller's mutation, so no code path can grow a sidecar unbounded. */
function clamp(l: SwarmRunLedger): SwarmRunLedger {
  l.title = l.title.slice(0, MAX_LEDGER_LINE)
  l.planItems = l.planItems.slice(0, MAX_LEDGER_PLAN_ITEMS)
  // Drop the OLDEST tasks, same reasoning as the events clamp below — and NOT the newest.
  // `dispatched()` always pushes, so a head-slice would silently discard every task after the
  // 200th: its `assigned` event would still land, pointing at a taskId no longer in `tasks`, and
  // the worker's later `settled()` would find no task and drop the result on the floor. In a run
  // long enough to hit the cap, the tail — the part still being worked — is exactly what must survive.
  if (l.tasks.length > MAX_LEDGER_TASKS) l.tasks = l.tasks.slice(-MAX_LEDGER_TASKS)
  // Drop the OLDEST events — unlike the pending-command queue (where dropping would lose an
  // approved action), an event is a narration/counting aid and the newest tail is what matters.
  if (l.events.length > MAX_LEDGER_EVENTS) l.events = l.events.slice(-MAX_LEDGER_EVENTS)
  for (const t of l.tasks) {
    if (t.result) t.result.refs = t.result.refs.slice(0, MAX_LEDGER_REFS)
  }
  return l
}

function emptyLedger(boardId: string, title: string, now: number): SwarmRunLedger {
  return {
    version: SWARM_LEDGER_VERSION,
    runId: boardId,
    boardId,
    title: title.slice(0, MAX_LEDGER_LINE),
    createdAt: now,
    lastActiveAt: now,
    lastSeenAt: now,
    state: 'live',
    planBoardId: null,
    planItems: [],
    tasks: [],
    events: [],
    eventSeq: 0
  }
}

export function createSwarmLedgerStore(deps: SwarmLedgerDeps): SwarmLedgerStore {
  const now = deps.now ?? Date.now
  const memoryFor = deps.memoryFor ?? ((dir: string): LedgerMemory => createCanvasMemory(dir))

  let boundDir: string | null = null
  let memory: LedgerMemory | null = null
  /** Loaded ledgers for the bound dir. */
  let cache = new Map<string, SwarmRunLedger>()
  /** Boards whose on-disk sidecar is a FUTURE version — never read, never written. */
  let foreign = new Set<string>()

  /** Resolve the memory writer for the ACTIVE dir, re-binding (and dropping the cache) on switch. */
  const bind = (): LedgerMemory | null => {
    const dir = deps.getProjectDir()
    if (dir === null || dir.length === 0) {
      boundDir = null
      memory = null
      cache = new Map()
      foreign = new Set()
      return null
    }
    if (dir !== boundDir) {
      boundDir = dir
      memory = memoryFor(dir)
      cache = new Map()
      foreign = new Set()
    }
    return memory
  }

  /** Read from cache, else disk. Does NOT create. */
  const load = (boardId: string): SwarmRunLedger | null => {
    const mem = bind()
    if (!mem || foreign.has(boardId)) return null
    const hit = cache.get(boardId)
    if (hit) return hit
    let raw: unknown
    try {
      raw = mem.readRun(boardId)
    } catch {
      return null // unreadable sidecar degrades to "no ledger", never throws into a caller
    }
    if (raw === undefined) return null
    const coerced = coerceLedger(raw, boardId, now())
    if (!coerced) {
      // Distinguish "future version" (hands off forever) from "garbage" (safe to overwrite).
      const v = (obj(raw).version as unknown) ?? 0
      if (typeof v === 'number' && v > SWARM_LEDGER_VERSION) foreign.add(boardId)
      return null
    }
    cache.set(boardId, coerced)
    return coerced
  }

  /** Persist one ledger + run the retention sweep. Best-effort: a failed write keeps the cache. */
  const persist = (l: SwarmRunLedger): SwarmRunLedger | null => {
    const mem = bind()
    if (!mem) return null
    clamp(l)
    l.lastActiveAt = now()
    cache.set(l.boardId, l)
    if (!mem.writeRun(l.boardId, l)) return null
    prune(mem, l.boardId)
    return l
  }

  /**
   * Retention (09 Q16): keep the newest MAX_RUNS_PER_PROJECT ledgers by `lastActiveAt`. The run
   * just written is always kept, and an unreadable/foreign sidecar is left alone rather than
   * deleted — pruning is a size guard, not a cleaner of files we could not parse.
   */
  const prune = (mem: LedgerMemory, keepId: string): void => {
    let ids: string[]
    try {
      ids = mem.listRunIds()
    } catch {
      return
    }
    if (ids.length <= MAX_RUNS_PER_PROJECT) return
    const dated = ids
      .filter((id) => id !== keepId)
      .map((id) => ({ id, at: load(id)?.lastActiveAt ?? null }))
      .filter((r): r is { id: string; at: number } => r.at !== null)
      .sort((a, b) => b.at - a.at)
    // -1 for the always-kept current run.
    for (const victim of dated.slice(MAX_RUNS_PER_PROJECT - 1)) {
      mem.removeRun(victim.id)
      cache.delete(victim.id)
    }
  }

  return {
    ensureRun(boardId, title) {
      const mem = bind()
      if (!mem || foreign.has(boardId)) return null
      const existing = load(boardId)
      if (existing) return existing
      if (foreign.has(boardId)) return null // load() may have just discovered a future version
      const fresh = emptyLedger(boardId, title, now())
      fresh.eventSeq = 1
      fresh.events.push({ seq: 1, at: fresh.createdAt, kind: 'runCreated', title: fresh.title })
      return persist(fresh)
    },
    readRun(boardId) {
      return load(boardId)
    },
    update(boardId, fn) {
      const l = load(boardId)
      if (!l) return null
      fn(l)
      return persist(l)
    },
    append(boardId, ev) {
      const l = load(boardId)
      if (!l) return null
      l.eventSeq += 1
      l.events.push({ ...ev, seq: l.eventSeq, at: now() } as SwarmLedgerEvent)
      return persist(l)
    },
    removeRun(boardId) {
      const mem = bind()
      if (!mem) return
      cache.delete(boardId)
      foreign.delete(boardId)
      mem.removeRun(boardId)
    },
    listRuns() {
      const mem = bind()
      if (!mem) return []
      let ids: string[]
      try {
        ids = mem.listRunIds()
      } catch {
        return []
      }
      return ids
        .map((id) => load(id))
        .filter((l): l is SwarmRunLedger => l !== null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    },
    invalidate() {
      boundDir = null
      memory = null
      cache = new Map()
      foreign = new Set()
    }
  }
}

// ── small pure helpers the session layer builds on (kept here so the shapes stay together) ──

/** Find a task by id. */
export function taskById(l: SwarmRunLedger, taskId: string): SwarmTask | undefined {
  return l.tasks.find((t) => t.taskId === taskId)
}

/** Terminal task states — a task here is finished and will never be worked again. (Exported for
 *  the per-turn roster, which mirrors {@link taskForBoard}'s current-task resolution.) */
export const TERMINAL_TASK_STATES: ReadonlySet<SwarmTaskState> = new Set([
  'done',
  'failed',
  'cancelled'
])

/**
 * The task a worker board is currently working, if any — else the last one it finished.
 *
 * A finished task KEEPS its `assignment`: that is the run's only record of who did the work, and
 * the worker cards and `runWorkerIds` read it. So a board reused for a second task (an ordinary
 * pattern — the orchestrator hands the next task to whichever worker went idle) matches several
 * rows, and a first-match scan would resolve to its FIRST-EVER task forever: task 2's `settled()`
 * would overwrite task 1's result while task 2 itself never left `in_progress`. Scan NEWEST first,
 * and prefer an open task, so a re-settle (a worker rewriting its own result) still lands on the
 * row it belongs to.
 */
export function taskForBoard(l: SwarmRunLedger, boardId: string): SwarmTask | undefined {
  let newestFinished: SwarmTask | undefined
  for (let i = l.tasks.length - 1; i >= 0; i--) {
    const t = l.tasks[i]
    if (t.assignment?.boardId !== boardId) continue
    if (!TERMINAL_TASK_STATES.has(t.state)) return t
    newestFinished ??= t
  }
  return newestFinished
}

/** Distinct worker board ids the run has ever assigned work to, in first-assignment order. */
export function runWorkerIds(l: SwarmRunLedger): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of l.tasks) {
    const id = t.assignment?.boardId
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Tasks that are neither finished nor cancelled — the drain set on failure case B. */
export function unsettledTasks(l: SwarmRunLedger): SwarmTask[] {
  return l.tasks.filter(
    (t) => t.state === 'pending' || t.state === 'in_progress' || t.state === 'blocked'
  )
}

/** Mark a task's state and record the transition in the bounded tail (one call, one truth). */
export function setTaskState(
  l: SwarmRunLedger,
  taskId: string,
  state: SwarmTaskState,
  at: number,
  provenance?: SwarmProvenance
): void {
  const task = taskById(l, taskId)
  if (!task) return
  task.state = state
  // A terminal state clears the blocked tag — a done task is not still "needs_input".
  if (state === 'done' || state === 'failed' || state === 'cancelled') delete task.blockedTag
  l.eventSeq += 1
  l.events.push({
    seq: l.eventSeq,
    at,
    kind: 'status',
    taskId,
    state,
    ...(provenance ? { provenance } : {})
  })
}

/** Tag a task as blocked (queue-visible) and record it. */
export function setBlockedTag(
  l: SwarmRunLedger,
  taskId: string,
  tag: SwarmBlockedTag,
  at: number
): void {
  const task = taskById(l, taskId)
  if (!task || task.blockedTag === tag) return
  task.blockedTag = tag
  l.eventSeq += 1
  l.events.push({ seq: l.eventSeq, at, kind: 'blocked', taskId, tag })
}

/** Re-export so callers get the run-state union without a second import path. */
export type { SwarmRunState }
