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

/**
 * Returns the board's serialized ANSI buffer + the EXACT byte boundary it represents on MAIN's ring
 * `written` axis (T2·D2 — the snapshot/tail splice point), or null when there is nothing worth
 * persisting. `watermark` lets MAIN splice the switch-back tail from the true snapshot boundary
 * instead of an approximate handler-entry ring count.
 */
type Snapshot = { text: string; watermark: number }
type Snapshotter = () => Snapshot | null

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
 *
 * `sync` forces MAIN's synchronous, event-loop-blocking writer instead of the default async one — pass
 * `true` ONLY for the main-driven before-quit flush (`project:flush`), where the process may exit right
 * after this resolves. Every other caller (window blur, project switch) must stay async so a large
 * scrollback buffer can't stall the whole app.
 */
export async function flushAllTerminalSnapshots(opts?: {
  sync?: boolean
  /** R2 dir-pin: the project these buffers BELONG to — MAIN rejects the write if a racing
   *  switch has already moved `currentDir` on (background sessions make that race real). */
  expectedDir?: string
}): Promise<void> {
  const sync = opts?.sync ?? false
  const entries = [...registry.entries()]
  await Promise.all(
    entries.map(async ([id, fn]) => {
      let snap: Snapshot | null = null
      try {
        snap = fn()
      } catch {
        snap = null
      }
      if (!snap || !snap.text || !snap.text.trim()) return
      await window.api.terminal
        .writeSnapshot(id, snap.text, sync, opts?.expectedDir, snap.watermark)
        .catch(() => false)
    })
  )
}
