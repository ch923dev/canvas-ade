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

/**
 * Which CLI a launch command starts, or `null` (plain shell / unknown). Skips leading flags and
 * package runners, then matches the first real command token's basename against a known CLI id —
 * so `claude --resume`, `npx --yes gemini`, and `C:\bin\codex.exe` all resolve.
 */
export function cliIdForLaunchCommand(cmd: string | undefined): CliId | null {
  if (!cmd) return null
  for (const tok of cmd.trim().split(/\s+/)) {
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

/** Record a divergent target dir we wrote a config into for `projectDir` (FIND-001). */
function recordProvisionedDir(projectDir: string, targetDir: string): void {
  if (targetDir === projectDir) return // the root is always cleaned; only track divergent dirs
  let dirs = provisionedDirs.get(projectDir)
  if (!dirs) {
    dirs = new Set<string>()
    provisionedDirs.set(projectDir, dirs)
  }
  dirs.add(targetDir)
}

/** Test seam: clear the divergent-dir registry between cases (module-level state). */
export function __resetProvisionedDirs(): void {
  provisionedDirs.clear()
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
  if (!opts.ids) provisionedDirs.delete(opts.projectDir)
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
