import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'
import type { GatedWriteInput, GatedWriteResult } from './dispatchGate'
import type { ConfirmBatchDecision, ConfirmBatchRequest } from './mcpConfirm'
import type { AuditInput } from './auditLog'
import type { DispatchStatus, LifecycleOrchestrator } from './mcpRegistry'

/**
 * The orchestrator this HOST builds: the package's `LifecycleOrchestrator` plus the in-process
 * extensions that exist only inside the app. `dispatchPrompts` is the first — host-side only, so
 * there is no broker wire change, no package publish, and no parity lockstep to keep.
 */
export interface HostOrchestrator extends LifecycleOrchestrator {
  dispatchPrompts(items: DispatchBatchItem[]): Promise<DispatchBatchResult[]>
}

/**
 * 🔒 BATCH assign method (orchestration S2, design D7) — the plural of `dispatchPrompt`, built to
 * the SAME shape `./mcpRelayBatch` proved for `relay_prompts` and extracted into its own module for
 * the same max-lines reason. `buildOrchestrator` injects the board/confirm/gate/audit seams and
 * spreads the returned method in, so the batch path is assembled at the ONE point.
 *
 * Why it exists: a swarm orchestrator's dispatch ROUND is naturally plural — "spawn three workers
 * and give them these three tasks" — and S1 made that N separate modals in a row. Modal fatigue is
 * how a human ends up clicking through the one dispatch they should have stopped (07 §4.7). One
 * modal with N reviewable rows is strictly more informed consent, not less.
 *
 * 🔒 IT DOES NOT WIDEN ONE APPROVAL INTO N WRITES. Every row is validated + sanitized BEFORE the
 * modal (so the human reads the exact line that will run), then each approved row travels the
 * shared write gate INDEPENDENTLY — its own single-use nonce, its own BUG-021 TOCTOU re-check, its
 * own audit row — with that row's decision fed in through the gate's `confirmOverride`. One row's
 * denial changes nothing for the others. Results are positionally 1:1 with `items`.
 */
export interface DispatchBatchItem {
  boardId: string
  text: string
}

export interface DispatchBatchResult {
  boardId: string
  status: 'dispatched' | 'denied' | 'rejected'
  delivery?: 'ready' | 'unconfirmed'
  detail?: string
}

export interface DispatchBatchDeps {
  listBoards(): Array<{ id: string; type: string; title: string }>
  /** Optional (the `confirmBatch?` registry idiom): absent ⇒ fail-closed, every valid row denied. */
  confirmBatch?(req: ConfirmBatchRequest): Promise<ConfirmBatchDecision>
  runGatedWrite(d: GatedWriteInput): Promise<GatedWriteResult>
  audit(input: Omit<AuditInput, 'status'> & { status: DispatchStatus }): Promise<void>
}

/** Bound the modal: a runaway orchestrator must not be able to render a 500-row confirm. */
export const MAX_DISPATCH_BATCH = 8

export function createDispatchBatchMethod(deps: DispatchBatchDeps): {
  dispatchPrompts(items: DispatchBatchItem[]): Promise<DispatchBatchResult[]>
} {
  return {
    async dispatchPrompts(items: DispatchBatchItem[]): Promise<DispatchBatchResult[]> {
      const results: DispatchBatchResult[] = new Array(items.length)
      const valid: Array<{ index: number; boardId: string; title: string; safeText: string }> = []

      for (let i = 0; i < items.length; i++) {
        const { boardId, text } = items[i]
        const reject = async (detail: string): Promise<void> => {
          await deps.audit({
            type: 'assign_prompt',
            targetId: boardId,
            prompt: text,
            nonce: '',
            status: 'rejected',
            detail
          })
          results[i] = { boardId, status: 'rejected', detail }
        }
        // (1) Resolve by OPAQUE id (never a label) — the singular path's rule, unchanged.
        const board = deps.listBoards().find((b) => b.id === boardId)
        if (!board) {
          await reject('board not found')
          continue
        }
        // (2) Terminal-only. Browser/Planning content must NEVER reach a PTY.
        if (board.type !== 'terminal') {
          await reject(`non-terminal target (${board.type})`)
          continue
        }
        // (3) Sanitize NOW, so the modal shows the EXACT one-line command that will run (the gate
        // re-sanitizes idempotently). An embedded CR/LF rejects the row — never flattened.
        let safeText: string
        try {
          safeText = sanitizeDispatchText(text)
        } catch (err) {
          const msg = err instanceof DispatchPayloadError ? err.message : 'unsafe payload'
          await reject(`unsafe payload: ${msg}`)
          continue
        }
        valid.push({ index: i, boardId, title: board.title, safeText })
      }

      // Nothing survived validation → no modal (every row already audited + recorded rejected).
      if (valid.length === 0) return results

      // ONE per-row confirm for every valid row (MAIN owns the decision, fail-closed). A registry
      // with no `confirmBatch` wired denies every row rather than falling back to un-gated writes.
      const { decisions } = deps.confirmBatch
        ? await deps.confirmBatch({
            title: valid.length === 1 ? 'Dispatch 1 task' : `Dispatch ${valid.length} tasks`,
            items: valid.map((v) => ({ label: v.title, body: v.safeText }))
          })
        : { decisions: valid.map(() => ({ approved: false })) }

      for (let j = 0; j < valid.length; j++) {
        const v = valid[j]
        const approved = decisions[j]?.approved === true
        try {
          const { delivery } = await deps.runGatedWrite({
            type: 'assign_prompt',
            targetId: v.boardId,
            text: items[v.index].text,
            terminator: '\r',
            detailSuffix: `${v.boardId} (batch)`,
            // The batch modal already rendered + authorized this row; confirmOverride skips the
            // per-item modal, so these are placeholders the gate does not surface in batch mode.
            confirmTitle: `Assign to "${v.title}"`,
            confirmBody: (s) => s,
            confirmOverride: () => Promise.resolve({ approved }),
            // 🔒 BUG-021 TOCTOU: the human may have deleted the board (or replaced it with a
            // non-terminal of the same id) while the modal was open — re-verify before the nonce
            // is consumed and anything is written.
            preWriteRecheck: (seq) => {
              const still = deps.listBoards().find((b) => b.id === v.boardId)
              return still && still.type === 'terminal'
                ? null
                : {
                    detail: `target vanished during confirm; ${v.boardId}; seq=${seq}`,
                    error: `assign_prompt: target ${v.boardId} is gone or no longer a terminal`
                  }
            }
          })
          results[v.index] = { boardId: v.boardId, status: 'dispatched', delivery }
        } catch (err) {
          // The gate throws on a human deny (confirmOverride approved:false), the TOCTOU vanish, or
          // a PTY write failure — all already audited inside the gate. A declined row is the
          // human's "no" (`denied`); anything approved that still failed is a `rejected`.
          results[v.index] = approved
            ? {
                boardId: v.boardId,
                status: 'rejected',
                detail: err instanceof Error ? err.message : 'dispatch failed'
              }
            : { boardId: v.boardId, status: 'denied', detail: 'declined by the human gate' }
        }
      }

      return results
    }
  }
}
