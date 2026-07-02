/**
 * Per-CLI MCP provisioners — public surface (Agent Orchestration Onboarding · WT-provision / P3).
 *
 * Closes the proven gap (REPORT §2.1): "MCP M0–M5 shipped but no real terminal agent can reach
 * it." Each agent CLI stores its MCP config differently, so a single `.mcp.json` is not enough —
 * this module owns one provisioner per CLI behind the package seam + two entry points:
 *
 *   - {@link makeOrchestrationSyncProvider} — the SYNCHRONOUS spawn-time hook wired into `pty.ts`.
 *     On every terminal start it re-writes the matching CLI's config with the LIVE endpoint+token
 *     BEFORE the launch line runs. This is what fixes the stale-endpoint-after-restart failure
 *     (the loopback port + bearer rotate each app restart → a stale config = "tool doesn't exist").
 *   - {@link getProvisionStatus} / {@link runProvisionerSync} / {@link unsyncProvisioners} — the
 *     async surface the Sync modal drives (via IPC the onboarding lane wires) and consent-revoke.
 *
 * Authority is decoupled: callers pass a `TerminalToken` / `mintToken` thunk, so WHO mints and HOW
 * (the `connected`-tier authority model, P0) lives in the authority lane — this module only writes
 * configs. Consent is read from the seam (`isOrchestrationEnabled`, P1). MAIN-only.
 */
import type { TerminalToken } from '../orchestration/seam'
import { isOrchestrationEnabled } from '../orchestration/seam'
import { claudeProvisioner } from './claude'
import { codexProvisioner } from './codex'
import { geminiProvisioner } from './gemini'
import { opencodeProvisioner } from './opencode'
import {
  clearPersistedDirs,
  loadProvisionedDirs,
  persistProvisionedDir
} from './provisionedDirStore'
import {
  type AppCliProvisioner,
  type CliId,
  type ProvisionStatus,
  type SyncResult,
  ENDPOINT_HOST,
  maskToken
} from './shared'

export type {
  AppCliProvisioner,
  CliId,
  ProvisionEndpoint,
  ProvisionRow,
  ProvisionStatus,
  SyncResult,
  SyncStatus
} from './shared'

/** Registry in mock-row order (Claude · Codex · Gemini · OpenCode — mock Step 2). */
export const PROVISIONERS_LIST: readonly AppCliProvisioner[] = [
  claudeProvisioner,
  codexProvisioner,
  geminiProvisioner,
  opencodeProvisioner
]

export const PROVISIONERS: Record<CliId, AppCliProvisioner> = {
  claude: claudeProvisioner,
  codex: codexProvisioner,
  gemini: geminiProvisioner,
  opencode: opencodeProvisioner
}

export const CLI_IDS = PROVISIONERS_LIST.map((p) => p.id) as readonly CliId[]

/** Leading wrappers we skip when reading a launch command's CLI: package runners + `env`/`sudo`. */
const RUNNERS = new Set([
  'env',
  'npx',
  'npm',
  'bunx',
  'bun',
  'pnpm',
  'pnpx',
  'yarn',
  'dlx',
  'exec',
  'run',
  'sudo'
])

/** A leading `KEY=value` env assignment (`env FOO=bar claude`, or the bare `FOO=bar claude`). */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Quote-aware token matcher: a `"..."`/`'...'` run, or a run of non-whitespace. */
const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g

/**
 * Which CLI a launch command starts, or `null` (plain shell / unknown). Skips leading flags and
 * package runners, then matches the first real command token's basename against a known CLI id —
 * so `claude --resume`, `npx --yes gemini`, `C:\bin\codex.exe`, and `"C:\Program
 * Files\claude.exe" --flag` all resolve.
 */
export function cliIdForLaunchCommand(cmd: string | undefined): CliId | null {
  if (!cmd) return null
  for (const raw of cmd.trim().match(TOKEN_RE) ?? []) {
    // Strip a single layer of surrounding quotes (`"C:\...\claude.exe"` -> `C:\...\claude.exe`).
    const tok =
      raw.length >= 2 &&
      ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw
    if (tok === '' || tok.startsWith('-')) continue
    // Skip leading `KEY=value` env assignments so `env FOO=bar claude` (and bare `FOO=bar claude`)
    // still resolve to the CLI rather than dead-ending on the assignment token.
    if (ENV_ASSIGN_RE.test(tok)) continue
    const base = tok
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat|ps1)$/i, '')
      .toLowerCase()
    if (!base) continue
    if ((CLI_IDS as readonly string[]).includes(base)) return base as CliId
    if (RUNNERS.has(base)) continue
    return null // first real command isn't a known CLI
  }
  return null
}

/** Detection map for the modal badges (each CLI's config dir present?). */
export async function detectInstalled(): Promise<Record<CliId, boolean>> {
  const entries = await Promise.all(
    PROVISIONERS_LIST.map(async (p) => [p.id, await p.detect()] as const)
  )
  return Object.fromEntries(entries) as Record<CliId, boolean>
}

/** Status for the Sync modal: the (masked) endpoint + a detected/installed row per CLI. */
export async function getProvisionStatus(opts: {
  projectDir: string
  port: number
}): Promise<ProvisionStatus> {
  const rows = await Promise.all(
    PROVISIONERS_LIST.map(async (p) => ({
      id: p.id,
      label: p.label,
      configLabel: p.configLabel(opts.projectDir),
      detected: await p.detect()
    }))
  )
  return {
    endpoint: { host: ENDPOINT_HOST, port: opts.port, maskedToken: maskToken() },
    rows
  }
}

/**
 * Run the selected provisioners against `projectDir` with one live `token`, returning a per-CLI
 * result for the modal. Failures are isolated (one bad CLI never blocks the others) and never
 * include the token in their message.
 */
export async function runProvisionerSync(opts: {
  projectDir: string
  ids: readonly CliId[]
  token: TerminalToken
}): Promise<SyncResult[]> {
  const results: SyncResult[] = []
  for (const id of opts.ids) {
    const p = PROVISIONERS[id]
    if (!p) continue
    try {
      const path = await Promise.resolve(p.writeSync(opts.projectDir, opts.token))
      results.push({ id, status: 'synced', detail: `Wrote ${path}`, path })
    } catch (err) {
      results.push({
        id,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}

/**
 * FIND-001: directories a PROJECT-SCOPED provisioner config (claude `.mcp.json`, opencode
 * `opencode.json`) was written into that DIVERGE from the project root. The spawn-time hook writes
 * to the board's cwd, which a user can point at any subfolder, so on consent revoke those configs
 * (each carrying a plaintext bearer token) must be cleaned up too — not only the project root.
 * Keyed by project root → set of divergent target dirs. Home-scoped CLIs (gemini/codex) ignore the
 * dir, so the root pass already covers them; only the extra project-scoped locations need tracking.
 */
const provisionedDirs = new Map<string, Set<string>>()

/**
 * W1-E / F8: the userData dir the divergent-dir registry persists THROUGH. Bound once at boot
 * (`bindProvisionedDirStore`); `null` in unit tests that don't exercise persistence. When null,
 * `recordProvisionedDir` still updates the in-memory Map but skips the disk write — graceful
 * degradation, the in-session FIND-001 fix is unaffected. The binding lives here (next to the Map it
 * guards) so `provisionedDirStore.ts` stays a pure, electron-free unit-test target (mirrors how the
 * consent binding lives in orchestrationConsent.ts, not the seam).
 */
let provisionedDirsUserData: string | null = null

/** Bind the userData dir the provisioned-dir store persists through. Idempotent; called once at boot. */
export function bindProvisionedDirStore(userDataDir: string): void {
  provisionedDirsUserData = userDataDir
}

/**
 * Boot hydration (F8): merge the persisted divergent-dir set into the in-memory Map BEFORE any
 * consent-revoke callback can fire, so a revoke in THIS session cleans the bearer tokens a PRIOR
 * session wrote into divergent board cwds (the in-memory Map would otherwise be empty after a
 * restart). Set-union merge → safe to call after some dirs were already recorded in-session.
 */
export function loadPersistedProvisionedDirs(userDataDir: string): void {
  loadProvisionedDirs(userDataDir, provisionedDirs)
}

/** Record a divergent target dir we wrote a config into for `projectDir` (FIND-001). */
function recordProvisionedDir(projectDir: string, targetDir: string): void {
  if (targetDir === projectDir) return // the root is always cleaned; only track divergent dirs
  let dirs = provisionedDirs.get(projectDir)
  if (!dirs) {
    dirs = new Set<string>()
    provisionedDirs.set(projectDir, dirs)
  }
  dirs.add(targetDir)
  // F8: persist the divergent dir so a consent-revoke in a LATER app session (when this in-memory
  // Map is empty) still finds and removes its on-disk bearer token. Best-effort: skip silently when
  // unbound (tests), and never let a write failure break the spawn or the in-memory fix.
  if (provisionedDirsUserData) {
    try {
      persistProvisionedDir(provisionedDirsUserData, projectDir, targetDir)
    } catch {
      /* best-effort persistence — an unwritable userData must not break the spawn-time write */
    }
  }
}

/** Test seam: clear the divergent-dir registry + its userData binding between cases. */
export function __resetProvisionedDirs(): void {
  provisionedDirs.clear()
  provisionedDirsUserData = null
}

/**
 * Remove our `canvas-ade` entry from every (or the given) CLI's config — on consent revoke.
 *
 * FIND-001: cleans the project root AND every divergent board-cwd a project-scoped config was
 * written into, so a revoked grant leaves NO bearer token on disk. `removeSync` is idempotent (a
 * no-op when our entry isn't present), so running each provisioner across every dir is safe; a
 * home-scoped CLI ignores the dir and is cleaned by the first (root) pass.
 */
export async function unsyncProvisioners(opts: {
  projectDir: string
  ids?: readonly CliId[]
}): Promise<void> {
  const dirs = new Set<string>([opts.projectDir, ...(provisionedDirs.get(opts.projectDir) ?? [])])
  for (const id of opts.ids ?? CLI_IDS) {
    for (const dir of dirs) {
      try {
        PROVISIONERS[id].removeSync(dir)
      } catch {
        /* best-effort cleanup — a missing/locked file must never block disable */
      }
    }
  }
  // A full unsync cleaned everything tracked for this project → forget it. A scoped (ids-subset)
  // unsync leaves the registry intact so a later full unsync still covers the untouched CLIs/dirs.
  if (!opts.ids) {
    provisionedDirs.delete(opts.projectDir)
    // F8: drop the persisted entry too, so the store doesn't accumulate dead projects. Best-effort:
    // a write failure here must never reject (the on-disk configs are already removed above).
    if (provisionedDirsUserData) {
      try {
        clearPersistedDirs(provisionedDirsUserData, opts.projectDir)
      } catch {
        /* best-effort — a locked store file must not block the in-memory + on-disk cleanup */
      }
    }
  }
}

/**
 * F22: coordinate consent-revoke ordering — run the on-disk cleanup (`unsync`) to completion, THEN
 * revoke the live in-memory connected tokens (`revoke`). Disk-resident bearer tokens must die
 * BEFORE the in-memory store is zeroed, so there is no window in which an on-disk token is still
 * readable after the in-memory token it mirrors has been invalidated (defense-in-depth). `unsync`
 * failures are swallowed so a locked/missing config file can never block the in-memory revoke, and
 * `revoke` always fires via `.finally`. Returns the promise so callers/tests can await the full
 * chain; the caller `void`s it so its own frame (the consent `onChange` callback) stays synchronous.
 */
export function revokeOrchestration(
  projectDir: string,
  unsync: (opts: { projectDir: string }) => Promise<void>,
  revoke: () => void
): Promise<void> {
  return unsync({ projectDir })
    .catch(() => {})
    .finally(() => {
      revoke()
    })
}

/** The synchronous provider wired into `pty.ts` (see module header). */
export type OrchestrationSyncProvider = (opts: {
  id: string
  launchCommand?: string
  cwd?: string
}) => void

/**
 * Build the spawn-time auto-sync provider. On each terminal start, if the current project has
 * orchestration consent and the launch command starts a known CLI, mint a token and (synchronously)
 * write that CLI's config to the board's cwd BEFORE the launch line runs.
 *
 * `getProjectDir` / `mintToken` are injected so this stays decoupled from index.ts state and the
 * authority lane. The token is NEVER logged. Errors propagate to pty.ts's spawn-time try/catch,
 * which guarantees a provisioning failure can never break a spawn (mirrors `recapEnvProvider`).
 */
export function makeOrchestrationSyncProvider(deps: {
  getProjectDir: () => string | null
  mintToken: (boardId: string) => TerminalToken
}): OrchestrationSyncProvider {
  return ({ id, launchCommand, cwd }) => {
    const projectDir = deps.getProjectDir()
    if (!projectDir || !isOrchestrationEnabled(projectDir)) return
    const cliId = cliIdForLaunchCommand(launchCommand)
    if (!cliId) return
    // Project-scoped CLIs (.mcp.json / opencode.json) must land where the agent runs (the board
    // cwd); home-scoped CLIs (gemini / codex) ignore the dir argument.
    const targetDir = cwd && cwd.trim() !== '' ? cwd : projectDir
    PROVISIONERS[cliId].writeSync(targetDir, deps.mintToken(id))
    // FIND-001: remember a divergent target dir so consent-revoke cleans its config too — the
    // root-only unsync would otherwise leave the bearer token on disk in <cwd>/.mcp.json.
    recordProvisionedDir(projectDir, targetDir)
  }
}
