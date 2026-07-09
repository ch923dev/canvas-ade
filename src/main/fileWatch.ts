/**
 * File-tree epic (S2) — the chokidar watcher that EMITS the `file:treeEvent` channel
 * reserved by S1 (see fileIpc.ts / preload). Watches the open project root and pushes
 * `{ type: 'add' | 'change' | 'unlink', path }` (path RELATIVE to the root, forward-slashed)
 * to the renderer so the docked tree stays live without re-walking the repo.
 *
 * Lifecycle: created once in index.ts; `watch(dir)` is (re)pointed on every project
 * open/switch (it closes the prior watcher first) and `close()` runs on quit. The watcher
 * is MAIN-only — the sandboxed renderer never touches fs/chokidar (security model intact).
 *
 * chokidar v5 notes (v4/v5 dropped globs): `ignored` is a match FUNCTION/regex/path — NOT a
 * glob — tested against the whole path; `awaitWriteFinish` holds an event until the file size
 * settles (no mid-save fires); `atomic: true` collapses the tmp-rename delete/recreate that
 * our own `write-file-atomic` saves produce into a single `change` (no save flicker). v5 is
 * ESM-only, so it loads via a lazy dynamic `import()` (MAIN bundles to CJS).
 */
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type { FSWatcher } from 'chokidar'

/** The raw chokidar event names we subscribe to (dir variants fold into add/unlink). */
export type RawWatchEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

/** Mirrors the preload `FileTreeEvent` contract (S1). `path` is RELATIVE to the project root. */
export interface TreeEventPayload {
  type: 'add' | 'change' | 'unlink'
  path: string
}

export interface FileWatcher {
  /** Point the watcher at a new project root (closing any prior one). `null` = stop watching. */
  watch(dir: string | null): Promise<void>
  /** Stop watching and release every fs handle. Safe to call repeatedly. */
  close(): Promise<void>
}

// H3: never watch the app's OWN write dir (`.canvas/` — canvas.json + .bak + memory + snapshots,
// all written ~1×/s: watching it is a write→watch→IPC feedback loop, and it's hidden from the File
// Tree anyway so there is zero functional loss) nor heavy dependency/build-output dirs (an open-time
// recursive readdir+stat storm on a large repo). Ignoring `.canvas` also cuts the atomic-write temp/
// rename contention behind the C3 false-`EPERM` "disk space" reports.
const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.canvas',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'venv',
  '.worktrees'
])
const IGNORED_BASENAMES = new Set(['canvas.json.bak'])

/**
 * Pure: should chokidar ignore this absolute path under `root`? Skips `.git/` and
 * `node_modules/` (any depth) and the parse-fail backup `canvas.json.bak`. The root itself is
 * never ignored; a path that resolves OUTSIDE the root is left to chokidar (defensive — the
 * watch target is the root, so this should not arise).
 */
export function shouldIgnore(root: string, absPath: string): boolean {
  const rel = path.relative(root, absPath)
  if (rel === '') return false
  if (rel.startsWith('..')) return false
  const segs = rel.split(/[\\/]/)
  for (const s of segs) if (IGNORED_SEGMENTS.has(s)) return true
  return IGNORED_BASENAMES.has(segs[segs.length - 1])
}

/**
 * Pure: map a chokidar event + absolute path into the renderer `FileTreeEvent` — a root-relative,
 * forward-slashed path (matching the tree's id scheme) with dir add/remove folded into add/unlink.
 * Returns `null` for the root itself or an out-of-root path (nothing for the tree to do).
 */
export function toTreeEvent(
  root: string,
  raw: RawWatchEvent,
  absPath: string
): TreeEventPayload | null {
  const rel = path.relative(root, absPath)
  if (rel === '' || rel.startsWith('..')) return null
  const type = raw === 'addDir' ? 'add' : raw === 'unlinkDir' ? 'unlink' : raw
  return { type, path: rel.split(/[\\/]/).join('/') }
}

export function createFileWatcher(getWin: () => BrowserWindow | null): FileWatcher {
  let watcher: FSWatcher | null = null
  // Monotonic token: a rapid open→switch can race the async setup below; only the latest
  // watch() call's token is honored, so a superseded setup disposes itself instead of leaking.
  let token = 0

  const send = (payload: TreeEventPayload): void => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send('file:treeEvent', payload)
  }

  async function close(): Promise<void> {
    const w = watcher
    watcher = null
    if (w) {
      try {
        await w.close()
      } catch {
        // best-effort — a failed close must never wedge a project switch or quit.
      }
    }
  }

  async function watch(dir: string | null): Promise<void> {
    const myToken = ++token
    await close()
    if (myToken !== token || !dir) return
    let root: string
    try {
      root = await realpath(dir)
    } catch {
      root = path.resolve(dir)
    }
    if (myToken !== token) return
    // FIND-003: chokidar is ESM-only and lazily imported, so a failed dynamic `import('chokidar')`
    // (a corrupt / asar-unresolvable module) or a throw from chokidarWatch() would REJECT this
    // promise. The sole caller is fire-and-forget (`void fileWatcher?.watch(dir)` in index.ts), so
    // that rejection has no `.catch` — it escapes to the global unhandledRejection sink and crashes
    // MAIN (crashShutdown → app.exit(1)). The live file tree is a convenience layer, so own the
    // error here and degrade gracefully (no watcher), exactly like startMcpServer / startLocalServer.
    try {
      const { watch: chokidarWatch } = await import('chokidar')
      if (myToken !== token) return
      const w = chokidarWatch(root, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignorePermissionErrors: true,
        // Hold an event until the file size settles — don't fire mid-save (chunked/large writes).
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        // Collapse the tmp-rename delete/recreate of our own write-file-atomic into one `change`.
        atomic: true,
        ignored: (p: string) => shouldIgnore(root, p)
      })
      const forward =
        (raw: RawWatchEvent) =>
        (abs: string): void => {
          const ev = toTreeEvent(root, raw, abs)
          if (ev) send(ev)
        }
      w.on('add', forward('add'))
        .on('change', forward('change'))
        .on('unlink', forward('unlink'))
        .on('addDir', forward('addDir'))
        .on('unlinkDir', forward('unlinkDir'))
        .on('error', (err) => console.warn('[fileWatch] watcher error (non-fatal)', err))
      // A newer watch() may have landed during realpath/import — if so, drop this one.
      if (myToken !== token) {
        try {
          await w.close()
        } catch {
          // ignore
        }
        return
      }
      watcher = w
    } catch (err) {
      // A dynamic-import / construction failure must NOT crash MAIN — log and run without the
      // live tree (it re-arms on the next project open). `watcher` stays null (close()d above).
      console.warn('[fileWatch] could not start the file watcher (non-fatal)', err)
    }
  }

  return { watch, close }
}
