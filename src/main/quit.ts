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
