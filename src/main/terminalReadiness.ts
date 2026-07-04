/**
 * Terminal boot-readiness waiter (the MCP dispatch readiness gate).
 *
 * PROBLEM: a PTY session exists the instant `pty.spawn` returns — BEFORE the shell has sourced its
 * profile and BEFORE any `launchCommand` agent (e.g. `claude`) has booted and drawn its input box.
 * The dispatch gate (`runGatedWrite`) writes the moment `writeToPty` finds a live session, so a
 * relay/assign into a freshly-spawned terminal can land mid-boot — swallowed by the shell line or
 * a CLI trust-prompt — while the tool still reports success. The only prior mitigation was the
 * renderer Command board's fixed 1500ms boot-settle (`useCommandDispatch`), which external MCP
 * callers never get.
 *
 * SIGNAL (hybrid, evaluated in the 2026-07-03 plan): a fixed floor alone can't see a slow boot,
 * and output-silence alone settles on the pre-launch quiet gap — so this waits for
 *   floor (min boot age) → activity seen → quiet window,
 * with a hard backstop that DEGRADES (resolves 'unconfirmed', never throws/blocks forever) and a
 * per-process latch + maturity fast-path so a busy, long-running agent never re-pays the wait.
 * Read-only observation: it taps only `getTerminalBootInfo` / `getTerminalActivityStaleMs`
 * (control-plane probes over the session map) — it never touches the PTY data stream and cannot
 * reorder or weaken the dispatch pipeline it serves.
 */

export type ReadinessOutcome =
  /** Boot-quiet observed after the floor — the REPL/prompt is up. */
  | 'ready'
  /**
   * This exact process (boardId+pid) was already confirmed ready by an earlier wait AND is
   * currently quiet (or re-quieted within the requalify cap — see READY_REQUALIFY_MS).
   */
  | 'ready_latched'
  /**
   * Session older than the backstop — boot finished long ago (readiness is about the boot window
   * only) AND currently quiet (or the requalify cap elapsed — see READY_REQUALIFY_MS).
   */
  | 'ready_assumed'
  /** Backstop elapsed (or the wait was aborted) without observing boot-quiet — delivery not guaranteed. */
  | 'unconfirmed'
  /** No live session for the id — the subsequent PTY write will fail loudly exactly as today. */
  | 'no_session'

export interface ReadinessResult {
  outcome: ReadinessOutcome
  waitedMs: number
}

/** Injected probes (prod wires pty.ts getters; tests inject fakes + a fake clock). */
export interface ReadinessDeps {
  bootInfo(id: string): { ageMs: number; pid: number } | undefined
  activityStaleMs(id: string): number | undefined
  now(): number
}

export interface ReadinessOpts {
  minBootMs?: number
  quietMs?: number
  pollMs?: number
  backstopMs?: number
  /** Cap on the latch/maturity requalify wait (relay cut-off fix) — see READY_REQUALIFY_MS. */
  requalifyMs?: number
  /** Abort (confirm denied) → resolve 'unconfirmed' immediately, all timers cleared. */
  signal?: AbortSignal
}

/** Floor before quiet counts — mirrors the renderer's proven WORKER_BOOT_SETTLE_MS. */
export const READY_MIN_BOOT_MS = 1500
/** Output-silence window that means "boot finished" (boot-quiet, not task-quiet — cf. awaitSettled's 6s). */
export const READY_QUIET_MS = 800
export const READY_POLL_MS = 250
/** Degrade-honestly deadline: past this we write anyway and audit `dispatched_unconfirmed`. */
export const READY_BACKSTOP_MS = 15_000
/**
 * Relay cut-off fix (2026-07-04): the latch and maturity fast-paths previously returned the
 * INSTANT they matched, with no look at the target's CURRENT output state — so a dispatch into a
 * long-lived session whose agent was mid-boot/redraw (`ready_assumed` on the observed F4 relay)
 * wrote straight into the burst and the TUI swallowed the head. Fast-path hits now requalify:
 * instantly quiet (staleMs ≥ quietMs) resolves as before; output CURRENTLY flowing runs a short
 * bounded quiet-wait capped at this value — NOT the 15s boot backstop, so a dispatch into a busy
 * streaming agent stalls ≤3s and then proceeds under its fast-path label (the paste-framed write
 * is safe mid-stream; this wait only narrows the mid-burst window).
 */
export const READY_REQUALIFY_MS = 3000

export interface ReadinessWaiter {
  awaitTerminalReady(id: string, opts?: ReadinessOpts): Promise<ReadinessResult>
}

export function createReadinessWaiter(deps: ReadinessDeps): ReadinessWaiter {
  /** boardId → the pid confirmed ready (a respawn under the same id gets a new pid → latch miss). */
  const latch = new Map<string, number>()

  const awaitTerminalReady = (id: string, opts: ReadinessOpts = {}): Promise<ReadinessResult> => {
    const minBootMs = opts.minBootMs ?? READY_MIN_BOOT_MS
    const quietMs = opts.quietMs ?? READY_QUIET_MS
    const pollMs = opts.pollMs ?? READY_POLL_MS
    const backstopMs = opts.backstopMs ?? READY_BACKSTOP_MS
    const requalifyMs = opts.requalifyMs ?? READY_REQUALIFY_MS
    const started = deps.now()

    /**
     * Bounded quiet-observation loop, shared by the full boot wait and the fast-path requalify.
     * Resolves 'ready' on activity-then-quiet (latching the observed pid); resolves `capOutcome`
     * at `capMs` (the boot wait degrades to 'unconfirmed'; a requalify falls back to its
     * fast-path label — the write proceeds either way, honesty rides the outcome + waitedMs).
     */
    const observeQuiet = (
      initialPid: number,
      presumeActivity: boolean,
      capMs: number,
      capOutcome: ReadinessOutcome
    ): Promise<ReadinessResult> =>
      new Promise<ReadinessResult>((resolve) => {
        let basePid = initialPid
        let sawActivity = presumeActivity
        let done = false

        const finish = (outcome: ReadinessOutcome): void => {
          if (done) return
          done = true
          clearInterval(pollTimer)
          clearTimeout(backstopTimer)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve({ outcome, waitedMs: Math.max(0, deps.now() - started) })
        }
        const onAbort = (): void => finish('unconfirmed')

        const tick = (): void => {
          const cur = deps.bootInfo(id)
          // Session died mid-wait → resolve now; the gate's own writeToPty failure path audits
          // `failed` + throws exactly as today (this waiter never converts that into a hang).
          if (!cur) return finish('no_session')
          // Respawn under the same board id mid-wait: a NEW process is booting — restart the
          // observation against it (fresh floor via its own ageMs, activity state reset). (A
          // respawn during a short requalify can therefore cap out under the fast-path label —
          // accepted: the paste-framed write is the real protection; this loop only narrows the
          // mid-burst window.)
          if (cur.pid !== basePid) {
            basePid = cur.pid
            sawActivity = false
          }
          if (cur.ageMs < minBootMs) return
          const stale = deps.activityStaleMs(id)
          if (stale === undefined) return
          if (stale < quietMs) {
            // Output is (still) flowing — the same "saw activity, then quiet" guard as
            // awaitSettled: never settle on a pre-output quiet gap.
            sawActivity = true
            return
          }
          if (sawActivity) {
            latch.set(id, basePid)
            finish('ready')
          }
        }

        const pollTimer = setInterval(tick, pollMs)
        pollTimer.unref?.()
        const backstopTimer = setTimeout(() => finish(capOutcome), capMs)
        backstopTimer.unref?.()
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        tick()
      })

    const info = deps.bootInfo(id)
    if (!info) return Promise.resolve({ outcome: 'no_session', waitedMs: 0 })

    // Fast paths — latch (this exact boardId+pid already confirmed ready) and maturity
    // (readiness is about the BOOT window only; a mid-task agent streaming output would never
    // show a quiet window, so a session older than the backstop is assumed booted). Both now
    // REQUALIFY against the target's CURRENT output state instead of returning blind (relay
    // cut-off fix — see READY_REQUALIFY_MS): instantly quiet resolves as before; output flowing
    // right now runs the short bounded quiet-wait and falls back to the fast-path label at cap.
    const latched = latch.get(id) === info.pid
    const mature = info.ageMs >= backstopMs
    if (latched || mature) {
      if (!latched) latch.set(id, info.pid)
      const fastOutcome: ReadinessOutcome = latched ? 'ready_latched' : 'ready_assumed'
      const stale = deps.activityStaleMs(id)
      if (stale !== undefined && stale >= quietMs) {
        return Promise.resolve({ outcome: fastOutcome, waitedMs: 0 })
      }
      return observeQuiet(info.pid, true, requalifyMs, fastOutcome)
    }

    return observeQuiet(info.pid, false, backstopMs, 'unconfirmed')
  }

  return { awaitTerminalReady }
}
