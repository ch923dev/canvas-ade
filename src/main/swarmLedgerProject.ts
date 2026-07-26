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
  type SwarmRunLedger,
  type SwarmTask,
  type SwarmTriageRow,
  type SwarmWorkerLedgerState
} from '../shared/swarmLedgerTypes'

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

/** Per-worker ledger state for the cards, in the run's first-assignment order. */
export function workerStates(
  ledger: SwarmRunLedger,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS
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
    out.push(entry)
  }
  return out
}

/**
 * Ledger-derived triage rows. Does NOT emit `needs_input` — see the two-source rule in the module
 * header. A snoozed task (the human pressed Wait) is suppressed until its snooze expires, so the
 * queue stays a work list rather than a nag list.
 */
export function triageRows(
  ledger: SwarmRunLedger,
  now: number,
  thresholdMs: number = SWARM_STALL_THRESHOLD_MS
): SwarmTriageRow[] {
  const rows: SwarmTriageRow[] = []
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
  opts: { now: number; restored?: boolean; thresholdMs?: number }
): SwarmLedgerSnapshot {
  const thresholdMs = opts.thresholdMs ?? SWARM_STALL_THRESHOLD_MS
  const workers = workerStates(ledger, opts.now, thresholdMs)
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
    triage: triageRows(ledger, opts.now, thresholdMs)
  }
}
