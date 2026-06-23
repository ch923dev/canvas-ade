/**
 * Persistent store for the divergent-dir registry (W1-E · F8, defect-audit 2026-06-20 HIGH).
 *
 * The spawn-time provisioner hook writes a PROJECT-SCOPED MCP config (Claude `.mcp.json`, OpenCode
 * `opencode.json`) — each carrying a PLAINTEXT bearer token — into the board's cwd, which the user
 * can point at any subfolder. `cliProvisioners/index.ts` tracks those divergent dirs in an
 * in-memory Map (`provisionedDirs`) so consent-revoke can clean EVERY on-disk token, not just the
 * project root (FIND-001). But that Map is process memory: after an app restart it is empty, so a
 * revoke in a LATER session never finds — and never deletes — a token a PRIOR session wrote into a
 * divergent cwd. The credential survives both the restart AND the revoke (the F8 leak).
 *
 * This module persists that Map to `<userData>/provisioned-dirs.json` so the full divergent-dir set
 * outlives any one session and revoke cleans ALL of them. It mirrors the orchestration-consent.json
 * / recap-consent.json stores exactly: a flat JSON object keyed by the absolute project root, value
 * = an array of divergent target dirs. The project root itself is NEVER stored (the unsync root pass
 * always cleans it). Pure Node fs keyed by an EXPLICIT `userDataDir` (no electron `app`) so it
 * unit-tests without an electron mock — the module-level boot binding lives in `index.ts` alongside
 * the Map it guards (mirrors how the consent binding lives in `orchestrationConsent.ts`, not the seam).
 *
 * 🔒 This file holds ONLY directory PATHS — never a token. The token-bearing configs it helps locate
 * are written 0o600 / merge-not-clobber by the per-CLI provisioners; this spec does not touch those
 * write paths. The renderer never sees this file and cannot request writes to it (MAIN single writer).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

/** The persisted shape: project root (abs path) → divergent target dirs (abs paths). */
type ProvisionedDirStore = Record<string, string[]>

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'provisioned-dirs.json')
}

/**
 * Read the persisted store. Parse-defensive: a missing OR corrupt file degrades to `{}` (the same
 * safe default as "no prior sessions"), and only well-typed entries (string key → array-of-strings)
 * survive — a hand-edited / partially-migrated file can never inject a non-path value downstream.
 * Mirrors `readAll` in recapConsent.ts / orchestrationConsent.ts.
 */
function readStore(userDataDir: string): ProvisionedDirStore {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>
    const out: ProvisionedDirStore = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((d): d is string => typeof d === 'string')
    }
    return out
  } catch {
    return {}
  }
}

/** Atomically persist the full store (write-file-atomic), creating `userDataDir` if needed. */
function writeStore(userDataDir: string, store: ProvisionedDirStore): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(store, null, 2), 'utf8')
}

/**
 * Record a divergent target dir for a project (read → merge → atomic write). Idempotent: a dir
 * already persisted is a no-op (no rewrite). The project root is never stored — only divergent dirs
 * are tracked (the root is always cleaned by the unsync root pass), so a root target is a no-op too.
 */
export function persistProvisionedDir(
  userDataDir: string,
  projectDir: string,
  targetDir: string
): void {
  if (targetDir === projectDir) return
  const store = readStore(userDataDir)
  const dirs = new Set(store[projectDir] ?? [])
  if (dirs.has(targetDir)) return // already persisted — skip the rewrite
  dirs.add(targetDir)
  store[projectDir] = [...dirs]
  writeStore(userDataDir, store)
}

/**
 * Hydrate the in-memory Map from the persisted store (boot). Merges with Set-union semantics so any
 * dirs already recorded in THIS session survive (idempotent re-load). Read-only — never writes.
 */
export function loadProvisionedDirs(userDataDir: string, map: Map<string, Set<string>>): void {
  const store = readStore(userDataDir)
  for (const [projectDir, dirs] of Object.entries(store)) {
    let set = map.get(projectDir)
    if (!set) {
      set = new Set<string>()
      map.set(projectDir, set)
    }
    for (const d of dirs) set.add(d)
  }
}

/** Drop a project's entry after a full unsync cleaned everything for it. No-op when absent. */
export function clearPersistedDirs(userDataDir: string, projectDir: string): void {
  const store = readStore(userDataDir)
  if (!(projectDir in store)) return
  delete store[projectDir]
  writeStore(userDataDir, store)
}
