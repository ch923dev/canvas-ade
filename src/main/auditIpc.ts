import type { IpcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import type { AuditEntry, AuditInput, AuditLog } from './auditLog'
import { MAX_READ_LIMIT } from './auditLog'

/**
 * Read-only IPC surface over the MCP dispatch {@link AuditLog} (T4.1), plus the
 * process-wide accessor the dispatch tools (T4.3+) and the e2e harness append through.
 *
 * The renderer audit-log viewer reads via `audit:read` (invoke). It is frame-guarded
 * (only the main window's main frame is answered — a foreign frame gets `[]`, never a
 * peek at the trail) like every other renderer→MAIN surface in this app
 * (`isForeignSender`, mirrored in `boardRegistry`/`mcpCommand`). Read-only: there is NO
 * `audit:write` IPC — entries are written ONLY MAIN-side by the dispatch path, so a
 * compromised renderer can neither forge nor erase an audit entry.
 */

let registered: AuditLog | null = null

/** The wired audit log (set by {@link registerAuditHandler}); null before app boot. */
export function getAuditLog(): AuditLog | null {
  return registered
}

/**
 * The registry `audit` sink (extracted from index.ts's startMcpServer literal, max-lines ratchet):
 * append through the LIVE log — resolved lazily so the closure reads it at dispatch time. A failed
 * audit write is a forensic gap — surface it in the log even if a future non-awaiting caller
 * forgets to handle the rejection, then RE-THROW so today's awaiting callers (the mcpOrchestrator
 * dispatch paths) still see it and can react. Pre-boot (no wired log) resolves as a no-op.
 */
export function appendAuditEntry(e: AuditInput): Promise<void> {
  return (
    getAuditLog()
      ?.append(e)
      .then(() => {})
      .catch((err: unknown) => {
        console.error('[mcp-audit] append failed', err)
        throw err
      }) ?? Promise.resolve()
  )
}

export function registerAuditHandler(
  ipcMain: Pick<IpcMain, 'handle'>,
  getWin: () => BrowserWindow | null,
  log: AuditLog
): void {
  registered = log
  ipcMain.handle(
    'audit:read',
    async (e: IpcMainInvokeEvent, opts?: { limit?: number }): Promise<AuditEntry[]> => {
      if (isForeignSender(e, getWin)) return []
      // 🔒 Validate the renderer-supplied limit before forwarding (BUG-043). Passing an
      // unvalidated limit (0, negative, NaN) to log.read triggers slice(-0) = full log.
      // Clamp to a positive integer within the sane cap here at the IPC boundary.
      const rawLimit = opts?.limit
      const safeLimit =
        typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, MAX_READ_LIMIT)
          : undefined // let log.read use its own default
      return log.read(safeLimit !== undefined ? { limit: safeLimit } : undefined)
    }
  )
}
