/**
 * Shared style grammar for the settings detail panes (`settings/panes/*`). Lifted verbatim from
 * `SettingsModal.tsx` + `SettingsVoiceSection.tsx` so every ported section keeps the exact
 * field/label/input/toggle look it had in the old single-column modal — the tile-launcher only
 * reshapes the container (`SettingsPanel`), never the controls. One place so the panes don't each
 * re-declare the grammar (the reason `SettingsVoiceSection` had to keep a private copy).
 */
import type { CSSProperties } from 'react'

export const pane: Record<string, CSSProperties> = {
  // A pane body is a vertical stack; the panel's detailBody already scrolls + pads.
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  head: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  hint: { fontSize: 11, lineHeight: '15px', color: 'var(--text-3)', fontWeight: 400 },
  input: {
    minHeight: 30,
    padding: '0 9px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--inset)',
    color: 'var(--text)',
    fontSize: 12.5,
    fontFamily: 'var(--ui)'
  },
  error: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--warn)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  notice: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--text-3)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  divider: { height: 1, background: 'var(--border-subtle)', margin: '2px 0' },
  // A "setrow" — description on the left, control on the right (recap/orchestration/voice-pill).
  setrow: {
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '12px 13px',
    display: 'flex',
    alignItems: 'center',
    gap: 12
  },
  rowTitle: { fontSize: 12.5, color: 'var(--text)', fontWeight: 500 },
  rowSub: { fontSize: 11, color: 'var(--text-3)', lineHeight: '15px', marginTop: 2 },
  toggle: {
    position: 'relative',
    width: 36,
    height: 21,
    flex: 'none',
    border: 'none',
    padding: 0,
    borderRadius: 999,
    transition: 'background 0.12s ease-out'
  },
  toggleKnob: {
    position: 'absolute',
    top: 2,
    width: 17,
    height: 17,
    borderRadius: 999,
    background: '#fff',
    transition: 'left 0.12s ease-out'
  },
  syncBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'var(--ui)',
    color: 'var(--accent-hover)',
    border: '1px solid rgba(79,140,255,.4)',
    background: 'var(--accent-wash)',
    borderRadius: 'var(--r-ctl)',
    padding: '5px 11px',
    cursor: 'pointer'
  },
  ctlDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  // Account identity row + CTA card + plan badges (Account / Billing panes).
  acctRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '11px 13px'
  },
  acctEmail: {
    fontSize: 12.5,
    color: 'var(--text)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  acctSub: { fontSize: 11, color: 'var(--text-3)', marginTop: 2 },
  acctCta: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '12px 13px'
  },
  acctCtaText: { flex: 1, fontSize: 12, color: 'var(--text-2)', lineHeight: '17px' },
  badgeFree: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.03em',
    color: 'var(--text-3)',
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 4,
    padding: '2px 7px'
  },
  badgePro: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.03em',
    color: 'var(--accent)',
    background: 'var(--accent-wash)',
    border: '1px solid rgba(79,140,255,.4)',
    borderRadius: 4,
    padding: '2px 7px'
  }
}
