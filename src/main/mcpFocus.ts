import type { McpCommand, McpCommandAck } from './mcpCommand'
import { McpToolError } from './mcpToolError'

/**
 * 🔒 H1 camera-focus method — the orchestrator's `focusViewport` loopback, factored OUT of
 * `mcpOrchestrator.ts` (which sits at the max-lines cap) and spread into its return object — the
 * extract-on-touch pattern `createTidyMethod` (P2) set.
 *
 * It moves the USER'S VIEWPORT only (the camera is ephemeral session state — no board is created,
 * moved, resized, or deleted, and the canvas doc is untouched), and the user reverses it by
 * scrolling: no cap, no mint, no sanitize, no nonce, no audit. It forwards a `focusCamera` command;
 * the renderer applier resolves the target against the LIVE store (unknown id ⇒ {ok:false} ⇒ throw
 * here) and hands the fit to the camera layer.
 *
 * 🔒 D1 gate (spatial SPEC, `@expanse-ade/mcp` ≥ 0.27.0) — the `createTidyMethod` twin: the package
 * registers `focus_viewport` for the LEAD and CONNECTED tiers and binds the caller's token-derived
 * `sourceBoardId`. Present (`!== undefined`, so an empty id still gates) ⇒ ONE approve/deny human
 * confirm before the camera moves; declined ⇒ a `declined` tool error. Absent ⇒ the orchestrator
 * tier and the Jarvis facet, un-gated as before.
 *
 * Pure host module (no electron value import) — unit-tested through the orchestrator harness.
 */

/** The command channel + the D1 confirm seams the focus method needs (the tidy method's deps). */
export interface FocusMethodDeps {
  sendCommand: (cmd: McpCommand) => Promise<McpCommandAck>
  /** MAIN-owned, fail-closed human confirm (the same modal every gated write uses). */
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
  /** The live renderer mirror — names the requesting board and a board target in the confirm. */
  listBoards: () => Array<{ id: string; type: string; title: string }>
  /** The Named-Group mirror — names a group target in the confirm (absent ⇒ a generic label). */
  listGroups?: () => Array<{ id: string; name: string }>
}

/** The outcome surfaced to the agent (host-owned shape; the package types it `unknown`). */
export interface FocusOutcome {
  focused: 'board' | 'group' | 'all'
  id?: string
}

export function createFocusMethod(deps: FocusMethodDeps): {
  focusViewport(input: {
    boardId?: string
    groupId?: string
    sourceBoardId?: string
  }): Promise<FocusOutcome>
} {
  return {
    async focusViewport(input) {
      const boardId =
        typeof input?.boardId === 'string' && input.boardId ? input.boardId : undefined
      const groupId =
        typeof input?.groupId === 'string' && input.groupId ? input.groupId : undefined
      // At most ONE target (defense in depth — the package tool already rejects both; re-validate
      // at the trust boundary so a raw orchestrator caller can't make the applier pick a winner).
      if (boardId !== undefined && groupId !== undefined) {
        throw new McpToolError(
          'invalid_input',
          'focus_viewport: pass at most one of boardId / groupId'
        )
      }
      if (input?.sourceBoardId !== undefined) {
        const boards = deps.listBoards()
        const source = boards.find((b) => b.id === input.sourceBoardId)
        const who = source ? `The agent in "${source.title}"` : 'A terminal agent'
        const target =
          boardId !== undefined
            ? `the board "${boards.find((b) => b.id === boardId)?.title ?? boardId}"`
            : groupId !== undefined
              ? `the group "${deps.listGroups?.().find((g) => g.id === groupId)?.name ?? groupId}"`
              : 'the whole canvas'
        const { approved } = await deps.confirm({
          title: 'Move your view?',
          body:
            `${who} asked to move your view to ${target}. Only the camera moves: no board ` +
            'changes, and you can scroll back at any time.'
        })
        if (!approved) {
          throw new McpToolError(
            'declined',
            'focus_viewport: declined by the user — the view did not move'
          )
        }
      }
      const ack = await deps.sendCommand({
        type: 'focusCamera',
        ...(boardId !== undefined ? { boardId } : {}),
        ...(groupId !== undefined ? { groupId } : {})
      })
      if (!ack.ok) throw new Error(`focus_viewport failed: ${ack.error}`)
      // The outcome is derived from the validated input — the applier acked that the target
      // resolved, so the shape here can't disagree with what the camera is fitting.
      if (boardId !== undefined) return { focused: 'board', id: boardId }
      if (groupId !== undefined) return { focused: 'group', id: groupId }
      return { focused: 'all' }
    }
  }
}
