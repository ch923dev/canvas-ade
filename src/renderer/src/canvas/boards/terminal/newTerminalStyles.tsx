/**
 * NewTerminalDialog presentation helpers — the Field wrapper, the §6 focus ring, and every
 * style const, extracted verbatim from NewTerminalDialog.tsx at the S1 max-lines ratchet
 * (the terminalMenu/OrchestratorLeadRow precedent). No behavior lives here.
 */
import type { CSSProperties, ReactElement } from 'react'

export function Field({
  label,
  children
}: {
  label: string
  children: ReactElement
}): ReactElement {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

// Inline-styled fields can't use :focus-visible — mirror the §6 select-ring on focus/blur
// (matches TerminalConfig's ringOn/ringOff).
export const ringOn = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = '0 0 0 1.5px var(--accent)'
}
export const ringOff = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = ''
}

export const card: CSSProperties = {
  width: 460,
  maxWidth: '92vw',
  maxHeight: '92vh',
  overflowY: 'auto',
  scrollbarWidth: 'thin',
  scrollbarColor: 'var(--border-strong) transparent',
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 13
}
export const title: CSSProperties = {
  textAlign: 'center',
  fontSize: 15,
  lineHeight: '22px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--text)'
}
export const sectionLabel: CSSProperties = {
  fontSize: 10,
  lineHeight: '14px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 6
}
export const presets: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'space-between' }
export const presetBtn: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 5,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer'
}
export const tile: CSSProperties = {
  width: '100%',
  maxWidth: 54,
  height: 46,
  borderRadius: 'var(--r-inner)',
  background: 'var(--surface-overlay)',
  border: '1px solid var(--border-subtle)',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-2)'
}
export const tileSel: CSSProperties = {
  background: 'var(--accent-wash)',
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  boxShadow: '0 0 0 1px var(--accent)'
}
export const presetName: CSSProperties = {
  fontSize: 11,
  lineHeight: '13px',
  color: 'var(--text-3)',
  textAlign: 'center'
}
export const presetNameSel: CSSProperties = { color: 'var(--text-2)' }
export const seg: CSSProperties = {
  alignSelf: 'center',
  display: 'inline-flex',
  gap: 2,
  padding: 2,
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)'
}
export const segBtn: CSSProperties = {
  height: 24,
  padding: '0 14px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text-3)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  cursor: 'pointer'
}
export const segOn: CSSProperties = {
  ...segBtn,
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 500
}
export const fieldWrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
export const fieldLabel: CSSProperties = { fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }
export const fld: CSSProperties = {
  height: 30,
  padding: '0 9px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  outline: 'none',
  // Render the native Shell dropdown popup with dark chrome (harmless for the text inputs).
  colorScheme: 'dark'
}
// Explicit per-option colors so the native Shell popup is always readable on dark.
export const shellOpt: CSSProperties = {
  background: 'var(--surface-overlay)',
  color: 'var(--text)'
}
export const check: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left'
}
export const box: CSSProperties = {
  width: 16,
  height: 16,
  flex: 'none',
  borderRadius: 4,
  border: '1px solid var(--border-strong)',
  background: 'transparent',
  display: 'grid',
  placeItems: 'center'
}
export const boxOn: CSSProperties = { background: 'var(--accent)', borderColor: 'var(--accent)' }
export const checkLbl: CSSProperties = { fontSize: 12.5, color: 'var(--text)' }
export const checkHint: CSSProperties = { fontSize: 11, color: 'var(--text-3)' }
export const fontRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
export const stepBtn: CSSProperties = {
  height: 28,
  width: 36,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 13,
  cursor: 'pointer'
}
export const stepOff: CSSProperties = { opacity: 0.35, cursor: 'default' }
export const fontVal: CSSProperties = {
  minWidth: 80,
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--text-2)'
}
export const sbRow: CSSProperties = { display: 'flex', gap: 6 }
export const sbChip: CSSProperties = {
  flex: 1,
  height: 32,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1.1
}
export const sbChipOn: CSSProperties = {
  background: 'var(--accent-wash)',
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  boxShadow: '0 0 0 1px var(--accent)'
}
export const sbSub: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.85,
  marginTop: 1
}
export const sbHint: CSSProperties = {
  fontSize: 11,
  lineHeight: '15px',
  color: 'var(--text-3)',
  marginTop: 2
}
// ── Theme picker (Lane B) — 2-col swatch grid with a live mini-terminal preview ──
export const themeGrid: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }
export const themeCard: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  background: 'var(--inset)',
  padding: 7,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  textAlign: 'left'
}
export const themeCardOn: CSSProperties = {
  borderColor: 'var(--accent)',
  background: 'var(--accent-wash)',
  boxShadow: '0 0 0 1px var(--accent)'
}
export const preview: CSSProperties = {
  borderRadius: 4,
  padding: '7px 8px',
  fontFamily: 'var(--term-mono)',
  fontSize: 10.5,
  lineHeight: 1.5,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  border: '1px solid rgba(255,255,255,0.05)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2
}
export const pvLine: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis' }
export const dots: CSSProperties = { display: 'inline-flex', gap: 3 }
export const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 'var(--r-pill)',
  flex: 'none'
}
export const themeName: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-2)'
}
export const themeNameOn: CSSProperties = { color: 'var(--accent)' }
export const themePin: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.85
}
// Font-family chips — like the scrollback chips but taller (name + glyph sample), each in its own face.
export const fontChip: CSSProperties = {
  flex: 1,
  height: 40,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text-2)',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  lineHeight: 1.15
}
export const fontChipName: CSSProperties = { fontSize: 12.5 }
export const fontChipSample: CSSProperties = { fontSize: 11, opacity: 0.85 }
export const footer: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 2
}
export const btnGhost: CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer'
}
export const btnPrimary: CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 600
}
