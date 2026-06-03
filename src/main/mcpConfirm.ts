import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { isForeignSender } from './preview'

/**
 * 🔒 Human-confirm gate (T4.2). The reusable "are you sure?" used by every dangerous
 * MCP action — M4 dispatch (handoff/assign), M6 merge, M7 permission answers. MAIN
 * OWNS THE DECISION: a tool calls {@link requestConfirm}, which posts a request to the
 * renderer, shows a modal, and BLOCKS the tool until the human approves or denies. The
 * decision authority is the human via our own trusted UI — NOT an MCP client
 * elicitation (which an agent's client could auto-answer), and never the
 * worker-originated content that prompted the action.
 *
 * Fail-closed in EVERY degenerate case — a gone/destroyed window, a send failure, a
 * malformed reply, a foreign-frame reply, or a safety-timeout all resolve to
 * `{ approved: false }`. The only way to get `approved: true` is a genuine main-frame
 * reply carrying `approved: true`. There is no path where ambiguity approves a write
 * into another agent's shell.
 */

export interface ConfirmRequest {
  /** Short modal title (e.g. "Dispatch to terminal"). */
  title: string
  /** Body text — what exactly will happen if approved (resolved target + the prompt). */
  body: string
  /** Optional button labels (default Approve / Deny). */
  confirmLabel?: string
  denyLabel?: string
}

export interface ConfirmDecision {
  approved: boolean
}

/** A human takes time — no decision timeout by default. Degenerate cases still deny. */
const DEFAULT_TIMEOUT_MS: number | undefined = undefined

const DENIED: ConfirmDecision = { approved: false }

/**
 * Post a confirm request to the renderer and resolve the human's decision. Mirrors
 * `sendMcpCommand`'s injected-bus, frame-guarded, never-throws shape — but the only
 * "ok" outcome is an explicit `approved: true`; everything else fails closed.
 *
 * `bus` is injected (not imported) so the module stays free of electron value imports
 * and is unit-testable without the runtime.
 */
export function requestConfirm(
  bus: Pick<IpcMain, 'once' | 'removeListener'>,
  getWin: () => BrowserWindow | null,
  request: ConfirmRequest,
  opts: { timeoutMs?: number } = {}
): Promise<ConfirmDecision> {
  const win = getWin()
  const wc = win?.webContents
  if (!win || win.isDestroyed() || !wc || wc.isDestroyed()) {
    return Promise.resolve(DENIED) // no UI to confirm against → deny
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<ConfirmDecision>((resolve) => {
    const replyChannel = `mcp:confirm:reply:${Date.now()}:${Math.random().toString(36).slice(2)}`
    let done = false
    const finish = (decision: ConfirmDecision): void => {
      if (done) return
      done = true
      bus.removeListener(replyChannel, onReply)
      if (timer) clearTimeout(timer)
      resolve(decision)
    }
    const onReply = (e: IpcMainEvent, decision: unknown): void => {
      if (isForeignSender(e, getWin)) return // a foreign frame can't decide — ignore
      // Fail-closed: ONLY an explicit `approved === true` approves; anything else denies.
      const approved =
        decision !== null &&
        typeof decision === 'object' &&
        (decision as ConfirmDecision).approved === true
      finish({ approved })
    }
    // Optional safety timeout (deny). Off by default — a human is allowed to take time.
    const timer = timeoutMs === undefined ? null : setTimeout(() => finish(DENIED), timeoutMs)
    bus.once(replyChannel, onReply)
    try {
      wc.send('mcp:confirm', { request, replyChannel })
    } catch {
      finish(DENIED) // couldn't even show the modal → deny
    }
  })
}
