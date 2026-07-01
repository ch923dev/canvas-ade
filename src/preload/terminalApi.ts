import { ipcRenderer } from 'electron'

/**
 * The preload `terminal` namespace — save-output (Phase 5 · S1) + scrollback snapshot persist/restore
 * (Phase 5 · S3) — factored out of preload/index.ts to stay under the max-lines ratchet. Control
 * plane only (plain `ipcRenderer.invoke`); the PTY data plane rides a MessagePort wired in index.ts.
 * Every handler is `isForeignSender` frame-guarded in MAIN (terminalIpc.ts).
 */
export const terminalApi = {
  /** S1: hand MAIN the serialized buffer text + a suggested name; it drives the native save dialog. */
  saveOutput: (args: {
    text: string
    suggestedName: string
  }): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:saveOutput', args),
  // ── S3: persist/restore the live buffer across restart (per-board .canvas/terminal/ sidecar) ──
  /** Write the serialized ANSI buffer to the board's sidecar. False on no-project / bad id / fs error. */
  writeSnapshot: (boardId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:writeSnapshot', boardId, text),
  /** Read the board's persisted snapshot back (ANSI), or null when absent. */
  readSnapshot: (boardId: string): Promise<string | null> =>
    ipcRenderer.invoke('terminal:readSnapshot', boardId),
  /** Delete the board's sidecar (on board removal). Resolves true even when none existed. */
  deleteSnapshot: (boardId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:deleteSnapshot', boardId)
}
