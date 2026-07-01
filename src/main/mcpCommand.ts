import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import type {
  McpCommand,
  McpCommandAck,
  PlanningOp,
  PlanningOpTint,
  KanbanOp,
  PlanItem,
  Visualization
} from '../shared/mcpTypes'

/**
 * The MCP control-plane types (`McpCommand`, `McpCommandAck`, `PlanningOp`, `PlanningOpTint`)
 * now live in the cross-bundle single-source-of-truth module `src/shared/mcpTypes.ts`, imported
 * by both MAIN and the renderer applier (`useMcpCommands`, a separate bundle) so the union is
 * defined ONCE and the two processes can no longer drift (W1-D / F9). Their per-variant docs live
 * with the canonical definitions there. Re-exported from here so MAIN call sites + tests that
 * import them from `./mcpCommand` keep resolving unchanged.
 */
export type {
  McpCommand,
  McpCommandAck,
  PlanningOp,
  PlanningOpTint,
  KanbanOp,
  PlanItem,
  Visualization
}

const ACK_TIMEOUT_MS = 2000

/**
 * Post a command to the renderer and await its ack. Mirrors `flushRenderer`'s
 * request/reply shape: a unique reply channel + a one-shot listener, resolved on
 * the renderer's reply OR a timeout fallback so a wedged/closed renderer can never
 * hang the caller. The reply is frame-guarded (only the main frame's ack counts).
 * Never throws — returns `{ok:false}` on a gone window / send failure / timeout.
 *
 * `bus` is injected (not imported) so the module stays free of electron *value*
 * imports and is unit-testable without the electron runtime — the project's
 * handler-registration convention.
 */
export function sendMcpCommand(
  bus: Pick<IpcMain, 'on' | 'removeListener'>,
  getWin: () => BrowserWindow | null,
  command: McpCommand,
  timeoutMs: number = ACK_TIMEOUT_MS
): Promise<McpCommandAck> {
  const win = getWin()
  const wc = win?.webContents
  if (!win || win.isDestroyed() || !wc || wc.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'no-window' })
  }
  return new Promise<McpCommandAck>((resolve) => {
    // 🔒 CSPRNG channel id — matches the BUG-022/BUG-038 hardening sweep (BUG-031).
    // Date.now()+Math.random() is predictable (~48 bits); randomUUID() is not.
    const replyChannel = `mcp:command:ack:${randomUUID()}`
    let done = false
    const finish = (ack: McpCommandAck): void => {
      if (done) return
      done = true
      bus.removeListener(replyChannel, onReply)
      clearTimeout(timer)
      resolve(ack)
    }
    const onReply = (e: IpcMainEvent, ack: unknown): void => {
      if (isForeignSender(e, getWin)) return // ignore a foreign-frame ack
      finish(
        ack !== null && typeof ack === 'object'
          ? (ack as McpCommandAck)
          : { ok: false, error: 'malformed-ack' }
      )
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    // 🔒 Use bus.on (not bus.once) so a foreign-frame event does NOT consume the listener
    // before the genuine renderer ack arrives (BUG-030). finish() calls removeListener.
    bus.on(replyChannel, onReply)
    try {
      wc.send('mcp:command', { command, replyChannel })
    } catch {
      finish({ ok: false, error: 'send-failed' })
    }
  })
}
