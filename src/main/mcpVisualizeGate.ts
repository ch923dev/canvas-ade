import { randomUUID } from 'node:crypto'
import type { McpCommand, McpCommandAck, Visualization } from './mcpCommand'
import type { ConfirmChoices } from './mcpConfirm'
import type { DispatchStatus, LifecycleOrchestrator } from './mcpRegistry'
import {
  buildPlanItems,
  renderVisualizeConfirmBody,
  resolveVisualization,
  VisualizeContentError,
  VISUALIZATION_LABEL,
  VISUALIZATIONS
} from './mcpVisualize'

/**
 * The plan-visualize method (P5), factored out of `mcpOrchestrator.ts` so that file stays under the
 * max-lines gate (mirrors `mcpKanbanGate`). `createVisualizeMethod` builds the gate over injected
 * registry deps + the audit sink and returns the `visualizePlan` implementation the orchestrator
 * spreads into its object. Pure host module (no electron value import) — unit-tested through the
 * orchestrator harness.
 *
 * 🔒 The gate mirrors `addPlanningElements` (attacker-influenceable content onto the durable canvas,
 * ADR 0003) with ONE upgrade: the mandatory human confirm carries a layout CHOOSER, and the shape
 * that materializes is the option the HUMAN picked (re-validated against {@link VISUALIZATIONS}, so a
 * forged `choice` can never widen it). No PTY write, no nonce — nothing executes; a board is passive.
 */

/** The confirm/command/audit slice the visualize gate needs. `confirm` returns the human's `choice`. */
export interface VisualizeGateDeps {
  confirm: (req: {
    title: string
    body: string
    confirmLabel?: string
    denyLabel?: string
    choices?: ConfirmChoices
  }) => Promise<{ approved: boolean; choice?: string }>
  sendCommand: (cmd: McpCommand) => Promise<McpCommandAck>
  audit: (input: {
    type: string
    targetId: string
    prompt: string
    nonce: string
    status: DispatchStatus
    detail?: string
  }) => Promise<void>
}

type VisualizeMethod = Pick<LifecycleOrchestrator, 'visualizePlan'>

export function createVisualizeMethod(deps: VisualizeGateDeps): VisualizeMethod {
  return {
    async visualizePlan(spec) {
      const auditType = 'visualize_plan'
      // The board id is minted before the confirm so every post-mint audit line carries the target;
      // the pre-mint rejection (bad content) audits with an empty target (no board exists yet).
      let boardId = ''
      const audit = (
        status: DispatchStatus,
        opts: { prompt?: string; detail?: string } = {}
      ): Promise<void> =>
        deps.audit({
          type: auditType,
          targetId: boardId,
          prompt: opts.prompt ?? '',
          nonce: '',
          status,
          ...(opts.detail !== undefined ? { detail: opts.detail } : {})
        })

      // (1) Validate + sanitize + cap the plan. A malformed/oversized plan is rejected BEFORE the
      // human gate — never shown to the human to rubber-stamp, never minted into a command.
      let plan
      try {
        plan = buildPlanItems(spec.items, spec.title)
      } catch (err) {
        const detail =
          err instanceof VisualizeContentError
            ? `invalid content: ${err.message}`
            : `error building plan: ${err instanceof Error ? err.message : String(err)}`
        await audit('rejected', { detail })
        throw err
      }

      // (2) Resolve the agent's suggestion (always a valid shape) + MINT the board id.
      const suggested = resolveVisualization(spec.suggested)
      boardId = randomUUID()

      // (3) Mandatory human confirm — the UPGRADED gate: the body shows the FULL plan, the chooser
      // offers the four shapes with the suggestion preselected. MAIN owns the decision, fail-closed.
      const body = renderVisualizeConfirmBody(plan, suggested)
      const { approved, choice } = await deps.confirm({
        title: `Visualize a ${plan.items.length}-item plan`,
        body,
        confirmLabel: 'Create on canvas',
        denyLabel: 'Cancel',
        choices: {
          label: 'Visualization',
          options: VISUALIZATIONS.map((v) => ({ id: v, label: VISUALIZATION_LABEL[v] })),
          default: suggested
        }
      })
      if (!approved) {
        await audit('denied', { prompt: body, detail: `${plan.items.length} items` })
        throw new Error(`${auditType}: declined by the human gate`)
      }

      // (4) 🔒 Re-validate the human's pick against the offered set; fall back to the suggestion for
      // anything off-set (a forged/garbage `choice` can never produce an off-shape board).
      const visualization: Visualization = (VISUALIZATIONS as readonly string[]).includes(
        choice ?? ''
      )
        ? (choice as Visualization)
        : suggested

      // (5) Apply via the command channel — the renderer builds the fully-populated board + tidies it
      // into open space as one undoable edit, re-validating as defense in depth. False ack → audit + throw.
      const ack = await deps.sendCommand({
        type: 'visualizePlan',
        id: boardId,
        visualization,
        ...(plan.title !== undefined ? { title: plan.title } : {}),
        items: plan.items
      })
      if (!ack.ok) {
        await audit('failed', { prompt: body, detail: `apply failed: ${ack.error}` })
        throw new Error(`${auditType} failed: ${ack.error}`)
      }

      // (6) Record the landed create for the forensic trail + return the minted board id.
      await audit('applied', {
        prompt: body,
        detail: `${visualization}; ${plan.items.length} items`
      })
      return { id: boardId }
    }
  }
}
