import { watch } from 'node:fs'

export interface RecapWatcherDeps {
  onIntent: (boardId: string) => void
  debounceMs?: number
  /** injectable for tests; default wraps fs.watch */
  watchFile?: (path: string, onChange: () => void) => () => void
}

export interface RecapWatcher {
  track(boardId: string, transcriptPath: string): void
  untrack(boardId: string): void
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
      let w: ReturnType<typeof watch> | null = null
      try {
        w = watch(p, { persistent: false }, () => cb())
      } catch {
        /* file may not exist yet; watcher armed when it does */
      }
      return () => {
        try {
          w?.close()
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

  return {
    track(boardId, transcriptPath) {
      // Dispose any prior watcher for this board before re-arming.
      disposers.get(boardId)?.()
      disposers.set(
        boardId,
        watchFile(transcriptPath, () => fire(boardId))
      )
    },

    untrack(boardId) {
      disposers.get(boardId)?.()
      disposers.delete(boardId)
      const t = timers.get(boardId)
      if (t) clearTimeout(t)
      timers.delete(boardId)
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
