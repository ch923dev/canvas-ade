/**
 * Switch-transition overlay state (Background Project Sessions, Phase 4c — the signed-off
 * PHASE4C-MOTION-MOCK spec). `performProjectSwitch` arms this store right before the
 * `setProjectLoading()` unmount; `SwitchTransitionOverlay` renders whatever phase is set.
 *
 * Phase machine (durations from the approved spec table):
 *   idle → out (260ms: the switch-away snapshot minimizes into its dock slot)
 *        → hold (only while the load hasn't settled — solid --void, never the picker)
 *        → in  (240ms: the REAL incoming canvas rises under a now-transparent overlay)
 *        → idle (self-clears after IN + a small buffer).
 * A missing snapshot (capture failed / over budget) skips OUT entirely — straight to HOLD,
 * so a switch is never blocked on cosmetics. `prefers-reduced-motion` swaps both legs for
 * 120ms fades (sampled once at arm so JS timing and CSS visuals can't disagree).
 *
 * Safety: settle/clear are driven by the pipeline's REAL landing ('open' → IN, load error →
 * immediate clear so the error screen stays reachable), and a WATCHDOG force-clears ~4s
 * after arm — a hung load (or a throw between arm and load) can never hide the app behind
 * the overlay; the WelcomeScreen's D0-7 loading line remains the fallback surface.
 */
import { create } from 'zustand'

export type SwitchTransitionPhase = 'idle' | 'out' | 'hold' | 'in'

/** OUT: snapshot scales 1 → 0.05 toward its dock card slot (spec table row 1). */
export const SWITCH_OUT_MS = 260
/** IN: incoming canvas rises — scale 1.03 → 1, +10px → 0, fade (spec table row 3). */
export const SWITCH_IN_MS = 240
/** prefers-reduced-motion: both legs become a plain linear cross-fade (spec table row 4). */
export const SWITCH_REDUCED_MS = 120
/** Grace after IN before the overlay unmounts (the mock's +60ms settle). */
export const SWITCH_IN_CLEAR_BUFFER_MS = 60
/** Force-clear after arm — a hung load can never leave the app hidden behind the overlay. */
export const SWITCH_WATCHDOG_MS = 4000

export interface SwitchTransitionState {
  phase: SwitchTransitionPhase
  /** Outgoing canvas's dock thumbnail (data URL); null ⇒ no scale-out, straight to HOLD. */
  snapshotUrl: string | null
  /** Incoming project's display name — the HOLD line + the minidock receiving card. */
  incomingName: string | null
  /** Outgoing project's display name — the minidock's second card ("it went HERE"). */
  outgoingName: string | null
  /** prefers-reduced-motion sampled at arm — drives phase timing AND the no-dock-peek branch. */
  reduced: boolean
}

const IDLE: SwitchTransitionState = {
  phase: 'idle',
  snapshotUrl: null,
  incomingName: null,
  outgoingName: null,
  reduced: false
}

export const useSwitchTransitionStore = create<SwitchTransitionState>(() => ({ ...IDLE }))

// Timers live at module level (like the ask-store's reqId counter) — they are plumbing,
// not renderable state. `settled` marks a load that finished while OUT was still playing:
// IN must not start before OUT completes (the mock sequences them), so the OUT timer
// consumes the flag instead of HOLD ever showing.
let outTimer: ReturnType<typeof setTimeout> | null = null
let clearTimer: ReturnType<typeof setTimeout> | null = null
let watchdog: ReturnType<typeof setTimeout> | null = null
let settled = false

function cancelTimers(): void {
  if (outTimer !== null) clearTimeout(outTimer)
  if (clearTimer !== null) clearTimeout(clearTimer)
  if (watchdog !== null) clearTimeout(watchdog)
  outTimer = clearTimer = watchdog = null
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Arm the overlay (phase OUT, or HOLD when there is no snapshot) + start the watchdog. */
export function armSwitchTransition(opts: {
  snapshotUrl: string | null
  incomingName: string | null
  outgoingName: string | null
}): void {
  cancelTimers()
  settled = false
  const reduced = prefersReducedMotion()
  if (opts.snapshotUrl === null) {
    // No snapshot → skip the scale-out, go straight to the HOLD ground (still no picker).
    useSwitchTransitionStore.setState({ ...opts, phase: 'hold', reduced })
  } else {
    useSwitchTransitionStore.setState({ ...opts, phase: 'out', reduced })
    outTimer = setTimeout(
      () => {
        outTimer = null
        if (useSwitchTransitionStore.getState().phase !== 'out') return
        if (settled) enterIn()
        else useSwitchTransitionStore.setState({ phase: 'hold' })
      },
      reduced ? SWITCH_REDUCED_MS : SWITCH_OUT_MS
    )
  }
  watchdog = setTimeout(() => {
    watchdog = null
    clearSwitchTransition()
  }, SWITCH_WATCHDOG_MS)
}

/** The load settled 'open' — play IN (immediately from HOLD; queued behind a running OUT). */
export function settleSwitchTransitionIn(): void {
  const phase = useSwitchTransitionStore.getState().phase
  if (phase === 'idle' || phase === 'in') return
  if (phase === 'out') {
    settled = true
    return
  }
  enterIn()
}

function enterIn(): void {
  if (watchdog !== null) {
    clearTimeout(watchdog)
    watchdog = null
  }
  const reduced = useSwitchTransitionStore.getState().reduced
  useSwitchTransitionStore.setState({ phase: 'in' })
  clearTimer = setTimeout(
    () => {
      clearTimer = null
      clearSwitchTransition()
    },
    (reduced ? SWITCH_REDUCED_MS : SWITCH_IN_MS) + SWITCH_IN_CLEAR_BUFFER_MS
  )
}

/** Drop the overlay NOW (load error, watchdog, e2e reset) — the app must be reachable. */
export function clearSwitchTransition(): void {
  cancelTimers()
  settled = false
  useSwitchTransitionStore.setState({ ...IDLE })
}
