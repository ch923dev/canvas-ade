/**
 * Generic-PTY agent-lifecycle detection (desktop-notifications Phase 3) — the EFFECTFUL half.
 *
 * The pure decisions live in ptyLifecycle.ts; `pty.ts` owns the session map + the spawn closure.
 * This module sits between them: the event-driven idle-at-prompt monitor (quiescence checks armed
 * off onData, audit R13 — formerly a 2s scan interval) and the small emit helpers `pty.ts`
 * calls from its onExit / onData / spawn-failed sites. Kept OUT of `pty.ts` so that file stays under
 * its max-lines ratchet (the recapHealth.ts / lifecycleNotifications.ts precedent) and so the scan
 * is decoupled from the session-map internals — it operates on injected accessors + a structural
 * {@link IdleSession} view, never on `pty.ts`'s private `sessions`/`boardCwds` (no import cycle).
 */
import { readRingSince, type OutputRing } from './ptyOutput'
import { classifyExit, isIdleAtPrompt, type PtyLifecycleEmitter } from './ptyLifecycle'

/** Output-silence dwell before an at-prompt session is deemed to be awaiting input. */
const IDLE_PROMPT_MS = 10_000
/** Chars of ring tail inspected for a prompt — only the last line matters. */
const IDLE_TAIL_CHARS = 512

/**
 * The structural view of a live PTY session the idle scan reads (and the one field it mutates,
 * `awaitingInput`). `pty.ts`'s `SessionLike` satisfies it — declared here so the scan never imports
 * `pty.ts` (which would cycle: `pty.ts` imports this module for the emit helpers).
 */
export interface IdleSession {
  /** Lifecycle state; only `'running'` sessions are scanned. */
  state: string
  /** `monitorActivity` opt-out captured at spawn; absent ⇒ monitored. */
  monitored?: boolean
  /** Set true when the scan flags this session as awaiting input (cleared on the next output). */
  awaitingInput?: boolean
  /** Epoch ms of the last PTY output (drives the output-silence dwell). */
  lastActivityAt: number
  /** The board's output ring (its tail is inspected for a prompt). */
  buf: OutputRing
  /** The live renderer port (the reserved `awaiting-input` state is posted here). */
  port: { postMessage: (message: unknown) => void }
}

/**
 * Clear the idle-at-prompt flag on the next PTY output and flip the board's chrome back to
 * `running`. No-op unless the session was flagged, so `pty.ts` can call it unconditionally on the
 * hot onData path. Called only on the transition OUT of an idle-fired state.
 */
export function clearAwaitingInput(s: Pick<IdleSession, 'awaitingInput' | 'port'>): void {
  if (!s.awaitingInput) return
  s.awaitingInput = false
  try {
    s.port.postMessage({ t: 'state', state: 'running' })
  } catch {
    /* port closed */
  }
}

/**
 * Emit a lifecycle signal for a NATURAL process exit (`pty.ts` calls this only from the
 * identity-guarded onExit branch, never for a kill/restart/reap). No-op when notifications are
 * unwired (`emit` undefined) or the board opted out (`monitored === false`).
 */
export function emitPtyExit(
  emit: PtyLifecycleEmitter | undefined,
  id: string,
  exitCode: number,
  monitored: boolean | undefined,
  cwd: string | undefined
): void {
  if (!emit || monitored === false) return
  emit({ boardId: id, event: classifyExit(exitCode), cwd })
}

/**
 * Emit an `error` signal for a synchronous spawn failure (no session exists yet, so the raw
 * `monitorActivity` opt-out is passed). No-op when notifications are unwired or the board opted out.
 */
export function emitPtyError(
  emit: PtyLifecycleEmitter | undefined,
  id: string,
  monitorActivity: boolean | undefined,
  cwd: string | undefined
): void {
  if (!emit || monitorActivity === false) return
  emit({ boardId: id, event: 'error', cwd })
}

/** Handle for the event-driven idle monitor (audit R13 — replaced the 2s scan interval). */
export interface IdleMonitor {
  /**
   * Note PTY output on a session — `pty.ts` calls this from the hot onData path. O(1) and
   * timer-churn-free: if a quiescence check is already pending for the id it does nothing
   * (the check lazily re-arms itself off `lastActivityAt`); otherwise it arms one unref'd
   * `setTimeout` for the idle dwell. Zero live sessions ⇒ zero timers ⇒ zero idle CPU.
   */
  poke(id: string): void
  /** Cancel a session's pending check (kill/reap teardown). A skipped call is harmless —
   *  an orphaned check fires once, finds no session via `getSession`, and self-clears. */
  drop(id: string): void
  /** Stop everything (emitter unwired). */
  dispose(): void
}

/**
 * Start the idle-at-prompt monitor: for each running + monitored + output-silent +
 * at-a-soliciting-prompt session, flag it once — posting the reserved `awaiting-input` state to
 * its port (chrome) and emitting a `needs-input` signal (OS notification + toast + attention).
 * The flag is cleared by {@link clearAwaitingInput} on the next output, whose `poke` re-arms the
 * heuristic for a fresh idle period.
 *
 * EVENT-DRIVEN off onData quiescence (audit R13): there is no polling interval. Each `poke`
 * ensures one pending per-session check at `lastActivityAt + idleMs`; a check that fires early
 * (output happened since arming) re-arms itself for the remainder instead of resetting per chunk
 * — so a torrenting PTY costs one Map lookup per chunk, and an idle app costs nothing. This is
 * equivalent to the old 2s scan because the prompt tail can only change via output, and every
 * output pokes: evaluating once per quiescence window observes every state the scan could.
 *
 * Session access is injected (`getSession` at fire time — never a captured session object, so a
 * respawn under the same id is always evaluated against the LIVE session; `getSessions` for the
 * one initial sweep over sessions alive before the emitter was wired) so this module stays
 * decoupled from `pty.ts`'s private maps. All timeouts are unref'd — never keep the process alive.
 */
export function startIdleMonitor(
  getSession: (id: string) => IdleSession | undefined,
  getSessions: () => Iterable<[string, IdleSession]>,
  cwdOf: (id: string) => string | undefined,
  emit: PtyLifecycleEmitter,
  opts?: { idleMs?: number; now?: () => number }
): IdleMonitor {
  const idleMs = opts?.idleMs ?? IDLE_PROMPT_MS
  const now = opts?.now ?? Date.now
  const pending = new Map<string, NodeJS.Timeout>()
  let disposed = false

  const arm = (id: string, delayMs: number): void => {
    const t = setTimeout(() => check(id), delayMs)
    t.unref?.()
    pending.set(id, t)
  }

  const check = (id: string): void => {
    pending.delete(id)
    if (disposed) return
    const s = getSession(id)
    if (!s) return
    const staleMs = now() - s.lastActivityAt
    if (staleMs < idleMs) {
      // Output landed while this check was pending — lazy re-arm for the remainder
      // (this, not a per-chunk timer reset, is what keeps the hot path cheap).
      arm(id, idleMs - staleMs)
      return
    }
    const tail = readRingSince(s.buf, Math.max(0, s.buf.written - IDLE_TAIL_CHARS))
    if (
      !isIdleAtPrompt({
        running: s.state === 'running',
        monitored: s.monitored !== false,
        alreadyAwaiting: s.awaitingInput === true,
        staleMs,
        idleMs,
        tail
      })
    )
      // Not a soliciting prompt (or not running/monitored/already flagged). No re-arm:
      // the tail can only change via output, and output pokes.
      return
    s.awaitingInput = true
    try {
      s.port.postMessage({ t: 'state', state: 'awaiting-input' })
    } catch {
      /* port closed (parking / adopting) — flag dropped on the next spawn/adopt */
    }
    emit({ boardId: id, event: 'needs-input', cwd: cwdOf(id) })
  }

  const monitor: IdleMonitor = {
    poke(id) {
      if (disposed || pending.has(id)) return
      arm(id, idleMs)
    },
    drop(id) {
      const t = pending.get(id)
      if (t) clearTimeout(t)
      pending.delete(id)
    },
    dispose() {
      disposed = true
      for (const t of pending.values()) clearTimeout(t)
      pending.clear()
    }
  }

  // Initial sweep: sessions already alive when the emitter is wired (e.g. surviving daemon
  // sessions adopted across an app restart) may never output again — arm each once so a
  // pre-existing quiet prompt is still detected.
  for (const [id] of getSessions()) monitor.poke(id)

  return monitor
}
