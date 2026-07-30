/**
 * The swarm run-event vocabulary — extracted verbatim from swarmTools.ts (max-lines ratchet,
 * the terminalSpawnMath precedent: swarmTools re-exports it so every existing import path
 * keeps working). One union, one channel: the executor emits these and the renderer's swarm
 * board mirrors the run live.
 */
import type { SwarmLedgerSnapshot } from '../shared/swarmLedgerTypes'

/** Run events the executor emits so the renderer's swarm board mirrors the run live. */
export type SwarmRunEvent =
  | { kind: 'workerSpawned'; workerId: string; role?: string; title: string }
  | { kind: 'planDrawn'; planBoardId: string }
  | { kind: 'activity'; workerId: string; text: string }
  | {
      kind: 'workerSettled'
      workerId: string
      provenance: 'claimed' | 'synthesized'
      status: string
    }
  /**
   * S2: the durable projection. Rides the EXISTING run-event channel rather than a second sync
   * path (the kickoff's rule), so the renderer has ONE subscription and MAIN has ONE push.
   */
  | { kind: 'ledger'; snapshot: SwarmLedgerSnapshot }
  /**
   * S2: something happened to the run BETWEEN turns (a worker died, a worker stalled) and the
   * orchestrator says so in its own voice. `text` is the sentence TAIL — the renderer prefixes the
   * worker's title, because MAIN carries board ids and never titles (the `SwarmTriageRow` rule).
   * Composed deterministically in MAIN: no LLM call, no budget spend, and it can only state facts
   * the ledger actually holds.
   */
  | { kind: 'narrate'; boardId?: string; status?: string; text: string }
  /**
   * base P5: the run's ACTIVE session-consent snapshot (full state, idempotent — pushed on any
   * grant/revoke and on board re-hydrate). The renderer renders one revocable chip per entry;
   * an empty list clears the row. MAIN carries role ids + display names only.
   */
  | { kind: 'consent'; consents: Array<{ roleId: string; roleName: string }> }
