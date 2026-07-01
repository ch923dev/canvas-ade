/**
 * Phase 5 · S3 — a runtime registry of mounted terminals' buffer serializers, so the app can flush
 * every live terminal's scrollback to its `.canvas/terminal/<id>.snapshot` sidecar at the
 * "everything is going away" moments (app quit, window close, project switch) WITHOUT threading a
 * ref through React. Each Terminal board registers a thunk on mount (backed by its SerializeAddon)
 * and unregisters on teardown.
 *
 * Decoupling the flush from React unmount is deliberate: a hard `app.exit(0)` on quit (BUG-M2) never
 * runs React teardown, and a project switch replaces the scene before the old nodes unmount — so a
 * registry iterated at the flush moment is the only reliable capture point. Empty/whitespace-only
 * buffers are skipped so an untouched idle board never writes a blank sidecar.
 */

/** Returns the board's serialized ANSI buffer, or null when there is nothing worth persisting. */
type Snapshotter = () => string | null

const registry = new Map<string, Snapshotter>()

export function registerTerminalSnapshotter(id: string, fn: Snapshotter): void {
  registry.set(id, fn)
}

export function unregisterTerminalSnapshotter(id: string): void {
  registry.delete(id)
}

/**
 * Serialize + persist every registered terminal. Best-effort per board (one board's serialize/write
 * error never blocks the others). Awaited by the caller so the before-quit reply can't resolve the
 * quit and let `app.exit(0)` race ahead of the writes.
 */
export async function flushAllTerminalSnapshots(): Promise<void> {
  const entries = [...registry.entries()]
  await Promise.all(
    entries.map(async ([id, fn]) => {
      let text: string | null = null
      try {
        text = fn()
      } catch {
        text = null
      }
      if (!text || !text.trim()) return
      await window.api.terminal.writeSnapshot(id, text).catch(() => false)
    })
  )
}
