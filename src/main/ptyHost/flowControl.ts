/**
 * PTY-host flow control — audit R7 (P-3), ported from VS Code's pty-host watermark protocol
 * (`src/vs/platform/terminal/common/terminal.ts`, `FlowControlConstants`).
 *
 * Hop 1 of the terminal data path (daemon → MAIN, over the named pipe) was the only unguarded one.
 * Hops 2–4 already batch: MAIN → renderer micro-batches (`ptyDataBatch.ts`) and the renderer
 * coalesces per rAF (`terminalWriteCoalescer.ts`). Hop 1 did one `JSON.stringify(msg) + '\n'`
 * socket write PER PTY CHUNK, with nothing telling a runaway agent to slow down: a `cat`ted
 * binary or a chatty TUI produced output as fast as the shell could write it, and the daemon
 * JSON-escaped every chunk of it.
 *
 * Two mechanisms, in the order they matter:
 *
 * 1. **Ack/pause (the load-bearing one).** The daemon counts chars sent but not yet acknowledged.
 *    Past `HIGH_WATERMARK_CHARS` it calls `pause()` on the pty, so the PRODUCER stops; once the
 *    consumer's acks bring the debt back under `LOW_WATERMARK_CHARS` it `resume()`s. The audit is
 *    explicit that this matters more than the byte encoding — do not be tempted into replacing
 *    JSON instead.
 * 2. **Same-tick coalescing.** Chunks arriving in one tick become one `ev:output` line, so the
 *    per-message `JSON.stringify` + socket write is paid once per tick instead of once per chunk.
 *
 * Pure and dependency-free (no net, no node-pty), so the state machine that decides when a
 * terminal freezes is unit-testable without a process.
 */

/** Unacked chars past which the pty is paused. */
export const HIGH_WATERMARK_CHARS = 100_000
/** Unacked chars at or below which a paused pty resumes. */
export const LOW_WATERMARK_CHARS = 5_000
/**
 * Chars the consumer buffers before sending one ack.
 *
 * MUST be ≤ `LOW_WATERMARK_CHARS`. If it were larger, the consumer would sit on a debt too small
 * to trigger an ack while the daemon waited for that same debt to fall to the low watermark, and
 * a paused pty would never resume — the terminal freezes permanently, with no error anywhere.
 * This is the one way to get the protocol subtly and irreversibly wrong; `flowControl.test.ts`
 * asserts the inequality so a future tuning edit cannot land it silently.
 */
export const CHAR_COUNT_ACK_SIZE = 5_000

/** Cancellable one-shot tick, injectable so tests need no real timers. */
export type FlowScheduler = (fn: () => void) => { cancel: () => void }

const immediateScheduler: FlowScheduler = (fn) => {
  const handle = setImmediate(fn)
  return { cancel: () => clearImmediate(handle) }
}

export interface SessionFlowDeps {
  /** Emit one coalesced payload to every subscriber (the daemon's `ev:output` fan-out). */
  send: (data: string) => void
  /** Stop the pty producing (node-pty `IPty.pause`). */
  pause: () => void
  /** Let it produce again (node-pty `IPty.resume`). */
  resume: () => void
  scheduler?: FlowScheduler
  limits?: { high?: number; low?: number }
}

export interface SessionFlow {
  /** Account a chunk and buffer it for this tick's coalesced send. */
  push(chunk: string): void
  /** The consumer acknowledged `chars` characters. */
  ack(chars: number): void
  /** Send this tick's buffer NOW. Call before any message that must not be overtaken. */
  flush(): void
  /**
   * Tell the session how many subscribers it has.
   *
   * ZERO SUBSCRIBERS MUST NEVER PAUSE. Daemon sessions outlive the app by design (an update
   * install, a crash, a plain restart) and run with no client attached. With no client there are
   * no acks, so an accounting session would sail past the high watermark and pause a pty that
   * nobody is going to un-pause — a background agent frozen until the app happens to come back.
   * Dropping to zero therefore clears the debt and resumes.
   */
  setSubscribers(count: number): void
  /**
   * Enable accounting for this session. Negotiated per connection: a client that never declared
   * `flowControl` in its `hello` gets the old unthrottled behavior, because a NEW daemon must not
   * pause for an OLD app that will never ack (they coexist — a surviving daemon is reattached to
   * across app updates).
   */
  setEnabled(on: boolean): void
  readonly paused: boolean
  readonly unacked: number
  /** Drop the pending buffer and any scheduled flush (session ended). */
  dispose(): void
}

export function createSessionFlow(deps: SessionFlowDeps): SessionFlow {
  const schedule = deps.scheduler ?? immediateScheduler
  const high = deps.limits?.high ?? HIGH_WATERMARK_CHARS
  const low = deps.limits?.low ?? LOW_WATERMARK_CHARS

  let pending: string[] = []
  let scheduled: { cancel: () => void } | null = null
  let unacked = 0
  let paused = false
  let enabled = false
  let subscribers = 0

  const flush = (): void => {
    if (scheduled) {
      scheduled.cancel()
      scheduled = null
    }
    if (pending.length === 0) return
    const data = pending.length === 1 ? pending[0] : pending.join('')
    pending = []
    deps.send(data)
  }

  const resumeIfDrained = (): void => {
    if (paused && unacked <= low) {
      paused = false
      deps.resume()
    }
  }

  return {
    push(chunk) {
      // Buffer for the coalesced send regardless of accounting — batching is independent of, and
      // safe without, the ack protocol.
      pending.push(chunk)
      if (scheduled === null) scheduled = schedule(flush)
      if (!enabled || subscribers === 0) return
      unacked += chunk.length
      if (!paused && unacked >= high) {
        paused = true
        deps.pause()
      }
    },
    ack(chars) {
      if (!(chars > 0)) return
      unacked = Math.max(0, unacked - chars)
      resumeIfDrained()
    },
    flush,
    setSubscribers(count) {
      subscribers = Math.max(0, count)
      if (subscribers > 0) return
      unacked = 0
      resumeIfDrained()
    },
    setEnabled(on) {
      enabled = on
      if (on) return
      // Turning accounting off must not strand a pause taken while it was on.
      unacked = 0
      resumeIfDrained()
    },
    get paused() {
      return paused
    },
    get unacked() {
      return unacked
    },
    dispose() {
      if (scheduled) scheduled.cancel()
      scheduled = null
      pending = []
    }
  }
}

/**
 * The consumer half (MAIN): buffer received chars and report when an ack is due. Kept here beside
 * the watermarks it has to agree with, rather than inline in client.ts, so the ack size and the
 * low watermark cannot drift apart across two files.
 */
export function createAckCounter(ackSize = CHAR_COUNT_ACK_SIZE): {
  /** Returns the char count to ack, or 0 when the debt is still below the ack size. */
  received: (chars: number) => number
  reset: () => void
} {
  let pending = 0
  return {
    received(chars) {
      pending += chars
      if (pending < ackSize) return 0
      const due = pending
      pending = 0
      return due
    },
    reset() {
      pending = 0
    }
  }
}
