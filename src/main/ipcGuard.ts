import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

/**
 * The single IPC trust-boundary guard: TRUE when an invoke's sender is NOT the main window's
 * live main frame (foreign → the handler must deny). One source of truth, consumed by every
 * frame-guarded handler (preview/projectIpc/pty/llmIpc + audit/mcp). Was copy-pasted per file;
 * three of those copies resolved the frame in the caller (`getWin()?.webContents.mainFrame`),
 * which throws if the webContents is torn down mid-invoke — this canonical version takes `getWin`
 * and does the destroyed-window check itself so no caller touches a dead frame.
 *
 * Rules:
 * - No `senderFrame` → a synthetic/internal call (our own e2e harness / in-process invoke) → ALLOW.
 * - Window unresolved, destroyed, or its webContents destroyed → no trusted frame to match → DENY
 *   (and never touch `.webContents.mainFrame`, which throws on a torn-down window).
 * - Otherwise compare the sender frame against the live main frame.
 */
export function isForeignSender(
  e: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  getWin: () => BrowserWindow | null
): boolean {
  if (!e.senderFrame) return false // synthetic/internal call — allow
  const win = getWin()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return true
  return e.senderFrame !== win.webContents.mainFrame
}
