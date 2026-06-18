import type { ConnectorMirror } from '../boardRegistry'

/**
 * Shared seam for the **Agent Orchestration Onboarding** umbrella (PLAN §3, 2026-06-19).
 *
 * This file is the CONTRACT the three parallel lanes code against — it is stubbed FIRST on
 * the integration branch so every worktree compiles against it immediately. Only `canRelay`
 * carries a real body (it is a pure predicate, no I/O); the stateful entries are typed stubs
 * each owning lane fills in. **Do NOT implement the stubs here** — that is each phase's job:
 *
 *   - WT-authority  (P0): `mintTerminalToken`; consumes `canRelay` in the relay path
 *   - WT-onboarding (P1): `isOrchestrationEnabled` / `setOrchestrationEnabled`
 *   - WT-provision  (P3): `CliProvisioner` implementations + the spawn-time auto-sync hook
 *
 * Spec: `docs/research/2026-06-19-agent-orchestration-onboarding/PLAN.md`.
 * Security invariants (PLAN §6): never log tokens; provisioner files `0o600`; `unsync` on
 * disable; MAIN-only; per-action ConfirmModal stays; cable-is-authorization for relay.
 */

// ── WT-authority (P0) implements ────────────────────────────────────────────

/** Capability tier a Terminal board's MCP token carries. v1 mints only `connected`. */
export type TerminalTier = 'connected'

/** A minted MCP token for one Terminal board: tier-scoped, bound to a board + its server port. */
export interface TerminalToken {
  token: string
  tier: TerminalTier
  port: number
}

/**
 * Mint a `connected`-tier MCP token bound to `boardId`.
 *
 * STUB — implemented by WT-authority (P0). The real body derives/registers the token against
 * the running MCP server (NEVER logged — PLAN §6). Throws until P0 lands so a premature caller
 * fails loudly rather than relaying with a bogus token.
 */
export function mintTerminalToken(boardId: string): TerminalToken {
  throw new Error(`mintTerminalToken(${boardId}): not implemented until P0 (WT-authority)`)
}

/**
 * Relay authorization (terminal→terminal): a dispatch `src → dst` is allowed iff a persisted
 * ORCHESTRATION connector with that exact direction exists. *The cable is the authority.*
 *
 * Pure predicate — no I/O, no side effects. The caller still applies the unbounded-await TOCTOU
 * re-check and the per-action ConfirmModal (PLAN §2); this only resolves "is there a directed
 * cable". Mirrors the relay-gate resolution in `mcpOrchestrator.ts` so both agree by construction.
 */
export function canRelay(
  src: string,
  dst: string,
  connectors: readonly ConnectorMirror[]
): boolean {
  return connectors.some(
    (c) => c.kind === 'orchestration' && c.sourceId === src && c.targetId === dst
  )
}

// ── WT-onboarding (P1) implements ───────────────────────────────────────────

/**
 * Per-project orchestration consent (the one-time **Enable**). Read from the userData consent
 * store — NEVER the project folder (CLAUDE.md persistence rule).
 *
 * STUB — implemented by WT-onboarding (P1). Defaults **closed** (`false`) until then: no consent
 * ⇒ no orchestration, so the P3 spawn-time hook + the plan-write gate scaffold safely against it.
 */
export function isOrchestrationEnabled(projectDir: string): boolean {
  void projectDir
  return false
}

/**
 * Grant / revoke per-project orchestration consent.
 *
 * STUB — implemented by WT-onboarding (P1); persists to the userData consent store and drives
 * provisioner `sync`/`unsync`. Throws until then so a consent write can't silently no-op.
 */
export function setOrchestrationEnabled(projectDir: string, on: boolean): void {
  throw new Error(
    `setOrchestrationEnabled(${projectDir}, ${on}): not implemented until P1 (WT-onboarding)`
  )
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
