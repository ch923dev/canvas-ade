/**
 * The guarded before-quit chain, extracted so it is unit-testable in isolation from the
 * electron `app` lifecycle (index.ts can't be imported in a node test — it boots the app).
 *
 * `before-quit-flush-no-catch`: the flush → shutdown → exit chain must ALWAYS reach
 * shutdown() (the awaited PTY-tree drain, #49) even if the renderer flush rejects. The old
 * inline `flushRenderer().then(shutdown).finally(exit)` skipped `.then(shutdown)` on a flush
 * rejection, orphaning a deep agent child-process tree on quit. The `.catch` here guarantees
 * teardown runs regardless; `exit(0)` still fires last via `.finally`.
 */
export function performGuardedQuit(deps: {
  flush: () => Promise<void>
  shutdown: () => Promise<void>
  exit: (code: number) => void
  onFlushError?: (err: unknown) => void
}): Promise<void> {
  return deps
    .flush()
    .catch((err) => {
      deps.onFlushError?.(err)
    })
    .then(() => deps.shutdown())
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
