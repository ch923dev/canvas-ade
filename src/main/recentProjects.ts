/**
 * Recent-projects list, stored in the app's userData dir (NEVER in a project folder).
 * Pure file I/O keyed by an explicit userDataDir + caller-supplied timestamp, so it's
 * fully testable without Electron's `app`. MRU-ordered, capped, prunes dead folders.
 */
import { mkdirSync, readFileSync, existsSync } from 'fs'
import { access } from 'fs/promises'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export const RECENT_LIMIT = 10

/**
 * Per-path timeout for the async existence check (BUG-010).
 * A stale UNC/SMB path can block existsSync for 5–30 s; we give up after this many ms
 * instead and treat the path as gone. 500 ms is generous for local paths (which resolve
 * in < 1 ms) while remaining far below the SMB timeout floor.
 */
const PATH_CHECK_TIMEOUT_MS = 500

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'recent-projects.json')
}

/**
 * BUG-010: check whether a path exists without blocking the IPC thread.
 * Uses Promise.race between fs/promises.access and a timeout so a stale UNC/SMB share
 * that would block existsSync for up to 30 s is abandoned after PATH_CHECK_TIMEOUT_MS.
 * Note: AbortSignal on fs.promises.access is not reliably honored on Windows for UNC
 * paths (the kernel-level SMB probe continues in the background), so we race instead —
 * the timeout Promise wins after PATH_CHECK_TIMEOUT_MS and we treat the path as gone.
 */
function pathExists(p: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), PATH_CHECK_TIMEOUT_MS)
    access(p).then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      }
    )
  })
}

/**
 * L3: the parsed+shaped list, cached per userDataDir so project:open/create/reopen (each calling
 * listRecents, incl. the isUnderApprovedRoot gate) don't re-read + re-parse the file on every call.
 * Every write in this module goes through `touchRecent`/`removeRecent`/`clearRecents`, and each of
 * those overwrites this cache with the exact list it just persisted — so the cache can never observe
 * a write this process didn't just make itself.
 */
const storedCache = new Map<string, RecentProject[]>()

function shapeRecents(raw: unknown): RecentProject[] {
  return (Array.isArray(raw) ? (raw as RecentProject[]) : []).filter(
    (r) =>
      r &&
      typeof r.path === 'string' &&
      typeof r.name === 'string' &&
      typeof r.lastOpenedAt === 'number'
  )
}

/**
 * Read + shape-validate the stored list WITHOUT any existence filtering.
 * BUG-044: this is the persistence-side read — touchRecent must build its written list
 * from the raw stored entries, because the pathExists timeout in listRecents is a
 * DISPLAY concern: a transiently-slow (>500ms) network-share path would otherwise be
 * permanently deleted from the MRU file by the next touch.
 */
function readStoredRecents(userDataDir: string): RecentProject[] {
  const cached = storedCache.get(userDataDir)
  if (cached) return cached
  const file = fileFor(userDataDir)
  if (!existsSync(file)) {
    storedCache.set(userDataDir, [])
    return []
  }
  let shaped: RecentProject[]
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
    shaped = shapeRecents(parsed.projects)
  } catch {
    return [] // parse failure: don't cache — a fixed-up file on a later read should be seen
  }
  storedCache.set(userDataDir, shaped)
  return shaped
}

/**
 * Read the list, pruning any entry whose folder no longer exists.
 * BUG-010: async so the IPC thread is never blocked by a synchronous existsSync on a
 * stale UNC/network share. Each entry is checked via pathExists (async + timeout).
 * The prune is read-time/display only — it is never persisted back (BUG-044).
 */
export async function listRecents(userDataDir: string): Promise<RecentProject[]> {
  const shaped = readStoredRecents(userDataDir)
  const exists = await Promise.all(shaped.map((r) => pathExists(r.path)))
  return shaped.filter((_, i) => exists[i])
}

/** Insert/move `path` to the front, stamp `at`, cap to RECENT_LIMIT, persist. */
export async function touchRecent(
  userDataDir: string,
  path: string,
  name: string,
  at: number
): Promise<void> {
  mkdirSync(userDataDir, { recursive: true })
  // BUG-044: persist from the UNFILTERED stored list — never from listRecents' output.
  // listRecents drops any path whose access() probe exceeds the 500ms timeout (a cold
  // SMB/UNC share routinely does); writing that filtered list back would permanently
  // delete a merely-slow entry from the MRU file on every open of any other project.
  const others = readStoredRecents(userDataDir).filter((r) => r.path !== path)
  const next = [{ path, name, lastOpenedAt: at }, ...others].slice(0, RECENT_LIMIT)
  // Atomic write (mirrors projectStore): a torn writeFileSync could zero the MRU,
  // making listRecents silently return [] (BUG-L5). write-file-atomic stages to a
  // temp file + rename, so a crash mid-write leaves the prior good file intact.
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify({ projects: next }, null, 2), 'utf8')
  storedCache.set(userDataDir, next) // L3: this write IS the new cached truth — no re-read needed
}

/**
 * Remove a single entry from the stored list. LIST-ONLY: never touches the project
 * folder on disk. Filters the UNFILTERED stored list (BUG-044 discipline — removing
 * one entry must not silently drop a transiently-slow sibling the display prune is
 * hiding). No-op (no write) if the path is not present.
 */
export async function removeRecent(userDataDir: string, path: string): Promise<void> {
  const stored = readStoredRecents(userDataDir)
  const next = stored.filter((r) => r.path !== path)
  if (next.length === stored.length) return
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify({ projects: next }, null, 2), 'utf8')
  storedCache.set(userDataDir, next) // L3
}

/** Wipe the stored list entirely. LIST-ONLY: project folders on disk are untouched. */
export async function clearRecents(userDataDir: string): Promise<void> {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify({ projects: [] }, null, 2), 'utf8')
  storedCache.set(userDataDir, []) // L3
}
