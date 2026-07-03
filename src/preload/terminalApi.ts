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
  /**
   * Write the serialized ANSI buffer to the board's sidecar. False on no-project / bad id / fs error.
   * `sync` (default false → async, non-blocking MAIN) should only be `true` for the before-quit flush,
   * where the process may exit right after and the write must land before that happens.
   */
  writeSnapshot: (boardId: string, text: string, sync?: boolean): Promise<boolean> =>
    ipcRenderer.invoke('terminal:writeSnapshot', boardId, text, sync),
  /** Read the board's persisted snapshot back (ANSI), or null when absent. */
  readSnapshot: (boardId: string): Promise<string | null> =>
    ipcRenderer.invoke('terminal:readSnapshot', boardId),
  /** Delete the board's sidecar (on board removal). Resolves true even when none existed. */
  deleteSnapshot: (boardId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:deleteSnapshot', boardId),
  // ── Terminal-resume F1+F3: MAIN validates the stored session against the transcript's on-disk
  // reality (terminalResume.ts). `stored` relays the board's canvas.json fields — UNTRUSTED, so
  // MAIN sanitizes the id + trusted-path-guards the path before either nears a read or a command.
  /** F1: is the board's stored agent session actually resumable right now? */
  resumeCheck: (
    boardId: string,
    stored: { sessionId?: string; transcriptPath?: string }
  ): Promise<{ canResume: boolean }> => ipcRenderer.invoke('terminal:resumeCheck', boardId, stored),
  /** F3: the Resume launch line, re-resolved at click time. `command` absent ⇒ start fresh. */
  resumeLaunch: (
    boardId: string,
    stored: { sessionId?: string; transcriptPath?: string }
  ): Promise<{ mode: 'resume' | 'continue' | 'fresh'; command?: string }> =>
    ipcRenderer.invoke('terminal:resumeLaunch', boardId, stored)
}
