/**
 * Switch-latency instrumentation (project-switch & perf audit, R1).
 *
 * Before this module the app had ZERO timing instrumentation — `performance.mark` appeared nowhere
 * in `src/`, so nobody could say what a project switch cost. Roadmap Phases 2 and 3 of that audit
 * are gated on this file existing: every later optimization is judged before/after against these
 * numbers, and PS-1's dead air (fixed by R3) is only verifiable through the `arm` segment.
 *
 * WHAT IS MEASURED — four segments, derived from marks laid along `performProjectSwitch`:
 *
 *   arm    `start` → `armed`     the DEAD AIR. From the user's gesture to the transition overlay
 *                                standing in for the outgoing canvas. This is PS-1; budget <100 ms.
 *   load   `armed` → `loaded`    disk read + `applyOpenResult`.
 *   paint  `loaded` → `paintable` React mount + the first frame that actually painted.
 *   total  `start` → `paintable`, minus `ask`.
 *
 * `ask` (the ask-on-switch dialog) is measured SEPARATELY and subtracted from `arm` and `total`.
 * It is human think-time: a user who stares at the dialog for nine seconds has not experienced a
 * nine-second switch, and folding that in would make every other number meaningless. It is still
 * reported so the exclusion is visible rather than silent.
 *
 * WHY THERE IS NO `interactive` MARK. The audit's R1 sketch listed one, and it is deliberately not
 * implemented: "interactive" for this app would mean boards live, but `TerminalBoard` mount kicks
 * off an async `pty:spawn` and Browser boards start an offscreen window, both unbounded and both
 * mostly measuring the *agent's* boot rather than the switch. `paintable` — the first painted frame
 * of the new canvas — is the last moment the switch pipeline is honestly responsible for, so that
 * is where `total` stops. Anything beyond it belongs to a board-level metric.
 *
 * Marks are laid with `performance.mark`/`performance.measure` (best-effort, for the devtools
 * Performance panel) but every number reported here is derived from `performance.now()` captured at
 * the call site. The arithmetic must not depend on the entry buffer: it has a bounded size, callers
 * may clear it, and jsdom's implementation is thinner than Chromium's.
 */
import { create } from 'zustand'

/** Points along the switch pipeline. Order is the pipeline's order. */
export type SwitchMark =
  | 'start'
  | 'decided'
  | 'flushed'
  | 'thumbed'
  | 'armed'
  | 'loaded'
  | 'paintable'

/** How a measured switch ended — mirrors `SwitchOutcome` plus the in-flight case. */
export type SwitchMetricsOutcome =
  | 'switched'
  | 'locked'
  | 'save-failed'
  | 'background-failed'
  | 'cancelled'

/** Latency budget buckets, per the NN/g response-time limits the audit measures against. */
export type SwitchBucket = 'ok' | 'warn' | 'err'

/** 0.1 s — the limit below which a result feels instantaneous. */
export const BUCKET_OK_MS = 100
/** 1 s — the limit below which the user's flow of thought is uninterrupted. */
export const BUCKET_WARN_MS = 1000

/** Bucket a duration against the NN/g limits. `null` (segment never happened) is not a bucket. */
export function bucketOf(ms: number | null): SwitchBucket | null {
  if (ms === null) return null
  if (ms < BUCKET_OK_MS) return 'ok'
  if (ms < BUCKET_WARN_MS) return 'warn'
  return 'err'
}

/** One completed switch. Any segment whose marks did not both land is `null`, never 0 — a missing
 *  measurement and an instantaneous one must not read the same. */
export interface SwitchMetrics {
  /** `start` → `paintable`, minus `ask`. Null if the switch never reached a painted frame. */
  total: number | null
  /** `start` → `armed`, minus `ask`. The dead air (PS-1). Null on the welcome-screen open path,
   *  which arms no overlay because there is no outgoing canvas to stand in for. */
  arm: number | null
  /** `armed` → `loaded`. Falls back to spanning from `start` when nothing was armed. */
  load: number | null
  /** `loaded` → `paintable`. */
  paint: number | null
  /** How long the ask-on-switch dialog was open. Null when no dialog appeared. */
  ask: number | null
  /** MAIN's own `project:open` duration when it reported one (see `reportMainOpen`). */
  mainOpen: number | null
  /** How the switch ended. Aborted switches are still recorded — a save-failed switch that burned
   *  four seconds before aborting is exactly the kind of thing this exists to catch. */
  outcome: SwitchMetricsOutcome
  /** `Date.now()` when the record was committed, for ordering in the e2e probe. */
  at: number
}

interface SwitchMetricsState {
  /** The most recently completed switch, or null before the first one. */
  last: SwitchMetrics | null
  /** Commit a completed record (called by `endSwitch`). */
  commit: (m: SwitchMetrics) => void
  /** Drop the record — test/e2e reset. */
  reset: () => void
}

export const useSwitchMetricsStore = create<SwitchMetricsState>((set) => ({
  last: null,
  commit: (m) => set({ last: m }),
  reset: () => set({ last: null })
}))

/** In-flight run state. Module-level rather than in the store: these are written several times per
 *  switch on the animation-critical path, and a Zustand set per mark would churn every subscriber
 *  mid-switch — the overlay only ever wants the COMPLETED record. */
interface Run {
  t: Partial<Record<SwitchMark, number>>
  askMs: number | null
  mainOpenMs: number | null
}

let run: Run | null = null

/** Best-effort `performance.mark`. Never throws into the switch pipeline: instrumentation that can
 *  break a project switch is worse than no instrumentation. */
function nativeMark(name: string): void {
  try {
    performance.mark?.(name)
  } catch {
    /* devtools nicety only — the numbers come from performance.now() */
  }
}

/** Best-effort `performance.measure`, same contract as `nativeMark`. */
function nativeMeasure(name: string, start: string, end: string): void {
  try {
    performance.measure?.(name, start, end)
  } catch {
    /* see nativeMark */
  }
}

/** Open a measurement window and lay `switch:start`. Any previous unfinished run is discarded —
 *  the cross-surface switch lock makes overlap impossible in practice, and if one ever did occur
 *  the newer switch is the one the user is waiting on. */
export function beginSwitch(): void {
  run = { t: {}, askMs: null, mainOpenMs: null }
  markSwitch('start')
}

/** Lay a mark. A no-op when no run is open, so a stray call can never resurrect a stale window. */
export function markSwitch(mark: SwitchMark): void {
  if (run === null) return
  run.t[mark] = performance.now()
  nativeMark(`switch:${mark}`)
}

/** Record how long the ask-on-switch dialog was open, to be excluded from `arm` and `total`.
 *  Additive: a pipeline that somehow showed two dialogs excludes both. */
export function recordAskTime(ms: number): void {
  if (run === null || !Number.isFinite(ms) || ms < 0) return
  run.askMs = (run.askMs ?? 0) + ms
}

/** Fold in MAIN's self-reported `project:open` duration (measured there with `perf_hooks`). */
export function reportMainOpen(ms: number): void {
  if (run === null || !Number.isFinite(ms) || ms < 0) return
  run.mainOpenMs = ms
}

/** Difference between two marks, or null when either is missing. */
function span(t: Run['t'], from: SwitchMark, to: SwitchMark): number | null {
  const a = t[from]
  const b = t[to]
  return a === undefined || b === undefined ? null : b - a
}

/** Subtract excluded think-time without letting float noise produce a negative duration. */
function minusAsk(ms: number | null, askMs: number | null): number | null {
  if (ms === null) return null
  return askMs === null ? ms : Math.max(0, ms - askMs)
}

/**
 * Close the measurement window, derive the segments and commit the record.
 *
 * Aborted outcomes are committed too, with whichever segments completed; `paintable` never lands on
 * those paths so `total` and `paint` stay null, which is the honest reading — the switch did not
 * finish, so it has no end-to-end duration.
 */
export function endSwitch(outcome: SwitchMetricsOutcome): SwitchMetrics | null {
  if (run === null) return null
  const { t, askMs, mainOpenMs } = run
  run = null

  const arm = minusAsk(span(t, 'start', 'armed'), askMs)
  // The welcome-screen open arms no overlay (no outgoing canvas to cover), so `armed` is absent
  // there. Span `load` from `start` in that case rather than reporting null: the load genuinely
  // began at the start of the pipeline, and dropping the number would leave that path unmeasured.
  const load =
    t.armed === undefined ? minusAsk(span(t, 'start', 'loaded'), askMs) : span(t, 'armed', 'loaded')

  const metrics: SwitchMetrics = {
    total: minusAsk(span(t, 'start', 'paintable'), askMs),
    arm,
    load,
    paint: span(t, 'loaded', 'paintable'),
    ask: askMs,
    mainOpen: mainOpenMs,
    outcome,
    at: Date.now()
  }

  // Emit devtools measures for the spans that completed, so a Performance recording shows the same
  // segmentation as the overlay. Guarded on the underlying marks: `performance.measure` throws when
  // a referenced mark is absent.
  if (t.armed !== undefined) nativeMeasure('switch:arm', 'switch:start', 'switch:armed')
  if (t.armed !== undefined && t.loaded !== undefined)
    nativeMeasure('switch:load', 'switch:armed', 'switch:loaded')
  if (t.loaded !== undefined && t.paintable !== undefined)
    nativeMeasure('switch:paint', 'switch:loaded', 'switch:paintable')

  useSwitchMetricsStore.getState().commit(metrics)
  return metrics
}

/** Mark `paintable` on the first frame that actually painted the new canvas, then close the record.
 *
 *  A single `requestAnimationFrame` callback runs BEFORE that frame's paint, so it would time the
 *  React commit and not the pixels. Waiting one more frame means the callback runs after the
 *  browser has presented the frame the new canvas first appeared in — which is the moment the user
 *  sees the new project. */
export function markPaintableAndEnd(outcome: SwitchMetricsOutcome): void {
  if (run === null) return
  if (typeof requestAnimationFrame !== 'function') {
    // Non-browser host (unit tests, headless smoke): close the record without a paint sample
    // instead of hanging the window open forever.
    endSwitch(outcome)
    return
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      markSwitch('paintable')
      endSwitch(outcome)
    })
  })
}

/** Test/e2e seam: drop any in-flight run. */
export function resetSwitchMetrics(): void {
  run = null
  useSwitchMetricsStore.getState().reset()
}

/** Test seam: is a measurement window currently open? */
export function isSwitchMeasuring(): boolean {
  return run !== null
}
