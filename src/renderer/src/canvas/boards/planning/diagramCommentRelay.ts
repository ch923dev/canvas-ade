/**
 * Diagram node-comment relay (diagram Phase 4, T3) — sends a user's comment about a diagram node to a
 * Terminal board's agent as a prompt, over the SAME vetted terminal-input seam voice injection uses
 * (bracketed paste → settle → one discrete `\r`, gated on `running[id]` at fire time). MAIN owns the
 * PTY write; this is trusted-user input only. The comment is an ACTION — it writes nothing to the
 * diagram spec (no persistence, no schema field).
 */
import type { SpecNode } from '../../../lib/diagramSpec'
import { getTerminalInput } from '../terminal/terminalInputRegistry'
import { useTerminalRuntimeStore } from '../../../store/terminalRuntimeStore'

/** Paste → submit settle (the Claude Code TUI submit discipline — mirrors the voice/relay pacing). */
const PASTE_SUBMIT_MS = 150

/** Compose the agent-facing prompt from a node + the user's comment. Pure — unit-tested. Node id and
 *  label give the agent unambiguous context ("which node"); the comment is the ask. */
export function composeNodeComment(
  node: Pick<SpecNode, 'id' | 'label' | 'detail'>,
  comment: string
): string {
  const detail = node.detail ? ` — ${node.detail}` : ''
  return `Regarding diagram node "${node.label}"${detail} (id: ${node.id}): ${comment.trim()}`
}

/**
 * Send `text` to a terminal board's agent: bracketed paste, then ONE `\r` after a settle, both gated
 * on the terminal being live. Returns false (no-op) if the target is not running or not mounted —
 * the caller surfaces that. The only `\r` emitter here; there is no auto-submit path.
 */
export async function sendNodeComment(targetId: string, text: string): Promise<boolean> {
  if (!useTerminalRuntimeStore.getState().running[targetId]) return false
  const entry = getTerminalInput(targetId)
  if (!entry) return false
  entry.paste(text)
  await new Promise((r) => setTimeout(r, PASTE_SUBMIT_MS))
  // Re-check running at fire time (the target may have exited during the settle).
  if (useTerminalRuntimeStore.getState().running[targetId]) {
    getTerminalInput(targetId)?.submit()
    return true
  }
  return false
}
