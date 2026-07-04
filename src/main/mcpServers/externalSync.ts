/**
 * External MCP servers — config-sync orchestration (feature: add external MCP servers, Phase 3).
 *
 * Bridges the registry ({@link ./mcpServersStore}) to the per-CLI writers
 * ({@link ../cliProvisioners/external}). Two entry points, both built on ONE primitive
 * ({@link resyncCliDir} — write the enabled+targeting set, remove everything else we own):
 *
 *   - {@link makeExternalMcpSyncProvider} — the spawn-time hook (composed into pty's provider slot
 *     alongside the canvas-ade one). On each terminal start it resyncs the launching CLI's config so
 *     a fresh terminal sees exactly the currently-enabled servers, then records a project-scoped dir.
 *   - {@link onRegistryChanged} — fired after any registry mutation (save/enable/disable/remove). It
 *     resyncs the HOME-scoped CLIs immediately and cleans every tracked PROJECT-scoped dir, so a
 *     removed/disabled server's on-disk entry — which for a project CLI holds a DECRYPTED secret —
 *     is deleted at once, not left until the next relaunch.
 *
 * Gate: enabled + targets ONLY — NOT orchestration consent (external servers are the user's own,
 * REPORT §D1). Project-scoped write dirs are persisted (`<userData>/external-mcp-dirs.json`) so the
 * secret-bearing cleanup survives an app restart (mirrors the canvas-ade divergent-dir store).
 *
 * 🔒 Secrets are decrypted only inside the writers, only for the duration of a write; never logged.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { cliIdForLaunchCommand, type OrchestrationSyncProvider } from '../cliProvisioners'
import {
  EXTERNAL_WRITERS,
  detectExternalClisSync,
  writerTargetDir,
  type ExternalCliWriter
} from '../cliProvisioners/external'
import type { CliId, ResolvedServer } from './types'

/** The registry surface this module needs (a subset of `McpServersStore`). */
export interface ExternalSyncStore {
  listResolvedEnabled(): ResolvedServer[]
  listMasked(): { name: string }[]
}

/**
 * Does a server apply to CLI `id`? An explicit `targets` list is authoritative. An EMPTY list means
 * "every DETECTED CLI" (REPORT contract) — NOT literally every CLI — so a server the user never
 * scoped (or one left empty by the detect-load race in the form) is never written into a CLI that
 * isn't installed, which would otherwise leak its decrypted headers/env into e.g. a freshly-created
 * `~/.codex/config.toml` for a tool the user doesn't use.
 */
function targetsCli(s: { targets: CliId[] }, id: CliId, detected: Record<CliId, boolean>): boolean {
  return s.targets.length === 0 ? detected[id] : s.targets.includes(id)
}

/**
 * Bring ONE CLI's config at `dir` into exact agreement with the registry: upsert every enabled
 * server that targets this CLI, and remove every OTHER server we own (disabled, removed, or no
 * longer targeting). `detected` resolves the empty-targets case. Idempotent; the single primitive
 * behind both entry points.
 */
function resyncCliDir(
  writer: ExternalCliWriter,
  dir: string,
  store: ExternalSyncStore,
  detected: Record<CliId, boolean>
): void {
  const write = store.listResolvedEnabled().filter((s) => targetsCli(s, writer.id, detected))
  const writeNames = new Set(write.map((s) => s.name))
  const remove = store
    .listMasked()
    .map((s) => s.name)
    .filter((n) => !writeNames.has(n))
  writer.writeServers(dir, write)
  writer.removeServers(dir, remove)
}

// ── Persisted project-scoped write-dir set (flat — the registry is global, not per-project) ──────

let userDataDir: string | null = null
const projectDirs = new Set<string>()

function fileFor(dir: string): string {
  return join(dir, 'external-mcp-dirs.json')
}

/** Bind the userData dir + hydrate the tracked project-dir set (boot). Best-effort. */
export function bindExternalSyncStore(dir: string): void {
  userDataDir = dir
  try {
    const f = fileFor(dir)
    if (!existsSync(f)) return
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown
    if (Array.isArray(parsed)) for (const d of parsed) if (typeof d === 'string') projectDirs.add(d)
  } catch {
    /* corrupt/absent → start empty (next spawn re-records); never block boot */
  }
}

function persistProjectDirs(): void {
  if (!userDataDir) return
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify([...projectDirs], null, 2), 'utf8')
  } catch {
    /* best-effort — a write failure must never break the spawn */
  }
}

/** Test seam: reset the in-memory tracking + binding between cases. */
export function __resetExternalSync(): void {
  userDataDir = null
  projectDirs.clear()
}

// ── Spawn-time hook ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the spawn-time external-server sync provider (pty provider shape). On each terminal start,
 * resync the launching CLI's config to the currently-enabled servers. Composed alongside the
 * canvas-ade provider in index.ts; both run inside pty's spawn try/catch so a failure never breaks a
 * spawn.
 */
export function makeExternalMcpSyncProvider(deps: {
  getProjectDir: () => string | null
  store: ExternalSyncStore
}): OrchestrationSyncProvider {
  return ({ launchCommand, cwd }) => {
    const cliId = cliIdForLaunchCommand(launchCommand)
    if (!cliId) return
    const writer = EXTERNAL_WRITERS[cliId]
    const base = cwd && cwd.trim() !== '' ? cwd : deps.getProjectDir()
    // Project-scoped CLIs need a real dir; home-scoped (gemini/codex) ignore it.
    if (writer.scope === 'project' && (!base || base.trim() === '')) return
    const dir = writerTargetDir(cliId, base ?? '')
    // The launching CLI is definitionally in use → count it as detected even if its home config dir
    // doesn't exist yet (first run), so an empty-targets server still reaches the terminal starting now.
    const detected = detectExternalClisSync()
    detected[cliId] = true
    resyncCliDir(writer, dir, deps.store, detected)
    if (writer.scope === 'project') {
      if (!projectDirs.has(dir)) {
        projectDirs.add(dir)
        persistProjectDirs()
      }
    }
  }
}

// ── On-change resync + cleanup ─────────────────────────────────────────────────────────────────

/**
 * Reconcile on-disk configs after a registry mutation. Home-scoped CLIs (gemini/codex) are resynced
 * in place; every tracked project-scoped dir is reconciled for BOTH project writers (claude,
 * opencode) — so a disabled/removed server's decrypted secret is removed from disk immediately,
 * while a newly-enabled server is (re)written into dirs a terminal already ran in. Best-effort per
 * dir/CLI; a locked file never blocks the others. Fire-and-forget from the IPC handler.
 */
export function onRegistryChanged(store: ExternalSyncStore): void {
  // Empty-targets servers apply only to DETECTED CLIs here (no launching CLI to force-include), so a
  // resync never creates a config — with decrypted secrets — for a CLI the user hasn't installed.
  const detected = detectExternalClisSync()
  const tryResync = (writer: ExternalCliWriter, dir: string): void => {
    try {
      resyncCliDir(writer, dir, store, detected)
    } catch {
      /* best-effort — one bad CLI/dir never blocks the rest */
    }
  }
  // Home-scoped: fixed location, always reconcilable.
  tryResync(EXTERNAL_WRITERS.gemini, writerTargetDir('gemini', ''))
  tryResync(EXTERNAL_WRITERS.codex, writerTargetDir('codex', ''))
  // Project-scoped: every dir a terminal of that CLI has run in.
  for (const dir of projectDirs) {
    tryResync(EXTERNAL_WRITERS.claude, dir)
    tryResync(EXTERNAL_WRITERS.opencode, dir)
  }
}
