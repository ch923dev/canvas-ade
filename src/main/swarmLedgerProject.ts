/**
 * Swarm ledger → renderer projection (orchestration S2) — PURE functions, no I/O, no clock of
 * their own (`now` is always passed in). Split out of `swarmLedger.ts` under the max-lines
 * doctrine, and because this is the half worth exhaustively unit-testing: the stall math and the
 * triage ordering are the two places a wrong answer is silently wrong on screen.
 *
 * What it produces is `SwarmLedgerSnapshot` — the bounded view MAIN pushes over the EXISTING
 * `swarm:runEvent` channel (the kickoff forbids inventing a second sync path). Deliberately NOT
 * included: raw four-field task specs (the board never renders them; the confirm modal does).
 *
 * 🔒 The two-source rule for triage rows. Ledger-derived rows (`lost` · `failing_check` ·
 * `stalled` · `dependency` · `unreviewed`) are built HERE. The `needs_input` rows are built in the
 * RENDERER from `attentionStore`, which is the live authority on "an agent is asking a human" —
 * MAIN has no better signal and duplicating it would create two disagreeing truths. The renderer
 * concatenates both and sorts by `SWARM_BLOCKED_TAGS` order, in which `needs_input` is index 0, so
 * the human-blocking rows land on top without either side needing to know about the other.
 */
import {
  SWARM_BLOCKED_TAGS,
  SWARM_STALL_THRESHOLD_MS,
  type SwarmLedgerSnapshot,
  type SwarmMergeStep,
  type SwarmRunLedger,
  type SwarmTask,
  type SwarmTriageRow,
  type SwarmWorkerLedgerState,
  type SwarmWorktreeChip,
  type SwarmWorktreeStatus
} from '../shared/swarmLedgerTypes'
import {
  buildMergeSequence,
  describeOverlapFiles,
  detectOverlaps,
  normalizeRef,
  overlapKey,
  type MergeCandidate,
  type OverlapPair
} from './swarmOverlap'

/**
 * S3 — live git facts keyed by worktree PATH, read from disk by MAIN and passed in, because this
 * module owns no I/O. A path missing from the map is UNKNOWN: chips and rows that depend on
 * dirtiness simply do not claim anything, rather than claiming "clean".
 */
export type WorktreeStatusMap = Readonly<Record<string, SwarmWorktreeStatus>>

/** Compact duration for a UI string: `45s` / `18m` / `2h 05m`. Matches the card timer's weight. */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * How long a task's worker has been silent. `null` when the task carries no assignment (nothing
 * has been dispatched, so there is nothing to be silent about) — callers must not read that as 0.
 */
export function silentMs(task: SwarmTask, now: number): number | null {
  const a = task.assignment
  if (!a) return null
  return Math.max(0, now - a.lastActivityAt)
}

/**
 * Is this task stalled? Only an IN-PROGRESS, assigned, un-snoozed task can stall: a pending task
 * has no worker, a blocked-on-a-human task is the human's turn (that is `needs_input`, not a
 * stall), and a settled task is finished. This is why the stalled card keeps a neutral border —
 * a stalled worker is not asking anyone for anything.
 */
export function isStalled(
  task: SwarmTask,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS
): boolean {
  if (task.state !== 'in_progress') return false
  if (task.snoozedUntil !== undefined && now < task.snoozedUntil) return false
  const silent = silentMs(task, now)
  return silent !== null && silent >= thresholdMs
}

/** 1-based plan position for a task, for the `task 3 · …` disclosure. `null` when unmapped. */
function planPosition(ledger: SwarmRunLedger, task: SwarmTask): number | null {
  if (!task.planItemId) return null
  const i = ledger.planItems.findIndex((p) => p.id === task.planItemId)
  return i < 0 ? null : i + 1
}

/**
 * The card's mono third line. ONE source of truth for this string, MAIN-side, because the S1
 * eyeball bug proved the rule: a reason not carried in the visible string is a reason that does
 * not exist. Kept terse — the worker grid's minimum column is 180px and a truncated disclosure
 * discloses nothing.
 */
export function discloseFor(
  ledger: SwarmRunLedger,
  task: SwarmTask,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS
): string | undefined {
  if (task.blockedTag === 'lost' || (task.state === 'failed' && task.result)) {
    const r = task.result
    if (!r) return 'lost mid-task'
    const derived = r.provenance === 'synthesized' ? 'derived' : 'claimed'
    const files =
      r.refs.length > 0 ? ` · ${r.refs.length} file${r.refs.length === 1 ? '' : 's'}` : ''
    return `${r.status} · ${derived}${files}`
  }
  if (isStalled(task, now, thresholdMs)) {
    const silent = silentMs(task, now) ?? 0
    return `stalled ${fmtDur(silent)} · threshold ${fmtDur(thresholdMs)}`
  }
  const pos = planPosition(ledger, task)
  const label = pos !== null ? `task ${pos}` : task.content.slice(0, 40)
  if (task.state === 'in_progress' && task.assignment) {
    return `${label} · dispatched ${fmtDur(now - task.assignment.dispatchedAt)} ago`
  }
  if (task.result) {
    const files = task.result.refs.length
    return files > 0 ? `${label} · ${files} file${files === 1 ? '' : 's'}` : label
  }
  return label || undefined
}

/**
 * S3 — the card's worktree line (design variant C). Returns `undefined` for a worker with no
 * worktree, which is the point: a read-only role's card is byte-identical to what S2 shipped, and
 * isolation cost is visibly paid only by writers.
 *
 * The trailing `note` is the only state-dependent part and says the one thing a human needs from
 * a branch at that moment: how much is in it, that it is mergeable, or that its tree was
 * PRESERVED rather than destroyed. Composed here beside `discloseFor` so there is exactly one
 * source for these strings (the S1 eyeball lesson).
 */
export function worktreeChipFor(
  task: SwarmTask,
  status: SwarmWorktreeStatus | undefined
): SwarmWorktreeChip | undefined {
  const a = task.assignment
  if (!a?.branch || !a.worktree) return undefined
  const leaf = a.branch.split('/').filter(Boolean).pop() ?? a.branch
  const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`
  const running = task.state === 'in_progress'
  let note: string
  if (status?.exists === false) {
    // The tree was disposed of or removed; the BRANCH is what survives and is still mergeable.
    note = 'branch only · worktree removed'
  } else if (status?.dirty && !running) {
    // Never "lost" or "deleted": the locked policy kept it, and the string has to say so.
    note = `kept, ${status.changed} uncommitted`
  } else if (running) {
    note = status ? (status.changed > 0 ? files(status.changed) : 'no changes yet') : 'working'
  } else if (task.result) {
    note = `${files(task.result.refs.length)} · ready`
  } else {
    note = 'ready'
  }
  return {
    branch: a.branch,
    leaf,
    note,
    ...(status?.dirty && !running ? { dirty: true as const } : {})
  }
}

/** Per-worker ledger state for the cards, in the run's first-assignment order. */
export function workerStates(
  ledger: SwarmRunLedger,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS,
  worktrees: WorktreeStatusMap = {}
): SwarmWorkerLedgerState[] {
  const out: SwarmWorkerLedgerState[] = []
  const seen = new Set<string>()
  for (const task of ledger.tasks) {
    const a = task.assignment
    if (!a || seen.has(a.boardId)) continue
    seen.add(a.boardId)
    const entry: SwarmWorkerLedgerState = { boardId: a.boardId, taskId: task.taskId, role: a.role }
    if (task.activeForm) entry.activity = task.activeForm
    if (task.blockedTag === 'lost') entry.state = 'lost'
    else if (isStalled(task, now, thresholdMs)) entry.state = 'stalled'
    if (task.result) entry.provenance = task.result.provenance
    const disclose = discloseFor(ledger, task, now, thresholdMs)
    if (disclose) entry.disclose = disclose
    const chip = worktreeChipFor(task, a.worktree ? worktrees[a.worktree] : undefined)
    if (chip) entry.worktree = chip
    out.push(entry)
  }
  return out
}

// ── S3: integration (the collision worktree isolation cannot remove) ──

/** A task is finished for integration purposes — its branch holds whatever it produced. */
function isSettledForMerge(task: SwarmTask): boolean {
  return task.state === 'done' || task.state === 'failed' || task.blockedTag === 'lost'
}

/**
 * 🔒 Worktrees a RUNNING task is currently writing to. Exported because it is the single
 * definition of "busy" that both the triage projection and MAIN's dispose gate must agree on: a
 * worker reused for a second task keeps ONE worktree, so liveness cannot be read off whichever
 * task record happens to be in hand. Anything destructive keys off this, never off a task's own
 * state.
 */
export function liveWorktrees(ledger: SwarmRunLedger): string[] {
  const out = new Set<string>()
  for (const t of ledger.tasks) {
    if (t.state === 'in_progress' && t.assignment?.worktree) out.add(t.assignment.worktree)
  }
  return [...out]
}

/**
 * One entry per BRANCH (not per task): a worker that took several tasks holds ONE worktree, so its
 * branch must appear once, carrying the union of everything it touched. A branch with any task
 * still `in_progress` is excluded entirely — it is not finished, and offering it for merge would
 * invite the human to merge work that is still being written.
 *
 * Ordering is the dependency order the human authored: plan-item position first (the plan strip
 * IS that order), then dispatch time for tasks that map to no plan item.
 */
export function mergeCandidates(
  ledger: SwarmRunLedger,
  worktrees: WorktreeStatusMap = {}
): Array<MergeCandidate & { worktree: string; refs: string[] }> {
  interface Group {
    branch: string
    worktree: string
    boardId: string
    taskId: string
    label: string
    refs: string[]
    planPos: number
    dispatchedAt: number
    live: boolean
  }
  const groups = new Map<string, Group>()
  for (const task of ledger.tasks) {
    const a = task.assignment
    if (!a?.branch || !a.worktree) continue
    const pos = planPosition(ledger, task)
    const g = groups.get(a.branch)
    if (!g) {
      groups.set(a.branch, {
        branch: a.branch,
        worktree: a.worktree,
        boardId: a.boardId,
        taskId: task.taskId,
        label: pos !== null ? `task ${pos}` : task.content.slice(0, 40),
        refs: task.result ? [...task.result.refs] : [],
        planPos: pos ?? Number.MAX_SAFE_INTEGER,
        dispatchedAt: a.dispatchedAt,
        live: task.state === 'in_progress'
      })
      continue
    }
    g.live ||= task.state === 'in_progress'
    g.planPos = Math.min(g.planPos, pos ?? Number.MAX_SAFE_INTEGER)
    g.dispatchedAt = Math.min(g.dispatchedAt, a.dispatchedAt)
    if (task.result) g.refs.push(...task.result.refs)
    // The label follows the NEWEST settled task — that is the work the human is about to merge.
    if (isSettledForMerge(task)) {
      g.taskId = task.taskId
      g.label = pos !== null ? `task ${pos}` : task.content.slice(0, 40)
    }
  }
  const settledBranches = new Set(
    ledger.tasks
      .filter((t) => t.assignment?.branch && isSettledForMerge(t))
      .map((t) => t.assignment!.branch!)
  )
  return [...groups.values()]
    .filter((g) => !g.live && settledBranches.has(g.branch))
    .sort((x, y) => x.planPos - y.planPos || x.dispatchedAt - y.dispatchedAt)
    .map((g) => {
      // Count DISTINCT normalised files, not raw refs: a worker that reported `x.ts` and
      // `x.ts:42` touched one file, and a count that says two is a count that lies.
      const distinct = new Set<string>()
      for (const r of g.refs) {
        const n = normalizeRef(r, g.worktree)
        if (n) distinct.add(overlapKey(n))
      }
      const dirty = worktrees[g.worktree]?.dirty === true
      return {
        taskId: g.taskId,
        boardId: g.boardId,
        branch: g.branch,
        worktree: g.worktree,
        label: g.label,
        files: distinct.size,
        refs: g.refs,
        ...(dirty ? { dirty: true } : {})
      }
    })
}

/** The full integration projection: the ordered sequence plus the raw pairs the rows render. */
export function integrationFor(
  ledger: SwarmRunLedger,
  worktrees: WorktreeStatusMap = {}
): { sequence: SwarmMergeStep[]; overlaps: OverlapPair[]; boardOf: Map<string, string> } {
  const candidates = mergeCandidates(ledger, worktrees)
  const overlaps = detectOverlaps(
    candidates.map((c) => ({
      taskId: c.taskId,
      boardId: c.boardId,
      worktree: c.worktree,
      refs: c.refs
    }))
  )
  return {
    sequence: buildMergeSequence(candidates, overlaps),
    overlaps,
    boardOf: new Map(candidates.map((c) => [c.taskId, c.boardId]))
  }
}

/**
 * Ledger-derived triage rows. Does NOT emit `needs_input` — see the two-source rule in the module
 * header. A snoozed task (the human pressed Wait) is suppressed until its snooze expires, so the
 * queue stays a work list rather than a nag list.
 */
export function triageRows(
  ledger: SwarmRunLedger,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS,
  worktrees: WorktreeStatusMap = {},
  integration: ReturnType<typeof integrationFor> = integrationFor(ledger, worktrees)
): SwarmTriageRow[] {
  const rows: SwarmTriageRow[] = [
    ...overlapRows(integration),
    ...dirtyWorktreeRows(ledger, worktrees),
    ...mergeReadyRows(integration)
  ]
  for (const task of ledger.tasks) {
    const boardId = task.assignment?.boardId
    if (!boardId) continue
    if (task.dismissed === true) continue
    if (task.snoozedUntil !== undefined && now < task.snoozedUntil) continue
    const pos = planPosition(ledger, task)
    const on = pos !== null ? ` on task ${pos}` : ''

    if (task.blockedTag === 'lost') {
      const r = task.result
      const salv = r
        ? ` — result salvaged (${r.provenance === 'synthesized' ? 'derived' : 'claimed'}, ${r.refs.length} file${r.refs.length === 1 ? '' : 's'})`
        : ' — nothing salvageable'
      rows.push({
        id: task.taskId,
        tag: 'lost',
        boardId,
        text: `died${on}${salv}`,
        actions: r ? ['accept', 'reassign'] : ['reassign']
      })
      continue
    }
    if (task.blockedTag === 'failing_check') {
      rows.push({
        id: task.taskId,
        tag: 'failing_check',
        boardId,
        // The reason must ride the visible string — the statusline renders summary only.
        text: `reported done but ${task.result?.summary || 'an acceptance check failed'}`,
        actions: ['dismiss', 'reassign']
      })
      continue
    }
    if (task.blockedTag === 'dependency') {
      rows.push({
        id: task.taskId,
        tag: 'dependency',
        boardId,
        text: `is blocked${on} on another task's result`,
        actions: ['open']
      })
      continue
    }
    if (isStalled(task, now, thresholdMs)) {
      const silent = silentMs(task, now) ?? 0
      rows.push({
        id: task.taskId,
        tag: 'stalled',
        boardId,
        text: `silent ${fmtDur(silent)}${on} — threshold ${fmtDur(thresholdMs)}`,
        actions: ['wait', 'reassign']
      })
      continue
    }
    // A finished result nobody has looked at since it landed. `lastSeenAt` is the human's
    // last visit to the run, so a result that predates it has already been on screen.
    if (task.state === 'done' && task.result && !task.result.acceptedByHuman) {
      if (task.result.at <= ledger.lastSeenAt) continue
      const claimed = task.result.provenance === 'claimed'
      rows.push({
        id: task.taskId,
        tag: 'unreviewed',
        boardId,
        text: `reported ${task.result.summary || 'a result'}${claimed ? ' — agent-claimed, unverified' : ' — derived from transcript'}`,
        actions: ['dismiss', 'open']
      })
    }
  }
  return sortTriage(rows)
}

/**
 * S3 — the overlap warning. One row per overlapping PAIR, anchored on the LATER branch, because
 * that is the one that has to move ("merge one, rebase the other, re-run its checks"). Ranked
 * above `stalled` in the shared tag order: a stall costs time, an unnoticed overlap costs work.
 */
function overlapRows(integration: ReturnType<typeof integrationFor>): SwarmTriageRow[] {
  const { sequence, overlaps, boardOf } = integration
  const posOf = new Map(sequence.map((s, i) => [s.taskId, i + 1]))
  const rows: SwarmTriageRow[] = []
  for (const pair of overlaps) {
    const pa = posOf.get(pair.a)
    const pb = posOf.get(pair.b)
    if (pa === undefined || pb === undefined) continue
    const [earlier, later] = pa < pb ? [pair.a, pair.b] : [pair.b, pair.a]
    const laterBoard = boardOf.get(later)
    const earlierBoard = boardOf.get(earlier)
    if (!laterBoard || !earlierBoard) continue
    rows.push({
      id: `overlap:${earlier}:${later}`,
      tag: 'overlap',
      boardId: laterBoard,
      boardId2: earlierBoard,
      text: `both touched ${describeOverlapFiles(pair.files)} — merge one, rebase the other, re-run its checks`,
      actions: ['dismiss', 'open']
    })
  }
  return rows
}

/**
 * S3 — a worktree kept on disk because it had uncommitted changes. NOT a hazard (nothing is at
 * risk; keeping it is the locked policy) but it must be LISTED: a preserved tree the human is
 * never told about is disk that leaks and work that is silently abandoned.
 *
 * Only a worker that is FINISHED produces a row — a running builder's tree is dirty by definition
 * and surfacing that would be a nag, not triage.
 *
 * 🔒 "Finished" is a property of the WORKTREE, not of the task record being visited. A reused
 * worker keeps one worktree across several tasks, so the ledger can hold an older finished task
 * and a newer `in_progress` one pointing at the SAME tree. Skipping only the in-progress record
 * would then emit a row anchored on the stale finished task, describing dirt that the still-running
 * worker is producing right now — and its `resolve` → Discard would `git clean -fd` a tree the
 * worker is actively editing. So the live set is computed FIRST and excluded wholesale.
 */
function dirtyWorktreeRows(ledger: SwarmRunLedger, worktrees: WorktreeStatusMap): SwarmTriageRow[] {
  const rows: SwarmTriageRow[] = []
  const seen = new Set(liveWorktrees(ledger))
  // Newest first, so a reused worker's row anchors on the task the human just saw finish.
  for (let i = ledger.tasks.length - 1; i >= 0; i--) {
    const task = ledger.tasks[i]
    const a = task.assignment
    if (!a?.worktree || task.state === 'in_progress' || task.dismissed === true) continue
    if (seen.has(a.worktree)) continue
    const st = worktrees[a.worktree]
    if (!st?.exists || !st.dirty) continue
    seen.add(a.worktree)
    const shown = `.canvas/worktrees/${
      a.worktree
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? ''
    }`
    const n = st.changed
    rows.push({
      id: task.taskId,
      tag: 'dirty_worktree',
      boardId: a.boardId,
      // "kept on disk, nothing discarded" is the whole reassurance — never drop it for brevity.
      text: `left ${n} uncommitted file${n === 1 ? '' : 's'} in ${shown} — kept on disk, nothing discarded`,
      actions: ['resolve']
    })
  }
  return rows
}

/**
 * S3 — the merge sequence. ONE row per RUN, not one per branch: N branch rows would drown the
 * queue in the exact "nag list" failure the risk ordering exists to prevent. It sorts LAST (the
 * positive end-state) and carries no ledger action — the renderer expands it to the ordered
 * sequence, which is the deliverable. Auto-merge is deferred; nothing here merges.
 */
function mergeReadyRows(integration: ReturnType<typeof integrationFor>): SwarmTriageRow[] {
  const { sequence } = integration
  if (sequence.length === 0) return []
  const overlapping = sequence.filter((s) => s.overlapsWith.length > 0).length
  const dirty = sequence.filter((s) => s.dirty).length
  const parts = [
    `${sequence.length} branch${sequence.length === 1 ? '' : 'es'} ready to merge`,
    ...(overlapping > 0 ? [`${overlapping} overlap${overlapping === 1 ? '' : 's'}`] : []),
    ...(dirty > 0 ? [`${dirty} with uncommitted changes`] : [])
  ]
  return [
    {
      id: 'merge-sequence',
      tag: 'merge_ready',
      boardId: sequence[0].boardId,
      text: `${parts.join(' · ')} — sequence below`,
      actions: []
    }
  ]
}

/** Risk order = `SWARM_BLOCKED_TAGS` order (design §5). Stable within a tag (ledger order). */
export function sortTriage(rows: SwarmTriageRow[]): SwarmTriageRow[] {
  const rank = (t: SwarmTriageRow['tag']): number => {
    const i = SWARM_BLOCKED_TAGS.indexOf(t)
    return i < 0 ? SWARM_BLOCKED_TAGS.length : i
  }
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row.tag) - rank(b.row.tag) || a.i - b.i)
    .map((e) => e.row)
}

/**
 * Which plan items a live worker currently holds, and how that worker is doing. A settled or
 * unassigned task contributes nothing — an item with no dot is simply nobody's right now.
 */
export function planOwners(
  ledger: SwarmRunLedger,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS
): Record<string, 'working' | 'stalled'> {
  const out: Record<string, 'working' | 'stalled'> = {}
  for (const item of ledger.planItems) {
    if (!item.ownerTaskId) continue
    const task = ledger.tasks.find((t) => t.taskId === item.ownerTaskId)
    if (!task || task.state !== 'in_progress' || !task.assignment) continue
    out[item.id] = isStalled(task, now, thresholdMs) ? 'stalled' : 'working'
  }
  return out
}

/** The whole renderer-facing projection. `restored` is true only on the post-rehydrate push. */
export function buildSnapshot(
  ledger: SwarmRunLedger,
  opts: {
    now: number
    restored?: boolean
    thresholdMs?: number
    /** S3 — live git facts per worktree path. Absent ⇒ no chip note, no dirty rows (unknown). */
    worktrees?: WorktreeStatusMap
  }
): SwarmLedgerSnapshot {
  const thresholdMs = opts.thresholdMs ?? SWARM_STALL_THRESHOLD_MS
  const worktrees = opts.worktrees ?? {}
  const workers = workerStates(ledger, opts.now, thresholdMs, worktrees)
  // Computed ONCE and shared with the rows: the sequence the `merge_ready` row expands to must be
  // the same object the overlap rows are numbered against, or the row would say "overlaps #1"
  // about a different #1 than the one on screen.
  const integration = integrationFor(ledger, worktrees)
  return {
    runId: ledger.runId,
    state: ledger.state,
    restored: opts.restored === true,
    createdAt: ledger.createdAt,
    planBoardId: ledger.planBoardId,
    counts: {
      workers: workers.length,
      results: ledger.tasks.filter((t) => t.result !== undefined).length
    },
    planOwners: planOwners(ledger, opts.now, thresholdMs),
    workers,
    triage: triageRows(ledger, opts.now, thresholdMs, worktrees, integration),
    mergeSequence: integration.sequence
  }
}
