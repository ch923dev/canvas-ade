import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { isForeignSender } from './preview'

/**
 * Control-plane command envelope, MAIN → renderer — the inverse of the `mcp:boards`
 * mirror (which carries board facts renderer → MAIN). This is how the MCP layer
 * *drives* the canvas once it gains write tools.
 *
 * **This type is the contract M3 builds on.** T0.3 ships only `ping` (a round-trip
 * proof); M3 (lifecycle) extends the union with board CRUD, e.g.
 *   | { type: 'addBoard'; board: PersistedBoard }
 *   | { type: 'removeBoard'; id: string }
 *   | { type: 'selectBoard'; id: string }
 * Keep this the single source of truth; the renderer applier (`useMcpCommands`,
 * a separate bundle) mirrors it by hand.
 */
export type McpCommand = { type: 'ping' }

/** The renderer's reply to a command. `type` echoes the handled command. */
export type McpCommandAck = { ok: true; type: string } | { ok: false; error: string }

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
  bus: Pick<IpcMain, 'once' | 'removeListener'>,
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
    const replyChannel = `mcp:command:ack:${Date.now()}:${Math.random().toString(36).slice(2)}`
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
    bus.once(replyChannel, onReply)
    try {
      wc.send('mcp:command', { command, replyChannel })
    } catch {
      finish({ ok: false, error: 'send-failed' })
    }
  })
}
