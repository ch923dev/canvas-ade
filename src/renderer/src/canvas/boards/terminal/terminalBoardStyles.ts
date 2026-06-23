// Static layout styles for TerminalBoard, extracted so the host stays under its max-lines pin
// (PA-9/TERM-07 ratchet; pins move DOWNWARD only). Pure CSSProperties — no logic, no imports
// beyond the type. The counter-scaled xterm-host variant (screenStyle) is still computed inline
// in useTerminalReraster; `screen` here is its identity (counterScale = 1) base.
import type { CSSProperties } from 'react'

export const shell: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column'
}

/** LOD: hide the xterm well (keep it mounted so the PTY session stays alive). */
export const shellHidden: CSSProperties = { ...shell, display: 'none' }

export const screenWrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  background: 'var(--inset)'
}

/** Identity (counterScale = 1) layout for the xterm host; the counter-scaled variant is
 *  computed inline in render (screenStyle) and reduces to exactly this at cs = 1. */
export const screen: CSSProperties = {
  position: 'absolute',
  inset: 0,
  padding: '12px' // was '12px 12px 4px'; DESIGN.md §7.1 = 12px. Cosmetic — FitAddon ignores
  // this padding, so fitWhole (not the padding) is what prevents the clip.
}

/** Idle (restored/duplicated, not yet started) overlay: centered Start affordance
 *  over the empty --inset well so the terminal never silently auto-spawns (M-1). */
export const idleOverlay: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--inset)'
}

export const startBtn: CSSProperties = {
  font: 'inherit',
  fontSize: 12.5,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-ctl)',
  padding: '6px 14px',
  cursor: 'pointer'
}

/** TERM-06: the transient "interrupt sent" chip beside the pill (warn-toned, calm). */
export const interruptChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--warn)',
  whiteSpace: 'nowrap',
  paddingRight: 4
}
