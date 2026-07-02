/**
 * Shared types + filesystem helpers for the per-CLI MCP provisioners (Agent Orchestration
 * Onboarding, PLAN §3 · WT-provision / P3).
 *
 * Each supported agent CLI stores its MCP-server config in a different place and format, so
 * every provisioner ({@link ./claude}, {@link ./gemini}, {@link ./opencode}, {@link ./codex})
 * implements the package seam `CliProvisioner` but shares the write discipline defined here:
 *
 *   - **Merge, never clobber.** Onboarding writes into the user's REAL project folder and home
 *     config — files that may already hold their own MCP servers / settings. We read, set ONLY
 *     our `canvas-ade` entry, and write the rest back untouched. (`unsync` removes ONLY our key.)
 *     This is why we do NOT use the package's `writeMcpJson`, which overwrites the whole file —
 *     that helper targets app-owned worktree dirs, not a user's project. The `.mcp.json` ENTRY
 *     shape is still type-pinned to the package's {@link McpJson} so a package change is caught
 *     at compile time.
 *   - **0o600.** Every file embeds a plaintext bearer token, so it is written owner-only (PLAN §6;
 *     POSIX mode is a no-op on Windows but harmless).
 *   - **Never log the token.** The raw token is used ONLY to build config files in MAIN; it is
 *     never logged and never crosses to the renderer — the modal receives a fixed masked string.
 *
 * MAIN-only (node:fs / node:os). No electron import — provisioners resolve the home directory via
 * `os.homedir()`, so this whole subtree stays unit-testable without an electron mock and adds no
 * electron coupling to `pty.ts`'s import graph.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { McpJson } from '@expanse-ade/mcp'
import type { TerminalToken } from '../orchestration/seam'

/** The supported agent CLIs (mirrors the seam's `CliProvisioner['id']`). */
export type CliId = 'claude' | 'codex' | 'gemini' | 'opencode'

/** A JSON config that carries an `mcpServers` map (Claude `.mcp.json`, Gemini `settings.json`). */
export interface McpServersConfig {
  mcpServers?: Record<string, unknown>
  [k: string]: unknown
}

/** The single server key we own across every CLI's config (matches the package `.mcp.json`). */
export const SERVER_NAME = 'canvas-ade'

/** Loopback host the MCP server binds (matches the package `buildMcpJson`). */
export const ENDPOINT_HOST = '127.0.0.1'

/** Outcome of one CLI's sync attempt, surfaced per-row in the Sync modal. */
export type SyncStatus = 'synced' | 'error'
export interface SyncResult {
  id: CliId
  status: SyncStatus
  /** One short human line for the modal row (never contains the token). */
  detail: string
  /** Display path that was written, when known. */
  path?: string
}

/** A CLI row for the Sync modal: which configs exist + whether this CLI is installed. */
export interface ProvisionRow {
  id: CliId
  label: string
  /** Human config path shown in the row (e.g. `~/.gemini/settings.json`). */
  configLabel: string
  /** Installed on this host (its config dir is present)? Drives the detected / not-installed badge. */
  detected: boolean
}

/** Endpoint summary for the modal. The token is ALREADY masked — the raw value never leaves MAIN. */
export interface ProvisionEndpoint {
  host: string
  port: number
  /** Fixed masked placeholder — we deliberately never expose token characters to the renderer. */
  maskedToken: string
}

export interface ProvisionStatus {
  endpoint: ProvisionEndpoint
  rows: ProvisionRow[]
}

/**
 * One supported CLI's provisioner. Extends the package seam with the metadata the modal needs and
 * a SYNCHRONOUS write/remove pair the spawn-time hook uses (the file must be on disk before the
 * launch line is written — see {@link ../pty}). The async `sync`/`unsync` (the seam contract,
 * used by the modal) simply wrap the synchronous core.
 */
export interface AppCliProvisioner {
  readonly id: CliId
  readonly label: string
  /** Config path shown in the modal row (host-relative `~/…` for global configs). */
  configLabel(projectDir: string): string
  /** Installed? Resolved from the CLI's config dir (honest detection — PLAN/mock annotation F). */
  detect(): Promise<boolean>
  /** SYNCHRONOUS write of THIS CLI's config (0o600), authorized by `tok`. Used by the spawn hook. */
  writeSync(projectDir: string, tok: TerminalToken): string
  /** SYNCHRONOUS removal of ONLY our `canvas-ade` entry (consent revoke). */
  removeSync(projectDir: string): void
  /** Seam contract (async) — thin wrappers over the synchronous core, used by the Sync modal. */
  sync(projectDir: string, tok: TerminalToken): Promise<void>
  unsync(projectDir: string): Promise<void>
}

// ── Endpoint / token helpers ───────────────────────────────────────────────

/** The loopback MCP url an agent connects to (matches the package `buildMcpJson`). */
export function mcpUrl(port: number): string {
  return `http://${ENDPOINT_HOST}:${port}/mcp`
}

/** The `Authorization` header value carrying the bearer token. */
export function bearer(token: string): string {
  return `Bearer ${token}`
}

/**
 * A fixed, token-free mask for the modal. We intentionally reveal NOTHING about the token — not
 * even its length or last characters — so a screenshot or log can never leak it (PLAN §6).
 */
export function maskToken(): string {
  return '••••••'
}

/** The `.mcp.json` entry, type-pinned to the package so a package shape change breaks the build. */
export function mcpEntry(port: number, token: string): McpJson['mcpServers']['canvas-ade'] {
  return {
    type: 'http',
    url: mcpUrl(port),
    headers: { Authorization: bearer(token) }
  }
}

// ── Host config-dir resolution (os.homedir — no electron) ──────────────────

export function claudeHome(): string {
  return join(homedir(), '.claude')
}
export function geminiHome(): string {
  return join(homedir(), '.gemini')
}
export function codexHome(): string {
  return join(homedir(), '.codex')
}
/** OpenCode follows XDG: `$XDG_CONFIG_HOME/opencode` else `~/.config/opencode` (all platforms). */
export function opencodeHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode')
}

/** Resolve `~`-prefixed display paths to a friendly form for the modal (never used for I/O). */
export function tildeify(abs: string): string {
  const home = homedir()
  return abs.startsWith(home) ? '~' + abs.slice(home.length).replace(/\\/g, '/') : abs
}

// ── JSON read / merge / write (0o600) ──────────────────────────────────────

/**
 * Parse an existing JSON config, or `undefined` if absent. Throws on a present-but-corrupt file so
 * the caller can refuse to clobber it (we never overwrite a file we failed to parse — that would
 * destroy unrelated user config).
 */
export function readJsonConfig<T = Record<string, unknown>>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  const raw = readFileSync(file, 'utf8')
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`existing config is not valid JSON: ${tildeify(file)} (${String(err)})`)
  }
}

/**
 * Force owner-only perms AFTER a write. `writeFileSync`'s `mode` only applies when it CREATES the
 * file — an existing config (e.g. a CLI installer's `~/.gemini/settings.json` left at 0o644) keeps
 * its old, possibly world-readable mode, which would expose the embedded bearer token (PLAN §6).
 * chmod closes that hole on every write, new or existing. Best-effort: Windows has no POSIX mode
 * bits, so a throw/no-op there is harmless.
 */
function enforceOwnerOnly(file: string): void {
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best-effort — Windows has no POSIX perms; nothing to enforce */
  }
}

/**
 * Write a JSON config owner-only (0o600), creating the parent dir if needed.
 *
 * FIND-008: written ATOMICALLY (write-file-atomic = temp-file + fsync + rename), so a crash or
 * power-loss mid-write can never leave a truncated/corrupt config behind. These files hold a
 * bearer token AND the user's own MCP servers, and `readJsonConfig` THROWS on a present-but-corrupt
 * file (to avoid clobbering it) — so a torn write would otherwise make every subsequent sync fail
 * permanently (sticky corruption). Mirrors the atomic discipline used for every other token-bearing
 * write (orchestrationConsent.ts, the recap map, the canvas save path).
 */
export function writeJsonConfig(file: string, data: unknown): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileAtomic.sync(file, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600
  })
  enforceOwnerOnly(file)
}

/** Write a raw text config owner-only (0o600), creating the parent dir if needed. Atomic (FIND-008). */
export function writeTextConfig(file: string, text: string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileAtomic.sync(file, text, { encoding: 'utf8', mode: 0o600 })
  enforceOwnerOnly(file)
}

/** Read a raw text config, or `undefined` if absent. */
export function readTextConfig(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/** Honest "is this CLI installed" probe: its config dir exists (mock annotation F). */
export function dirExists(dir: string): Promise<boolean> {
  return Promise.resolve(existsSync(dir))
}

/** Best-effort delete (used when an `unsync` empties a file we own). Never throws. */
export function removeFileQuiet(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* already gone */
  }
}

// ── Minimal, safe TOML table upsert (codex `~/.codex/config.toml`) ──────────
//
// We do NOT pull in a TOML parser: codex's config.toml holds the user's whole codex setup, so the
// only safe operation is a SURGICAL one on OUR OWN `[mcp_servers.canvas-ade]` table — replace it
// if present, append it otherwise, and leave every other byte (other tables, comments, formatting)
// exactly as-is. Our block has a fixed, sub-table-free shape, so removal-by-header is unambiguous.

const CODEX_HEADER_RE = /^\s*\[mcp_servers\.(?:canvas-ade|"canvas-ade")\]\s*$/
const ANY_TABLE_HEADER_RE = /^\s*\[/

/** Escape a string for a TOML basic (double-quoted) string. Tokens are URL-safe, but be defensive. */
export function tomlBasicString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Our codex table block (3 lines, no trailing newline). */
export function codexBlock(port: number, token: string): string {
  return (
    '[mcp_servers.canvas-ade]\n' +
    `url = ${tomlBasicString(mcpUrl(port))}\n` +
    `http_headers = { Authorization = ${tomlBasicString(bearer(token))} }`
  )
}

/**
 * Remove our `[mcp_servers.canvas-ade]` table (its header through the line before the next table
 * header or EOF), preserving everything else. Returns the content unchanged if our table is absent.
 */
export function removeCodexTable(content: string): string {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => CODEX_HEADER_RE.test(l))
  if (start === -1) return content
  let end = start + 1
  while (end < lines.length && !ANY_TABLE_HEADER_RE.test(lines[end])) end++
  lines.splice(start, end - start)
  return lines.join('\n')
}

/** Whichever EOL style dominates `text` (ties/no-newlines default to bare `\n`). */
function dominantEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lfOnly = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lfOnly ? '\r\n' : '\n'
}

/**
 * Upsert our codex table: drop any prior copy of it, then append a fresh block at EOF.
 *
 * Normalizes to LF while splicing (so the surgical line-matching in {@link removeCodexTable} is
 * unaffected by the file's original EOL style), then re-applies whichever EOL style the existing
 * file predominantly used — otherwise an appended LF-only block on a CRLF file leaves mixed line
 * endings behind.
 */
export function upsertCodexTable(
  existing: string | undefined,
  port: number,
  token: string
): string {
  const raw = existing ?? ''
  const eol = dominantEol(raw)
  const cleaned = removeCodexTable(raw.replace(/\r\n/g, '\n')).replace(/\s+$/, '')
  const block = codexBlock(port, token)
  const result = cleaned === '' ? block + '\n' : cleaned + '\n\n' + block + '\n'
  return eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result
}
