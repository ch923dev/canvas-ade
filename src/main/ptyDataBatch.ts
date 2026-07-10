/**
 * M9 (perf-persistence-audit polish): micro-batches PTY output chunks that land within the same
 * tick into one `postMessage`, instead of one per `onData` chunk. Under heavy output (a build log,
 * a fast `cat`) several chunks arrive per tick; posting each individually multiplies the per-chunk
 * cross-process IPC + renderer handler cost. Pure/electron-free so it unit-tests without node-pty.
 *
 * Owns the full "resolve the CURRENT live target, then post" step (not just the buffering) so the
 * per-spawn identity-guard wiring in `pty.ts` stays to a single `getLive` line — a park/adopt
 * between a chunk's `push` and this flush must resolve against whatever session is live NOW, same
 * as the direct per-chunk post this replaces.
 */
export interface LiveDataTarget {
  postMessage(msg: { t: 'data'; d: string }): void
}

/** The identity-guard ternary factored out so `pty.ts`'s per-spawn wiring stays to one line: a
 *  session is only a valid post target while it still owns the CALLER's exact proc — a dying old
 *  proc that keeps draining bytes after kill(), or one already replaced by a respawn, must not. */
export function ownedPort<T extends { proc: unknown; port: LiveDataTarget }>(
  live: T | undefined,
  proc: unknown
): LiveDataTarget | undefined {
  return live && live.proc === proc ? live.port : undefined
}

export interface ChunkBatcher {
  /** Buffer a chunk; schedules a flush on the next tick if one isn't already pending. */
  push(chunk: string): void
  /** Flush any buffered chunks synchronously now, cancelling a pending scheduled flush. */
  flushNow(): void
}

export function createChunkBatcher(getLive: () => LiveDataTarget | undefined): ChunkBatcher {
  let pending: string[] = []
  let scheduled: NodeJS.Immediate | null = null

  function run(): void {
    scheduled = null
    if (pending.length === 0) return
    const d = pending.length === 1 ? pending[0] : pending.join('')
    pending = []
    try {
      getLive()?.postMessage({ t: 'data', d })
    } catch {
      /* port closed */
    }
  }

  return {
    push(chunk) {
      pending.push(chunk)
      if (scheduled === null) scheduled = setImmediate(run)
    },
    flushNow() {
      if (scheduled !== null) {
        clearImmediate(scheduled)
        scheduled = null
      }
      run()
    }
  }
}

/**
 * Teardown-side drain: synchronously flush a session's pending micro-batch via the `flushData`
 * hook it carries (absent on mocks/legacy shapes ⇒ no-op). Called by cleanupCore/parkCore BEFORE
 * the map delete + port close, so a chunk buffered in the same tick as a kill/restart/reap/park
 * still reaches the renderer — the per-chunk post this module replaced was synchronous and never
 * lost that final output. Emptying the buffer also stops a stray scheduled flush from
 * double-posting after a later adopt() replays the ring (which already holds these bytes).
 * Swallows: a drain must never block teardown.
 */
export function drainBatch(s: { flushData?: () => void }): void {
  try {
    s.flushData?.()
  } catch {
    /* port closed / already torn down */
  }
}
