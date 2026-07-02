import type { McpCommand, McpCommandAck } from './mcpCommand'

/**
 * 🔒 P2 canvas-tidy method — the orchestrator's `tidyCanvas` loopback, factored OUT of
 * `mcpOrchestrator.ts` (which sits at the max-lines cap) and spread into its return object, the
 * extract-on-touch pattern `createBoardCardsMethod` (P3b) / `createVisualizeMethod` (P5a) use.
 *
 * It is the SIMPLEST write method: reposition-only, content-less, and UN-GATED — no cap, no mint, no
 * sanitize, no human confirm, no nonce, no audit (it mirrors `spawn_group`: a structural reposition is
 * not a content dispatch, and it is fully reversible in ONE host undo step). It just forwards a
 * `tidyBoards` command to the renderer's already-built, already-undoable `canvasStore.tidyBoards`
 * packer and returns the moved count the applier reports on the ack (0 ⇒ the canvas was already tidy).
 *
 * Pure host module (no electron value import) — unit-tested through the orchestrator harness.
 */

/** The command channel the tidy method needs — the same `sendCommand` seam the other gates take. */
export interface TidyMethodDeps {
  sendCommand: (cmd: McpCommand) => Promise<McpCommandAck>
}

export function createTidyMethod(deps: TidyMethodDeps): {
  tidyCanvas(input: { mode?: string }): Promise<{ moved: number }>
} {
  return {
    async tidyCanvas(input) {
      // Forward `mode` only when the agent supplied one; the renderer applier re-validates it and
      // falls back to 'smart' for an absent/off-enum value, so a bad mode never reaches the packer.
      const mode = input?.mode
      const ack = await deps.sendCommand({
        type: 'tidyBoards',
        ...(mode !== undefined ? { mode: mode as 'smart' | 'by-type' | 'grid' } : {})
      })
      if (!ack.ok) throw new Error(`tidy_canvas failed: ${ack.error}`)
      // The applier reports the moved count on a successful ack; default to 0 defensively.
      return { moved: typeof ack.moved === 'number' ? ack.moved : 0 }
    }
  }
}
