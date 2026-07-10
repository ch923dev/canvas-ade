/**
 * Generic-PTY agent-lifecycle detection (desktop-notifications Phase 3) — the EFFECTFUL half.
 *
 * The pure decisions live in ptyLifecycle.ts; `pty.ts` owns the session map + the spawn closure.
 * This module sits between them: the idle-at-prompt scan loop and the small emit helpers `pty.ts`
 * calls from its onExit / onData / spawn-failed sites. Kept OUT of `pty.ts` so that file stays under
 * its max-lines ratchet (the recapHealth.ts / lifecycleNotifications.ts precedent) and so the scan
 * is decoupled from the session-map internals — it operates on injected accessors + a structural
 * {@link IdleSession} view, never on `pty.ts`'s private `sessions`/`boardCwds` (no import cycle).
 */
import { readRingSince, type OutputRing } from './ptyOutput'
import { classifyExit, isIdleAtPrompt, type PtyLifecycleEmitter } from './ptyLifecycle'

/** Output-silence dwell before an at-prompt session is deemed to be awaiting input. */
const IDLE_PROMPT_MS = 10_000
/** How often the live-session scan runs. */
const IDLE_SCAN_INTERVAL_MS = 2_000
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

/**
 * Start the idle-at-prompt monitor: a single unref'd interval that scans the live sessions and,
 * for each running + monitored + output-silent + at-a-soliciting-prompt session, flags it once —
 * posting the reserved `awaiting-input` state to its port (chrome) and emitting a `needs-input`
 * signal (OS notification + toast + attention). The flag is cleared by {@link clearAwaitingInput}
 * on the next output, so a fresh idle period can fire again.
 *
 * Session access is injected (`getSessions` / `cwdOf`) so this stays decoupled from `pty.ts`'s
 * private maps. Returns a disposer; the interval is unref'd so it never keeps the process alive.
 */
export function startIdleMonitor(
  getSessions: () => Iterable<[string, IdleSession]>,
  cwdOf: (id: string) => string | undefined,
  emit: PtyLifecycleEmitter,
  opts?: { intervalMs?: number; idleMs?: number; now?: () => number }
): () => void {
  const idleMs = opts?.idleMs ?? IDLE_PROMPT_MS
  const now = opts?.now ?? Date.now
  const tick = (): void => {
    const t = now()
    for (const [id, s] of getSessions()) {
      const tail = readRingSince(s.buf, Math.max(0, s.buf.written - IDLE_TAIL_CHARS))
      if (
        !isIdleAtPrompt({
          running: s.state === 'running',
          monitored: s.monitored !== false,
          alreadyAwaiting: s.awaitingInput === true,
          staleMs: t - s.lastActivityAt,
          idleMs,
          tail
        })
      )
        continue
      s.awaitingInput = true
      try {
        s.port.postMessage({ t: 'state', state: 'awaiting-input' })
      } catch {
        /* port closed (parking / adopting) — flag dropped on the next spawn/adopt */
      }
      emit({ boardId: id, event: 'needs-input', cwd: cwdOf(id) })
    }
  }
  const timer = setInterval(tick, opts?.intervalMs ?? IDLE_SCAN_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
