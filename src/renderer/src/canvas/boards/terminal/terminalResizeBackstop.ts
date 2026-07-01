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

/** Mutable single-slot pending flag: ONE deferred re-fit collapses however many drag frames
 *  were skipped while a backstop was in flight. */
export interface BackstopGate {
  pending: boolean
}

export interface BackstopFitDeps extends ResizeBackstopDeps {
  /** Current terminal column count (already reflects any prior resize). */
  currentCols: () => number
  /** FitAddon's proposed grid for the current well size; undefined when not finite / not laid out. */
  propose: () => { cols: number; rows: number } | undefined
  /** True only for an ESTABLISHED grid — one with scrollback worth protecting from reflow. */
  established: () => boolean
  /** The non-reflowing fit path (rows-only / fresh). Returns false if the well is not laid out. */
  plainFit: () => boolean
  /** Whether a backstop's async write is still mid-parse (the re-entrancy gate). */
  isInFlight: () => boolean
  /** Re-run the full fit once the in-flight backstop resolves and a re-fit is pending. */
  refit: () => void
}

/**
 * One `fitWhole` invocation's resize decision, WITH a re-entrancy guard.
 *
 * A backstop is asynchronous: `term.write(snapshot, done)` parses over multiple frames when the
 * scrollback is large (long agent logs — the target use case). The ResizeObserver fires per-frame
 * during a continuous board drag (there is NO debounce — a real drag changes the well's border-box
 * every frame), so a second fit can arrive while a prior backstop's write is still mid-parse.
 * Starting a second `serialize()`/`reset()` then snapshots a HALF-written buffer and wipes the
 * pre-drag scrollback before the first snapshot ever fully lands — the exact #5319 corruption this
 * slice removes.
 *
 * Guard: while a backstop is in flight (`isInFlight()`), record a SINGLE pending re-fit and bail —
 * do not touch the terminal. When the in-flight backstop resolves, replay one fit (`refit()`),
 * which re-reads the LATEST proposed dimensions. Backstops therefore run strictly sequentially and
 * converge to the final drag width, with zero overlap. The chain terminates when the drag stops
 * (cols stop changing → the replay takes the plain-fit path).
 *
 * Returns true when a fit ran (the caller should run its post-fit row-shed), false when the call
 * was skipped (in flight) or the plain fit could not lay out (LOD / display:none).
 */
export function runBackstopFit(gate: BackstopGate, d: BackstopFitDeps): boolean {
  if (d.isInFlight()) {
    gate.pending = true // coalesce: one catch-up fit after the in-flight backstop resolves
    return false
  }
  const proposed = d.propose()
  if (d.established() && proposed && colsChanged(d.currentCols(), proposed.cols)) {
    applyResizeBackstop(proposed.cols, proposed.rows, {
      serialize: d.serialize,
      resize: d.resize,
      reset: d.reset,
      write: d.write,
      pausePump: d.pausePump,
      resumePump: () => {
        d.resumePump()
        if (gate.pending) {
          gate.pending = false
          d.refit() // catch up to the latest drag width (re-reads proposeDimensions)
        }
      }
    })
    return true
  }
  return d.plainFit()
}
