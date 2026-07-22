/**
 * Resize-storm fix (terminal display v2) — collapse a burst of grid resizes into ONE
 * PTY-bound resize message.
 *
 * A full-view enter/exit (and any backstop fit) can resize the xterm grid more than once in
 * quick succession: the cols-changing backstop resize plus the whole-cell row-shed land in the
 * same fitWhole call, and a coalesced catch-up fit can follow a frame later. Each term.resize
 * fires term.onResize, and forwarding each one to the PTY means one ConPTY resize + SIGWINCH
 * per step — a streaming TUI repaints its live region per SIGWINCH, and every repaint whose
 * cursor-up cannot reach rows already scrolled off litters scrollback with a duplicate frame
 * (claude-code#51828; the app-side amplification this slice removes). The xterm grid may step
 * as often as it likes — the PTY only needs the SETTLED grid.
 *
 * Trailing throttle: the first push of a burst arms one timer; pushes inside the window just
 * overwrite the pending dims; the timer posts the LATEST dims once. The window is short enough
 * (~3 frames) that a TUI's reflow to the new width still reads as immediate.
 *
 * Hold (T1a′, interactive drag): pacing is not enough for a handle-drag — even one resize per
 * 50 ms window is ~20 SIGWINCH on a slow drag, each littering scrollback under #51828. While
 * held (BoardNode's NodeResizer drag, via boardResizeDrag), pushes only record the latest dims
 * and nothing posts; release re-arms the trailing window so the PTY gets exactly ONE resize —
 * the released grid — after any final ResizeObserver fit has landed.
 *
 * Pure of xterm/React — timers are injected, so burst-collapse and dispose are unit-testable.
 */

/** ~3 frames at 60 Hz: wide enough to swallow a fitWhole's resize+row-shed pair (same tick)
 *  and the reraster's one-frame-deferred refit; short enough to be imperceptible on a drag. */
export const RESIZE_SETTLE_MS = 50

export interface ResizeSettlerDeps {
  /** Deliver the settled grid to the PTY (postMessage {t:'resize'} on the current port). */
  post: (cols: number, rows: number) => void
  /** Trailing window in ms (RESIZE_SETTLE_MS in production). */
  delayMs: number
  schedule: (fn: () => void, ms: number) => number
  cancel: (handle: number) => void
}

export interface ResizeSettler {
  /** Record the latest grid; arms the trailing timer if none is pending (and not held). */
  push(cols: number, rows: number): void
  /** While held, pushes accumulate silently; releasing re-arms the window for the latest dims. */
  setHold(held: boolean): void
  /** Drop the pending dims + timer (teardown — the session is going away). */
  dispose(): void
}

export function createResizeSettler(d: ResizeSettlerDeps): ResizeSettler {
  let timer = 0
  let held = false
  let pending: { cols: number; rows: number } | null = null
  const arm = (): void => {
    timer = d.schedule(() => {
      timer = 0
      // Re-held while armed (next drag started inside the window): keep the pending dims
      // for that drag's own release instead of posting a mid-drag grid.
      if (held) return
      const p = pending
      pending = null
      if (p) d.post(p.cols, p.rows)
    }, d.delayMs)
  }
  return {
    push(cols, rows) {
      pending = { cols, rows }
      if (held || timer) return // trailing: the armed timer will read the latest pending
      arm()
    },
    setHold(h) {
      if (held === h) return
      held = h
      if (!h && pending && !timer) arm()
    },
    dispose() {
      if (timer) d.cancel(timer)
      timer = 0
      pending = null
    }
  }
}
