/**
 * The guarded before-quit chain, extracted so it is unit-testable in isolation from the
 * electron `app` lifecycle (index.ts can't be imported in a node test — it boots the app).
 *
 * `before-quit-flush-no-catch`: the flush → shutdown → exit chain must ALWAYS reach
 * shutdown() (the awaited PTY-tree drain, #49) even if the renderer flush rejects. The old
 * inline `flushRenderer().then(shutdown).finally(exit)` skipped `.then(shutdown)` on a flush
 * rejection, orphaning a deep agent child-process tree on quit. The `.catch` here guarantees
 * teardown runs regardless; `exit(0)` still fires last via `.finally`.
 *
 * `quit-reject-catch`: a `shutdown()` rejection (e.g. the PTY drain throwing) was not caught, so
 * the returned promise stayed rejected even though `.finally` still fired `exit(0)`. The caller
 * in index.ts invokes this with `void performGuardedQuit(...)` (a synchronous `before-quit`
 * handler can't await it), so that rejection had nowhere to land but
 * `process.on('unhandledRejection', ...)` — routing a normal quit through the crash sink. The
 * `.catch` below mirrors the flush-side handling so a shutdown failure is reported via
 * `onShutdownError` instead of escaping as an unhandled rejection.
 */
export function performGuardedQuit(deps: {
  flush: () => Promise<void>
  shutdown: () => Promise<void>
  exit: (code: number) => void
  onFlushError?: (err: unknown) => void
  onShutdownError?: (err: unknown) => void
}): Promise<void> {
  return deps
    .flush()
    .catch((err) => {
      deps.onFlushError?.(err)
    })
    .then(() => deps.shutdown())
    .catch((err) => {
      deps.onShutdownError?.(err)
    })
    .finally(() => deps.exit(0))
}

/**
 * Crash/signal cleanup (#50), extracted from index.ts for the same testability reason as
 * performGuardedQuit. before-quit/window-all-closed don't fire on an uncaught error or an external
 * SIGINT/SIGTERM, which would orphan the node-pty child trees. The returned handler — shared by all
 * the crash sinks (uncaughtException / unhandledRejection / SIGINT / SIGTERM) — is idempotent (the
 * FIRST crash wins, so a cascading error during teardown can't re-enter), logs the error when one is
 * present, fires the best-effort tree-kill (shutdown is fire-and-forget — a crash handler can't await
 * the async taskkill), then exits with the given code.
 */
export function makeCrashHandler(deps: {
  shutdown: () => Promise<void>
  exit: (code: number) => void
  logError?: (err: unknown) => void
}): (exitCode: number, err?: unknown) => void {
  let crashing = false
  return (exitCode, err) => {
    if (crashing) return
    crashing = true
    if (err !== undefined) deps.logError?.(err)
    void deps.shutdown()
    deps.exit(exitCode)
  }
}

/**
 * The window `'closed'` cleanup, extracted (same testability reason as the two above) so the
 * darwin-only PTY-dispose guard — the whole point of this fix — is unit-pinned.
 *
 * The main window's `'closed'` handler always tears down the offscreen preview renderers + the
 * Mermaid worker (BUG-005: they don't die with their window, so they'd leak while no window
 * exists). On **darwin ONLY** it must ALSO reap the PTY trees: closing the last window on macOS
 * does NOT quit the app (`window-all-closed` is a no-op there), so the `before-quit` →
 * `shutdown()` → `disposeAllPtys()` drain never fires and every live + parked agent PTY is
 * orphaned — running, burning tokens, unreachable (adopt only reattaches *parked* sessions, not
 * live ones) — until Cmd+Q.
 *
 * Why the guard (do NOT drop it): on Win/Linux `window-all-closed` routes through `app.quit()` →
 * the **awaited** `before-quit` drain, so `app.exit(0)` cannot race the tree-kill. Disposing here
 * as well would clear the session maps first, turning that awaited `disposeAllPtys()` into a no-op
 * and moving the real (async `taskkill`) reap OFF the awaited path — re-introducing the orphan on
 * the platform that currently gets it right. So the dispose is darwin-only; Win/Linux keep the
 * before-quit path untouched.
 *
 * `disposePtys` is fire-and-forget here: on darwin the app keeps running, so the async tree-kill
 * completes in the background with nothing racing it. Terminal scrollback snapshots are captured
 * renderer-side on `beforeunload` (useAutosave `onUnload`) from the xterm buffer — independent of
 * the live PTY — so killing the tree here cannot lose them.
 */
export function performWindowCloseCleanup(deps: {
  platform: NodeJS.Platform
  disposeOsr: () => void
  disposeDiagramWorker: () => void
  disposePtys: () => Promise<void> | void
}): void {
  deps.disposeOsr()
  deps.disposeDiagramWorker()
  if (deps.platform === 'darwin') void deps.disposePtys()
}
