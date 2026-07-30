// Terminal-clip fix — the deferred clip-verify watch window behind `fitWhole`'s row-shed.
//
// xterm's DOM renderer USUALLY applies a row-count change synchronously inside `term.resize`, so
// the shed that runs right after a fit measures a fresh rect and absorbs FitAddon's one-row
// over-proposal in the same tick. But under load (measured in the dataFlow → terminalClip e2e
// adjacency capture, docs/reviews/2026-07-28-terminal-clip-adjacency.md) the reflow can land 1-2
// frames AFTER `term.resize` — the same-tick rect still shows the PRE-fit grid, the shed reads a
// clean (even negative) overflow and does nothing, and the real spill materializes after the fit
// returned, clipping the bottom row until the next external refit. A real user resizing a board
// into an unlucky remainder on a busy canvas hits the identical sequence — no e2e involved.
//
// This chain re-measures the rendered grid against the clipping well once per frame for a short,
// fixed window after every fit and sheds whatever REAL overflow appears. Two properties are
// load-bearing:
//  - It deliberately does NOT early-exit on a clean read — a stale rect READS clean (the pre-fit
//    grid still fits the well), so "clean" cannot distinguish verified from not-yet-reflowed.
//    Only the frame budget ends the chain.
//  - Corrections are rows-only (`shedTargetRows` never touches cols), which is lossless — a
//    rows-only resize never triggers xterm's reflow, so the chain never needs the S2 backstop.
//
// Pure of xterm/React — every collaborator is injected (the terminalResizeBackstop precedent), so
// the no-early-exit, coalescing, and guard semantics are unit-testable with a fake rAF.
import { shedTargetRows } from './terminalSpawnMath'

/** Frames the watch window re-measures. Measured worst case in the adjacency capture = 2 frames
 *  late; 6 (~100ms at 60fps) buys margin without a perceptible cost — each tick is two rect reads
 *  unless it actually sheds. */
export const CLIP_VERIFY_FRAMES = 6

/** One final re-verify this long after the fit, wall-clock. The rAF window covers frame-deferred
 *  reflows; on a COLD, heavily-loaded instance (first launch of a fresh build) xterm's font/metric
 *  work can land later still and timer-driven, past however many janky frames the window spanned —
 *  observed as a rare first-run-after-build clip in the font-size matrix. One late tick is the
 *  bounded tail backstop: invisible in normal operation, and a rows-only shed is always safe. */
export const CLIP_VERIFY_LATE_MS = 350

/** One rendered-geometry sample: the live grid vs the well that clips it (screen px). */
export interface ClipVerifyMeasure {
  rows: number
  cols: number
  /** gridBottom − wellBottom: > 0 ⇒ the grid spills past the clip boundary. */
  overflow: number
  /** Rendered cell height (grid height / rows) — the shed step size. */
  cellH: number
}

/**
 * Sample the rendered grid vs the well that clips it — the SAME elements/geometry the e2e
 * terminalGeometry probe reads. `host` is the term.open() host (`screenRef`): the grid is its
 * `.xterm-screen` descendant, the well its closest `.nowheel` ancestor (the screenWrap). Null when
 * either is unresolvable (mount/teardown/portal hop mid-frame). Shared by `fitWhole`'s synchronous
 * shed and the verify chain so both measure the identical contract.
 */
export function measureClipGeometry(
  host: HTMLElement | null,
  rows: number,
  cols: number
): ClipVerifyMeasure | null {
  const screenEl = host?.querySelector('.xterm-screen') as HTMLElement | null
  const wellEl = host?.closest('.nowheel') as HTMLElement | null
  if (!screenEl || !wellEl) return null
  const grid = screenEl.getBoundingClientRect()
  return {
    rows,
    cols,
    overflow: grid.bottom - wellEl.getBoundingClientRect().bottom,
    cellH: grid.height / Math.max(1, rows)
  }
}

export interface ClipVerifyDeps {
  /** False once the term this chain was scheduled for is disposed/replaced — ends the chain. */
  stillCurrent: () => boolean
  /** True while an S2 backstop snapshot is mid-parse: geometry is in flux and the backstop's
   *  resumePump replays a full fitWhole (which reschedules) — skip the frame, keep ticking. */
  backstopInFlight: () => boolean
  /** Sample the CURRENT rendered geometry; null when an element is missing (portal hop mid-frame,
   *  teardown). Re-resolved per tick by the caller — never a captured node. */
  measure: () => ClipVerifyMeasure | null
  /** Rows-only lossless resize (cols passed through unchanged). */
  resize: (cols: number, rows: number) => void
  raf: (cb: () => void) => number
  caf: (handle: number) => void
  setTimer: (cb: () => void, ms: number) => number
  clearTimer: (handle: number) => void
}

/** Single-slot handles (rAF chain + late tail timer): a newer chain (or unmount) cancels whatever
 *  was pending — however many fits fire during a drag, at most ONE verify chain is ever live per
 *  terminal instance. */
export interface ClipVerifySlot {
  handle: number
  late: number
}

/** Cancel everything a chain may have pending (rAF tick + late tail tick). Unmount calls this. */
export function cancelClipVerify(slot: ClipVerifySlot): void {
  cancelAnimationFrame(slot.handle)
  clearTimeout(slot.late)
}

/** The hook-side wire for `verifyAfterFit`: everything is a getter so the chain always reads the
 *  LIVE value at tick time, never a capture. `term()` returns null once the terminal this chain
 *  was scheduled for is disposed/replaced — that ends the chain. */
export interface ClipVerifyWire {
  term: () => { rows: number; cols: number; resize: (cols: number, rows: number) => void } | null
  host: () => HTMLElement | null
  backstopInFlight: () => boolean
}

/** Wire `startClipVerify` to the real rAF + live terminal — the one-liner `fitWhole` calls after
 *  its synchronous shed. Kept apart from `startClipVerify` so the chain semantics stay unit-
 *  testable with a fake rAF. */
export function verifyAfterFit(slot: ClipVerifySlot, w: ClipVerifyWire): void {
  startClipVerify(slot, CLIP_VERIFY_FRAMES, {
    stillCurrent: () => w.term() !== null,
    backstopInFlight: w.backstopInFlight,
    measure: () => {
      const t = w.term()
      return t ? measureClipGeometry(w.host(), t.rows, t.cols) : null
    },
    resize: (cols, rows) => w.term()?.resize(cols, rows),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (handle) => cancelAnimationFrame(handle),
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (handle) => clearTimeout(handle)
  })
}

/**
 * Start (or restart) the verify chain: `frames` consecutive rAF ticks, each re-measuring and
 * shedding any real overflow via `shedTargetRows`. See the module doc for why a clean read must
 * NOT end the chain early.
 */
export function startClipVerify(slot: ClipVerifySlot, frames: number, d: ClipVerifyDeps): void {
  const verifyOnce = (): void => {
    if (!d.stillCurrent() || d.backstopInFlight()) return
    const m = d.measure()
    if (!m) return
    const rows = shedTargetRows(m.rows, m.overflow, m.cellH)
    if (rows !== m.rows) d.resize(m.cols, rows)
  }
  const tick = (framesLeft: number): void => {
    d.caf(slot.handle)
    slot.handle = d.raf(() => {
      if (!d.stillCurrent()) return // disposed/replaced: end the chain (late tick guards itself)
      verifyOnce() // backstop-in-flight skips the measure but the chain keeps ticking
      if (framesLeft > 1) tick(framesLeft - 1)
    })
  }
  // The late tail tick rides wall-clock, not frames: on a cold, janky instance xterm's metric
  // work can land timer-driven after the whole rAF window. Rescheduled (not stacked) per chain.
  d.clearTimer(slot.late)
  slot.late = d.setTimer(verifyOnce, CLIP_VERIFY_LATE_MS)
  tick(frames)
}
