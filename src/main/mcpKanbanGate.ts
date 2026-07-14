import { randomUUID } from 'node:crypto'
import type { KanbanOp } from './mcpCommand'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { DispatchStatus, LifecycleOrchestrator } from './mcpRegistry'
import {
  buildAddCardOp,
  buildKanbanAxisConfig,
  buildMoveCardOp,
  buildRemoveCardOp,
  buildUpdateCardOp,
  KanbanContentError,
  renderKanbanAxisConfirmBody,
  renderKanbanConfirmBody
} from './mcpKanban'

/**
 * The four Kanban card-write methods (P3), factored out of `mcpOrchestrator.ts` so that file stays
 * under the max-lines gate. `createKanbanMethods` builds the shared `applyKanbanOp` gate over injected
 * registry deps + the audit sink, then returns the `addCard/moveCard/updateCard/removeCard`
 * implementations the orchestrator spreads into its object. Pure host module (no electron value
 * import) — unit-tested through the orchestrator harness.
 */

/** The registry surface + audit sink the card gate needs (a narrow slice of `BoardRegistry`). */
export interface KanbanGateDeps {
  listBoards: () => Array<{ id: string; type: string; title: string }>
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
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

type KanbanMethods = Pick<
  LifecycleOrchestrator,
  'addCard' | 'moveCard' | 'updateCard' | 'removeCard'
>

/**
 * The card methods plus `configureAxis` — the v19 kanban board-AXIS config gate (columnAxis/axisLabel).
 * `configureBoard` in `mcpOrchestrator.ts` delegates to it when a config call targets a kanban board, so
 * the resolve→kanban-check→sanitize→confirm→configureBoard→audit gate lives here (max-lines discipline).
 */
type KanbanMethodsWithConfig = KanbanMethods & {
  configureAxis(boardId: string, config: unknown): Promise<void>
}

export function createKanbanMethods(deps: KanbanGateDeps): KanbanMethodsWithConfig {
  // 🔒 P3: the shared apply pipeline for ONE kanban card op — resolve + kanban-check + build
  // (sanitize/cap, via mcpKanban) + human-confirm + patchKanban + audit EVERY branch. Mirrors
  // addPlanningElements (attacker-influenceable content onto the durable canvas, ADR 0003); there is
  // NO PTY write and NO nonce (nothing executes — a card is passive). `buildOp` throws a
  // KanbanContentError on bad agent input (audited `rejected` before the human gate).
  const applyKanbanOp = async (
    boardId: string,
    auditType: string,
    buildOp: () => KanbanOp
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
    // (2) Kanban-only. Card content must never land on another board type.
    if (board.type !== 'kanban') {
      await audit('rejected', { detail: `non-kanban target (${board.type})` })
      throw new Error(`${auditType}: target is not a kanban board (${board.type})`)
    }
    // (3) Validate + sanitize + cap — a malformed op is rejected BEFORE the human gate.
    let op: KanbanOp
    try {
      op = buildOp()
    } catch (err) {
      const detail =
        err instanceof KanbanContentError
          ? `invalid content: ${err.message}`
          : `error building op: ${err instanceof Error ? err.message : String(err)}`
      await audit('rejected', { detail })
      throw err
    }
    // (4) Mandatory human confirm — the host owns the decision, fail-closed. Body shows the exact op.
    const body = renderKanbanConfirmBody(board.title, op)
    const { approved } = await deps.confirm({ title: `Modify "${board.title}"`, body })
    if (!approved) {
      await audit('denied', { prompt: body })
      throw new Error(`${auditType}: write denied by the human gate`)
    }
    // (5) Apply via the command channel (renderer re-validates the column/card + commits as one
    // undoable edit through PATCHABLE_KEYS.kanban). A false ack → audit failed + throw.
    const ack = await deps.sendCommand({ type: 'patchKanban', id: boardId, ops: [op] })
    if (!ack.ok) {
      await audit('failed', { prompt: body, detail: `apply failed: ${ack.error}` })
      throw new Error(`${auditType} failed: ${ack.error}`)
    }
    // (6) Record the landed write for the forensic trail.
    await audit('applied', { prompt: body })
  }

  return {
    // addCard MINTS the card id in the host (an agent can't forge/collide one) and returns it so the
    // agent can address the card later; move/update/remove take that id.
    async addCard(boardId, spec) {
      const id = randomUUID()
      await applyKanbanOp(boardId, 'add_card', () => buildAddCardOp(id, spec))
      return { id }
    },
    async moveCard(boardId, cardId, toColumnId) {
      await applyKanbanOp(boardId, 'move_card', () => buildMoveCardOp(cardId, toColumnId))
    },
    async updateCard(boardId, cardId, patch) {
      await applyKanbanOp(boardId, 'update_card', () => buildUpdateCardOp(cardId, patch))
    },
    async removeCard(boardId, cardId) {
      await applyKanbanOp(boardId, 'remove_card', () => buildRemoveCardOp(cardId))
    },
    // 🔒 v19: the kanban board-AXIS config gate (columnAxis/axisLabel via configure_board). Same
    // resolve→kanban-check→sanitize→confirm→configureBoard→audit discipline as the card ops — the
    // axisLabel is renderable content (ADR 0003), so it is human-confirmed like a card write. There is
    // NO PTY / nonce (nothing executes — the axis is passive board config).
    async configureAxis(boardId, rawConfig) {
      const audit = (
        status: DispatchStatus,
        opts: { prompt?: string; detail?: string } = {}
      ): Promise<void> =>
        deps.audit({
          type: 'configure_board',
          targetId: boardId,
          prompt: opts.prompt ?? '',
          nonce: '',
          status,
          ...(opts.detail !== undefined ? { detail: opts.detail } : {})
        })

      const board = deps.listBoards().find((b) => b.id === boardId)
      if (!board) {
        await audit('rejected', { detail: 'board not found' })
        throw new Error(`configure_board: board not found: ${boardId}`)
      }
      if (board.type !== 'kanban') {
        await audit('rejected', { detail: `non-kanban target (${board.type})` })
        throw new Error(`configure_board: axis config target is not a kanban board (${board.type})`)
      }
      let cfg: ReturnType<typeof buildKanbanAxisConfig>
      try {
        cfg = buildKanbanAxisConfig(rawConfig)
      } catch (err) {
        const detail =
          err instanceof KanbanContentError
            ? `invalid content: ${err.message}`
            : `error building config: ${err instanceof Error ? err.message : String(err)}`
        await audit('rejected', { detail })
        throw err
      }
      const body = renderKanbanAxisConfirmBody(board.title, cfg)
      const { approved } = await deps.confirm({ title: `Configure "${board.title}"`, body })
      if (!approved) {
        await audit('denied', { prompt: body })
        throw new Error('configure_board: axis config denied by the human gate')
      }
      const ack = await deps.sendCommand({ type: 'configureBoard', id: boardId, patch: cfg })
      if (!ack.ok) {
        await audit('failed', { prompt: body, detail: `apply failed: ${ack.error}` })
        throw new Error(`configure_board failed: ${ack.error}`)
      }
      await audit('configured', { prompt: body })
    }
  }
}
