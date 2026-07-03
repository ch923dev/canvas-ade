/**
 * Switch-transition overlay (Background Project Sessions, Phase 4c — the signed-off
 * PHASE4C-MOTION-MOCK). Mounted app-level from App.tsx (a sibling of Canvas, like
 * AskOnSwitchModal); renders whenever `switchTransitionStore` is armed and NOTHING when
 * idle. All timing lives in the store — this component only paints the current phase:
 *
 *  - OUT:  the switch-away snapshot minimizing into its dock card slot over solid --void.
 *  - HOLD: the void ground + a quiet mono "Opening <name>…" line — the point of the phase
 *          is that the welcome picker never paints mid-switch (App.tsx suppresses it while
 *          the overlay is up; the D0-7 welcome loading line stays the no-overlay fallback).
 *  - IN:   transparent + pointer-events:none — the REAL incoming canvas rises underneath
 *          (App.tsx's .st-app-rise wrapper) while the minidock tucks away.
 *
 * The minidock is presentation-only (two dumb cards: outgoing + receiving-with-ring) — it
 * exists to sell "your project went HERE", never reusing the data-driven ProjectDock. It is
 * skipped entirely under reduced motion (store-sampled flag; CSS hides it too).
 */
import type { ReactElement } from 'react'
import { useSwitchTransitionStore } from '../store/switchTransitionStore'

export function SwitchTransitionOverlay(): ReactElement | null {
  const phase = useSwitchTransitionStore((s) => s.phase)
  const snapshotUrl = useSwitchTransitionStore((s) => s.snapshotUrl)
  const incomingName = useSwitchTransitionStore((s) => s.incomingName)
  const outgoingName = useSwitchTransitionStore((s) => s.outgoingName)
  const reduced = useSwitchTransitionStore((s) => s.reduced)
  if (phase === 'idle') return null

  // Peek through OUT + HOLD; dropping the class when IN starts plays the 180ms tuck-away
  // inside the 240ms IN window (the mock's sequencing).
  const peeked = phase === 'out' || phase === 'hold'

  return (
    <div className={`st-overlay st-${phase}`} data-testid="switch-transition">
      {phase === 'out' && snapshotUrl && (
        <img className="st-snapshot" src={snapshotUrl} alt="" draggable={false} />
      )}
      {phase === 'hold' && (
        <div className="st-hold" role="status">
          <div className="st-hold-msg">
            <span className="st-spin" aria-hidden />
            <span>Opening {incomingName ?? 'project'}…</span>
          </div>
        </div>
      )}
      {!reduced && (
        <div
          className={peeked ? 'st-minidock st-peek' : 'st-minidock'}
          data-testid="st-minidock"
          aria-hidden
        >
          {outgoingName && (
            <span className="st-mcard">
              <span className="st-mname">{outgoingName}</span>
              <span className="st-mdot" />
            </span>
          )}
          <span className="st-mcard" data-recv="">
            <span className="st-mname">{incomingName ?? '…'}</span>
            <span className="st-mdot" />
          </span>
        </div>
      )}
    </div>
  )
}

export default SwitchTransitionOverlay
