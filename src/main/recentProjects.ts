/**
 * Recent-projects list, stored in the app's userData dir (NEVER in a project folder).
 * Pure file I/O keyed by an explicit userDataDir + caller-supplied timestamp, so it's
 * fully testable without Electron's `app`. MRU-ordered, capped, prunes dead folders.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const RECENT_LIMIT = 10

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'recent-projects.json')
}

/** Read the list, pruning any entry whose folder no longer exists. */
export function listRecents(userDataDir: string): RecentProject[] {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
    const raw = Array.isArray(parsed.projects) ? (parsed.projects as RecentProject[]) : []
    return raw.filter(
      (r) =>
        r &&
        typeof r.path === 'string' &&
        typeof r.name === 'string' &&
        typeof r.lastOpenedAt === 'number' &&
        existsSync(r.path)
    )
  } catch {
    return []
  }
}

/** Insert/move `path` to the front, stamp `at`, cap to RECENT_LIMIT, persist. */
export function touchRecent(userDataDir: string, path: string, name: string, at: number): void {
  mkdirSync(userDataDir, { recursive: true })
  const others = listRecents(userDataDir).filter((r) => r.path !== path)
  const next = [{ path, name, lastOpenedAt: at }, ...others].slice(0, RECENT_LIMIT)
  writeFileSync(fileFor(userDataDir), JSON.stringify({ projects: next }, null, 2), 'utf8')
}
