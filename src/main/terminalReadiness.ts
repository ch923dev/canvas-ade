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
  /** This exact process (boardId+pid) was already confirmed ready by an earlier wait. */
  | 'ready_latched'
  /** Session older than the backstop — boot finished long ago; readiness is about the boot window only. */
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
    const started = deps.now()

    const info = deps.bootInfo(id)
    if (!info) return Promise.resolve({ outcome: 'no_session', waitedMs: 0 })
    if (latch.get(id) === info.pid) {
      return Promise.resolve({ outcome: 'ready_latched', waitedMs: 0 })
    }
    // Maturity fast-path: readiness is about the BOOT window only. A mid-task agent streaming
    // output would never show a quiet window — without this, every later relay into a busy
    // board would stall for the full backstop.
    if (info.ageMs >= backstopMs) {
      latch.set(id, info.pid)
      return Promise.resolve({ outcome: 'ready_assumed', waitedMs: 0 })
    }

    return new Promise<ReadinessResult>((resolve) => {
      let basePid = info.pid
      let sawActivity = false
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
        // observation against it (fresh floor via its own ageMs, activity state reset).
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
      const backstopTimer = setTimeout(() => finish('unconfirmed'), backstopMs)
      backstopTimer.unref?.()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      tick()
    })
  }

  return { awaitTerminalReady }
}
