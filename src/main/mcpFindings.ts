import type { FindingsPublishOutcome, FindingsPublishResult } from './findingsPublish'
import type { DispatchStatus, LifecycleOrchestrator } from './mcpRegistry'

/**
 * 🔒 P4 `publish_findings` — the orchestrator's AGENT trigger for the end-of-run findings batch,
 * factored OUT of `mcpOrchestrator.ts` (max-lines doctrine) and spread into its return object, the
 * extract-on-touch pattern `createTidyMethod` / `createFocusMethod` use.
 *
 * WHY THIS EXISTS (the P1 it fixes): PR #400 wired `publishFindings` onto the BoardRegistry
 * (`mcpBoot.ts`) and the package's `registerPublishFindings` registers the tool only when
 * `typeof orchestrator.publishFindings === 'function'` — but `buildOrchestrator` never put the
 * method on the object `mcp.ts` hands to `createMcpHttpServer`. So the tool was absent from EVERY
 * tier's `tools/list` (the human "Publish findings →" button, which calls `findingsPublish`
 * directly over IPC, kept working and hid the gap; the package's drift guard ran against its own
 * `MockOrchestrator`, which does implement it). This module is the missing forward.
 *
 * PRESENCE IS THE GATE. An unwired registry yields NO key at all (`{}`), never a stub that throws:
 * the package keys registration off the method's existence, so a present-but-failing method would
 * advertise a tool every call of which errors. Wired ⇒ the key exists and the tool appears for the
 * orchestrator + lead tiers behind the host's `planningWrite` flag (the package's tier split).
 *
 * NOT DOUBLE-GATED. The registry method is `findingsPublish.publishFindings`, which already owns the
 * ONE per-row `confirmBatch` modal, the post-decision TOCTOU re-resolve and the single `patchKanban`
 * write — the same path the human button takes. Adding a confirm here would ask the human twice for
 * one act. What this layer DOES add is the one thing the agent path lacked: an AUDIT line on every
 * outcome. The human button is a human act (no audit, like every other on-canvas edit); an AGENT
 * landing durable content on the canvas is exactly what the MCP audit trail exists to record — the
 * same every-branch discipline as `add_planning_elements` / the card gate (ADR 0003).
 *
 * Pure host module (no electron value import) — unit-tested through the orchestrator harness.
 */

/** The audit vocabulary each publish outcome is recorded under (exhaustive by construction). */
const AUDIT_STATUS: Record<FindingsPublishOutcome, DispatchStatus> = {
  published: 'applied',
  // The human was shown the rows and approved none — a human "no".
  declined: 'denied',
  // Pre-write refusals: nothing composed / missing or non-kanban target / target removed mid-modal.
  empty: 'rejected',
  refused: 'rejected',
  'target-gone': 'rejected',
  'write-failed': 'failed'
}

/** The registry slice + audit sink the forwarder needs. */
export interface FindingsMethodDeps {
  /** `registry.publishFindings` — undefined when the host did not wire it (⇒ no method, no tool). */
  publishFindings?: (boardId: string, opts?: { lane?: string }) => Promise<FindingsPublishResult>
  audit: (input: {
    type: string
    targetId: string
    prompt: string
    nonce: string
    status: DispatchStatus
    detail?: string
  }) => Promise<void>
}

export function createFindingsMethod(
  deps: FindingsMethodDeps
): Pick<LifecycleOrchestrator, 'publishFindings'> {
  const publish = deps.publishFindings
  if (!publish) return {}

  // BUG-008 discipline: an audit append that fails AFTER the batch landed must not turn a real
  // publish into a thrown error — the agent would read "failed" and retry, writing every card twice.
  // So the audit never throws here; appendAuditEntry has already surfaced the failure to the log.
  const record = async (boardId: string, status: DispatchStatus, detail: string): Promise<void> => {
    try {
      // prompt '' — the agent supplied NO content (only a destination + optional lane); every card
      // is host-derived from write_result data. `detail` carries the host-composed outcome summary.
      await deps.audit({
        type: 'publish_findings',
        targetId: boardId,
        prompt: '',
        nonce: '',
        status,
        detail
      })
    } catch (err) {
      console.error(
        '[mcp-audit] publish_findings: outcome audit append failed; forensic gap (not re-thrown — ' +
          'the publish result already reached the agent and a retry would duplicate cards)',
        err
      )
    }
  }

  return {
    async publishFindings(boardId, opts) {
      const lane = opts?.lane !== undefined ? ` · lane=${opts.lane}` : ''
      let result: FindingsPublishResult
      try {
        result = await publish(boardId, opts)
      } catch (err) {
        await record(
          boardId,
          'failed',
          `publish threw: ${err instanceof Error ? err.message : String(err)}${lane}`
        )
        throw err
      }
      // The type makes `outcome` required, but an absent/unknown one at runtime must never fall
      // through to the audit's default `dispatched` (an off-vocabulary forensic line): record it
      // coarsely from what IS known — something landed, or nothing did.
      const status = AUDIT_STATUS[result.outcome] ?? (result.published > 0 ? 'applied' : 'rejected')
      await record(boardId, status, `${result.summary}${lane}`)
      return result
    }
  }
}
