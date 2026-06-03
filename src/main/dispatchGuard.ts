import { randomUUID } from 'node:crypto'

/**
 * 🔒 The single-use-nonce + monotonic-sequence authority for MCP dispatch (M4 T4.3).
 *
 * Every write into another board's PTY must be issued ONE nonce and then have that
 * exact nonce consumed exactly once. A replayed/forged nonce is rejected — so a tainted
 * or duplicated dispatch request can never re-fire a write that was already authorized
 * (or was never authorized at all). The monotonic `seq` is the gap-free ordering token
 * recorded in the audit trail (replay/order evidence).
 *
 * Pure + in-memory (no Electron, no I/O) so the security unit is unit-testable in
 * isolation. One guard instance is owned by MAIN for the life of the process.
 */
export interface DispatchGuard {
  /** Mint a fresh single-use nonce + the next monotonic sequence number. */
  issue(): { nonce: string; seq: number }
  /**
   * Redeem a nonce. Returns true the FIRST time an issued nonce is presented; false for
   * a replayed (already-consumed) nonce or one that was never issued (forged).
   */
  consume(nonce: string): boolean
}

export function createDispatchGuard(): DispatchGuard {
  // Outstanding nonces awaiting their single consume. A consumed nonce is deleted, so a
  // replay (or a never-issued nonce) simply isn't in the set → rejected.
  const outstanding = new Set<string>()
  let seq = 0

  return {
    issue() {
      const nonce = randomUUID()
      outstanding.add(nonce)
      seq += 1
      return { nonce, seq }
    },
    consume(nonce) {
      // delete() returns true only if the nonce was present (issued + not yet consumed).
      return outstanding.delete(nonce)
    }
  }
}
