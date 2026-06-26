// Phase 5 · S2 — lossless drag-resize backstop.
//
// A board drag-resize that changes the terminal's COLUMN count makes xterm REFLOW its buffer
// (xterm #5319/#3513): the rewrap trims + duplicates scrollback lines. This is the last live
// instance of the corruption class (Phase 1 closed the full-view toggle; the DOM renderer removed
// zoom-driven cols changes — see useTerminalSpawn `fitWhole`). The fix is to NOT reflow: snapshot
// the buffer, resize, clear the reflow-prone buffer, and re-WRITE the snapshot so xterm re-wraps it
// cleanly at the new width.
//
// In-flight PTY bytes are not dropped: the pump is paused across the snapshot→write window and
// resumed once the snapshot has PARSED, so any bytes that queued during it flush AFTER the restored
// scrollback (correct order), never interleaving into the freshly-reset buffer.
//
// Pure of xterm/React — every collaborator is injected, so the call ORDER + the pump-pause/resume
// guarantee are unit-testable without a live Terminal.

/** True when the proposed grid changes COLS — the only resize that reflows (rows-only is lossless). */
export function colsChanged(currentCols: number, proposedCols: number | undefined): boolean {
  return proposedCols !== undefined && Number.isFinite(proposedCols) && proposedCols !== currentCols
}

export interface ResizeBackstopDeps {
  /** Snapshot the live buffer (SerializeAddon.serialize) → ANSI string (incl. scrollback). */
  serialize: () => string
  /** Resize term + PTY to the new grid (term.resize → onResize → SIGWINCH). */
  resize: (cols: number, rows: number) => void
  /** Clear the reflow-mangled buffer (term.reset). */
  reset: () => void
  /** Re-write the snapshot; `done` fires once it has PARSED (term.write(data, done)). */
  write: (data: string, done: () => void) => void
  /** Hold the PTY→term pump — incoming bytes queue, none dropped. */
  pausePump: () => void
  /** Resume the pump + flush whatever queued during the hold (appended AFTER the snapshot). */
  resumePump: () => void
}

/**
 * Snapshot → resize → reset → re-write, with the pump held until the snapshot has parsed. Idempotent
 * w.r.t. data: the buffer is captured before the resize and restored after, so the reflow never runs.
 * The pump is ALWAYS resumed exactly once — even if serialize/resize throw — so a failure can never
 * leave the terminal frozen (pump stuck paused).
 */
export function applyResizeBackstop(cols: number, rows: number, d: ResizeBackstopDeps): void {
  d.pausePump()
  let resumed = false
  const resume = (): void => {
    if (resumed) return
    resumed = true
    d.resumePump()
  }
  try {
    const snapshot = d.serialize()
    d.resize(cols, rows)
    d.reset()
    d.write(snapshot, resume)
  } catch {
    // serialize/resize/reset/write threw synchronously → restore the pump now (the write
    // callback will never fire), so the board keeps rendering live PTY output.
    resume()
  }
}
