/**
 * Persistent registry of CROSS-CWD recap-hook installs (PR #333 review, warning disposition).
 *
 * The spawn-time / boot-detect providers write the recap hook into a board's cwd — which can be
 * any directory outside the open project. The consent-decline path previously removed only the
 * OPEN project's own hook, leaving `.claude/settings.local.json` permanently modified in every
 * other repo a board ever spawned into. This module tracks those divergent dirs (keyed by the
 * consenting project root) so a decline can clean EVERY dir the consent ever wrote into — and it
 * persists across restarts, so a revoke in a later session still finds a prior session's writes.
 *
 * Mirrors `cliProvisioners/provisionedDirStore.ts` (the F8 pattern this review pointed at):
 * a flat JSON object in `<userData>/recap-hook-dirs.json`, project root → divergent dirs. The
 * project root itself is never stored (the decline root pass always cleans it). Pure Node fs
 * keyed by an explicit `userDataDir` — unit-tests without an electron mock. Paths only, no
 * secrets: the hook entry it locates is the public recordSession.js exec line.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

type RecapHookDirStore = Record<string, string[]>

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'recap-hook-dirs.json')
}

/** Parse-defensive read: missing/corrupt file → {}; only string[] entries survive. */
function readStore(userDataDir: string): RecapHookDirStore {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    const out: RecapHookDirStore = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((d): d is string => typeof d === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(userDataDir: string, store: RecapHookDirStore): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(store, null, 2), 'utf8')
}

/**
 * Record a divergent recap-hook install (read → merge → atomic write). Idempotent; a root
 * target (dir === projectDir) is a no-op — the decline root pass always cleans the root.
 */
export function recordRecapHookDir(
  userDataDir: string,
  projectDir: string,
  targetDir: string
): void {
  if (targetDir === projectDir) return
  const store = readStore(userDataDir)
  const dirs = new Set(store[projectDir] ?? [])
  if (dirs.has(targetDir)) return
  dirs.add(targetDir)
  store[projectDir] = [...dirs]
  writeStore(userDataDir, store)
}

/** Every divergent dir recorded for a project (empty when none). Read-only. */
export function listRecapHookDirs(userDataDir: string, projectDir: string): string[] {
  return readStore(userDataDir)[projectDir] ?? []
}

/** Drop a project's entry after a decline cleaned everything for it. No-op when absent. */
export function clearRecapHookDirs(userDataDir: string, projectDir: string): void {
  const store = readStore(userDataDir)
  if (!(projectDir in store)) return
  delete store[projectDir]
  writeStore(userDataDir, store)
}
