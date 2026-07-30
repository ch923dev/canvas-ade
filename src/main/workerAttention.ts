/**
 * Worker → attention classification (orchestration P4) — the host-side detection the
 * `blocked` / `awaiting-review` attention buckets have been waiting for.
 *
 * Both buckets have existed and been styled since T1.1, and `canvas://attention` has served them
 * as a machine twin since T1.3 — but only `failed`/`done` ever flowed, because the only producer
 * was the Claude hook watcher (`Stop` → done, `Notification` → needs-input). A worker that reports
 * `status:"blocked"`, or one P2's `swarmWatch` has already classified as `lost`/`stalled`, reached
 * no ring at all. This module is the missing map, and nothing more: it invents no second notion of
 * "blocked" — it consumes the classification `SWARM_BLOCKED_TAGS` already encodes.
 *
 * 🔒 CLOSED VOCABULARY, SAFE FALLBACK. Every tag maps explicitly, and anything off-vocabulary maps
 * to `blocked`. That direction is deliberate: the failure mode this whole lane exists to fix is
 * SILENCE. Falling back to `done` would launder an unclassifiable state into success; falling back
 * to `error` would claim a failure nobody reported. `blocked` claims only "this worker is not
 * progressing and I could not say why" — true, visible, and corrected by the next report.
 */
import type { SwarmBlockedTag } from '../shared/swarmLedgerTypes'
import type { DeliverableSignal } from './lifecycleNotifications'

/** The on-canvas attention mark. Mirrors the renderer's `AttentionKind` across the process boundary. */
export type WorkerAttention = 'done' | 'needs-input' | 'blocked' | 'error'

/**
 * Tags that mean "a human must LOOK at this" rather than "this worker is stuck".
 *
 * `needs_input` is the literal ask. `unreviewed` and `merge_ready` are S3's end-state tags: the
 * work is finished and waiting on a human decision, which is `awaiting-review` in bucket terms, not
 * a block. Everything else in `SWARM_BLOCKED_TAGS` — lost · failing_check · overlap · stalled ·
 * dependency · dirty_worktree — is a worker that cannot proceed.
 */
const NEEDS_YOU: ReadonlySet<string> = new Set<SwarmBlockedTag>([
  'needs_input',
  'unreviewed',
  'merge_ready'
])

/**
 * Map a blocked tag onto the attention mark its board should carry.
 * An unknown tag (a newer writer's vocabulary reaching an older reader) resolves to `blocked`.
 */
export function attentionForBlockedTag(tag: string | undefined): WorkerAttention {
  return tag !== undefined && NEEDS_YOU.has(tag) ? 'needs-input' : 'blocked'
}

/**
 * The `LifecycleEvent` a given attention mark rides through `gateNotification`.
 *
 * 🔒 THIS IS WHY P4 NEEDS NO NOTIFICATIONS-CONFIG CHANGE. The gate's per-event switches
 * (`onDone`/`onInput`/`onError`) speak a three-member vocabulary; adding a fourth would mean a new
 * config key, a new default, a settings row, and a migration for every existing config file.
 * Instead `blocked` rides `needs-input` — semantically exact ("an agent is waiting on the user") —
 * and only the RING carries the finer distinction. A user who silenced `onInput` silences blocked
 * notifications too, which is the behaviour that setting already promises.
 */
export function eventForAttention(attention: WorkerAttention): 'done' | 'needs-input' | 'error' {
  switch (attention) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'blocked':
    case 'needs-input':
      return 'needs-input'
  }
}

/**
 * Build the lifecycle signal for a worker's attention state, or `null` when the state warrants no
 * mark at all.
 *
 * `null` is returned for a worker that is merely RUNNING: a live worker is the normal case, and
 * marking it would make the ring meaningless (every board would wear one). The signal is raised
 * only on a transition into a state a human might act on.
 */
export function workerAttentionSignal(input: {
  boardId: string
  attention: WorkerAttention | null
  /** The composed reason line, already clamped (`silent 11m`, `failing check`). */
  detail?: string
  cwd?: string
}): DeliverableSignal | null {
  if (input.attention === null) return null
  return {
    boardId: input.boardId,
    event: eventForAttention(input.attention),
    attention: input.attention,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
  }
}
