import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'
import { canRelay } from './orchestration/seam'
import type { GatedWriteInput, GatedWriteResult } from './dispatchGate'
import type { ConfirmBatchDecision, ConfirmBatchRequest } from './mcpConfirm'
import type { AuditInput } from './auditLog'
import type { ConnectorMirrorEntry, DispatchStatus, RelayItem, RelayResult } from './mcpRegistry'

/**
 * 🔒 BATCH relay method (relay_prompts) — the plural of `relayPrompt`, extracted into its own module
 * under the max-lines doctrine (like `./dispatchGate` / `./mcpKanbanGate` / `./mcpPlanningEditGate`)
 * so `mcpOrchestrator.ts` stays under the gate. `buildOrchestrator` injects its board/connector/
 * confirm/gate/audit seams here and spreads the returned method into the orchestrator, so the batch
 * path is assembled at the ONE point — no caller builds a partial pipeline.
 *
 * The method validates EVERY item up front (cable + terminal→terminal + sanitize) so the per-row
 * confirm modal shows only real, safe dispatches; raises ONE batch confirm; then runs each valid row
 * through the SAME shared write gate INDEPENDENTLY (its own single-use nonce, BUG-021 TOCTOU
 * re-check, and audit row) with the human's per-row decision fed in via the gate's `confirmOverride`.
 * The batch NEVER widens one approval into N commands — each row is still exactly one sanitized
 * command line under its own gate. Results are positionally 1:1 with `items`.
 */
export interface RelayBatchDeps {
  listBoards(): Array<{ id: string; type: string; title: string }>
  listConnectors(): ConnectorMirrorEntry[]
  /** Optional (the `confirmBatch?` registry idiom): absent ⇒ fail-closed, every valid row denied. */
  confirmBatch?(req: ConfirmBatchRequest): Promise<ConfirmBatchDecision>
  runGatedWrite(d: GatedWriteInput): Promise<GatedWriteResult>
  audit(input: Omit<AuditInput, 'status'> & { status: DispatchStatus }): Promise<void>
}

export function createRelayBatchMethod(deps: RelayBatchDeps): {
  relayPrompts(items: RelayItem[]): Promise<RelayResult[]>
} {
  return {
    async relayPrompts(items: RelayItem[]): Promise<RelayResult[]> {
      const results: RelayResult[] = new Array(items.length)
      // Rows that passed validation → shown in the modal; `index` maps a modal row back to `results`.
      const valid: Array<{
        index: number
        item: RelayItem
        sourceTitle: string
        targetTitle: string
        safeText: string
      }> = []

      for (let i = 0; i < items.length; i++) {
        const { sourceId, targetId, text } = items[i]
        // (1) The cable IS the authorization: require a directed orchestration edge source→target.
        if (!canRelay(sourceId, targetId, deps.listConnectors())) {
          await deps.audit({
            type: 'relay_prompt',
            targetId,
            prompt: text,
            nonce: '',
            status: 'rejected',
            detail: `no orchestration connector ${sourceId}->${targetId}`
          })
          results[i] = {
            sourceId,
            targetId,
            status: 'rejected',
            detail: `no orchestration connector ${sourceId} -> ${targetId}`
          }
          continue
        }
        // (2) Both ends must be terminals (never Browser→PTY). Resolve by opaque id.
        const boards = deps.listBoards()
        const source = boards.find((b) => b.id === sourceId)
        const target = boards.find((b) => b.id === targetId)
        if (!source || source.type !== 'terminal' || !target || target.type !== 'terminal') {
          await deps.audit({
            type: 'relay_prompt',
            targetId,
            prompt: text,
            nonce: '',
            status: 'rejected',
            detail: `relay requires terminal→terminal (source=${source?.type ?? 'missing'} target=${target?.type ?? 'missing'})`
          })
          results[i] = {
            sourceId,
            targetId,
            status: 'rejected',
            detail: 'relay requires a terminal source and a terminal target'
          }
          continue
        }
        // (3) Sanitize NOW so the modal shows the EXACT one-line command that will run (the gate
        // re-sanitizes idempotently). An embedded CR/LF / control char rejects the row (never
        // flattened) — the same single-command-line invariant relayPrompt enforces via the gate.
        let safeText: string
        try {
          safeText = sanitizeDispatchText(text)
        } catch (err) {
          const msg = err instanceof DispatchPayloadError ? err.message : 'unsafe payload'
          await deps.audit({
            type: 'relay_prompt',
            targetId,
            prompt: text,
            nonce: '',
            status: 'rejected',
            detail: `unsafe payload: ${msg}; ${sourceId}->${targetId}`
          })
          results[i] = { sourceId, targetId, status: 'rejected', detail: `unsafe payload: ${msg}` }
          continue
        }
        valid.push({
          index: i,
          item: items[i],
          sourceTitle: source.title,
          targetTitle: target.title,
          safeText
        })
      }

      // Nothing survived validation → no modal (every row already audited + recorded rejected).
      if (valid.length === 0) return results

      // ONE per-row confirm modal for every valid row (MAIN owns the decision, fail-closed).
      // A registry without `confirmBatch` wired (older stubs) fail-closes → every valid row denied.
      const { decisions } = deps.confirmBatch
        ? await deps.confirmBatch({
            title: valid.length === 1 ? 'Relay 1 prompt' : `Relay ${valid.length} prompts`,
            items: valid.map((v) => ({
              label: `${v.sourceTitle} → ${v.targetTitle}`,
              body: v.safeText
            }))
          })
        : { decisions: valid.map(() => ({ approved: false })) }

      // Each valid row runs the shared write gate INDEPENDENTLY, sequentially, with its batch
      // decision fed in. The gate still sanitizes + mints/consumes its own nonce + runs the TOCTOU
      // re-check + audits every branch — so a denied/rejected row changes nothing for the others.
      for (let j = 0; j < valid.length; j++) {
        const v = valid[j]
        const approved = decisions[j]?.approved === true
        const { sourceId, targetId } = v.item
        try {
          const { delivery } = await deps.runGatedWrite({
            type: 'relay_prompt',
            targetId,
            text: v.item.text,
            terminator: '\r',
            detailSuffix: `${sourceId}->${targetId} (batch)`,
            // The batch modal already rendered + authorized this row; confirmOverride skips the
            // per-item modal, so these are placeholders the gate does not surface in batch mode.
            confirmTitle: `Relay "${v.sourceTitle}" → "${v.targetTitle}"`,
            confirmBody: (s) => s,
            confirmOverride: () => Promise.resolve({ approved }),
            // 🔒 BUG-021 TOCTOU: re-verify the SAME directed cable still exists after the human
            // approved, before consuming the nonce / writing — the user may have deleted it while
            // the batch modal was open. Same `canRelay` predicate as the initial per-item check.
            preWriteRecheck: (seq) =>
              canRelay(sourceId, targetId, deps.listConnectors())
                ? null
                : {
                    detail: `authorization cable removed during confirm; ${sourceId}->${targetId}; seq=${seq}`,
                    error: `relay_prompt: authorization connector ${sourceId} -> ${targetId} removed during confirm`
                  }
          })
          results[v.index] = { sourceId, targetId, status: 'relayed', delivery }
        } catch (err) {
          // The gate throws on a human deny (confirmOverride approved:false), a TOCTOU cable-vanish,
          // or a PTY write failure — all already audited inside the gate. A declined row is the
          // human's "no" (`denied`); anything the human approved that still failed is a `rejected`.
          results[v.index] = approved
            ? {
                sourceId,
                targetId,
                status: 'rejected',
                detail: err instanceof Error ? err.message : 'relay failed'
              }
            : { sourceId, targetId, status: 'denied', detail: 'declined by the human gate' }
        }
      }

      return results
    }
  }
}
