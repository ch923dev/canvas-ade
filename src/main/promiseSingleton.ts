/**
 * Single-flight promise memoizer (M11 lazy-start; also a general util). Wraps an async `start` so
 * concurrent callers share ONE in-flight run and later callers get the same settled promise — the
 * canonical "memoize the promise, not the result" lazy-init pattern (jonmellman.com/posts/
 * singleton-promises, sindresorhus/p-memoize). Pure — imports nothing, so it is unit-testable without
 * the caller's dependency graph.
 *
 * Contract:
 * - The promise is assigned SYNCHRONOUSLY, so two calls in the same tick share one `start()`.
 * - `onResolve` fires once with the resolved value (INCLUDING a resolved `null` — a valid cached
 *   state, e.g. startMcpServer's non-fatal bind failure), before the value is handed back.
 * - A REJECTED start catch-evicts (nulls the latch) and re-throws, so a later call retries a fresh
 *   `start()` rather than replaying a poisoned rejection.
 */
export function singleFlight<T>(
  start: () => Promise<T>,
  onResolve: (value: T) => void
): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (!inFlight) {
      inFlight = start()
        .then((value) => {
          onResolve(value)
          return value
        })
        .catch((err) => {
          inFlight = null // evict so a later call retries a fresh start()
          throw err
        })
    }
    return inFlight
  }
}
