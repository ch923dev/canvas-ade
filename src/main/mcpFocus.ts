import type { McpCommand, McpCommandAck } from './mcpCommand'

/**
 * 🔒 H1 camera-focus method — the orchestrator's `focusViewport` loopback, factored OUT of
 * `mcpOrchestrator.ts` (which sits at the max-lines cap) and spread into its return object — the
 * extract-on-touch pattern `createTidyMethod` (P2) set.
 *
 * Like tidy it is UN-GATED — no cap, no mint, no sanitize, no human confirm, no nonce, no audit:
 * it moves the USER'S VIEWPORT only (the camera is ephemeral session state — no board is created,
 * moved, resized, or deleted, and the canvas doc is untouched), and the user reverses it by
 * scrolling. It forwards a `focusCamera` command; the renderer applier resolves the target against
 * the LIVE store (unknown id ⇒ {ok:false} ⇒ throw here) and hands the fit to the camera layer.
 *
 * Pure host module (no electron value import) — unit-tested through the orchestrator harness.
 */

/** The command channel the focus method needs — the same `sendCommand` seam the tidy method takes. */
export interface FocusMethodDeps {
  sendCommand: (cmd: McpCommand) => Promise<McpCommandAck>
}

/** The outcome surfaced to the agent (host-owned shape; the package types it `unknown`). */
export interface FocusOutcome {
  focused: 'board' | 'group' | 'all'
  id?: string
}

export function createFocusMethod(deps: FocusMethodDeps): {
  focusViewport(input: { boardId?: string; groupId?: string }): Promise<FocusOutcome>
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
        throw new Error('focus_viewport: pass at most one of boardId / groupId')
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
