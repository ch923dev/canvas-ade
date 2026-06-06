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
 * Read the list, pruning any entry whose folder no longer exists.
 * BUG-010: async so the IPC thread is never blocked by a synchronous existsSync on a
 * stale UNC/network share. Each entry is checked via pathExists (async + timeout).
 */
export async function listRecents(userDataDir: string): Promise<RecentProject[]> {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return []
  let raw: RecentProject[]
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
    raw = Array.isArray(parsed.projects) ? (parsed.projects as RecentProject[]) : []
  } catch {
    return []
  }
  // Validate shape, then check each entry's path asynchronously (non-blocking).
  const shaped = raw.filter(
    (r) =>
      r &&
      typeof r.path === 'string' &&
      typeof r.name === 'string' &&
      typeof r.lastOpenedAt === 'number'
  )
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
  const others = (await listRecents(userDataDir)).filter((r) => r.path !== path)
  const next = [{ path, name, lastOpenedAt: at }, ...others].slice(0, RECENT_LIMIT)
  // Atomic write (mirrors projectStore): a torn writeFileSync could zero the MRU,
  // making listRecents silently return [] (BUG-L5). write-file-atomic stages to a
  // temp file + rename, so a crash mid-write leaves the prior good file intact.
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify({ projects: next }, null, 2), 'utf8')
}
