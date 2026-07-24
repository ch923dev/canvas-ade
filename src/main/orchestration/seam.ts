import { isEnabled, setEnabled } from '../orchestrationConsent'

/**
 * Shared seam for the **Agent Orchestration Onboarding** umbrella (PLAN §3, 2026-06-19).
 *
 * This file is the CONTRACT the three parallel lanes code against — it is stubbed FIRST on
 * the integration branch so every worktree compiles against it immediately. Each owning lane
 * fills in its part:
 *
 *   - WT-authority  (P0, this lane): `mintTerminalToken` (via a registered minter) + `canRelay`,
 *     consumed by the relay path in `mcpOrchestrator.ts`. ✅ IMPLEMENTED.
 *   - WT-onboarding (P1): `isOrchestrationEnabled` / `setOrchestrationEnabled` (✅ IMPLEMENTED —
 *     delegate to the consent store in `orchestrationConsent.ts`).
 *   - WT-provision  (P3): `CliProvisioner` implementations + the spawn-time auto-sync hook.
 *
 * Spec: `docs/research/2026-06-19-agent-orchestration-onboarding/PLAN.md`.
 * Security invariants (PLAN §6): never log tokens; provisioner files `0o600`; `unsync` on
 * disable; MAIN-only; per-action ConfirmModal stays; cable-is-authorization for relay.
 */

// ── WT-authority (P0) implements ────────────────────────────────────────────

/**
 * Capability tier a Terminal board's MCP token carries. v1 minted only `connected`; orchestration
 * Phase 1 (precondition X) adds `lead` — the wire-facing orchestrator role, minted ONLY for the
 * single explicitly-granted lead board (see `leadAuthority.ts`; the minter in `mcp.ts` routes by
 * designation, so the spawn-time provisioner needs no tier awareness).
 */
export type TerminalTier = 'connected' | 'lead'

/** A minted MCP token for one Terminal board: tier-scoped, bound to a board + its server port. */
export interface TerminalToken {
  token: string
  tier: TerminalTier
  port: number
}

/**
 * The minter the running MCP server registers (`mcp.ts` → `startMcpServer`). Module-scoped so the
 * pure seam never imports the ESM-only `@expanse-ade/mcp` package nor holds the TokenStore — the
 * server owns both and injects a closure. `null` whenever no server is mounted (boot window /
 * after `close()`), so a premature mint fails loudly instead of relaying with a bogus token.
 */
let terminalTokenMinter: ((boardId: string) => TerminalToken) | null = null

/**
 * Register (or clear, with `null`) the connected-tier token minter. Called by `startMcpServer`
 * once the loopback server is up, and again with `null` on `close()`. Internal seam wiring — not
 * a public API. NEVER log the minted token (PLAN §6).
 */
export function __setTerminalTokenMinter(
  minter: ((boardId: string) => TerminalToken) | null
): void {
  terminalTokenMinter = minter
}

/**
 * Mint a `connected`-tier MCP token bound to `boardId`, against the running MCP server's token
 * store. The returned `{ token, tier:'connected', port }` is what the P3 spawn-time provisioner
 * writes into the agent's per-CLI MCP config. Throws when no server is mounted (the minter is
 * unregistered) so a premature caller fails loudly rather than provisioning a dead token.
 *
 * 🔒 NEVER log the returned token (PLAN §6).
 */
export function mintTerminalToken(boardId: string): TerminalToken {
  if (!terminalTokenMinter) {
    throw new Error(`mintTerminalToken(${boardId}): MCP server not mounted (no minter registered)`)
  }
  return terminalTokenMinter(boardId)
}

/** The minimal connector shape {@link canRelay} reads. Satisfied by both the renderer mirror's
 *  `ConnectorMirror` (boardRegistry) and the orchestrator's `ConnectorMirrorEntry` (mcpRegistry),
 *  so this predicate is the SINGLE source of truth the relay path consumes by construction. */
export interface RelayConnector {
  sourceId: string
  targetId: string
  kind: string
}

/**
 * Relay authorization (terminal→terminal): a dispatch `src → dst` is allowed iff a persisted
 * ORCHESTRATION connector with that exact direction exists. *The cable is the authority.*
 *
 * Pure predicate — no I/O, no side effects. The caller still applies the unbounded-await TOCTOU
 * re-check and the per-action ConfirmModal (PLAN §2); this only resolves "is there a directed
 * cable". `mcpOrchestrator.ts`'s relay path calls THIS for both its initial check and its TOCTOU
 * re-check, so the seam and the live gate agree by construction.
 */
export function canRelay(src: string, dst: string, connectors: readonly RelayConnector[]): boolean {
  return connectors.some(
    (c) => c.kind === 'orchestration' && c.sourceId === src && c.targetId === dst
  )
}

// ── WT-onboarding (P1) implements ───────────────────────────────────────────

/**
 * Per-project orchestration consent (the one-time **Enable**). Read from the userData consent
 * store — NEVER the project folder (CLAUDE.md persistence rule).
 *
 * P1 (WT-onboarding) — delegates to the consent store (`orchestrationConsent.ts`), which resolves
 * userData through the boot-time binding. Defaults **closed** (`false`) before the store is bound,
 * so the P3 spawn-time hook + the plan-write gate scaffold safely against it.
 */
export function isOrchestrationEnabled(projectDir: string): boolean {
  return isEnabled(projectDir)
}

/**
 * Grant / revoke per-project orchestration consent.
 *
 * P1 (WT-onboarding) — persists to the userData consent store. PERSIST-ONLY: the user-facing
 * path is the `orchestration:setConsent` IPC handler, which ALSO fires the provisioner
 * sync/unsync hook. Throws if the store is unbound so a consent write can never silently no-op.
 */
export function setOrchestrationEnabled(projectDir: string, on: boolean): void {
  setEnabled(projectDir, on)
}

// ── WT-provision (P3) implements + consumes the two above ────────────────────

/**
 * One supported agent CLI's MCP-config provisioner. WT-provision (P3) implements one per CLI;
 * the spawn-time hook in `pty.ts` (recapEnvProvider-style) runs the matching `sync` BEFORE
 * writing the launchCommand when `isOrchestrationEnabled(dir)`. All files written `0o600`;
 * `unsync` on consent revoke (PLAN §6). Codex transport is "verify transport" (PLAN §7) — it may
 * need a local stdio→http shim or land a release behind; ship the other three regardless.
 */
export interface CliProvisioner {
  id: 'claude' | 'codex' | 'gemini' | 'opencode'
  /** Config dir / binary present for this CLI on the host? */
  detect(): Promise<boolean>
  /** Write THIS CLI's MCP config for `projectDir`, authorized by `tok` (mode `0o600`). */
  sync(projectDir: string, tok: TerminalToken): Promise<void>
  /** Remove THIS CLI's MCP config for `projectDir` (on consent revoke). */
  unsync(projectDir: string): Promise<void>
}
