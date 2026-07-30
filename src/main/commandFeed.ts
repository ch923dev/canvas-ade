/**
 * The external-worker observability feed (orchestration P4) — MAIN's half.
 *
 * WHAT IT CLOSES. `write_result` is the only no-confirm, own-board-bound worker self-report channel,
 * and it landed in `boardResults`' in-memory Map with no push behind it: a worker dispatched through
 * the Command board surfaced in that board's recap (its dispatch parks `awaitSettled` on it), but a
 * worker an EXTERNAL orchestrator spawned surfaced on no board, raised no ring, and fired no toast.
 * This module turns each recorded result into (a) a Command-board feed push and (b) an attention
 * mark, using the ONE canvas write pipe (`sendCommand` → `useMcpCommands` → the renderer store).
 *
 * 🔒 ZERO HUMAN CONFIRMS, BY CONSTRUCTION. `commandFeed` writes only `commandStore`, which is
 * runtime-only and never serialized. That is the whole reason N-worker status can ride this channel:
 * a durable content write is human-confirmed, so streaming status durably would fire N modals at
 * exactly the scale the feature exists for. Durable aggregation is the separate, batched,
 * once-per-run path in `findingsBatch.ts`.
 *
 * 🔒 NO TITLES CROSS. The push carries board IDS only; the renderer resolves titles against the live
 * canvas. MAIN becoming a second title authority is the mistake S2 avoided with `SwarmTriageRow`.
 */
import {
  classifyFeedStatus,
  sanitizeFeedResult,
  clampLine,
  type CommandFeedPush,
  type CommandFeedState
} from '../shared/commandFeedTypes'
import { workerAttentionSignal, type WorkerAttention } from './workerAttention'
import type { McpCommand, McpCommandAck } from '../shared/mcpTypes'
import type { DeliverableSignal } from './lifecycleNotifications'

/**
 * Trailing coalesce window. A worker's status is a STATE, not an event stream, so latest-wins loses
 * nothing and needs no disclosure — unlike a dropped result, which does (see `MAX_FED_TASKS`). The
 * window is short enough to feel live and long enough that a burst (spawn → dispatch → first report)
 * costs one IPC round trip instead of three.
 */
const COALESCE_MS = 120

export interface CommandFeedDeps {
  /** `sendMcpCommand` bound to the live window. Never throws — it resolves `{ok:false}` instead. */
  send(command: McpCommand): Promise<McpCommandAck>
  /** The ONE lifecycle delivery function (`lifecycleNotifications.deliver`) — OS + toast + ring. */
  deliver(sig: DeliverableSignal): void
  /** Test seam for the debounce. Returns its own cancel, mirroring `SwarmWatchDeps.startSweep`. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Reported when a push lands but no Command board exists to render it. Optional. */
  onUnrendered?: (boardId: string) => void
}

export interface CommandFeed {
  /**
   * A worker recorded a structured result (the `write_result` seam). Classifies it, queues the feed
   * push, and raises the matching attention mark.
   *
   * `synthesized` results are fed too — a worker that DIED without self-reporting still has a
   * transcript-derived result, and that is exactly the case a human most needs to see — but they
   * never raise a `done` ring: a synthesis is a guess about a dead worker, not a completion it
   * claimed. Presenting one as done is the "launder a claim into a verification" mistake S2 named.
   */
  observeResult(
    boardId: string,
    result: { status?: string; summary?: string; refs?: string[] } | undefined,
    opts?: { synthesized?: boolean }
  ): void
  /**
   * A worker's ledger state changed (P2's `swarmWatch` classified it lost / stalled / blocked, or
   * it recovered). `attention: null` clears nothing — it simply raises no mark; a live worker
   * wearing a ring would make every ring meaningless.
   */
  observeAttention(
    boardId: string,
    attention: WorkerAttention | null,
    opts?: { detail?: string; role?: string; blockedTag?: string }
  ): void
  /** Send every queued push NOW (quit chain / tests). */
  flush(): void
  /** Drop pending timers. Queued pushes are NOT sent — the window is going away. */
  dispose(): void
}

/** Merge a new push over a pending one. Absent means UNCHANGED, so a later status-only push
 *  can never erase a result the earlier push carried. */
function merge(prev: CommandFeedPush | undefined, next: CommandFeedPush): CommandFeedPush {
  if (!prev) return next
  return {
    boardId: next.boardId,
    state: next.state ?? prev.state,
    blockedTag: next.blockedTag ?? prev.blockedTag,
    result: next.result ?? prev.result,
    disclose: next.disclose ?? prev.disclose,
    role: next.role ?? prev.role
  }
}

export function createCommandFeed(deps: CommandFeedDeps): CommandFeed {
  const pending = new Map<string, CommandFeedPush>()
  const timers = new Map<string, () => void>()
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      // `unref` keeps a queued push from holding the process alive at quit — the drain path
      // flushes explicitly, so a pending timer is never the thing that matters.
      t.unref?.()
      return () => clearTimeout(t)
    })

  const sendNow = (boardId: string): void => {
    timers.delete(boardId)
    const feed = pending.get(boardId)
    if (!feed) return
    pending.delete(boardId)
    void deps
      .send({ type: 'commandFeed', feed })
      .then((ack) => {
        // `rendered:false` = the push landed in the store but there is no Command board to show it.
        // Surfaced rather than swallowed: an unshown feed reads to the human as "nothing happened",
        // which is the exact failure this lane exists to fix.
        if (ack.ok && ack.rendered === false) deps.onUnrendered?.(boardId)
      })
      .catch(() => {
        /* send never rejects; the catch is belt-and-braces so a queue drain cannot throw */
      })
  }

  const queue = (push: CommandFeedPush): void => {
    pending.set(push.boardId, merge(pending.get(push.boardId), push))
    if (timers.has(push.boardId)) return
    timers.set(
      push.boardId,
      schedule(() => sendNow(push.boardId), COALESCE_MS)
    )
  }

  /** The attention mark a settled result warrants — or `null` for one that warrants none. */
  const attentionForState = (
    state: CommandFeedState,
    synthesized: boolean
  ): WorkerAttention | null => {
    switch (state) {
      case 'done':
        // A SYNTHESIZED result is a transcript-derived guess about a worker that never reported.
        // It must not wear the ✓ done ring, which the human reads as "this finished cleanly" —
        // it goes out as `blocked` so the run stays on their radar for a look.
        return synthesized ? 'blocked' : 'done'
      case 'failed':
        return 'error'
      case 'blocked':
        return 'needs-input'
      // routing / executing / reporting are the normal in-flight states. Marking them would put a
      // ring on every live board and destroy the signal.
      default:
        return null
    }
  }

  return {
    observeResult(boardId, result, opts) {
      if (typeof boardId !== 'string' || boardId.length === 0) return
      const synthesized = opts?.synthesized === true
      const sanitized = sanitizeFeedResult(result)
      const cls = classifyFeedStatus(result?.status)
      const disclose = synthesized
        ? 'derived from the transcript — the worker never reported'
        : cls.disclose
      queue({
        boardId,
        state: cls.state,
        ...(cls.blockedTag !== undefined ? { blockedTag: cls.blockedTag } : {}),
        ...(sanitized !== undefined ? { result: sanitized } : {}),
        ...(disclose !== undefined ? { disclose } : {})
      })
      const sig = workerAttentionSignal({
        boardId,
        attention: attentionForState(cls.state, synthesized),
        ...(disclose !== undefined ? { detail: disclose } : {})
      })
      if (sig) deps.deliver(sig)
    },

    observeAttention(boardId, attention, opts) {
      if (typeof boardId !== 'string' || boardId.length === 0) return
      const detail = opts?.detail !== undefined ? clampLine(opts.detail) : undefined
      // The feed mirrors the ledger's verdict so the CARD says the same thing as the ring. Only a
      // `blocked` mark changes the card's state; `done`/`error` here would race the result push
      // (the ledger and the worker's own report can disagree, and the worker's report wins the card).
      if (attention === 'blocked' || attention === 'needs-input') {
        queue({
          boardId,
          state: 'blocked',
          ...(opts?.blockedTag !== undefined ? { blockedTag: opts.blockedTag } : {}),
          ...(opts?.role !== undefined ? { role: opts.role } : {}),
          ...(detail !== undefined ? { disclose: detail } : {})
        })
      }
      const sig = workerAttentionSignal({
        boardId,
        attention,
        ...(detail !== undefined ? { detail } : {})
      })
      if (sig) deps.deliver(sig)
    },

    flush() {
      for (const cancel of timers.values()) cancel()
      timers.clear()
      for (const boardId of [...pending.keys()]) sendNow(boardId)
    },

    dispose() {
      for (const cancel of timers.values()) cancel()
      timers.clear()
      pending.clear()
    }
  }
}

// ── The app singleton + its call-site shims ──────────────────────────────────────────────────
//
// The feed is installed LATE (it needs the window and the lifecycle `deliver` handle, both created
// during `whenReady`) but is called from `boardResults.recordBoardResult`, a leaf module imported
// far earlier. So the call sites go through these no-op-until-installed shims — exactly the
// `setPtyLifecycleEmitter` pattern. Before install (unit tests, the headless self-test, the window
// between app start and boot) every call is a silent no-op, which is correct: there is no renderer
// to push to.

let installed: CommandFeed | null = null

/** Install (or clear, on teardown) the app's command feed. */
export function setCommandFeed(feed: CommandFeed | null): void {
  installed?.dispose()
  installed = feed
}

/** {@link CommandFeed.observeResult} against the installed feed, if any. */
export function observeWorkerResult(
  boardId: string,
  result: { status?: string; summary?: string; refs?: string[] } | undefined,
  opts?: { synthesized?: boolean }
): void {
  installed?.observeResult(boardId, result, opts)
}

/** {@link CommandFeed.observeAttention} against the installed feed, if any. */
export function observeWorkerAttention(
  boardId: string,
  attention: WorkerAttention | null,
  opts?: { detail?: string; role?: string; blockedTag?: string }
): void {
  installed?.observeAttention(boardId, attention, opts)
}

/** Flush queued pushes (quit chain). No-op when no feed is installed. */
export function flushCommandFeed(): void {
  installed?.flush()
}
