/**
 * External MCP servers — shared model (feature: add external MCP servers, 2026-07-04).
 *
 * A user-registered EXTERNAL MCP server that Expanse writes into each selected agent CLI's own MCP
 * config (via the per-CLI writers in `cliProvisioners/external.ts`), so a Terminal-board agent can
 * reach it. Expanse never proxies — the agent CLI owns the live connection. This is INDEPENDENT of
 * Expanse's own `canvas-ade` loopback server + orchestration consent (REPORT §1).
 *
 * Storage: `<userData>/mcp-servers.json` (NEVER the project folder / canvas.json — CLAUDE.md
 * persistence rule). Secret VALUES (header + env values) are encrypted at rest via safeStorage
 * (mirrors `llmKeyStore`); everything else is plaintext. The renderer only ever sees {@link MaskedServer}.
 */
import type { CliId } from '../cliProvisioners/shared'

export type { CliId }
export type Transport = 'http' | 'stdio'

/** A name/value pair whose VALUE is a secret. At rest `value` = base64(ciphertext); resolved = plaintext. */
export interface NamedSecret {
  name: string
  value: string
}

/**
 * The stored registry row. `headers`/`env` values are base64 ciphertext on disk. Never sent to the
 * renderer verbatim — mask via {@link maskServer} first, decrypt via the store's `getResolved`.
 */
export interface ExternalMcpServer {
  /** Stable uuid — the registry key. NEVER the config key (that is `name`). */
  id: string
  /** The config key written into each CLI. Validated ident, ≠ 'canvas-ade', unique in the registry. */
  name: string
  enabled: boolean
  transport: Transport
  // http:
  url?: string
  headers?: NamedSecret[]
  // stdio:
  command?: string
  args?: string[]
  env?: NamedSecret[]
  /** Which CLIs to write this server into. Empty ⇒ resolved to the detected set at write time. */
  targets: CliId[]
  /** Point-in-time result of the last Test (see `mcpClientProbe`). */
  lastTest?: ExternalMcpTestResult
}

export interface ExternalMcpTestResult {
  ok: boolean
  /** ms epoch. */
  at: number
  /** One short human line — NEVER contains a header/env value. */
  detail?: string
  /** Tool count from `tools/list` on success. */
  toolCount?: number
}

/** A secret reduced to its name + whether a value is stored — the only secret shape the renderer sees. */
export interface MaskedSecret {
  name: string
  hasValue: boolean
}

/** What crosses to the renderer: identical to {@link ExternalMcpServer} minus secret VALUES. */
export interface MaskedServer {
  id: string
  name: string
  enabled: boolean
  transport: Transport
  url?: string
  command?: string
  args?: string[]
  headers?: MaskedSecret[]
  env?: MaskedSecret[]
  targets: CliId[]
  lastTest?: ExternalMcpTestResult
}

/**
 * A server with its secrets DECRYPTED — built in MAIN only, immediately before a config write or a
 * Test. Never persisted, never sent to the renderer.
 */
export interface ResolvedServer {
  id: string
  name: string
  enabled: boolean
  transport: Transport
  url?: string
  headers?: NamedSecret[] // plaintext values
  command?: string
  args?: string[]
  env?: NamedSecret[] // plaintext values
  targets: CliId[]
}

/**
 * The shape the UI submits to save (create or update). `id` present ⇒ update. A secret whose `value`
 * is '' means KEEP the stored value (the "leave blank to keep" contract); a non-empty value replaces
 * it; a name absent from the array is removed.
 */
/**
 * A secret as SUBMITTED from the form. `value === ''` means "keep the stored secret"; `origName` is
 * the row's ORIGINAL name (present for a pre-existing row), so a blank-value KEEP still resolves the
 * prior ciphertext even when the user RENAMED the row — matching by current name alone would miss the
 * rename and silently discard the token.
 */
export interface SaveSecret extends NamedSecret {
  origName?: string
}

export interface SaveServerInput {
  id?: string
  name: string
  enabled: boolean
  transport: Transport
  url?: string
  headers?: SaveSecret[]
  command?: string
  args?: string[]
  env?: SaveSecret[]
  targets: CliId[]
}

export type SaveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'validation' | 'encryption-unavailable'; detail?: string }
