/**
 * Shared inline styles for the WS-4 workspace dialogs (New / Delete) and the Workspaces menu — the
 * NewKanbanDialog / NewTerminalDialog card language (tokens only, approved mock
 * claude.ai/artifact/HA8mQkDgxmQZKsXPZEjbbt), kept in one place so the two dialogs cannot drift.
 */
import type { CSSProperties } from 'react'

export const card: CSSProperties = {
  width: 520,
  maxWidth: '94vw',
  maxHeight: '90vh',
  overflowY: 'auto',
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
export const subtitle: CSSProperties = {
  textAlign: 'center',
  marginTop: -9,
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  color: 'var(--text-3)'
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
export const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
export const fieldLabel: CSSProperties = {
  width: 46,
  flex: 'none',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-3)'
}
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
  flex: 1,
  minWidth: 0
}
export const fldMono: CSSProperties = { ...fld, fontFamily: 'var(--mono)', fontSize: 12 }
export const select: CSSProperties = {
  ...fldMono,
  height: 28,
  flex: 'none',
  minWidth: 170,
  background: 'var(--surface-overlay)'
}
export const hint: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: 'var(--text-3)' }
export const mono: CSSProperties = { fontFamily: 'var(--mono)' }

const noteBase: CSSProperties = {
  borderRadius: 'var(--r-inner)',
  padding: '8px 10px',
  fontSize: 11.5,
  lineHeight: 1.45,
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-overlay)',
  color: 'var(--text-2)'
}
export const note: Record<'plain' | 'accent' | 'warn' | 'err' | 'ok', CSSProperties> = {
  plain: noteBase,
  accent: {
    ...noteBase,
    borderColor: 'rgba(79,140,255,0.3)',
    background: 'var(--accent-wash)',
    color: 'var(--text)'
  },
  warn: {
    ...noteBase,
    borderColor: 'rgba(232,179,57,0.3)',
    background: 'var(--warn-wash)',
    color: 'var(--text)'
  },
  err: {
    ...noteBase,
    borderColor: 'rgba(242,84,91,0.3)',
    background: 'var(--err-wash)',
    color: 'var(--text)'
  },
  ok: {
    ...noteBase,
    borderColor: 'rgba(62,207,142,0.3)',
    background: 'var(--ok-wash)',
    color: 'var(--text)'
  }
}

/** A selectable option row / tile (radio semantics via aria-pressed). */
export const option: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  borderRadius: 'var(--r-inner)',
  padding: '9px 10px',
  display: 'flex',
  gap: 9,
  alignItems: 'flex-start',
  color: 'var(--text-2)',
  textAlign: 'left',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  cursor: 'pointer',
  width: '100%'
}
export const optionOn: CSSProperties = {
  borderColor: 'var(--accent)',
  background: 'var(--accent-wash)',
  boxShadow: '0 0 0 1px var(--accent)',
  color: 'var(--text)'
}
export const optionBad: CSSProperties = {
  borderColor: 'var(--err)',
  background: 'var(--err-wash)',
  boxShadow: '0 0 0 1px var(--err)',
  color: 'var(--text)'
}
export const optionOff: CSSProperties = { opacity: 0.45, cursor: 'not-allowed' }
export const optionTitle: CSSProperties = { fontWeight: 600, color: 'var(--text)', fontSize: 12.5 }

export const tiles2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }

export const footer: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 8,
  marginTop: 2
}
export const footerMsg: CSSProperties = { flex: 1, fontSize: 11, color: 'var(--text-3)' }
export const btnGhost: CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap'
}
export const btnSmall: CSSProperties = { ...btnGhost, height: 26, padding: '0 10px', fontSize: 12 }
export const btnPrimary: CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 600
}
export const btnDanger: CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--err)',
  background: 'var(--err-wash)',
  color: 'var(--err)',
  fontWeight: 600
}
export const btnDisabled: CSSProperties = { opacity: 0.4, cursor: 'not-allowed' }

export const listBox: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  background: 'var(--inset)',
  overflow: 'hidden'
}
export const listRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  minHeight: 30,
  padding: '0 10px',
  border: 'none',
  borderTop: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer'
}
export const tag: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-pill)',
  padding: '1px 7px',
  whiteSpace: 'nowrap'
}
export const tagTone: Record<'accent' | 'warn' | 'err' | 'ok', CSSProperties> = {
  accent: { ...tag, color: 'var(--accent)', borderColor: 'rgba(79,140,255,0.35)' },
  warn: { ...tag, color: 'var(--warn)', borderColor: 'rgba(232,179,57,0.35)' },
  err: { ...tag, color: 'var(--err)', borderColor: 'rgba(242,84,91,0.35)' },
  ok: { ...tag, color: 'var(--ok)', borderColor: 'rgba(62,207,142,0.35)' }
}

/** A radio dot (filled when on). */
export function dot(on: boolean): CSSProperties {
  return {
    width: 10,
    height: 10,
    marginTop: 2,
    flex: 'none',
    borderRadius: 'var(--r-pill)',
    border: `1.5px solid ${on ? 'var(--accent)' : 'var(--text-3)'}`,
    background: on ? 'radial-gradient(var(--accent) 45%, transparent 50%)' : 'transparent'
  }
}

/** A colour marker dot. */
export function colorDot(css: string, size = 8): CSSProperties {
  return { width: size, height: size, borderRadius: 'var(--r-pill)', background: css, flex: 'none' }
}

// Inline-styled inputs can't use :focus-visible — mirror the select ring on focus/blur (as
// NewTerminalDialog / NewKanbanDialog do).
export const ringOn = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = '0 0 0 1.5px var(--accent)'
}
export const ringOff = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = ''
}
