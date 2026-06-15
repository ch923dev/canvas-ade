import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Control-plane command envelope, MAIN → renderer — the inverse of the `mcp:boards`
 * mirror (which carries board facts renderer → MAIN). This is how the MCP layer
 * *drives* the canvas once it gains write tools.
 *
 * **This type is the contract M3 builds on.** T0.3 ships only `ping` (a round-trip
 * proof); M3 (lifecycle) extends the union with board CRUD. `addBoard` carries only
 * a MINIMAL spec (id + type), NOT a full PersistedBoard: MAIN mints the id but does
 * not know canvas geometry, so the renderer builds the full board (free-slot
 * placement, per-type defaults) from this spec. `removeBoard` (T3.2) tears one down
 * by id. `configureBoard` (T3.3) changes a board's durable per-type config (the
 * renderer applies it through `updateBoard`, which filters to PATCHABLE_KEYS).
 * `patchPlanning` (S2) appends agent-authored CONTENT (notes/checklists/text/arrows) to a
 * planning board's `elements`; the ops are already validated + sanitized + capped + human-
 * confirmed by the orchestrator before this carries them.
 * Keep this the single source of truth; the renderer applier (`useMcpCommands`,
 * a separate bundle) mirrors it by hand.
 */
export type McpCommand =
  | { type: 'ping' }
  | { type: 'addBoard'; board: { id: string; type: string } }
  | { type: 'removeBoard'; id: string }
  | {
      type: 'configureBoard'
      id: string
      patch: { shell?: string; launchCommand?: string; cwd?: string }
    }
  | { type: 'patchPlanning'; id: string; ops: PlanningOp[] }

/** Note tint a `note` op carries (mirrors the renderer `NoteTint`). */
export type PlanningOpTint = 'yellow' | 'blue' | 'green' | 'plain'

/**
 * One SANITIZED, fully-normalized planning-element write op (S2), MAIN → renderer. The
 * orchestrator's `addPlanningElements` validates + sanitizes + caps the agent's content
 * BEFORE minting these (so the renderer receives clean, fully-specified ops: `tint` and
 * item `done` are no longer optional). The renderer materializes each into a full
 * `PlanningElement` — minting ids, stacking positions below existing content, and default
 * sizes — and re-validates against the schema (defense in depth) before it lands. Only the
 * existing schema kinds that carry agent content are expressible (note · checklist · text ·
 * arrow), so `MIN_READER_VERSION` stays at 9 (no schema bump). 🔒 Untrusted passive content:
 * it renders, never auto-arms an action.
 */
export type PlanningOp =
  | { kind: 'note'; text: string; tint: PlanningOpTint }
  | { kind: 'checklist'; title: string; items: Array<{ label: string; done: boolean }> }
  | { kind: 'text'; text: string }
  | { kind: 'arrow'; dx: number; dy: number }

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
