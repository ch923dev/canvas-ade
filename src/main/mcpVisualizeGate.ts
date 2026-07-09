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
  /**
   * Cross-project routing (2026-07-09), all three injected together or not at all (an unwired
   * gate keeps today's active-canvas behaviour): resolve the ACTIVE project + the CALLER'S own
   * project (from its token-derived `sourceBoardId`), and queue a confirmed command for a
   * non-active project — delivered via `sendCommand` when that project is next foregrounded.
   */
  currentProjectDir?: () => string | null
  boardProjectDir?: (boardId: string) => string | null
  enqueueProjectCommand?: (dir: string, command: McpCommand) => boolean
}

type VisualizeMethod = Pick<LifecycleOrchestrator, 'visualizePlan'>

/** Last path segment as a display name — separator-agnostic (Windows + POSIX), mirroring the
 *  renderer's `basenameOf` (node's `path.basename` would mis-split a foreign-platform dir,
 *  e.g. a Windows queue path replayed by the Linux unit leg). */
function projectDisplayName(dir: string): string {
  return (
    dir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || dir
  )
}

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

      // (2b) Cross-project routing: resolve the CALLER'S own project from its token-derived
      // sourceBoardId (unforgeable — the package tool sets it from SessionCtx, never client
      // input). A caller whose project is NOT the active one must land its board on ITS OWN
      // canvas — via the pending-command queue — never on whichever project is foregrounded.
      // All-or-nothing on the three optional deps; an unwired gate keeps the legacy behaviour.
      const routable =
        deps.currentProjectDir !== undefined &&
        deps.boardProjectDir !== undefined &&
        deps.enqueueProjectCommand !== undefined
      const callerDir =
        routable && spec.sourceBoardId !== undefined
          ? (deps.boardProjectDir?.(spec.sourceBoardId) ?? null)
          : null

      // (3) Mandatory human confirm — the UPGRADED gate: the body shows the FULL plan, the chooser
      // offers the four shapes with the suggestion preselected. MAIN owns the decision, fail-closed.
      // A cross-project call says so IN the confirm body: the human approves a board on the CALLER'S
      // (backgrounded) canvas, not the one on screen.
      const crossAtConfirm = callerDir !== null && deps.currentProjectDir?.() !== callerDir
      const body =
        renderVisualizeConfirmBody(plan, suggested) +
        (crossAtConfirm
          ? `\n\nTarget project: ${projectDisplayName(callerDir)} (in the background) — the board will be ` +
            `created on that project's canvas when it is next opened, not on the current one.`
          : '')
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

      const command: McpCommand = {
        type: 'visualizePlan',
        id: boardId,
        visualization,
        ...(plan.title !== undefined ? { title: plan.title } : {}),
        items: plan.items
      }

      // (5a) Cross-project apply: RE-resolve the active project AFTER the (long) human confirm —
      // a switch during the modal must not misroute — and queue the command for the caller's
      // project instead of drawing on the foregrounded canvas. Delivery rides the same
      // sendCommand path when that project is next opened; the agent learns via `queuedFor`.
      if (callerDir !== null && deps.currentProjectDir?.() !== callerDir) {
        const queued = deps.enqueueProjectCommand?.(callerDir, command) === true
        if (!queued) {
          await audit('failed', { prompt: body, detail: `queue full for ${callerDir}` })
          throw new Error(`${auditType} failed: the target project's pending-command queue is full`)
        }
        await audit('applied', {
          prompt: body,
          detail: `queued for ${callerDir}; ${visualization}; ${plan.items.length} items`
        })
        return { id: boardId, queuedFor: projectDisplayName(callerDir) }
      }

      // (5) Apply via the command channel — the renderer builds the fully-populated board + tidies it
      // into open space as one undoable edit, re-validating as defense in depth. False ack → audit + throw.
      const ack = await deps.sendCommand(command)
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
