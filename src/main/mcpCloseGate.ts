import type { BoardId } from '@expanse-ade/mcp'
import type { AuditInput } from './auditLog'
import type { DispatchStatus } from './mcpRegistry'

/**
 * 🔒 The human-gated `close_board` write (2026-07-02 — replaces the removed idle reaper): a board
 * is deleted ONLY by the user on the canvas, or here — after the human approves the exact board by
 * name. Wraps the lifecycle's raw closeBoard so EVERY agent-facing close pays the same MAIN-owned,
 * fail-closed confirm + audit the other write tools pay (configure_board / the content writes).
 * Audits every exit — denied / closed / failed — because the un-audited silent close was the
 * forensic gap that made reaper-deleted boards untraceable. Built as a DI factory and spread into
 * the orchestrator (mirrors mcpKanbanGate / mcpVisualizeGate; keeps mcpOrchestrator.ts under the
 * max-lines gate).
 */
export interface CloseGateDeps {
  /** The live renderer mirror — resolves the board's TITLE so the human confirms a name, not a UUID. */
  listBoards: () => Array<{ id: string; type: string; title: string }>
  /** MAIN-owned, fail-closed human confirm (the same modal every gated write uses). */
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
  /** The orchestrator's typed audit sink (status pinned to the DispatchStatus vocabulary). */
  audit: (input: Omit<AuditInput, 'status'> & { status: DispatchStatus }) => Promise<void>
  /** The lifecycle's raw teardown (drain PTY → removeBoard command → cap release → token revoke). */
  closeBoard: (boardId: BoardId) => Promise<void>
}

export function createCloseBoardMethod(deps: CloseGateDeps): {
  closeBoard(boardId: BoardId): Promise<void>
} {
  return {
    async closeBoard(boardId: BoardId): Promise<void> {
      // Resolve the live title (UUID fallback for a board already gone from the mirror — the
      // approve path then no-ops idempotently), mirroring configure_board's confirm-body discipline.
      const boardEntry = deps.listBoards().find((b) => b.id === boardId)
      const boardLabel = boardEntry?.title ?? boardId
      const { approved } = await deps.confirm({
        title: `Close board "${boardLabel}"?`,
        body:
          `The agent asked to close ${boardEntry ? `the ${boardEntry.type} board` : 'board'} ` +
          `"${boardLabel}". Its content will be removed from the canvas ` +
          `(Ctrl+Z restores it this session).`
      })
      if (!approved) {
        await deps.audit({
          type: 'close_board',
          targetId: boardId,
          prompt: '',
          nonce: '',
          status: 'denied',
          detail: `close of "${boardLabel}" denied by the human gate`
        })
        throw new Error('close_board: denied by the human gate')
      }
      try {
        await deps.closeBoard(boardId)
      } catch (err) {
        await deps.audit({
          type: 'close_board',
          targetId: boardId,
          prompt: '',
          nonce: '',
          status: 'failed',
          detail: `close of "${boardLabel}" failed: ${err instanceof Error ? err.message : String(err)}`
        })
        throw err
      }
      await deps.audit({
        type: 'close_board',
        targetId: boardId,
        prompt: '',
        nonce: '',
        status: 'closed',
        detail: `board "${boardLabel}" closed (human-approved)`
      })
    }
  }
}
