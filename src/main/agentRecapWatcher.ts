import { existsSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'

export interface RecapWatcherDeps {
  onIntent: (boardId: string) => void
  debounceMs?: number
  /** injectable for tests; default wraps fs.watch */
  watchFile?: (path: string, onChange: () => void) => () => void
}

export interface RecapWatcher {
  track(boardId: string, transcriptPath: string): void
  untrack(boardId: string): void
  /**
   * Untrack every currently-tracked board NOT in `liveBoardIds`. Driven from the canvas
   * doc-observe path (project save/open/switch) so a deleted terminal — or every board of a
   * project we switched away from — has its fs.watch handle + pending debounce torn down,
   * instead of leaking until app quit.
   */
  retain(liveBoardIds: Set<string>): void
  kick(boardId: string): void // test seam: simulate a change
  dispose(): void
}

export function createRecapWatcher(deps: RecapWatcherDeps): RecapWatcher {
  // 25s matches the value index.ts passes — a transcript can churn rapidly mid-turn, so we
  // coalesce a burst of writes into one summary refresh rather than re-summarizing per line.
  const debounceMs = deps.debounceMs ?? 25_000
  const watchFile =
    deps.watchFile ??
    ((p, cb) => {
      // Prefer a direct file watch (fires on every write, regardless of whether the platform
      // reports a filename). But the SessionStart hook can record the map entry — and so call
      // track() — a beat BEFORE Claude has written the transcript JSONL, and the map gets only
      // ONE entry per session, so a plain fs.watch(file) that ENOENTs would never re-arm for that
      // session (its auto-refresh would be dead until another session starts). So when the file
      // is absent, watch its PARENT DIR only long enough to catch the file's creation — gated on
      // existsSync(p) so a sibling session's transcript in the same projects/<slug>/ dir doesn't
      // trip it (and waste LLM budget) — then switch to a direct file watch.
      let fileW: ReturnType<typeof watch> | null = null
      let dirW: ReturnType<typeof watch> | null = null
      const armFile = (): void => {
        try {
          fileW = watch(p, { persistent: false }, () => cb())
        } catch {
          /* vanished again between the create event and the arm — re-armed on next map update */
        }
      }
      try {
        fileW = watch(p, { persistent: false }, () => cb())
      } catch {
        try {
          const fname = basename(p)
          dirW = watch(dirname(p), { persistent: false }, (_event, filename) => {
            if ((filename === null || filename === fname) && existsSync(p)) {
              try {
                dirW?.close()
              } catch {
                /* already closed */
              }
              dirW = null
              armFile()
              cb() // the file now exists — treat its creation as the first change
            }
          })
        } catch {
          /* neither file nor parent dir watchable yet — re-armed on the next session-map update */
        }
      }
      return () => {
        try {
          fileW?.close()
        } catch {
          /* already closed */
        }
        try {
          dirW?.close()
        } catch {
          /* already closed */
        }
      }
    })

  const disposers = new Map<string, () => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const fire = (id: string): void => {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        deps.onIntent(id)
      }, debounceMs)
    )
  }

  const untrackId = (boardId: string): void => {
    disposers.get(boardId)?.()
    disposers.delete(boardId)
    const t = timers.get(boardId)
    if (t) clearTimeout(t)
    timers.delete(boardId)
  }

  return {
    track(boardId, transcriptPath) {
      // Dispose any prior watcher for this board before re-arming.
      disposers.get(boardId)?.()
      disposers.set(
        boardId,
        watchFile(transcriptPath, () => fire(boardId))
      )
    },

    untrack: untrackId,

    retain(liveBoardIds) {
      for (const id of [...disposers.keys()]) {
        if (!liveBoardIds.has(id)) untrackId(id)
      }
    },

    kick: fire,

    dispose() {
      for (const d of disposers.values()) d()
      for (const t of timers.values()) clearTimeout(t)
      disposers.clear()
      timers.clear()
    }
  }
}
