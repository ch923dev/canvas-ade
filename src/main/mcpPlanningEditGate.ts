import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { ConfirmDiff, PlanningEditPatch } from '../shared/mcpTypes'
import type { DiagramSpec } from '../renderer/src/lib/diagramSpec'
import type { DispatchStatus, LifecycleOrchestrator } from './mcpRegistry'
import {
  buildPlanningUpdateOp,
  buildSpecOpsConfirmDiff,
  describeElement,
  renderPlanningEditConfirmBody
} from './mcpPlanningEdit'
import { PlanningContentError } from './mcpPlanning'

/**
 * The planning-element EDIT methods (S6) — `updatePlanningElement` / `removePlanningElement`, factored out
 * of `mcpOrchestrator.ts` so that file stays under the max-lines gate (the `createKanbanMethods`
 * precedent). `createPlanningEditMethods` builds the shared resolve→planning-check→resolve-element→
 * confirm→patchPlanningEdit→audit gate over injected registry deps, then returns the two methods the
 * orchestrator spreads into its object. Pure host module (no electron value import) — unit-tested through
 * the orchestrator harness. No PTY / nonce — an element is passive content (ADR 0003).
 */

/** One mirrored planning element the gate reads (id+kind to resolve; label fields for the confirm
 *  body; Phase 3: a diagram's `engine` + — for an expanse element — its FULL validated `spec`, the
 *  base the specOps result is computed/diffed against). */
export interface PlanningEditBoardElement {
  id: string
  kind: string
  text?: string
  title?: string
  engine?: string
  spec?: DiagramSpec
  items?: ReadonlyArray<{ id: string; label: string; done: boolean }>
}

/** The registry surface + audit sink the edit gate needs (a narrow slice of `BoardRegistry`). */
export interface PlanningEditGateDeps {
  listBoards: () => Array<{
    id: string
    type: string
    title: string
    planning?: { elements: PlanningEditBoardElement[] }
  }>
  confirm: (req: {
    title: string
    body: string
    diff?: ConfirmDiff
  }) => Promise<{ approved: boolean }>
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

type PlanningEditMethods = Pick<
  LifecycleOrchestrator,
  'updatePlanningElement' | 'removePlanningElement'
>

export function createPlanningEditMethods(deps: PlanningEditGateDeps): PlanningEditMethods {
  // 🔒 S6: the shared apply pipeline for ONE planning-element edit/remove — resolve board + planning-check
  // + resolve the element by id (read its kind) + build (sanitize/cap against the kind) + human-confirm +
  // patchPlanningEdit + audit EVERY branch. Mirrors addPlanningElements / applyKanbanOp (ADR 0003); NO PTY
  // and NO nonce (nothing executes — an element is passive). `buildOp` throws a PlanningContentError on bad
  // input (audited `rejected` before the human gate).
  const applyEdit = async (
    boardId: string,
    elementId: string,
    auditType: string,
    buildOp: (
      element: PlanningEditBoardElement,
      boardTitle: string
    ) => {
      op:
        | { op: 'update'; elementId: string; kind: string; patch: PlanningEditPatch }
        | { op: 'remove'; elementId: string }
      body: string
      diff?: ConfirmDiff
    }
  ): Promise<void> => {
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

    // (1) Resolve by OPAQUE id (never a label). Not found → audit + throw.
    const board = deps.listBoards().find((b) => b.id === boardId)
    if (!board) {
      await audit('rejected', { detail: 'board not found' })
      throw new Error(`${auditType}: board not found: ${boardId}`)
    }
    // (2) Planning-only. An element edit must never target a terminal/browser/kanban board.
    if (board.type !== 'planning') {
      await audit('rejected', { detail: `non-planning target (${board.type})` })
      throw new Error(`${auditType}: target is not a planning board (${board.type})`)
    }
    // (3) Resolve the element by id from the live mirror. Unknown id → reject (an agent must READ
    // canvas://board/{id}/planning first — the append-only anti-pattern is the very thing this closes).
    const element = board.planning?.elements.find((e) => e.id === elementId)
    if (!element) {
      await audit('rejected', { detail: `element not found: ${elementId}` })
      throw new Error(`${auditType}: element not found on ${boardId}: ${elementId}`)
    }
    // (4) Build + validate against the resolved kind. A malformed op is rejected BEFORE the human gate.
    let built: ReturnType<typeof buildOp>
    try {
      built = buildOp(element, board.title)
    } catch (err) {
      const detail =
        err instanceof PlanningContentError
          ? `invalid content: ${err.message}`
          : `error building op: ${err instanceof Error ? err.message : String(err)}`
      await audit('rejected', { detail })
      throw err
    }
    // (5) Mandatory human confirm — the host owns the decision, fail-closed. Body shows the exact
    // edit; a specOps edit additionally carries the Option-B semantic diff (presentation only).
    const { approved } = await deps.confirm({
      title: `Modify "${board.title}"`,
      body: built.body,
      ...(built.diff !== undefined ? { diff: built.diff } : {})
    })
    if (!approved) {
      await audit('denied', { prompt: built.body })
      throw new Error(`${auditType}: write denied by the human gate`)
    }
    // (6) Apply via the command channel (renderer re-resolves the element + commits as one undoable edit
    // through PATCHABLE_KEYS.planning `elements`). A false ack → audit failed + throw.
    const ack = await deps.sendCommand({ type: 'patchPlanningEdit', id: boardId, op: built.op })
    if (!ack.ok) {
      await audit('failed', { prompt: built.body, detail: `apply failed: ${ack.error}` })
      throw new Error(`${auditType} failed: ${ack.error}`)
    }
    // (7) Record the landed write for the forensic trail.
    await audit('applied', { prompt: built.body })
  }

  const labelOf = (el: PlanningEditBoardElement): string | undefined =>
    el.title ?? el.text ?? el.spec?.title

  return {
    async updatePlanningElement(boardId, elementId, patch) {
      await applyEdit(boardId, elementId, 'update_planning_element', (element, boardTitle) => {
        const built = buildPlanningUpdateOp(
          elementId,
          element.kind,
          patch,
          element.kind === 'diagram'
            ? {
                ...(element.engine !== undefined ? { engine: element.engine } : {}),
                ...(element.spec !== undefined ? { spec: element.spec } : {})
              }
            : undefined
        )
        // Phase 3: a specOps edit carries the Option-B semantic diff (computed against the SAME
        // mirror spec the ops were validated on) for both the plain body and the structured payload.
        const diff =
          built.op.patch.specOps !== undefined &&
          built.nextSpec !== undefined &&
          element.spec !== undefined
            ? buildSpecOpsConfirmDiff(element.spec, built.nextSpec)
            : undefined
        const body = renderPlanningEditConfirmBody(
          boardTitle,
          built.op,
          describeElement(element.kind, labelOf(element)),
          diff
        )
        return { op: built.op, body, ...(diff !== undefined ? { diff } : {}) }
      })
    },
    async removePlanningElement(boardId, elementId) {
      await applyEdit(boardId, elementId, 'remove_planning_element', (element, boardTitle) => {
        const op = { op: 'remove' as const, elementId }
        const body = renderPlanningEditConfirmBody(
          boardTitle,
          op,
          describeElement(element.kind, labelOf(element))
        )
        return { op, body }
      })
    }
  }
}
