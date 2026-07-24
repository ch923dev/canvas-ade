/**
 * Lead authority — the single-active-lead designation + token lifecycle (orchestration Phase 1,
 * precondition X / Q2 default).
 *
 * A "lead" is ONE terminal board the human has EXPLICITLY granted the wire-facing orchestrator
 * role: its spawn-time-provisioned MCP token is minted at the `lead` tier (dispatch bound to its
 * own board id broker-side) instead of `connected`. This module owns the two invariants the design
 * locks:
 *
 *   - **Single-active-lead (Q2):** at most ONE board holds the designation; granting while a
 *     DIFFERENT board holds it is refused (`already-active` + the holder id) — the human must
 *     revoke first. Re-granting the same board is an idempotent ok.
 *   - **No silent minting:** this module only records a designation the consent-gated IPC
 *     (`orchestrationLead.ts`) explicitly granted; the actual lead token is minted by the EXISTING
 *     spawn-time provisioning seam when the designated board's terminal (re)spawns — the same
 *     mechanics that stamp connected-tier tokens today (`mcp.ts` minter routes by designation).
 *
 * Designation is RUNTIME-ONLY (in-memory, like the TokenStore it feeds): an app restart clears it,
 * so lead authority never outlives the session that granted it — a deliberate consent posture for
 * the spike (persisting the grant would auto-mint on the next run without a fresh human act).
 *
 * Token lifecycle mirrors `makeConnectedTokenTracker` (mcp.ts): one live token per designation,
 * rotate-on-remint, revoke on board close / explicit revoke / consent revoke. Pure of the ESM-only
 * package (takes a `revoke` thunk) so it stays unit-testable.
 */

/** Typed outcome of a lead grant attempt (surfaced through the IPC to the Settings UI). */
export type LeadGrantResult = { ok: true } | { ok: false; reason: 'already-active'; holder: string }

export interface LeadAuthority {
  /** The currently-designated lead board id, or null when none. */
  designated(): string | null
  /** Designate `boardId` as THE lead. Refused while a different board holds the designation. */
  grant(boardId: string): LeadGrantResult
  /** Drop the designation and revoke the live lead token (if one was minted). Idempotent. */
  revoke(): void
  /**
   * Record the freshly-minted lead token for the designated board, revoking the prior one (a
   * re-spawn ROTATES, bounding accretion — the connected-tracker discipline). A track for a
   * board that is not the current designation is ignored (defensive: the minter only routes
   * lead mints for the designated board, so this indicates a raced revoke — the token is
   * revoked immediately rather than tracked).
   */
  track(boardId: string, token: string): void
  /** Board left the canvas → if it held the designation, revoke (designation + token die with it). */
  onBoardClosed(boardId: string): void
  /** Server teardown: forget everything WITHOUT revoking (the in-memory store dies anyway). */
  clear(): void
}

export function makeLeadAuthority(revokeToken: (token: string) => void): LeadAuthority {
  let leadBoardId: string | null = null
  let liveToken: string | null = null

  const revokeLive = (): void => {
    if (liveToken !== null) {
      revokeToken(liveToken)
      liveToken = null
    }
  }

  return {
    designated() {
      return leadBoardId
    },
    grant(boardId) {
      if (leadBoardId !== null && leadBoardId !== boardId) {
        return { ok: false, reason: 'already-active', holder: leadBoardId }
      }
      leadBoardId = boardId
      return { ok: true }
    },
    revoke() {
      revokeLive()
      leadBoardId = null
    },
    track(boardId, token) {
      if (boardId !== leadBoardId) {
        // Raced revoke/re-grant: a token minted for a board that no longer holds the designation
        // must not stay live. Revoke it on the spot.
        revokeToken(token)
        return
      }
      revokeLive()
      liveToken = token
    },
    onBoardClosed(boardId) {
      if (boardId === leadBoardId) {
        revokeLive()
        leadBoardId = null
      }
    },
    clear() {
      leadBoardId = null
      liveToken = null
    }
  }
}
